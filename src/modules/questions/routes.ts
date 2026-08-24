import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, requirePermission } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { questionsService } from "./service.js";

export async function questionsModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);
  const manageGuard = [authGuard, requirePermission(Permissions.QUESTION_MANAGE)];

  app.get("/api/v1/questions", {
    preHandler: manageGuard,
    schema: {
      querystring: { type: "object", properties: { page: { type: "integer", default: 1 }, perPage: { type: "integer", default: 20 }, category: { type: "string" } } }
    }
  }, async (request, reply) => {
    const q = (request.query ?? {}) as { page?: unknown; perPage?: unknown; category?: string };
    const page = Number(q.page ?? 1);
    const perPage = Number(q.perPage ?? 20);
    const category = q.category;
    const result = await questionsService.list({ page, perPage, category });
    return reply.ok(result.rows, { pagination: { page: result.page, perPage: result.perPage, total: result.total, totalPages: result.totalPages } });
  });

  app.post("/api/v1/questions", {
    preHandler: manageGuard,
    schema: {
      body: { type: "object", required: ["text"], properties: { text: { type: "string" }, type: { type: "string" }, explanation: { type: "string" }, difficulty: { type: "string" }, category: { type: "string" }, options: { type: "array", items: { type: "object", properties: { text: { type: "string" }, isCorrect: { type: "boolean" } } } } } }
    }
  }, async (request, reply) => {
    const body = request.body as Parameters<typeof questionsService.create>[1];
    const question = await questionsService.create(request.user!.id, body);
    return reply.created(question);
  });

  app.patch("/api/v1/questions/:id", {
    preHandler: manageGuard,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const question = await questionsService.update(id, body as never);
    return reply.ok(question);
  });

  app.delete("/api/v1/questions/:id", {
    preHandler: manageGuard,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await questionsService.remove(id);
    return reply.ok(result);
  });
}