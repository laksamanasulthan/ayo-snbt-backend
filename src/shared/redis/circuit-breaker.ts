/**
 * Generic circuit breaker used around Redis operations (and reusable for
 * any downstream). States: closed → open (after N consecutive failures)
 * → half-open (after cooldown, one probe allowed) → closed again.
 */
export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreakerOpenError extends Error {
  constructor(readonly breakerName: string) {
    super(`Circuit breaker "${breakerName}" is open — downstream presumed unavailable`);
    this.name = "CircuitBreakerOpenError";
  }
}

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures before opening. Default 3. */
  failureThreshold?: number;
  /** Consecutive successes in half-open before closing. Default 2. */
  successThreshold?: number;
  /** Time in open state before a half-open probe is allowed. Default 10s. */
  cooldownMs?: number;
}

export class CircuitBreaker {
  readonly name: string;
  state: BreakerState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private probing = false;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly cooldownMs: number;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.successThreshold = opts.successThreshold ?? 2;
    this.cooldownMs = opts.cooldownMs ?? 10_000;
  }

  isOpen(): boolean {
    if (this.state === "open") {
      // After cooldown the breaker allows a single probe (half-open).
      if (Date.now() - this.openedAt >= this.cooldownMs && !this.probing) {
        this.state = "half-open";
        this.probing = true;
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Run fn through the breaker. Rejects with CircuitBreakerOpenError when
   * open (callers must have a fallback — see DegradationManager consumers).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) throw new CircuitBreakerOpenError(this.name);
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.close();
      }
    } else if (this.state === "closed") {
      this.failures = 0;
    }
  }

  recordFailure(): void {
    if (this.state === "half-open") {
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = "open";
    this.openedAt = Date.now();
    this.probing = false;
    this.failures = 0;
    this.successes = 0;
  }

  private close(): void {
    this.state = "closed";
    this.probing = false;
    this.failures = 0;
    this.successes = 0;
  }

  reset(): void {
    this.close();
  }
}
