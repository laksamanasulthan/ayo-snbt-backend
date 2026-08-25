import type { FastifyReply } from "fastify";

/**
 * Standardized JSON envelope — every response in the API (success, error,
 * validation, 404, 500) uses this shape.
 *
 * Success: { success: true, data, meta }
 * Error:   { success: false, error: { code, message, details?, requestId } }
 */
export interface PaginationMeta {
  /** Opaque cursor for the next page; null when no more rows. */
  nextCursor: string | null;
  limit: number;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
    pagination?: PaginationMeta;
    /** A7: leaderboard context (requester's rank within the filtered set). */
    leaderboard?: { personalRank: number | null };
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
  leaderboard?: { personalRank: number | null };
}

/** Attach envelope helpers to FastifyReply: reply.ok(data, meta), etc. */
export function buildReplyHelpers(reply: FastifyReply) {
  const requestId = reply.request.id;

  const meta = (extra?: ReplyMeta): SuccessEnvelope<unknown>["meta"] => ({
    requestId,
    timestamp: new Date().toISOString(),
    ...(extra?.pagination ? { pagination: extra.pagination } : {}),
    ...(extra?.leaderboard ? { leaderboard: extra.leaderboard } : {})
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