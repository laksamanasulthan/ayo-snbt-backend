import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { isAppError, TooManyRequestsError } from "./errors.js";
import { buildReplyHelpers, type ErrorEnvelope } from "./envelope.js";
import { getLogger } from "../logger.js";

export interface EnvelopeErrorBody {
  code: string;
  message: string;
  statusCode: number;
  details?: unknown;
  requestId: string;
}

/**
 * Cross-cutting HTTP kernel:
 *  - requestId per request (echoed in envelope + X-Request-Id header + logs)
 *  - reply.ok/created/accepted/noContent helpers → standardized envelope
 *  - centralized error handler: AppError → envelope, validation → VALIDATION_ERROR,
 *    unknown → INTERNAL_ERROR (details never leaked in production)
 *  - not-found handler → NOT_FOUND envelope
 */
export const httpKernelPlugin = fp(async (app: FastifyInstance) => {
  // ── requestId ──────────────────────────────────────────────────────────
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const requestId = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    request.id = requestId;
    void reply.header("X-Request-Id", requestId);
  });

  // ── reply helpers ──────────────────────────────────────────────────────
  app.decorateReply("ok", function (this: FastifyReply, data: unknown, opts?: unknown) {
    return buildReplyHelpers(this).ok(data, opts as never);
  });
  app.decorateReply("created", function (this: FastifyReply, data: unknown, opts?: unknown) {
    return buildReplyHelpers(this).created(data, opts as never);
  });
  app.decorateReply("accepted", function (this: FastifyReply, data: unknown, opts?: unknown) {
    return buildReplyHelpers(this).accepted(data, opts as never);
  });
  app.decorateReply("noContent", function (this: FastifyReply) {
    return buildReplyHelpers(this).noContent();
  });

  // ── error handler ──────────────────────────────────────────────────────
  app.setErrorHandler(async (err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    // Fastify schema validation failures → VALIDATION_ERROR with field details
    if (typeof err === "object" && err !== null && "validation" in err && "validationContext" in err) {
      const validation = (err as { validation?: unknown; validationContext?: string }).validation ?? [];
      request.log.warn({ err, validation }, "request validation failed");
      return reply
        .code(400)
        .send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            statusCode: 400,
            details: { context: (err as { validationContext?: string }).validationContext, issues: validation },
            requestId
          }
        } satisfies ErrorEnvelope);
    }

    // Known application errors → their own code + status
    if (isAppError(err)) {
      if (err instanceof TooManyRequestsError && err.retryAfterSeconds !== undefined) {
        void reply.header("Retry-After", String(err.retryAfterSeconds));
      }
      request.log.warn({ err }, `app error: ${err.code}`);
      return reply.code(err.statusCode).send({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          statusCode: err.statusCode,
          ...(err.details !== undefined ? { details: err.details } : {}),
          requestId
        }
      } satisfies ErrorEnvelope);
    }

    // @fastify/rate-limit errors → 429 with Retry-After preserved
    if (typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 429) {
      const retryAfter = (err as { headers?: Record<string, string> }).headers?.["retry-after"];
      const body: ErrorEnvelope = {
        success: false,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: (err as Error).message || "Too many requests",
          statusCode: 429,
          requestId
        }
      };
      if (retryAfter) void reply.header("Retry-After", retryAfter);
      return reply.code(429).send(body);
    }

    // Unknown → INTERNAL_ERROR; never leak internals
    const internal = err instanceof Error ? err : new Error(String(err));
    request.log.error({ err: internal }, "unhandled error");
    getLogger().error({ err: internal, requestId }, "unhandled error (global)");
    return reply.code(500).send({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        statusCode: 500,
        requestId
      }
    } satisfies ErrorEnvelope);
  });

  // ── not-found handler ──────────────────────────────────────────────────
  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    const path = request.url;
    void reply.header("X-Request-Id", requestId);
    return reply.code(404).send({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: `Route not found: ${request.method} ${path}`,
        statusCode: 404,
        details: { path, method: request.method },
        requestId
      }
    } satisfies ErrorEnvelope);
  });
});

// Type augmentation so reply.ok etc. are typed everywhere
declare module "fastify" {
  interface FastifyReply {
    ok<T>(data: T, opts?: { pagination?: { page: number; perPage: number; total: number; totalPages: number } }): FastifyReply;
    created<T>(data: T, opts?: { pagination?: { page: number; perPage: number; total: number; totalPages: number } }): FastifyReply;
    accepted<T>(data: T, opts?: { pagination?: { page: number; perPage: number; total: number; totalPages: number } }): FastifyReply;
    noContent(): FastifyReply;
  }
}