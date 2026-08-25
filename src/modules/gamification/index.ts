import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { gamificationService } from "./service.js";

export async function gamificationModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  app.get("/api/v1/users/me/points", { preHandler: [authGuard] }, async (request, reply) => {
    const result = await gamificationService.points(getUser(request).id);
    return reply.ok(result);
  });

  app.get("/api/v1/users/me/badges", { preHandler: [authGuard] }, async (request, reply) => {
    const result = await gamificationService.allBadges(getUser(request).id);
    return reply.ok(result);
  });

  // Admin: create badge definitions
  app.post("/api/v1/admin/badges", {
    preHandler: [authGuard, requirePermission(Permissions.QUESTION_MANAGE)],
    schema: { body: { type: "object", required: ["code", "name", "pointsRequired"], properties: { code: { type: "string" }, name: { type: "string" }, description: { type: "string" }, pointsRequired: { type: "integer" } } } }
  }, async (request, reply) => {
    const body = request.body as { code: string; name: string; description?: string; pointsRequired: number };
    const badge = await gamificationService.createBadge(body);
    return reply.created(badge);
  });
}
