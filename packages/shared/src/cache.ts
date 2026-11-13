import { Redis } from 'ioredis';

/** JSON cache. Implementations must never throw: a cache outage is a miss. */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

export class RedisCache implements Cache {
  private readonly redis: Redis;

  constructor(url: string, onError: (err: Error) => void = () => {}) {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // fail fast instead of queueing while Redis is down
      connectTimeout: 2000,
    });
    this.redis.on('error', onError);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // best effort
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/** Process-local fallback for development, tests and single-instance deploys. */
export class MemoryCache implements Cache {
  private readonly entries = new Map<string, { json: string; expiresAt: number }>();

  constructor(private readonly maxEntries = 5000) {}

  async get<T>(key: string): Promise<T | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return JSON.parse(hit.json) as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      // Map iterates in insertion order, so this evicts the oldest entry.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { json: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

/**
 * In-process memoisation for values that do not survive JSON (Decimal, Date),
 * such as a tenant's markup matrix. Concurrent callers share one load.
 */
export function ttlMemo<T>(ttlMs: number, load: (key: string) => Promise<T>) {
  const entries = new Map<string, { value: Promise<T>; expiresAt: number }>();
  const get = (key: string): Promise<T> => {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = load(key);
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    value.catch(() => entries.delete(key)); // never cache a failure
    return value;
  };
  return Object.assign(get, { clear: () => entries.clear() });
}

const INVENTORY_EPOCH_KEY = 'inventory:epoch';

/**
 * Search results are cached under the current inventory epoch. Bumping it
 * (when an order takes a stone, or a feed sync finishes) orphans every cached
 * result at once, so a sold stone never lingers in search.
 */
export async function inventoryEpoch(cache: Cache): Promise<string> {
  return (await cache.get<string>(INVENTORY_EPOCH_KEY)) ?? '0';
}

export async function bumpInventoryEpoch(cache: Cache): Promise<void> {
  await cache.set(INVENTORY_EPOCH_KEY, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 30 * 86_400);
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Collapse concurrent identical loads into one. When a popular search expires
 * from the cache, the first request recomputes it and the others wait for that
 * result instead of each running the same query.
 */
export function singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = load().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}
