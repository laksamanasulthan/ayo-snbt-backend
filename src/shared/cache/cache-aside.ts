import type { DegradationManager } from "../redis/index.js";

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Redis-backed store. */
export class RedisCacheStore implements CacheStore {
  constructor(private readonly redis: { get(k: string): Promise<string | null>; set(k: string, v: string, mode: "PX", ttl: number): Promise<unknown>; del(k: string): Promise<unknown> }) {}
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, "PX", ttlMs);
  }
  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/**
 * Cache-aside with single-flight (stampede protection): concurrent misses
 * share one loader promise. When the Redis gate is degraded, reads bypass
 * the cache entirely (graceful switch to DB).
 */
export class CacheAside {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: CacheStore | null,
    private readonly degradation: DegradationManager,
    private readonly gate: "cache" = "cache",
    private readonly keyPrefix = "asbt"
  ) {}

  private fullKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  async get<T>(key: string, loader: () => Promise<T>, ttlMs: number): Promise<T> {
    const store = this.store;
    // Degraded → bypass cache, go straight to the source of truth (DB).
    if (!store || !this.degradation.canUseRedis(this.gate)) {
      return loader();
    }
    const fullKey = this.fullKey(key);
    const hit = await store.get(fullKey);
    if (hit !== null) return JSON.parse(hit) as T;

    // Single-flight: dedupe concurrent misses on the same key.
    const existing = this.inFlight.get(fullKey) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = (async (): Promise<T> => {
      try {
        const value = await loader();
        if (value !== null && value !== undefined) {
          await store.set(fullKey, JSON.stringify(value), ttlMs);
        }
        return value;
      } finally {
        this.inFlight.delete(fullKey);
      }
    })();
    this.inFlight.set(fullKey, promise);
    return promise;
  }

  async del(key: string): Promise<void> {
    if (!this.store || !this.degradation.canUseRedis(this.gate)) return;
    await this.store.del(this.fullKey(key));
  }
}
