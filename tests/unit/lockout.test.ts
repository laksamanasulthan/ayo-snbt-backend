import { describe, it, expect } from "vitest";
import { computeLockoutStatus } from "../../src/shared/auth/index.js";

describe("Login lockout (exponential windows)", () => {
  it("allows attempts under the threshold", () => {
    const s = computeLockoutStatus(3);
    expect(s.locked).toBe(false);
    expect(s.remainingAttempts).toBe(2);
  });

  it("locks for 5 minutes after 5 failures", () => {
    const s = computeLockoutStatus(5);
    expect(s.locked).toBe(true);
    expect(s.lockDurationMs).toBe(300_000);
  });

  it("locks for 15 minutes after 10 failures", () => {
    const s = computeLockoutStatus(10);
    expect(s.locked).toBe(true);
    expect(s.lockDurationMs).toBe(900_000);
  });

  it("locks for 60 minutes after 15+ failures", () => {
    expect(computeLockoutStatus(15).lockDurationMs).toBe(3_600_000);
    expect(computeLockoutStatus(42).lockDurationMs).toBe(3_600_000);
  });
});
