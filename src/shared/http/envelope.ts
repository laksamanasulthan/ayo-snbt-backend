import type { FastifyReply } from "fastify";

/**
 * Standardized JSON envelope — every response in the API (success, error,
 * validation, 404, 500) uses this shape.
 *
 * Success: { success: true, data, meta }
 * Error:   { success: false, error: { code, message, details?, requestId } }
 */
export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
    pagination?: PaginationMeta;
  };
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
    requestId: string;
  };
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface ReplyMeta {
  pagination?: PaginationMeta;
}

/** Attach envelope helpers to FastifyReply: reply.ok(data, meta), etc. */
export function buildReplyHelpers(reply: FastifyReply) {
  const requestId = reply.request.id;

  const meta = (extra?: ReplyMeta): SuccessEnvelope<unknown>["meta"] => ({
    requestId,
    timestamp: new Date().toISOString(),
    ...(extra?.pagination ? { pagination: extra.pagination } : {})
  });

  return {
    ok<T>(data: T, opts?: ReplyMeta): FastifyReply {
      return reply.code(200).send({ success: true, data, meta: meta(opts) } satisfies SuccessEnvelope<T>);
    },
    created<T>(data: T, opts?: ReplyMeta): FastifyReply {
      return reply.code(201).send({ success: true, data, meta: meta(opts) } satisfies SuccessEnvelope<T>);
    },
    accepted<T>(data: T, opts?: ReplyMeta): FastifyReply {
      return reply.code(202).send({ success: true, data, meta: meta(opts) } satisfies SuccessEnvelope<T>);
    },
    noContent(): FastifyReply {
      return reply.code(204).send();
    },
    errorEnvelope: (body: ErrorEnvelope["error"]): FastifyReply => {
      return reply.code(body.statusCode).send({ success: false, error: body } satisfies ErrorEnvelope);
    }
  };
}
