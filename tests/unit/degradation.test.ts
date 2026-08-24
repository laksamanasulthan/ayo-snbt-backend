import { describe, it, expect, vi } from "vitest";
import { RedisHealthMonitor, DegradationManager } from "../../src/shared/redis/index.js";

describe("RedisHealthMonitor", () => {
  it("starts healthy and transitions to down on failures", () => {
    const sample = vi.fn().mockResolvedValue({ ok: false, error: "timeout" });
    const monitor = new RedisHealthMonitor("test", { sample, failThreshold: 2, recoverPings: 2 });
    expect(monitor.state).toBe("healthy");
    monitor.evaluate({ ok: false });
    expect(monitor.state).toBe("stressed");
    monitor.evaluate({ ok: false });
    expect(monitor.state).toBe("down");
  });

  it("recovers after N consecutive healthy pings", () => {
    const monitor = new RedisHealthMonitor("test", { sample: async () => ({ ok: true }), failThreshold: 2, recoverPings: 3 });
    monitor.evaluate({ ok: false });
    monitor.evaluate({ ok: false });
    expect(monitor.state).toBe("down");
    // Recover
    monitor.evaluate({ ok: true, memoryPercent: 0.5 });
    expect(monitor.state).toBe("down"); // not enough recoveries yet
    monitor.evaluate({ ok: true, memoryPercent: 0.5 });
    monitor.evaluate({ ok: true, memoryPercent: 0.5 });
    expect(monitor.state).toBe("healthy");
  });

  it("enters stressed state when memory is high", () => {
    const monitor = new RedisHealthMonitor("test", { sample: async () => ({ ok: true }), stressMemoryPercent: 0.85 });
    monitor.evaluate({ ok: true, memoryPercent: 0.9 });
    expect(monitor.state).toBe("stressed");
  });
});

describe("DegradationManager", () => {
  it("starts all gates in redis mode when monitors are healthy", () => {
    const mgr = new DegradationManager();
    // Default monitors start healthy (no sample, but state defaults to healthy)
    expect(mgr.getGate("cache").mode).toBe("redis");
    expect(mgr.getGate("rateLimit").mode).toBe("redis");
    expect(mgr.getGate("queue").mode).toBe("redis");
    expect(mgr.getGate("presence").mode).toBe("redis");
    expect(mgr.isFullyHealthy()).toBe(true);
  });

  it("switches to db/memory/outbox when stressed", () => {
    const monitor = new RedisHealthMonitor("test", { sample: async () => ({ ok: true }), stressMemoryPercent: 0.85 });
    monitor.evaluate({ ok: true, memoryPercent: 0.9 });
    expect(monitor.state).toBe("stressed");
    const mgr = new DegradationManager({ cache: monitor, rateLimit: monitor, queue: monitor, presence: monitor });
    expect(mgr.getGate("cache").mode).toBe("db");
    expect(mgr.getGate("rateLimit").mode).toBe("memory");
    expect(mgr.getGate("queue").mode).toBe("outbox");
    expect(mgr.getGate("presence").mode).toBe("memory");
    expect(mgr.isFullyHealthy()).toBe(false);
  });

  it("switches to db/memory/reject when down", () => {
    const monitor = new RedisHealthMonitor("test", { sample: async () => ({ ok: false }), failThreshold: 1, recoverPings: 2 });
    monitor.evaluate({ ok: false });
    expect(monitor.state).toBe("down");
    const mgr = new DegradationManager({ cache: monitor, rateLimit: monitor, queue: monitor, presence: monitor });
    expect(mgr.getGate("cache").mode).toBe("db");
    expect(mgr.getGate("rateLimit").mode).toBe("memory");
    expect(mgr.getGate("queue").mode).toBe("reject");
    expect(mgr.getGate("presence").mode).toBe("memory");
  });

  it("snapshot returns all gates", () => {
    const mgr = new DegradationManager();
    const snap = mgr.snapshot();
    expect(snap.cache).toBeDefined();
    expect(snap.rateLimit).toBeDefined();
    expect(snap.queue).toBeDefined();
    expect(snap.presence).toBeDefined();
  });
});