import { getRedis } from "../redis/client.js";
import { getLogger } from "../logger.js";

const PREFIX = "asbt:lockout";

export interface LockoutStatus {
  locked: boolean;
  remainingAttempts: number;
  lockDurationMs: number;
}

/**
 * Login lockout with exponential windows:
 *  - 5  failures → 5 min lock
 *  - 10 failures → 15 min lock
 *  - 15+ failures → 60 min lock
 */
export class LoginLockout {
  private readonly log = getLogger();

  async recordFailed(email: string, ip: string): Promise<LockoutStatus> {
    const key = PREFIX + ":" + email + ":" + ip;
    try {
      const count = await getRedis().incr(key);
      if (count === 1) await getRedis().pexpire(key, 3_600_000); // 1h window
      return this.computeLockout(count);
    } catch (err) {
      this.log.warn({ err, email, ip }, "login lockout redis fallback (no-op)");
      return { locked: false, remainingAttempts: 5, lockDurationMs: 0 };
    }
  }

  async clear(email: string, ip: string): Promise<void> {
    const key = PREFIX + ":" + email + ":" + ip;
    try {
      await getRedis().del(key);
    } catch {
      /* best-effort */
    }
  }

  private computeLockout(count: number): LockoutStatus {
    return computeLockoutStatus(count);
  }
}

export const loginLockout = new LoginLockout();

/** Pure lockout computation with exponential windows (exported for tests). */
export function computeLockoutStatus(count: number): LockoutStatus {
  if (count >= 15) return { locked: true, remainingAttempts: 0, lockDurationMs: 3_600_000 };
  if (count >= 10) return { locked: true, remainingAttempts: 0, lockDurationMs: 900_000 };
  if (count >= 5) return { locked: true, remainingAttempts: 0, lockDurationMs: 300_000 };
  return { locked: false, remainingAttempts: 5 - count, lockDurationMs: 0 };
}