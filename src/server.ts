/**
 * The Node entry point.
 *
 * Cloudflare called `export default { fetch, scheduled }` for us. On a Linode
 * nothing does, so this is the thing that listens — and it calls the very same
 * handler, unchanged. Node 18 has Request, Response, Headers and fetch as
 * globals, so the Worker's own code needs no porting: only the plumbing around
 * it is different.
 *
 * Run it behind Nginx on 127.0.0.1. Nothing here terminates TLS or reads a
 * certificate; that is Nginx's job, and binding to localhost means the Node
 * process is not reachable from the internet even if the firewall is wrong.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import worker from './index';
import type { Env } from './types';
import { connectRedis } from './platform/kv-redis';
import { KvStore, MirroredStore, SupabaseStore } from './platform/store';
import { configFromProcess, configWarnings, missingRequired } from './platform/config';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * Everything the bot reads, from the environment.
 *
 * Values are trimmed because a secret pasted into a .env routinely picks up a
 * trailing space, and a token with whitespace fails authentication with an
 * error that names neither the token nor the space.
 */
function readEnv(state: Env['STATE']): Env {
  const e = new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key === 'STATE') return state;
      const raw = process.env[key];
      return typeof raw === 'string' ? raw.trim() : undefined;
    },
    has: () => true,
  });
  return e as unknown as Env;
}

/** Node's request, as the Fetch API one the handler expects. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? 'localhost';
  // Nginx terminates TLS, so the scheme it saw is the only source of truth for
  // what the caller used — Meta's webhook signature is over the body, but any
  // absolute URL we build from this must not say http.
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((one) => headers.append(k, one));
    else if (v !== undefined) headers.set(k, v);
  }

  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }

  /*
   * The body is read as bytes and passed through untouched. Both webhook
   * signature checks — Meta's X-Hub-Signature-256 and Razorpay's — hash the
   * exact bytes that arrived, so anything that re-serialises the JSON on the
   * way in silently breaks verification.
   */
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
  res.end(body);
}

async function main(): Promise<void> {
  /*
   * Checked at boot, so a missing secret is one line in the journal rather
   * than a shopper who gets no reply. This module existed and was never
   * called — which is why "APP_SECRET is unset, webhook signatures are NOT
   * verified" went unread for weeks while the endpoint accepted anything.
   */
  const config = configFromProcess(process.env as Record<string, string | undefined>);
  const missing = missingRequired(config);
  if (missing.length) {
    console.log('[config:MISSING]', missing.join(', '), '— the bot cannot answer a message');
  }
  for (const warning of configWarnings(config)) console.log('[config:warning]', warning);

  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const { kv } = await connectRedis(redisUrl);

  /*
   * Redis answers, Supabase remembers.
   *
   * Reads stay in memory on this machine, because several of them happen per
   * inbound message and a network round trip on each is felt in how quickly
   * the bot replies. Writes go to both, so state survives a Redis flush, an
   * eviction or a rebuilt server — and so the one genuinely sensitive key,
   * `addr:` with a real name and address on it, lives somewhere encrypted at
   * rest and backed up rather than only in plaintext on a disk.
   *
   * Without Supabase configured this is Redis alone, exactly as before. The
   * mirror is an addition, never a dependency.
   */
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_KEY?.trim();

  const store =
    url && serviceKey
      ? new MirroredStore(new KvStore(kv), new SupabaseStore({ url, serviceKey }))
      : new KvStore(kv);

  console.log(url && serviceKey ? '[store] redis, mirrored to supabase' : '[store] redis only');

  const env = readEnv(store as unknown as Env['STATE']);

  const server = createServer((req, res) => {
    /*
     * ctx.waitUntil, honestly.
     *
     * Workers guarantee a promise passed to waitUntil finishes after the
     * response is sent. Node makes no such promise: an unawaited promise dies
     * with the process, and under load that means analytics writes, Shopify
     * order creation and delivery receipts stop happening while everything
     * still LOOKS fine. So the work is collected and awaited after the
     * response goes out — the shopper is not kept waiting, and the work is
     * not abandoned.
     */
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(
          Promise.resolve(promise).catch((err) => console.log('[waitUntil:error]', String(err))),
        );
      },
      passThroughOnException() {},
    };

    (async () => {
      try {
        const request = await toRequest(req);
        const response = await worker.fetch(request, env, ctx as never);
        await writeResponse(res, response);
      } catch (err) {
        console.log('[server:error]', String(err));
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal error');
      } finally {
        // After the response, never before it.
        if (pending.length) await Promise.allSettled(pending);
      }
    })();
  });

  // A webhook body is small; anything large is either a mistake or an attack.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  server.listen(PORT, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} — closing`);
    server.close(() => process.exit(0));
    // Do not let a hung connection hold the process open forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.log('[server:fatal]', String(err));
  process.exit(1);
});
