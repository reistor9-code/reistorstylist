/**
 * Node entrypoint — the Linode deployment.
 *
 * The bot's entire HTTP surface lives in handleRequest() in index.ts, written
 * against the standard Request/Response objects that both Cloudflare Workers
 * and Node 18+ provide. This file is only an adapter: it accepts a Node
 * request, hands the shared handler a standard Request, and writes the
 * standard Response back out.
 *
 * Deliberately built on `node:http` rather than Express. A self-hosted box is
 * something somebody has to patch for years, and the fewer dependencies in the
 * path between the internet and the bot, the less there is to patch. TLS,
 * compression and rate limiting belong in nginx in front of this, not here.
 *
 * Run it:
 *   node --env-file=.env dist/server.js
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleRequest, runDailyPull } from './index.js';
import type { Env } from './types.js';
import { configFromProcess, configWarnings, missingRequired } from './platform/config.js';

/* ------------------------------------------------------------------ *
 * Node <-> Fetch adapters
 * ------------------------------------------------------------------ */

/**
 * Reads the body as raw bytes.
 *
 * It must stay raw. Meta's X-Hub-Signature-256 is an HMAC over the exact bytes
 * sent, so anything that parses and re-serialises the JSON on the way in makes
 * every signature fail.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toRequest(req: IncomingMessage, body: Buffer, origin: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }

  const method = req.method ?? 'GET';

  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    // GET and HEAD must not carry a body, or the Request constructor throws.
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  res.writeHead(response.status, headers);
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

/* ------------------------------------------------------------------ *
 * Background work
 * ------------------------------------------------------------------ */

/**
 * The Node counterpart of ctx.waitUntil.
 *
 * On Cloudflare that call keeps the isolate alive past the response. Here the
 * process is already long-lived, so the promise simply runs on — but it still
 * needs a catch, because an unhandled rejection in Node terminates the process
 * by default, and losing the whole bot to one failed analytics write would be
 * a poor trade.
 */
const inFlight = new Set<Promise<unknown>>();

function background(promise: Promise<unknown>): void {
  inFlight.add(promise);
  promise
    .catch((err) => console.log('[background:error]', String(err)))
    .finally(() => inFlight.delete(promise));
}

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

/**
 * Runs the nightly pull at a fixed UTC hour.
 *
 * A recursive setTimeout to the next occurrence rather than a fixed 24-hour
 * interval: an interval drifts a little on every tick and, after a restart,
 * fires at whatever time the process happened to start. This always lands on
 * the intended hour.
 */
function scheduleDailyPull(env: Env, utcHour: number): void {
  const nextRun = (): number => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(utcHour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  };

  const arm = () => {
    const delay = nextRun();
    console.log('[cron] next pull in', Math.round(delay / 60000), 'minutes');
    setTimeout(() => {
      background(runDailyPull(env));
      arm();
    }, delay).unref?.();
  };

  arm();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

export function start(): void {
  const config = configFromProcess(process.env);
  const env = config as unknown as Env;

  const missing = missingRequired(config);
  if (missing.length) {
    // Refuse to start rather than accept webhooks it cannot answer. A bot that
    // 200s every message and silently drops it is worse than one that is down.
    console.error('[boot:fatal] missing required configuration:', missing.join(', '));
    process.exit(1);
  }

  for (const warning of configWarnings(config)) console.warn('[boot:warn]', warning);

  const port = Number(config.PORT) || 8787;
  // nginx terminates TLS and proxies here, so the public origin is whatever
  // PUBLIC_BASE_URL says — not the loopback address this socket is bound to.
  const origin = config.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const response = await handleRequest(toRequest(req, body, origin), env, background);
        await writeResponse(res, response);
      } catch (err) {
        console.log('[server:error]', String(err), (err as Error)?.stack);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal error');
      }
    })();
  });

  // Meta gives a webhook call a short window to answer. The handler already
  // replies immediately and works in the background, so a long keep-alive here
  // only holds sockets open.
  server.keepAliveTimeout = 20_000;
  server.headersTimeout = 25_000;

  server.listen(port, () => {
    console.log(`[boot] Reistor AI Stylist listening on :${port}`);
    console.log(`[boot] webhook   ${origin}/webhook`);
    console.log(`[boot] dashboard ${origin}/dashboard`);
    console.log(`[boot] health    ${origin}/health`);
  });

  scheduleDailyPull(env, Number(process.env.PULL_UTC_HOUR ?? 21));

  /*
   * Graceful shutdown. systemd sends SIGTERM on restart; finishing the
   * in-flight work first means a deploy cannot lose the analytics writes for
   * messages already answered.
   */
  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} — draining`);
    server.close(() => {
      void Promise.allSettled([...inFlight]).then(() => {
        console.log('[shutdown] done');
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 10_000).unref?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejection that reaches here is a bug, but killing the bot over it would
  // turn a logging failure into an outage.
  process.on('unhandledRejection', (reason: unknown) => {
    console.log('[unhandled-rejection]', String(reason));
  });
}

start();
