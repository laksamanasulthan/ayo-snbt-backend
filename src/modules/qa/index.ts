import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { qaService } from "./service.js";

export async function qaModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);
  const adminGuard = [authGuard, requirePermission(Permissions.QUESTION_MANAGE)];

  // Thread (public, no auth needed — questions are visible based on auth)
  // Using authGuard: any logged-in user can read threads
  app.get("/api/v1/questions/:id/thread", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await qaService.getThread(id);
    return reply.ok(result);
  });

  app.post("/api/v1/questions/:id/replies", {
    preHandler: [authGuard],
    schema: { body: { type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 4000 } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { body } = request.body as { body: string };
    const result = await qaService.addReply(getUser(request).id, id, body);
    return reply.created(result);
  });

  app.post("/api/v1/replies/:id/upvote", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await qaService.upvote(getUser(request).id, id);
    return reply.ok(result);
  });

  // Admin moderation
  app.post("/api/v1/admin/replies/:id/hide", { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await qaService.hideReply(getUser(request).id, id);
    return reply.ok(result);
  });
}
