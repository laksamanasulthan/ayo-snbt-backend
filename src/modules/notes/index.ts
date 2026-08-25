import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, getUser } from "../../shared/middleware/auth.js";
import { notesService } from "./service.js";

export async function notesModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  app.get("/api/v1/users/me/notes", { preHandler: [authGuard] }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown };
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    const result = await notesService.listMine(getUser(request).id, q.cursor, limit);
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit } });
  });

  app.get("/api/v1/questions/:id/note", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await notesService.get(getUser(request).id, id);
    return reply.ok(result);
  });

  app.put("/api/v1/questions/:id/note", {
    preHandler: [authGuard],
    schema: { body: { type: "object", required: ["body"], properties: { body: { type: "string", maxLength: 4000 } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { body } = request.body as { body: string };
    const result = await notesService.upsert(getUser(request).id, id, body);
    return reply.ok(result);
  });

  app.delete("/api/v1/questions/:id/note", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await notesService.remove(getUser(request).id, id);
    return reply.ok(result);
  });
}
