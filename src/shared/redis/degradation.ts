import { getLogger } from "../logger.js";

/**
 * DegradationManager — the "graceful switch to DB when Redis is
 * full/down/under pressure" requirement.
 *
 * A monitor pings Redis and samples memory pressure; based on its health
 * each subsystem gate (cache, rateLimit, queue, presence) selects a mode:
 *
 *   cache     : "redis" → Redis cache-aside | "db" → bypass cache, read DB
 *   rateLimit : "redis" → distributed store | "memory" → per-instance store
 *   queue     : "redis" → BullMQ           | "outbox" → PG outbox (critical jobs)
 *                                            | "reject" → 503 + Retry-After
 *   presence  : "redis" → pub/sub presence | "memory" → degraded presence
 *
 * Hysteresis: recovery requires recoverPings consecutive healthy pings so
 * a flapping Redis doesn't thrash the gates.
 */
export type GateName = "cache" | "rateLimit" | "queue" | "presence";
export type GateMode = "redis" | "db" | "memory" | "outbox" | "reject";
export type HealthState = "healthy" | "stressed" | "down";

export interface HealthSample {
  ok: boolean;
  latencyMs?: number;
  memoryPercent?: number; // used_memory / maxmemory
  error?: string;
}

export interface MonitorOptions {
  intervalMs?: number;
  failThreshold?: number;
  recoverPings?: number;
  stressMemoryPercent?: number;
  sample: () => Promise<HealthSample>;
}

export interface GateSnapshot {
  mode: GateMode;
  reason: string;
}

/**
 * Periodic Redis health monitor. Testable: inject any sample() function.
 * Polling loop uses setTimeout chains (unref'd) — never overlapping.
 */
export class RedisHealthMonitor {
  state: HealthState = "healthy";
  lastSample: HealthSample | null = null;
  private consecutiveFailures = 0;
  private consecutiveRecoveries = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly failThreshold: number;
  private readonly recoverPings: number;
  private readonly stressMemoryPercent: number;
  private readonly sampleFn: () => Promise<HealthSample>;
  private readonly log = getLogger();
  readonly name: string;

  constructor(name: string, opts: MonitorOptions) {
    this.name = name;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.failThreshold = opts.failThreshold ?? 2;
    this.recoverPings = opts.recoverPings ?? 3;
    this.stressMemoryPercent = opts.stressMemoryPercent ?? 0.85;
    this.sampleFn = opts.sample;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      this.lastSample = await this.sampleFn();
      this.evaluate(this.lastSample);
    } catch (err) {
      this.evaluate({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Force a synchronous evaluation from an external sample (tests, /ready). */
  evaluate(sample: HealthSample): void {
    this.lastSample = sample;
    const previous = this.state;
    if (!sample.ok) {
      this.consecutiveFailures += 1;
      this.consecutiveRecoveries = 0;
      if (this.consecutiveFailures >= this.failThreshold) this.state = "down";
      else if (this.state === "healthy") this.state = "stressed";
    } else if ((sample.memoryPercent ?? 0) >= this.stressMemoryPercent) {
      this.consecutiveFailures = 0;
      this.consecutiveRecoveries += 1;
      this.state = "stressed"; // memory pressure: keep serving, bypass cache writes
    } else {
      this.consecutiveFailures = 0;
      this.consecutiveRecoveries += 1;
      if (this.state !== "healthy" && this.consecutiveRecoveries >= this.recoverPings) {
        this.state = "healthy";
      }
    }
    if (previous !== this.state) {
      this.log.warn({ monitor: this.name, from: previous, to: this.state, sample }, "redis health transition");
    }
  }
}

export class DegradationManager {
  readonly cache: RedisHealthMonitor;
  readonly rateLimit: RedisHealthMonitor;
  readonly queue: RedisHealthMonitor;
  readonly presence: RedisHealthMonitor;

  constructor(monitors?: Partial<Record<GateName, RedisHealthMonitor>>) {
    const defaults = (name: GateName) =>
      new RedisHealthMonitor(name, {
        sample: async () => ({ ok: false, error: "not configured" })
      });
    this.cache = monitors?.cache ?? defaults("cache");
    this.rateLimit = monitors?.rateLimit ?? defaults("rateLimit");
    this.queue = monitors?.queue ?? defaults("queue");
    this.presence = monitors?.presence ?? defaults("presence");
  }

  private gate(monitor: RedisHealthMonitor, name: GateName): GateSnapshot {
    switch (monitor.state) {
      case "healthy":
        return { mode: "redis", reason: "healthy" };
      case "stressed":
        switch (name) {
          case "cache":
            return { mode: "db", reason: "redis under memory pressure" };
          case "rateLimit":
          case "presence":
            return { mode: "memory", reason: "redis under memory pressure" };
          case "queue":
            return { mode: "outbox", reason: "redis under memory pressure" };
        }
        break;
      case "down":
        switch (name) {
          case "cache":
            return { mode: "db", reason: "redis unavailable" };
          case "rateLimit":
          case "presence":
            return { mode: "memory", reason: "redis unavailable" };
          case "queue":
            return { mode: "reject", reason: "redis unavailable" };
        }
        break;
    }
    return { mode: "redis", reason: "unknown" };
  }

  getGate(name: GateName): GateSnapshot {
    switch (name) {
      case "cache":
        return this.gate(this.cache, name);
      case "rateLimit":
        return this.gate(this.rateLimit, name);
      case "queue":
        return this.gate(this.queue, name);
      case "presence":
        return this.gate(this.presence, name);
    }
  }

  /** Convenience: is it safe to talk to Redis for this subsystem right now? */
  canUseRedis(name: GateName): boolean {
    return this.getGate(name).mode === "redis";
  }

  /** Snapshot for /ready and metrics. */
  snapshot(): Record<GateName, GateSnapshot> {
    return {
      cache: this.getGate("cache"),
      rateLimit: this.getGate("rateLimit"),
      queue: this.getGate("queue"),
      presence: this.getGate("presence")
    };
  }

  /** True when every gate is on Redis (fully healthy). */
  isFullyHealthy(): boolean {
    const snap = this.snapshot();
    return Object.values(snap).every((g) => g.mode === "redis");
  }
}