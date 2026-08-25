/**
 * Workers KV, backed by Redis.
 *
 * The bot reads and writes state through `env.STATE`, a KVNamespace, at
 * nineteen call sites across seven files. Rather than change all of them, this
 * satisfies the same shape — the three methods actually used — so every module
 * above it is unchanged between Cloudflare and Linode.
 *
 * Redis is a better fit than KV was, not a worse one. KV is eventually
 * consistent with no compare-and-set, which is what lost shoppers' baskets and
 * forced the cart into its own key; Redis reads its own writes immediately.
 * `EX` maps onto `expirationTtl` exactly.
 */

import { createClient, type RedisClientType } from 'redis';

/** The surface the bot actually uses. Not the whole KVNamespace API. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export class RedisKV implements KVLike {
  constructor(private readonly client: RedisClientType) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    /*
     * A TTL below one second is not expressible in Redis and would be stored
     * forever, so it is floored. Nothing in the bot asks for one, but a
     * silently immortal key is the kind of bug that only shows up months later
     * as a stale basket.
     */
    const ttl = options?.expirationTtl;
    if (ttl && ttl > 0) {
      await this.client.set(key, value, { EX: Math.max(1, Math.floor(ttl)) });
      return;
    }
    await this.client.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }
}

/**
 * Opens the connection.
 *
 * Fails loudly rather than degrading: without state the bot cannot remember
 * what a shopper picked one message ago, and a version that starts and then
 * answers every message as if it were the first is worse than one that does
 * not start.
 */
export async function connectRedis(url: string): Promise<{ kv: RedisKV; client: RedisClientType }> {
  const client: RedisClientType = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      /*
       * Bounded, and quiet about it.
       *
       * The default retries forever, which turns "Redis is not running" into
       * an endless wall of ECONNREFUSED that buries the one line explaining
       * what to do. Five attempts is enough to ride out a restart; beyond
       * that the process should die and let systemd restart it.
       */
      reconnectStrategy: (retries) => (retries >= 5 ? new Error('redis unreachable') : 200),
    },
  });

  // Logged once per connection, not once per retry.
  let logged = false;
  client.on('error', (err: unknown) => {
    if (logged) return;
    logged = true;
    console.log('[redis:error]', String(err));
  });

  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    throw new Error(
      `Cannot reach Redis at ${url}. ` +
        'Start it with `sudo systemctl start redis-server`, or set REDIS_URL. ' +
        `(${String(err)})`,
    );
  }

  console.log('[redis] connected', url.replace(/\/\/.*@/, '//'));
  return { kv: new RedisKV(client), client };
}
