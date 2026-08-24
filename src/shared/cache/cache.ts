import { CacheAside, RedisCacheStore } from "./cache-aside.js";
import { getRedis } from "../redis/client.js";
import type { DegradationManager } from "../redis/degradation.js";

let current: CacheAside | null = null;

/**
 * App-wide cache-aside instance. bindCache() must be called at boot with
 * the DegradationManager so the Redis gate decides between Redis caching
 * and direct DB reads (graceful degradation).
 */
export function bindCache(degradation: DegradationManager): CacheAside {
  current = new CacheAside(new RedisCacheStore(getRedis() as never), degradation);
  return current;
}

export function getCache(): CacheAside {
  if (!current) throw new Error("Cache not bound — call bindCache(degradation) at boot");
  return current;
}
