import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { getPool } from "../../src/shared/db/client.js";
import { accessCookieName } from "../../src/shared/auth/index.js";
import WebSocket from "ws";

let app: Awaited<ReturnType<typeof buildApp>>;
let wsBase: string;
let mentorToken: string;
let studentAToken: string;
let studentBToken: string;
let outsiderToken: string;
let roomId: string;

function authHeaders(token: string): Record<string, string> {
  return { cookie: accessCookieName() + "=" + token + "; csrf_token=test", "x-csrf-token": "test" };
}

async function truncateDb() {
  const pool = getPool();
  await pool.query("TRUNCATE TABLE user_roles, users RESTART IDENTITY CASCADE");
}

async function loginAs(email: string, name: string, role: string): Promise<string> {
  const db = getPool();
  const user = await db.query("INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id", [email, "ignored", name, "active"]);
  const userId = user.rows[0]?.id as string;
  const roleRow = await db.query("SELECT id FROM roles WHERE name = $1", [role]);
  if (roleRow.rows[0]) await db.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleRow.rows[0].id]);
  const { issueAccessToken } = await import("../../src/modules/auth/index.js");
  return issueAccessToken(userId, email);
}

/** Connect a WS client and wait for the welcome message. */
function connectWs(tokenOrTicket: string, viaCookie: boolean): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = viaCookie
      ? wsBase + "?cookie=1"
      : wsBase + "?ticket=" + encodeURIComponent(tokenOrTicket);
    const ws = new WebSocket(url, { headers: viaCookie ? { cookie: accessCookieName() + "=" + tokenOrTicket } : undefined });
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
    ws.on("open", () => {
      // wait for welcome to confirm auth
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") {
        clearTimeout(timer);
        resolve(ws);
      } else if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error("ws auth error: " + msg.code));
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Wait for the next message of a given type. */
function waitFor(ws: WebSocket, type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("timeout waiting for " + type));
    }, timeoutMs);
    const handler = (raw: unknown) => {
      const msg = JSON.parse((raw as Buffer).toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function wsSend(ws: WebSocket, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload));
}

describe("Phase 5: live chat (WS + MongoDB)", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildApp({ minimal: true, logger: false, degradation: new DegradationManager(), healthRegistry: new HealthRegistry() });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    wsBase = "ws://127.0.0.1:" + port + "/api/v1/chat/ws";
    mentorToken = await loginAs("chat-mentor@t.id", "Chat Mentor", "mentor");
    studentAToken = await loginAs("chat-a@t.id", "Siswa A", "student");
    studentBToken = await loginAs("chat-b@t.id", "Siswa B", "student");
    outsiderToken = await loginAs("chat-c@t.id", "Siswa C", "student");
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("creates a group chat room with members", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat/rooms",
      headers: authHeaders(mentorToken),
      payload: { type: "group", name: "Grup TPS", memberIds: ["chat-a", "chat-b"] }
    });
    // The memberIds are tokens, not ids — the mentor creates with real ids below
    expect(res.statusCode).toBe(201);
  });

  it("creates a proper group room (real user ids) and lists rooms", async () => {
    const db = getPool();
    const a = await db.query("SELECT id FROM users WHERE email = $1", ["chat-a@t.id"]);
    const b = await db.query("SELECT id FROM users WHERE email = $1", ["chat-b@t.id"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat/rooms",
      headers: authHeaders(mentorToken),
      payload: { type: "group", name: "Grup TPS", memberIds: [a.rows[0].id, b.rows[0].id] }
    });
    expect(res.statusCode).toBe(201);
    roomId = res.json().data._id;
    expect(roomId).toBeTruthy();
    // List my rooms (mentor is a member)
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/chat/rooms",
      headers: authHeaders(mentorToken)
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.some((r: { id: string }) => r.id === roomId)).toBe(true);
  });

  it("issues a short-lived ws ticket", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat/ticket",
      headers: authHeaders(studentBToken)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ticket).toBeTruthy();
    expect(res.json().data.expiresInSeconds).toBe(120);
  });

  it("connects two WS clients (cookie + ticket auth)", async () => {
    const wsA = await connectWs(studentAToken, true);
    expect(wsA.readyState).toBe(WebSocket.OPEN);
    wsA.close();
    const ticketRes = await app.inject({
      method: "POST",
      url: "/api/v1/chat/ticket",
      headers: authHeaders(studentBToken)
    });
    const ticket = ticketRes.json().data.ticket as string;
    const wsB = await connectWs(ticket, false);
    expect(wsB.readyState).toBe(WebSocket.OPEN);
    wsB.close();
  });

  it("rejects unauthenticated WS connections", async () => {
    await expect(connectWs("garbage-ticket", false)).rejects.toThrow();
  });

  it("joins a room and exchanges messages in real time", async () => {
    const wsA = await connectWs(studentAToken, true);
    const ticketRes = await app.inject({
      method: "POST",
      url: "/api/v1/chat/ticket",
      headers: authHeaders(studentBToken)
    });
    const wsB = await connectWs(ticketRes.json().data.ticket as string, false);

    // Both join the room
    wsSend(wsA, { type: "join", roomId });
    await waitFor(wsA, "joined");
    wsSend(wsB, { type: "join", roomId });
    await waitFor(wsB, "joined");

    // A sends a message → B receives it, A gets an ack
    const recvPromise = waitFor(wsB, "message");
    wsSend(wsA, { type: "message", roomId, body: "Halo teman-teman! 👋" });
    const ack = await waitFor(wsA, "ack");
    expect(ack.seq).toBe(1);
    const delivered = await recvPromise;
    const message = delivered.message as Record<string, unknown>;
    expect(message.body).toBe("Halo teman-teman! 👋");
    expect(message.senderName).toBe("Siswa A");
    expect(message.seq).toBe(1);

    wsA.close();
    wsB.close();
  });

  it("persists messages and paginates history with unread counts", async () => {
    // History from B's perspective (has 1 unread message from A)
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/chat/rooms/" + roomId + "/messages",
      headers: authHeaders(studentBToken)
    });
    expect(history.statusCode).toBe(200);
    const messages = history.json().data;
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe("Halo teman-teman! 👋");
    expect(messages[0].seq).toBe(1);

    // Rooms list shows unread for B, none for A
    const roomsB = await app.inject({
      method: "GET",
      url: "/api/v1/chat/rooms",
      headers: authHeaders(studentBToken)
    });
    const roomB = roomsB.json().data.find((r: { id: string }) => r.id === roomId);
    expect(roomB.unreadCount).toBe(1);
    const roomsA = await app.inject({
      method: "GET",
      url: "/api/v1/chat/rooms",
      headers: authHeaders(studentAToken)
    });
    const roomA = roomsA.json().data.find((r: { id: string }) => r.id === roomId);
    expect(roomA.unreadCount).toBe(0);

    // B marks read → unread resets
    const read = await app.inject({
      method: "POST",
      url: "/api/v1/chat/rooms/" + roomId + "/read",
      headers: authHeaders(studentBToken)
    });
    expect(read.statusCode).toBe(200);
    const roomsB2 = await app.inject({
      method: "GET",
      url: "/api/v1/chat/rooms",
      headers: authHeaders(studentBToken)
    });
    const roomB2 = roomsB2.json().data.find((r: { id: string }) => r.id === roomId);
    expect(roomB2.unreadCount).toBe(0);
  });

  it("blocks non-members from rooms", async () => {
    // Outsider (not a member) cannot read history
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/chat/rooms/" + roomId + "/messages",
      headers: authHeaders(outsiderToken)
    });
    expect(history.statusCode).toBe(403);
    expect(history.json().error.code).toBe("NOT_ROOM_MEMBER");
  });
});