import { CacheAside, RedisCacheStore } from "./cache-aside.js";
import { getRedis } from "../redis/client.js";
import { DegradationManager } from "../redis/degradation.js";

let current: CacheAside | null = null;

/**
 * App-wide cache-aside instance. bindCache() must be called at boot with
 * the DegradationManager so the Redis gate decides between Redis caching
 * and direct DB reads (graceful degradation).
 */
export function bindCache(degradation: DegradationManager): CacheAside {
  current = new CacheAside(new RedisCacheStore(redisStoreAdapter(getRedis())), degradation);
  return current;
}

/** Structural adapter: ioredis → the narrow CacheStore shape. */
function redisStoreAdapter(redis: ReturnType<typeof getRedis>): { get(k: string): Promise<string | null>; set(k: string, v: string, mode: "PX", ttl: number): Promise<unknown>; del(k: string): Promise<unknown> } {
  return {
    get: (k) => redis.get(k),
    set: (k, v, mode, ttl) => redis.set(k, v, mode, ttl),
    del: (k) => redis.del(k)
  };
}

/**
 * Returns the bound cache-aside, or — when unbound (unit tests, minimal
 * boot) — a bypass cache that always loads from the source of truth. The
 * cache must never be a hard dependency of a request path.
 */
export function getCache(): CacheAside {
  if (!current) {
    current = new CacheAside(null, new DegradationManager());
  }
  return current;
}