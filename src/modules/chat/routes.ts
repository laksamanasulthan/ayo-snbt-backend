import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { authGuard, csrfGuard, getUser } from "../../shared/middleware/auth.js";
import { chatService } from "./service.js";
import { ensureChatIndexes } from "./mongo.js";
import { handleWsConnection, signWsTicket, bindGatewayDegradation, ensureSubscriber } from "./gateway.js";

export async function chatModule(app: FastifyInstance): Promise<void> {
  await ensureChatIndexes();
  bindGatewayDegradation(app.degradation);
  ensureSubscriber(); // Redis pub/sub listener for cross-instance delivery
  await app.register(websocket);
  await app.addHook("preHandler", csrfGuard);

  // ── Ticket (for WS auth when cookies aren't available) ───────────────
  app.post("/api/v1/chat/ticket", { preHandler: [authGuard] }, async (request, reply) => {
    const ticket = await signWsTicket(getUser(request).id);
    return reply.ok({ ticket, expiresInSeconds: 120 });
  });

  // ── WebSocket gateway ───────────────────────────────────────────────
  app.get("/api/v1/chat/ws", { websocket: true }, (socket, request) => {
    void handleWsConnection(socket, request);
  });

  // ── Rooms ───────────────────────────────────────────────────────────
  app.get("/api/v1/chat/rooms", { preHandler: [authGuard] }, async (request, reply) => {
    const rooms = await chatService.listMyRooms(getUser(request).id);
    return reply.ok(rooms);
  });

  app.post("/api/v1/chat/rooms", {
    preHandler: [authGuard],
    schema: {
      body: { type: "object", required: ["type"], properties: { type: { type: "string" }, name: { type: "string" }, courseId: { type: "string" }, mentorId: { type: "string" }, memberIds: { type: "array", items: { type: "string" } } } }
    }
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const user = getUser(request);
    const room = await chatService.createRoom({ id: user.id, name: user.email, roles: user.roles }, body as unknown as Parameters<typeof chatService.createRoom>[1]);
    return reply.created(room);
  });

  app.post("/api/v1/chat/rooms/:id/join", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const room = await chatService.getRoom(id);
    await chatService.assertMember(getUser(request), room);
    return reply.ok({ joined: true });
  });

  // ── Messages ─────────────────────────────────────────────────────────
  app.get("/api/v1/chat/rooms/:id/messages", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { before?: string; limit?: string };
    const before = q.before ? Number(q.before) : undefined;
    const limit = q.limit ? Number(q.limit) : 50;
    const room = await chatService.getRoom(id);
    await chatService.assertMember(getUser(request), room);
    const messages = await chatService.history(id, before, limit);
    return reply.ok(messages);
  });

  app.post("/api/v1/chat/rooms/:id/read", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await chatService.markRead(getUser(request).id, id);
    return reply.ok({ read: true });
  });
}