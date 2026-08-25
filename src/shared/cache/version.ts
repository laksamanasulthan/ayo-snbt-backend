import { getRedis } from "../redis/client.js";
import { getLogger } from "../logger.js";

const log = getLogger();
const PREFIX = "asbt:ver";

/**
 * Version-tagged cache invalidation: instead of deleting arbitrary cache
 * keys on mutation, we bump a per-entity version token. Cache keys embed
 * the version, so old entries are simply never read again and expire via
 * TTL. Works with unbounded keysets (cursor pagination).
 */
export async function cacheVersion(entity: string): Promise<string> {
  try {
    const v = await getRedis().get(PREFIX + ":" + entity);
    return v ?? "1";
  } catch {
    return "1"; // degraded: version is stable, caches still bypass via gates
  }
}

export async function bumpCacheVersion(entity: string): Promise<void> {
  try {
    await getRedis().incr(PREFIX + ":" + entity);
  } catch (err) {
    log.warn({ err, entity }, "cache version bump failed (degraded)");
  }
}
