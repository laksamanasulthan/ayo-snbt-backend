import { Redis, type RedisOptions } from "ioredis";
import { getEnv } from "../../config/index.js";

import { backoffDelayMs } from "../backoff/retry.js";

let appClient: Redis | undefined;
let bullClients: { connection: Redis; subscriber: Redis } | undefined;

/** Connection options shared by all Redis clients. */
function baseOptions(): RedisOptions {
  return {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    // Fail-fast: commands reject during reconnect so the circuit breaker and
    // DegradationManager (not an infinite offline queue) own the fallback.
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    // Exponential backoff + full jitter for reconnect (1s → 30s cap)
    retryStrategy: (times: number) => {
      if (times > 30) return null; // give up permanently after ~5min of failing
      return backoffDelayMs(times, { baseDelayMs: 1_000, maxDelayMs: 30_000, jitter: "full" });
    }
  };
}

/** Shared application Redis client (cache, rate limit, presence). */
export function getRedis(): Redis {
  if (!appClient) {
    appClient = new Redis(getEnv().REDIS_URL, baseOptions());
  }
  return appClient;
}

/**
 * BullMQ requires a dedicated connection with maxRetriesPerRequest: null
 * (otherwise jobs fail while Redis blips) and its own subscriber connection.
 */
export function getBullConnections() {
  if (!bullClients) {
    const env = getEnv();
    const opts: RedisOptions = {
      ...baseOptions(),
      maxRetriesPerRequest: null,
      enableOfflineQueue: false
    };
    bullClients = {
      connection: new Redis(env.REDIS_URL, opts),
      subscriber: new Redis(env.REDIS_URL, opts)
    };
  }
  return bullClients;
}

export async function closeRedis(): Promise<void> {
  const closables: (Redis | undefined)[] = [appClient, bullClients?.connection, bullClients?.subscriber];
  appClient = undefined;
  bullClients = undefined;
  await Promise.allSettled(closables.map((c) => (c ? c.quit().catch(() => c.disconnect()) : Promise.resolve())));
}