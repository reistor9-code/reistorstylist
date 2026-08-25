/**
 * The nightly job, as a one-shot process.
 *
 * `[triggers] crons` in wrangler.toml called `scheduled()` for us. A systemd
 * timer calls this instead — deliberately a separate process rather than a
 * scheduler inside the server, because a timer survives an app crash and an
 * in-process interval does not. If the bot falls over at 20:00, the pull still
 * runs at 21:00.
 *
 * Exits non-zero on failure so `systemctl status` and journald show it, rather
 * than a silent success that quietly stops importing orders.
 */

import worker from './index';
import type { Env } from './types';
import { connectRedis } from './platform/kv-redis';

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

async function main(): Promise<void> {
  const { kv, client } = await connectRedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const env = readEnv(kv as unknown as Env['STATE']);

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
  };

  const started = Date.now();
  console.log('[cron] starting');

  // Same handler Cloudflare called. `cron` is the expression that fired, which
  // the Worker does not branch on — there is only one schedule.
  await worker.scheduled(
    { cron: process.env.CRON_EXPRESSION ?? '0 21 * * *', scheduledTime: Date.now() } as never,
    env,
    ctx as never,
  );

  // scheduled() does its work inside waitUntil, so this is where it happens.
  await Promise.all(pending);

  console.log('[cron] done in', `${Math.round((Date.now() - started) / 1000)}s`);
  await client.quit();
}

main().catch((err) => {
  console.log('[cron:fatal]', String(err));
  process.exit(1);
});
