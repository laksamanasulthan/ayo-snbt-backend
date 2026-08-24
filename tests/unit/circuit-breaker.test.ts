import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker, CircuitBreakerOpenError } from "../../src/shared/redis/index.js";

describe("CircuitBreaker", () => {
  it("starts closed and allows calls", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 2, cooldownMs: 10_000 });
    expect(cb.state).toBe("closed");
    const result = await cb.execute(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("opens after consecutive failures", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 2, cooldownMs: 10_000 });
    await expect(cb.execute(() => Promise.reject(new Error("e1")))).rejects.toThrow("e1");
    expect(cb.state).toBe("closed");
    await expect(cb.execute(() => Promise.reject(new Error("e2")))).rejects.toThrow("e2");
    expect(cb.state).toBe("open");
  });

  it("rejects immediately when open (CircuitBreakerOpenError)", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, cooldownMs: 60_000 });
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cb.state).toBe("open");
    await expect(cb.execute(() => Promise.resolve(1))).rejects.toThrow(CircuitBreakerOpenError);
  });

  it("transitions to half-open after cooldown then closes on success", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, cooldownMs: 10_000, successThreshold: 2 });
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cb.state).toBe("open");

    // Advance past cooldown → half-open (probe mode)
    vi.advanceTimersByTime(10_000);
    // isOpen returns false after cooldown (probe allowed)
    expect(cb.isOpen()).toBe(false);
    expect(cb.state).toBe("half-open");

    // First success in half-open
    const r1 = await cb.execute(() => Promise.resolve(1));
    expect(r1).toBe(1);
    expect(cb.state).toBe("half-open");

    // Second success → closes
    const r2 = await cb.execute(() => Promise.resolve(2));
    expect(r2).toBe(2);
    expect(cb.state).toBe("closed");
    vi.useRealTimers();
  });

  it("reopens on failure in half-open", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, cooldownMs: 10_000 });
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    vi.advanceTimersByTime(10_000);
    cb.isOpen(); // → half-open
    await expect(cb.execute(() => Promise.reject(new Error("again")))).rejects.toThrow("again");
    expect(cb.state).toBe("open");
    vi.useRealTimers();
  });
});