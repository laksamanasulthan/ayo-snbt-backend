import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authGuard, csrfGuard, getUser } from "../../shared/middleware/auth.js";
import { ForbiddenError } from "../../shared/http/errors.js";
import { adminService } from "./service.js";
import { analyticsService } from "../analytics/service.js";
import { tagAccuracyStats } from "../questions/stats.js";

/** Admin role gate (role claim, not permission — admin is a role). */
async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user?.roles.includes("admin")) throw new ForbiddenError("Admin access required");
}

export async function adminModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);
  const adminGuard = [authGuard, requireAdmin];

  // ── Dashboard stats ───────────────────────────────────────────────────
  app.get("/api/v1/admin/stats", { preHandler: adminGuard }, async (_request, reply) => {
    const stats = await adminService.getStats();
    return reply.ok(stats);
  });

  // ── A9: analytics (admin) ────────────────────────────────────────────
  app.get("/api/v1/admin/analytics/summary", { preHandler: adminGuard }, async (_request, reply) => {
    const summary = await analyticsService.summary();
    return reply.ok(summary);
  });

  app.get("/api/v1/admin/analytics/cohort", { preHandler: adminGuard }, async (request, reply) => {
    const q = request.query as { days?: unknown };
    const days = Math.min(Math.max(Number(q.days ?? 14), 1), 90);
    const cohort = await analyticsService.cohort(days);
    return reply.ok(cohort);
  });

  // ── A10: question quality (tag accuracy) ────────────────────────────
  app.get("/api/v1/admin/questions/stats/tag-accuracy", { preHandler: adminGuard }, async (_request, reply) => {
    const stats = await tagAccuracyStats();
    return reply.ok(stats);
  });

  // ── User management ───────────────────────────────────────────────────
  app.get("/api/v1/admin/users", {
    preHandler: adminGuard,
    schema: { querystring: { type: "object", properties: { cursor: { type: "string" }, limit: { type: "integer" }, q: { type: "string" } } } }
  }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown; q?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    const result = await adminService.listUsers({ cursor: q.cursor, limit, q: q.q });
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit } });
  });

  app.get("/api/v1/admin/users/:id", { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const summary = await adminService.getUserSummary(id);
    return reply.ok(summary);
  });

  app.patch("/api/v1/admin/users/:id/status", {
    preHandler: adminGuard,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["active", "suspended"] } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: string };
    const result = await adminService.setUserStatus(getUser(request).id, id, status);
    return reply.ok(result);
  });
}
