import { describe, it, expect, vi } from "vitest";
import { CacheAside } from "../../src/shared/cache/index.js";
import { DegradationManager, RedisHealthMonitor } from "../../src/shared/redis/index.js";

describe("CacheAside", () => {
  it("calls loader on miss and caches the result", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), del: vi.fn() };
    const mgr = new DegradationManager();
    const cache = new CacheAside(store, mgr);
    const loader = vi.fn().mockResolvedValue({ user: "alice" });
    const result = await cache.get("user:1", loader, 1000);
    expect(result).toEqual({ user: "alice" });
    expect(store.get).toHaveBeenCalledWith("asbt:user:1");
    expect(store.set).toHaveBeenCalledWith("asbt:user:1", JSON.stringify({ user: "alice" }), 1000);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("returns cached value on hit (no loader call)", async () => {
    const store = { get: vi.fn().mockResolvedValue(JSON.stringify({ user: "alice" })), set: vi.fn(), del: vi.fn() };
    const mgr = new DegradationManager();
    const cache = new CacheAside(store, mgr);
    const loader = vi.fn();
    const result = await cache.get("user:1", loader, 1000);
    expect(result).toEqual({ user: "alice" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("bypasses cache when Redis gate is degraded", async () => {
    const store = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
    const monitor = new RedisHealthMonitor("test", { sample: async () => ({ ok: false }), failThreshold: 1, recoverPings: 2 });
    monitor.evaluate({ ok: false });
    const mgr = new DegradationManager({ cache: monitor, rateLimit: monitor, queue: monitor, presence: monitor });
    const cache = new CacheAside(store, mgr);
    const loader = vi.fn().mockResolvedValue(42);
    const result = await cache.get("key", loader, 1000);
    expect(result).toBe(42);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent misses (single-flight)", async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), del: vi.fn() };
    const mgr = new DegradationManager();
    const cache = new CacheAside(store, mgr);
    const loader = vi.fn().mockImplementation(async () => { await new Promise((r) => setTimeout(r, 50)); return { user: "bob" }; });
    const [r1, r2] = await Promise.all([cache.get("user:2", loader, 1000), cache.get("user:2", loader, 1000)]);
    expect(r1).toEqual({ user: "bob" });
    expect(r2).toEqual({ user: "bob" });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("del calls store.del with prefixed key", async () => {
    const store = { get: vi.fn(), set: vi.fn(), del: vi.fn().mockResolvedValue(undefined) };
    const mgr = new DegradationManager();
    const cache = new CacheAside(store, mgr);
    await cache.del("user:1");
    expect(store.del).toHaveBeenCalledWith("asbt:user:1");
  });
});