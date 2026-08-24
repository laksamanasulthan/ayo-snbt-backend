/**
 * Central error taxonomy. Every error the API returns is an AppError
 * (or mapped to one) so the envelope is always consistent.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "TOKEN_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYMENT_REQUIRED"
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  | "RATE_LIMIT_REDIS_DEGRADED"
  | (string & {}); // allow domain-specific codes (e.g. "AUTH_INVALID_CREDENTIALS")

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown, expose = true) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", code: ErrorCode = "BAD_REQUEST", details?: unknown) {
    super(400, code, message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details?: unknown, message = "Validation failed") {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required", code: ErrorCode = "UNAUTHORIZED", details?: unknown) {
    super(401, code, message, details);
  }
}

export class TokenExpiredError extends AppError {
  constructor(message = "Token expired", details?: unknown) {
    super(401, "TOKEN_EXPIRED", message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions", code: ErrorCode = "FORBIDDEN", details?: unknown) {
    super(403, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details?: unknown) {
    super(404, "NOT_FOUND", message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict", code: ErrorCode = "CONFLICT", details?: unknown) {
    super(409, code, message, details);
  }
}

export class PaymentRequiredError extends AppError {
  constructor(message = "Payment required", details?: unknown) {
    super(402, "PAYMENT_REQUIRED", message, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests", details?: unknown, retryAfterSeconds?: number) {
    super(429, "TOO_MANY_REQUESTS", message, details);
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
  retryAfterSeconds?: number;
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable", code: ErrorCode = "SERVICE_UNAVAILABLE", details?: unknown) {
    super(503, code, message, details);
  }
}

export class InternalError extends AppError {
  constructor(message = "Internal server error", details?: unknown) {
    super(500, "INTERNAL_ERROR", message, details, false);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}