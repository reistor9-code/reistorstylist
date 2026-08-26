/**
 * The storage seam.
 *
 * Every piece of bot state — conversation state, webhook dedupe markers, the
 * Shopify catalog cache, the Shopify access token — goes through this
 * interface instead of touching Cloudflare KV directly.
 *
 * That matters because Workers KV does not exist anywhere but Cloudflare. With
 * ~40 call sites spread through the bot, moving hosts would otherwise mean
 * editing all of them. Behind this interface it means writing one new class.
 *
 * The method signatures deliberately mirror KVNamespace's, so the migration in
 * index.ts was a rename rather than a rewrite.
 */

import {
  type SupabaseConfig,
  remove,
  rpc,
  select,
  upsert,
} from './supabase.js';

export interface PutOptions {
  /** Seconds until the entry expires. Omitted means it never does. */
  expirationTtl?: number;
}

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Supabase — the portable one, used on Cloudflare and on Linode alike
 * ------------------------------------------------------------------ */

interface KvRow {
  value: string;
  expires_at: string | null;
}

export class SupabaseStore implements Store {
  constructor(private cfg: SupabaseConfig) {}

  async get(key: string): Promise<string | null> {
    const res = await select<KvRow[]>(
      this.cfg,
      'kv',
      `key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`,
    );

    const row = res.data?.[0];
    if (!row) return null;

    /*
     * Postgres has no TTL of its own, so expiry is enforced on read. A row past
     * its date is treated as absent immediately rather than waiting for the
     * sweeper — otherwise a stale conversation state could be handed back to a
     * shopper hours after it should have reset.
     */
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

    return row.value;
  }

  async put(key: string, value: string, options?: PutOptions): Promise<void> {
    const expires =
      options?.expirationTtl && options.expirationTtl > 0
        ? new Date(Date.now() + options.expirationTtl * 1000).toISOString()
        : null;

    await upsert(
      this.cfg,
      'kv',
      { key, value, expires_at: expires, updated_at: new Date().toISOString() },
      'key',
    );
  }

  async delete(key: string): Promise<void> {
    await remove(this.cfg, 'kv', `key=eq.${encodeURIComponent(key)}`);
  }

  /** Housekeeping for the cron job. Correctness never depends on it. */
  async sweep(): Promise<number> {
    const res = await rpc<number>(this.cfg, 'kv_sweep');
    return typeof res.data === 'number' ? res.data : 0;
  }
}

/* ------------------------------------------------------------------ *
 * Cloudflare KV — kept so the bot still runs if Supabase is unset
 * ------------------------------------------------------------------ */

/** Structural type, so this file needs no Cloudflare types to compile on Node. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export class KvStore implements Store {
  constructor(private kv: KvLike) {}

  get(key: string) {
    return this.kv.get(key);
  }

  put(key: string, value: string, options?: PutOptions) {
    return this.kv.put(key, value, options);
  }

  delete(key: string) {
    return this.kv.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * Memory — tests, and a last resort so a misconfiguration degrades
 * ------------------------------------------------------------------ */

export class MemoryStore implements Store {
  private map = new Map<string, { value: string; expires: number | null }>();

  async get(key: string): Promise<string | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expires !== null && hit.expires <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  async put(key: string, value: string, options?: PutOptions): Promise<void> {
    this.map.set(key, {
      value,
      expires: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Test helper. */
  clear() {
    this.map.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

export interface StoreEnv {
  STATE?: KvLike;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

/**
 * Picks the backing store, in order of preference:
 *
 *   Supabase  the portable choice — same behaviour on Cloudflare and Linode
 *   KV        Cloudflare only; the pre-Supabase path, kept as a fallback
 *   memory    no durable state at all, so a misconfigured deploy still answers
 *             messages instead of throwing on the first read
 *
 * The order matters during the migration: setting the two Supabase secrets is
 * what flips a running Worker over, with no code change and no redeploy.
 */
export function getStore(env: StoreEnv): Store {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    return new SupabaseStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
  }
  if (env.STATE) return new KvStore(env.STATE);

  console.log('[store:memory] no SUPABASE_URL or KV binding — state will not survive restarts');
  return new MemoryStore();
}

/* ------------------------------------------------------------------ *
 * Both at once
 * ------------------------------------------------------------------ */

/**
 * Redis in front, Supabase behind, every write going to both.
 *
 * Redis answers reads because it is in the same machine and in memory —
 * several state reads happen per inbound message, and a network round trip on
 * each one is felt in how fast the bot replies. Supabase gets the same write
 * so the data survives the thing Redis cannot survive: a flush, an eviction,
 * a rebuilt server. It is also encrypted at rest and backed up, which matters
 * most for `addr:` — real names, addresses and phone numbers that otherwise
 * live only in plaintext on a disk.
 *
 * No duplicates arise. The `kv` table has `key` as its primary key and the
 * write is an upsert on it, so a second write to `state:9198…` updates that
 * one row. The guarantee is the schema's, not this class's.
 *
 * A miss is a miss. Falling back to Supabase whenever Redis returned null
 * would put a network round trip on every legitimate absence — a new shopper,
 * an unseen message id — which is most of them. Supabase is consulted only
 * when Redis actually fails, which is the case where it holds something Redis
 * cannot answer for.
 */
export class MirroredStore implements Store {
  constructor(
    private fast: Store,
    private durable: Store,
  ) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.fast.get(key);
    } catch (err) {
      /*
       * Redis is down, so the copy earns its keep. Logged every time rather
       * than swallowed — a bot quietly running on the slow path is something
       * you want to know about before the day it matters.
       */
      console.log('[store:redis-read-failed]', key, String(err));
      return this.durable.get(key);
    }
  }

  async put(key: string, value: string, options?: PutOptions): Promise<void> {
    /*
     * Concurrent, so the pair costs what the slower one costs rather than
     * both added together. Redis is awaited for real; a failed mirror is
     * logged and swallowed, because losing the backup copy of a cart is not
     * a reason to stop answering the shopper holding it.
     */
    const [, mirrored] = await Promise.allSettled([
      this.fast.put(key, value, options),
      this.durable.put(key, value, options),
    ]);

    if (mirrored.status === 'rejected') {
      console.log('[store:mirror-failed]', key, String(mirrored.reason));
    }
  }

  async delete(key: string): Promise<void> {
    const [, mirrored] = await Promise.allSettled([
      this.fast.delete(key),
      this.durable.delete(key),
    ]);

    /*
     * A delete that only half-lands is the one failure worth caring about: it
     * leaves a row in Supabase that Redis has forgotten, which a later Redis
     * outage would serve back as if it were current. Rows carry expires_at,
     * so it ages out on its own — but it is logged so a pattern of them is
     * visible rather than inferred.
     */
    if (mirrored.status === 'rejected') {
      console.log('[store:mirror-delete-failed]', key, String(mirrored.reason));
    }
  }
}
