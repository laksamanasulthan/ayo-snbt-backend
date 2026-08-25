import type { FastifyInstance } from "fastify";
import { authGuard, optionalAuth, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { pathsService } from "./service.js";

export async function pathsModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);
  const manageGuard = [authGuard, requirePermission(Permissions.COURSE_UPDATE)];

  // ── Public catalog ────────────────────────────────────────────────────
  app.get("/api/v1/paths", { preHandler: [optionalAuth] }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown };
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    const result = await pathsService.list({ cursor: q.cursor, limit });
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit } });
  });

  app.get("/api/v1/paths/:id", { preHandler: [optionalAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await pathsService.getById(id, request.user?.id);
    return reply.ok(result);
  });

  // ── Enrollment (any authed user) ──────────────────────────────────────
  app.post("/api/v1/paths/:id/enroll", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await pathsService.enroll(getUser(request).id, id);
    return reply.ok(result);
  });

  // ── Management (mentor/admin) ─────────────────────────────────────────
  app.post("/api/v1/paths", {
    preHandler: manageGuard,
    schema: { body: { type: "object", required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, courseIds: { type: "array", items: { type: "string" } } } } }
  }, async (request, reply) => {
    const body = request.body as { title: string; description?: string; courseIds?: string[]; status?: string };
    const result = await pathsService.create(getUser(request), body);
    return reply.created(result);
  });

  app.patch("/api/v1/paths/:id", {
    preHandler: manageGuard,
    schema: { body: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, courseIds: { type: "array", items: { type: "string" } } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; description?: string; courseIds?: string[]; status?: string };
    const result = await pathsService.update(getUser(request), id, body);
    return reply.ok(result);
  });
}
