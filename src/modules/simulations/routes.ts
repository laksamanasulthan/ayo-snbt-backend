import type { FastifyInstance } from "fastify";
import { authGuard, optionalAuth, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { simulationsService } from "./service.js";

export async function simulationsModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);
  const manageGuard = [authGuard, requirePermission(Permissions.SIMULATION_MANAGE)];

  // ── Packages (public read, admin/mentor CRUD) ────────────────────────
  app.get("/api/v1/simulations/packages", async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown };
    const limit = Number(q.limit ?? 20);
    const result = await simulationsService.listPackages({ cursor: q.cursor, limit });
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit: result.limit } });
  });

  app.get("/api/v1/simulations/packages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const pkg = await simulationsService.getPackage(id);
    return reply.ok(pkg);
  });

  app.post("/api/v1/simulations/packages", {
    preHandler: manageGuard,
    schema: {
      body: { type: "object", required: ["title"], properties: { title: { type: "string" }, durationMinutes: { type: "integer" }, description: { type: "string" }, questionCounts: { type: "object" }, scoring: { type: "object" } } }
    }
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const pkg = await simulationsService.createPackage(getUser(request).id, body as unknown as Parameters<typeof simulationsService.createPackage>[1]);
    return reply.created(pkg);
  });

  app.patch("/api/v1/simulations/packages/:id", { preHandler: manageGuard }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const pkg = await simulationsService.updatePackage(id, body);
    return reply.ok(pkg);
  });

  app.post("/api/v1/simulations/packages/:id/publish", { preHandler: manageGuard }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pkg = await simulationsService.updatePackage(id, { status: "published" });
    return reply.ok({ published: pkg.status === "published" });
  });

  app.delete("/api/v1/simulations/packages/:id", { preHandler: manageGuard }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await simulationsService.removePackage(getUser(request), id);
    return reply.ok(result);
  });

  app.post("/api/v1/simulations/packages/:id/restore", { preHandler: manageGuard }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await simulationsService.restorePackage(getUser(request), id);
    return reply.ok(result);
  });

  // ── Sessions (student) ───────────────────────────────────────────────
  app.post("/api/v1/simulations/:packageId/start", {
    preHandler: [authGuard],
    config: { rateLimit: { max: 10, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const { packageId } = request.params as { packageId: string };
    const result = await simulationsService.startSession(getUser(request).id, packageId);
    return reply.created(result);
  });

  app.get("/api/v1/simulations/sessions", { preHandler: [authGuard] }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown };
    const limit = Number(q.limit ?? 20);
    const result = await simulationsService.listMySessions(getUser(request).id, q.cursor, limit);
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit: result.limit } });
  });

  app.get("/api/v1/simulations/sessions/:id", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await simulationsService.getSession(getUser(request).id, id);
    return reply.ok(session);
  });

  app.post("/api/v1/simulations/sessions/:id/answers", {
    preHandler: [authGuard],
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["questionId", "selectedOptionId"], properties: { questionId: { type: "string" }, selectedOptionId: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { questionId, selectedOptionId } = request.body as { questionId: string; selectedOptionId: string };
    const result = await simulationsService.saveAnswer(getUser(request).id, id, questionId, selectedOptionId);
    return reply.ok(result);
  });

  app.post("/api/v1/simulations/sessions/:id/submit", {
    preHandler: [authGuard],
    config: { rateLimit: { max: 5, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await simulationsService.submitSession(getUser(request).id, id);
    return reply.accepted(result);
  });

  app.get("/api/v1/simulations/sessions/:id/result", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await simulationsService.getResult(getUser(request).id, id);
    return reply.ok(result);
  });

  // ── Leaderboard ──────────────────────────────────────────────────────
  app.get("/api/v1/simulations/leaderboard", { preHandler: [optionalAuth] }, async (request, reply) => {
    const q = (request.query ?? {}) as { packageId: string; limit?: unknown };
    const limit = Number(q.limit ?? 20);
    const rows = await simulationsService.getLeaderboard(q.packageId, limit);
    return reply.ok(rows);
  });
}