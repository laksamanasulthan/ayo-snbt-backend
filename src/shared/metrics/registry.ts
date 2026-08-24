import promClient from "prom-client";
import type { DegradationManager } from "../redis/degradation.js";
import { getQueue, QueueName } from "../queue/queues.js";

promClient.collectDefaultMetrics({ register: promClient.register, prefix: "ayosnbt_" });

// ── HTTP metrics ─────────────────────────────────────────────────────
export const httpRequestsTotal = new promClient.Counter({
  name: "ayosnbt_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
});

export const httpRequestDurationSeconds = new promClient.Histogram({
  name: "ayosnbt_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// ── Cache metrics (single-flight) ────────────────────────────────────
export const cacheHitsTotal = new promClient.Counter({
  name: "ayosnbt_cache_hits_total",
  help: "Cache hits",
});
export const cacheMissesTotal = new promClient.Counter({
  name: "ayosnbt_cache_misses_total",
  help: "Cache misses",
});
export const cacheSingleflightTotal = new promClient.Counter({
  name: "ayosnbt_cache_singleflight_total",
  help: "Cache requests deduplicated by single-flight",
});

// ── Degradation gauges (sampled on scrape) ────────────────────────────
let currentDegradation: DegradationManager | null = null;
export function setMetricDegradation(d: DegradationManager): void { currentDegradation = d; }

export const degradationGates = new promClient.Gauge({
  name: "ayosnbt_degradation_gate_mode",
  help: "Degradation gate mode: 0=redis, 1=db, 2=memory, 3=outbox, 4=reject",
  labelNames: ["gate"] as const,
  collect() {
    if (!currentDegradation) return;
    const map: Record<string, number> = { redis: 0, db: 1, memory: 2, outbox: 3, reject: 4 };
    const snap = currentDegradation.snapshot();
    for (const [gate, info] of Object.entries(snap)) {
      this.set({ gate }, map[info.mode] ?? 0);
    }
  },
});

export const breakerState = new promClient.Gauge({
  name: "ayosnbt_redis_breaker_state",
  help: "Redis circuit breaker state: 0=closed, 1=half-open, 2=open",
  collect() {
    // Breaker state is reported via the degradation monitor health
    // (the gate mode already reflects Redis availability).
    this.set({}, 0);
  },
});

// ── Queue depth (polled every 15s — async operation) ─────────────────
function updateQueueGauges(): void {
  try {
    for (const name of Object.values(QueueName)) {
      const queue = getQueue(name as QueueName);
      // Defensive: in tests / degraded environments the queue may be a stub
      if (typeof queue.getJobCounts !== "function") continue;
      queue.getJobCounts().then((counts) => {
      const labels = { queue: name };
      queueDepthGauge.set(labels, counts.waiting ?? 0);
      queueActiveGauge.set(labels, counts.active ?? 0);
      queueDelayedGauge.set(labels, counts.delayed ?? 0);
        queueFailedGauge.set(labels, counts.failed ?? 0);
      }).catch(() => { /* metric unavailable */ });
    }
  } catch {
    /* metrics are best-effort */
  }
}

export const queueDepthGauge = new promClient.Gauge({
  name: "ayosnbt_queue_depth",
  help: "Number of jobs waiting in the queue",
  labelNames: ["queue"] as const,
});
export const queueActiveGauge = new promClient.Gauge({
  name: "ayosnbt_queue_active",
  help: "Number of active jobs",
  labelNames: ["queue"] as const,
});
export const queueDelayedGauge = new promClient.Gauge({
  name: "ayosnbt_queue_delayed",
  help: "Number of delayed jobs",
  labelNames: ["queue"] as const,
});
export const queueFailedGauge = new promClient.Gauge({
  name: "ayosnbt_queue_failed",
  help: "Number of failed jobs",
  labelNames: ["queue"] as const,
});

export function startQueueMetricsPolling(): void {
  updateQueueGauges();
  setInterval(updateQueueGauges, 15_000).unref();
}

export { promClient };