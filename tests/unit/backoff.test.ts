import { describe, it, expect, vi } from "vitest";
import { backoffDelayMs, retryWithBackoff, RetryExhaustedError } from "../../src/shared/backoff/retry.js";

describe("backoffDelayMs", () => {
  it("produces exponential delays within bounds (full jitter)", () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = backoffDelayMs(attempt, { baseDelayMs: 1_000, maxDelayMs: 30_000 });
      const cap = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(cap);
    }
  });

  it("caps at maxDelayMs", () => {
    for (let attempt = 8; attempt < 12; attempt++) {
      const delay = backoffDelayMs(attempt, { baseDelayMs: 1_000, maxDelayMs: 30_000 });
      expect(delay).toBeLessThan(30_000);
    }
  });
});

describe("retryWithBackoff", () => {
  it("resolves on first attempt when fn succeeds", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await retryWithBackoff(fn, { attempts: 3 });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail 1")).mockRejectedValueOnce(new Error("fail 2")).mockResolvedValue(42);
    const result = await retryWithBackoff(fn, { attempts: 4, baseDelayMs: 10 });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws RetryExhaustedError after all attempts fail", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("persistent"));
    await expect(retryWithBackoff(fn, { attempts: 3, baseDelayMs: 10 })).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects shouldRetry filter", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(retryWithBackoff(fn, { attempts: 3, baseDelayMs: 10, shouldRetry: (err: unknown) => (err as Error).message !== "fatal" })).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with attempt info", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error("n1")).mockRejectedValueOnce(new Error("n2")).mockResolvedValue(99);
    await retryWithBackoff(fn, { attempts: 4, baseDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    const first = onRetry.mock.calls[0]![0]!;
    const second = onRetry.mock.calls[1]![0]!;
    expect(first.attempt).toBe(1);
    expect((first.error as Error).message).toBe("n1");
    expect(second.attempt).toBe(2);
  });
});