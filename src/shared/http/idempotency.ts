import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { getRedis } from "../redis/client.js";
import { getRequestContext } from "../context/request-context.js";
import { getLogger } from "../logger.js";

const log = getLogger();
const PREFIX = "asbt:idem";
const TTL_SECONDS = 86400; // 24h

const IDEMPOTENCY_HEADER = "idempotency-key";

interface StoredResponse {
  statusCode: number;
  body: string;
  requestBodyHash: string;
}

declare module "fastify" {
  interface FastifyRequest {
    idempotencyKey?: string;
  }
}

function bodyHash(body: unknown): string {
  return createHash("sha256").update(typeof body === "string" ? body : JSON.stringify(body ?? {})).digest("hex");
}

function isMutating(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/**
 * Client-side idempotency: when a mutating request carries an
 * Idempotency-Key header, the first response is stored (Redis, 24h TTL)
 * and identical retries receive the stored response instead of
 * re-executing the handler. A reused key with a DIFFERENT payload
 * returns 409 IDEMPOTENCY_KEY_REUSED.
 *
 * Degradation: if Redis is unreachable the request is processed normally
 * (idempotency is best-effort, never a hard dependency).
 */
export const idempotencyPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  // preHandler (not onRequest): the request body must be parsed before we
  // can hash it — replay detection compares the stored body hash.
  app.addHook("preHandler", async (request, reply) => {
    const header = request.headers[IDEMPOTENCY_HEADER];
    if (!isMutating(request.method) || typeof header !== "string" || header.length === 0) return;
    if (header.length > 128) {
      void reply.code(400).send({ success: false, error: { code: "BAD_REQUEST", message: "Idempotency-Key too long (max 128 chars)", statusCode: 400, requestId: request.id } });
      return;
    }
    // Namespace by actor (or IP for unauthenticated) to prevent cross-user reuse
    const ctx = getRequestContext();
    const namespace = ctx?.actorId ?? ctx?.ip ?? "anon";
    request.idempotencyKey = PREFIX + ":" + namespace + ":" + header;
    try {
      const raw = await getRedis().get(request.idempotencyKey);
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredResponse;
      if (stored.requestBodyHash !== bodyHash(request.body)) {
        void reply.code(409).send({ success: false, error: { code: "IDEMPOTENCY_KEY_REUSED", message: "Idempotency-Key was already used with a different payload", statusCode: 409, requestId: request.id } });
        return;
      }
      // Replay the stored response; sending in preHandler stops the lifecycle
      void reply.code(stored.statusCode).type("application/json; charset=utf-8").send(stored.body);
    } catch (err) {
      // Redis degraded → process normally (best-effort idempotency)
      log.warn({ err }, "idempotency lookup failed — processing request normally");
      request.idempotencyKey = undefined;
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const key = request.idempotencyKey;
    if (!key) return;
    if (reply.statusCode >= 500) return; // never cache server errors
    try {
      const stored: StoredResponse = {
        statusCode: reply.statusCode,
        body: typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
        requestBodyHash: bodyHash(request.body)
      };
      await getRedis().set(key, JSON.stringify(stored), "EX", TTL_SECONDS);
    } catch (err) {
      log.warn({ err }, "idempotency store failed — response not cached");
    }
  });
});