import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { jwtVerify, SignJWT } from "jose";
import { getEnv } from "../../config/index.js";
import { getRedis } from "../../shared/redis/client.js";
import { getLogger } from "../../shared/logger.js";
import { chatService } from "./service.js";
import type { DegradationManager } from "../../shared/redis/degradation.js";
import { accessCookieName } from "../../shared/auth/index.js";

const log = getLogger();

// Bound at module registration (app.degradation) so gateway code can check gates
let degradation: DegradationManager | null = null;
export function bindGatewayDegradation(mgr: DegradationManager): void {
  degradation = mgr;
}
const textEncoder = new TextEncoder();

const PRESENCE_TTL = 90; // seconds
const SEND_LIMIT = 30; // messages per minute per user
const SEND_WINDOW = 60_000;

// ── Tickets (short-lived WS auth) ────────────────────────────────────
export async function signWsTicket(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, type: "ws-ticket" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(textEncoder.encode(getEnv().JWT_ACCESS_SECRET));
}

async function verifyWsTicket(ticket: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(ticket, textEncoder.encode(getEnv().JWT_ACCESS_SECRET), { algorithms: ["HS256"] });
    if (payload.type !== "ws-ticket" || typeof payload.sub !== "string") return null;
    return payload.sub;
  } catch {
    return null;
  }
}

// ── Per-instance registries ───────────────────────────────────────────
interface Connection {
  socket: WebSocket;
  userId: string;
  userName: string;
  roles: string[];
  rooms: Set<string>;
}

const connections = new Map<WebSocket, Connection>();
const roomSockets = new Map<string, Set<WebSocket>>();

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function deliverToRoom(roomId: string, payload: unknown, except?: WebSocket): void {
  const sockets = roomSockets.get(roomId);
  if (!sockets) return;
  for (const socket of sockets) {
    if (socket !== except && socket.readyState === 1) socket.send(JSON.stringify(payload));
  }
}

// ── Redis pub/sub fan-out (with degraded fallback) ────────────────────
let subscriber: ReturnType<typeof getRedis> | null = null;

function roomChannel(roomId: string): string {
  return "chat:room:" + roomId;
}

export function ensureSubscriber(): void {
  if (subscriber) return;
  const redis = getRedis();
  subscriber = redis.duplicate();
  subscriber.on("message", (channel: string, data: string) => {
    // Deliver cross-instance messages to local sockets
    if (channel.startsWith("chat:room:")) {
      const roomId = channel.slice("chat:room:".length);
      try {
        const payload = JSON.parse(data) as { event: string; data: unknown };
        deliverToRoom(roomId, payload.data);
      } catch (err) {
        log.warn({ err }, "bad pub/sub payload");
      }
    }
  });
}

function publish(roomId: string, event: string, data: unknown): void {
  const payload = JSON.stringify({ event, data });
  // Local delivery first (always works)
  deliverToRoom(roomId, data);
  // Cross-instance via Redis when healthy; degraded → local-only
  if (degradation?.canUseRedis("presence") ?? true) {
    try {
      void getRedis().publish(roomChannel(roomId), payload);
    } catch (err) {
      log.warn({ err }, "pub/sub publish failed (local-only delivery)");
    }
  }
}

// ── Presence ──────────────────────────────────────────────────────────
async function setOnline(userId: string, online: boolean): Promise<void> {
  try {
    if (online) {
      await getRedis().set("chat:presence:" + userId, "1", "EX", PRESENCE_TTL);
    } else {
      await getRedis().del("chat:presence:" + userId);
    }
  } catch {
    /* degraded: presence best-effort */
  }
}

// ── Send rate limiting (Redis, memory fallback) ───────────────────────
const memoryBuckets = new Map<string, { count: number; resetsAt: number }>();

async function allowSend(userId: string): Promise<boolean> {
  const key = "chat:send:" + userId;
  try {
    const count = await getRedis().incr(key);
    if (count === 1) await getRedis().pexpire(key, SEND_WINDOW);
    return count <= SEND_LIMIT;
  } catch {
    const now = Date.now();
    const bucket = memoryBuckets.get(userId);
    if (!bucket || bucket.resetsAt <= now) {
      memoryBuckets.set(userId, { count: 1, resetsAt: now + SEND_WINDOW });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= SEND_LIMIT;
  }
}

// ── Message handlers ──────────────────────────────────────────────────
async function handleJoin(conn: Connection, roomId: string): Promise<void> {
  try {
    const room = await chatService.getRoom(roomId);
    await chatService.assertMember({ id: conn.userId, roles: conn.roles }, room);
    conn.rooms.add(roomId);
    let sockets = roomSockets.get(roomId);
    if (!sockets) {
      sockets = new Set();
      roomSockets.set(roomId, sockets);
    }
    sockets.add(conn.socket);
    sendJson(conn.socket, { type: "joined", roomId });
  } catch (err) {
    sendJson(conn.socket, { type: "error", code: "JOIN_FAILED", message: err instanceof Error ? err.message : "join failed" });
  }
}

async function handleLeave(conn: Connection, roomId: string): Promise<void> {
  conn.rooms.delete(roomId);
  const sockets = roomSockets.get(roomId);
  sockets?.delete(conn.socket);
  if (sockets?.size === 0) roomSockets.delete(roomId);
  sendJson(conn.socket, { type: "left", roomId });
}

async function handleMessage(conn: Connection, roomId: string, body: string): Promise<void> {
  if (typeof body !== "string" || body.trim().length === 0) {
    sendJson(conn.socket, { type: "error", code: "EMPTY_MESSAGE", message: "message body required" });
    return;
  }
  if (body.length > 2000) {
    sendJson(conn.socket, { type: "error", code: "MESSAGE_TOO_LONG", message: "max 2000 chars" });
    return;
  }
  if (!(await allowSend(conn.userId))) {
    sendJson(conn.socket, { type: "error", code: "TOO_MANY_REQUESTS", message: "slow down" });
    return;
  }
  try {
    const room = await chatService.getRoom(roomId);
    await chatService.assertMember({ id: conn.userId, roles: conn.roles }, room);
    const message = await chatService.persistMessage({ roomId, senderId: conn.userId, senderName: conn.userName, body: body.trim() });
    sendJson(conn.socket, { type: "ack", messageId: message._id, seq: message.seq });
    publish(roomId, "message", { type: "message", message: { id: message._id, roomId, senderId: message.senderId, senderName: message.senderName, body: message.body, seq: message.seq, createdAt: message.createdAt } });
  } catch (err) {
    sendJson(conn.socket, { type: "error", code: "SEND_FAILED", message: err instanceof Error ? err.message : "send failed" });
  }
}

async function handleTyping(conn: Connection, roomId: string, isTyping: boolean): Promise<void> {
  publish(roomId, "typing", { type: "typing", roomId, userId: conn.userId, isTyping });
}

// ── Connection lifecycle ──────────────────────────────────────────────
export async function handleWsConnection(socket: WebSocket, request: FastifyRequest): Promise<void> {
  // Auth: cookie access token OR short-lived ws ticket
  let userId: string | null = null;
  let roles: string[] = [];
  const cookie = request.cookies?.[accessCookieName()];
  if (cookie) {
    try {
      const { jwtVerify: verify } = await import("jose");
      const { payload } = await verify(cookie, textEncoder.encode(getEnv().JWT_ACCESS_SECRET), { algorithms: ["HS256"] });
      userId = typeof payload.sub === "string" ? payload.sub : null;
      roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
    } catch {
      userId = null;
    }
  }
  if (!userId) {
    const url = new URL(request.url, "http://localhost");
    const ticket = url.searchParams.get("ticket");
    if (ticket) {
      const ticketUserId = await verifyWsTicket(ticket);
      if (ticketUserId) userId = ticketUserId;
    }
  }
  if (!userId) {
    socket.close(4001, "unauthorized");
    return;
  }

  // Load user name + roles for ticket-authed connections (DB lookups)
  let userName = "user";
  try {
    const [{ usersService }, { getUserClaims }] = await Promise.all([
      import("../users/index.js"),
      import("../auth/index.js"),
    ]);
    const profile = await usersService.getProfile(userId);
    userName = profile.name ?? profile.email;
    if (roles.length === 0) {
      const claims = await getUserClaims(userId);
      roles = claims.roles;
    }
  } catch {
    /* keep fallbacks */
  }

  const conn: Connection = { socket, userId, userName, roles, rooms: new Set() };
  connections.set(socket, conn);
  await setOnline(userId, true);

  socket.on("message", (raw: unknown) => {
    let msg: { type?: string; roomId?: string; body?: string; isTyping?: boolean } = {};
    try {
      msg = JSON.parse((raw as Buffer).toString()) as typeof msg;
    } catch {
      sendJson(socket, { type: "error", code: "BAD_JSON", message: "invalid JSON" });
      return;
    }
    switch (msg.type) {
      case "join":
        if (msg.roomId) void handleJoin(conn, msg.roomId);
        break;
      case "leave":
        if (msg.roomId) void handleLeave(conn, msg.roomId);
        break;
      case "message":
        if (msg.roomId) void handleMessage(conn, msg.roomId, msg.body ?? "");
        break;
      case "typing":
        if (msg.roomId) void handleTyping(conn, msg.roomId, msg.isTyping === true);
        break;
      case "ping":
        sendJson(socket, { type: "pong" });
        break;
      default:
        sendJson(socket, { type: "error", code: "UNKNOWN_EVENT", message: "unknown event type" });
    }
  });

  socket.on("close", () => {
    connections.delete(socket);
    for (const roomId of conn.rooms) {
      const sockets = roomSockets.get(roomId);
      sockets?.delete(socket);
      if (sockets?.size === 0) roomSockets.delete(roomId);
    }
    void setOnline(userId!, false);
  });

  // Heartbeat: keep presence TTL refreshed
  const heartbeat = setInterval(() => {
    if (socket.readyState === 1) void setOnline(userId!, true);
  }, 30_000);
  heartbeat.unref?.();
  socket.on("close", () => clearInterval(heartbeat));

  sendJson(socket, { type: "welcome", userId });
}