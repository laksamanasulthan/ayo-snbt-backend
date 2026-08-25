import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, getUser } from "../../shared/middleware/auth.js";
import { notificationsService } from "./service.js";

export async function notificationsModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  app.get("/api/v1/notifications", { preHandler: [authGuard] }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown; unread?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    const onlyUnread = q.unread === "true";
    const result = await notificationsService.list(getUser(request).id, q.cursor, limit, onlyUnread);
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit } });
  });

  app.get("/api/v1/notifications/unread-count", { preHandler: [authGuard] }, async (request, reply) => {
    const count = await notificationsService.unreadCount(getUser(request).id);
    return reply.ok({ count });
  });

  app.post("/api/v1/notifications/:id/read", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await notificationsService.markRead(getUser(request).id, id);
    return reply.ok(result);
  });

  app.post("/api/v1/notifications/read-all", { preHandler: [authGuard] }, async (request, reply) => {
    const result = await notificationsService.markAllRead(getUser(request).id);
    return reply.ok(result);
  });
}
