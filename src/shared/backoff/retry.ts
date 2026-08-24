/**
 * Exponential backoff helpers (the "Exponential Backoff" requirement):
 *  - backoffDelayMs: pure delay computation (exponential + jitter)
 *  - retryWithBackoff: retry an async fn with exponential backoff
 * Used for outbound calls (SMTP, S3, payment providers, OAuth token exchange)
 * and by Redis reconnect strategies. BullMQ jobs use its built-in
 * exponential backoff (see src/shared/queue).
 */
export type JitterMode = "full" | "equal" | "none";

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Full jitter (AWS style) is the default: delay in [0, cap). */
  jitter?: JitterMode;
}

/** Pure exponential-backoff delay for the given attempt (1-based). */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const { baseDelayMs = 1_000, maxDelayMs = 30_000, jitter = "full" } = opts;
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  switch (jitter) {
    case "none":
      return exponential;
    case "equal":
      return exponential / 2 + Math.random() * (exponential / 2);
    case "full":
    default:
      return Math.floor(Math.random() * exponential);
  }
}

export interface RetryOptions extends BackoffOptions {
  /** Total attempts including the first. Default 4. */
  attempts?: number;
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export class RetryExhaustedError extends Error {
  constructor(readonly attempts: number, override readonly cause: unknown) {
    super(`Operation failed after ${attempts} attempts`);
    this.name = "RetryExhaustedError";
  }
}

/** Retry fn with exponential backoff + jitter; throws RetryExhaustedError. */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 4, shouldRetry = () => true, onRetry } = opts;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // shouldRetry=false → the caller decided this error is not retriable:
      // propagate the ORIGINAL error, not a wrapped one.
      if (!shouldRetry(err)) throw err;
      if (attempt >= attempts) break;
      const delayMs = backoffDelayMs(attempt, opts);
      onRetry?.({ attempt, delayMs, error: err });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new RetryExhaustedError(attempts, lastError);
}