import type { DegradationManager } from "../redis/index.js";

/** Matches @fastify/rate-limit v11 FastifyRateLimitStore (callback-based). */
export interface RateLimitStore {
  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindowMs: number,
    max: number
  ): void;
  child(routeOptions?: unknown): RateLimitStore;
}

/**
 * Fixed-window INCR+PEXPIRE store (atomic, cheap — right for 100k req/s).
 * @fastify/rate-limit v11 constructs stores via a class factory receiving
 * plugin options and uses a callback-based incr(key, cb, timeWindowMs, max).
 * We close over the DegradationManager; when the Redis gate degrades we
 * fall back to a per-instance in-memory store — rate limiting is NEVER
 * silently disabled.
 */
export interface RateLimitRedis {
  incr(k: string): Promise<number>;
  pexpire(k: string, ms: number): Promise<unknown>;
  pttl(k: string): Promise<number>;
}

export function createRedisRateLimitStore(
  degradation: DegradationManager,
  redis: RateLimitRedis,
  prefix = "asbt:rl"
) {
  class RedisRateLimitStore implements RateLimitStore {
    /**
     * @param routeScope — when the plugin builds a per-route store via
     * child(), we scope the Redis key by the route path so each route has
     * its OWN counter bucket (route limits must not share the global one).
     */
    constructor(_options: unknown = {}, private readonly routeScope?: string) {}

    child(routeOptions: unknown): RateLimitStore {
      // mergeParams nests the route info under routeInfo: { path, prefix }
      const opts = routeOptions as { path?: string; prefix?: string; routeInfo?: { path?: string; prefix?: string } } | undefined;
      const path = opts?.routeInfo?.path ?? opts?.path;
      if (!path) return new RedisRateLimitStore(undefined);
      const prefixPath = (opts?.routeInfo?.prefix ?? opts?.prefix ?? "") + path;
      // NOTE: constructor is (options, routeScope) — the scope is the 2nd arg!
      return new RedisRateLimitStore(undefined, prefixPath);
    }

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindowMs: number,
      max: number
    ): void {
      if (!degradation.canUseRedis("rateLimit")) {
        memoryRateLimitStore.incr(key, callback, timeWindowMs, max);
        return;
      }
      const scope = this.routeScope ? ":" + this.routeScope : "";
      const k = prefix + scope + ":" + key;
      redis
        .incr(k)
        .then(async (total) => {
          if (total === 1) await redis.pexpire(k, timeWindowMs);
          const ttlMs = await redis.pttl(k);
          callback(null, { current: total, ttl: ttlMs > 0 ? ttlMs : timeWindowMs });
        })
        .catch((_err: unknown) => {
          // Redis blip mid-request → fall back to memory for this window
          memoryRateLimitStore.incr(key, callback, timeWindowMs, max);
        });
    }
  }
  return RedisRateLimitStore;
}

/** Per-instance fallback (bounded map + periodic sweep). */
class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetsAt: number }>();

  constructor(private readonly scope?: string) {}

  child(routeOptions: unknown): RateLimitStore {
    const opts = routeOptions as { path?: string; routeInfo?: { path?: string } } | undefined;
    const path = opts?.routeInfo?.path ?? opts?.path;
    return path ? new MemoryRateLimitStore(path) : new MemoryRateLimitStore(undefined);
  }

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindowMs: number,
    _max: number
  ): void {
    const now = Date.now();
    const fullKey = (this.scope ? this.scope + ":" : "") + key;
    const existing = this.buckets.get(fullKey);
    if (!existing || existing.resetsAt <= now) {
      this.buckets.set(fullKey, { count: 1, resetsAt: now + timeWindowMs });
      this.sweep(now);
      callback(null, { current: 1, ttl: timeWindowMs });
      return;
    }
    existing.count += 1;
    callback(null, { current: existing.count, ttl: Math.max(0, existing.resetsAt - now) });
  }

  private sweep(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const [k, v] of this.buckets) {
      if (v.resetsAt <= now) this.buckets.delete(k);
    }
  }
}

export const memoryRateLimitStore = new MemoryRateLimitStore();