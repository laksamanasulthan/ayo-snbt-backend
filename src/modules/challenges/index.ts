import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { challengesService } from "./service.js";

export async function challengesModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  // N1: question of the day (answer flows through practice endpoints)
  app.get("/api/v1/challenges/today", { preHandler: [authGuard] }, async (_request, reply) => {
    const result = await challengesService.getToday();
    return reply.ok(result);
  });

  // N1: streak (consecutive days with a practice answer)
  app.get("/api/v1/challenges/streak", { preHandler: [authGuard] }, async (request, reply) => {
    const streak = await challengesService.streak(getUser(request).id);
    return reply.ok({ streak });
  });

  // N1: admin pins today's question
  app.post("/api/v1/admin/challenges/today", {
    preHandler: [authGuard, requirePermission(Permissions.QUESTION_MANAGE)],
    schema: { body: { type: "object", required: ["questionId"], properties: { questionId: { type: "string" } } } }
  }, async (request, reply) => {
    const { questionId } = request.body as { questionId: string };
    const result = await challengesService.pinChallenge(getUser(request).id, new Date().toISOString().slice(0, 10), questionId);
    return reply.ok(result);
  });
}
