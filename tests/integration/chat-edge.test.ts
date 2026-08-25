import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { getPool } from "../../src/shared/db/client.js";
import { getRedis } from "../../src/shared/redis/client.js";
import { getChatDb } from "../../src/shared/mongo/client.js";
import { accessCookieName } from "../../src/shared/auth/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse, userIdByEmail, ensureRedisConnected,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let wsBase: string;
let mentorToken: string;
let studentAToken: string;
let outsiderToken: string;
let courseId: string;
let groupRoomId: string;

function connectWs(tokenOrTicket: string, viaCookie: boolean): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = viaCookie ? wsBase + "?cookie=1" : wsBase + "?ticket=" + encodeURIComponent(tokenOrTicket);
    const ws = new WebSocket(url, { headers: viaCookie ? { cookie: accessCookieName() + "=" + tokenOrTicket } : undefined });
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
    ws.on("open", () => {});
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") { clearTimeout(timer); resolve(ws); }
      else if (msg.type === "error") { clearTimeout(timer); reject(new Error("ws auth error: " + msg.code)); }
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitFor(ws: WebSocket, type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", handler); reject(new Error("timeout waiting for " + type)); }, timeoutMs);
    const handler = (raw: unknown) => {
      const msg = JSON.parse((raw as Buffer).toString());
      if (msg.type === type) { clearTimeout(timer); ws.off("message", handler); resolve(msg); }
    };
    ws.on("message", handler);
  });
}

function wsSend(ws: WebSocket, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload));
}

describe("Chat edge cases (WS + MongoDB)", () => {
  beforeAll(async () => {
    await truncateDb();
    // Wipe Mongo chat state from previous runs
    try { await getChatDb().dropDatabase(); } catch { /* mongo may be down */ }
    // Clear WS send-rate buckets from previous runs
    await ensureRedisConnected();
    const redis = getRedis();
    const sendKeys = await redis.keys("chat:send:*").catch(() => [] as string[]);
    if (sendKeys.length) await redis.del(...sendKeys);

    app = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    wsBase = "ws://127.0.0.1:" + port + "/api/v1/chat/ws";
    mentorToken = await loginAs("chat-e-mentor@t.id", "Mentor E", "mentor");
    studentAToken = await loginAs("chat-e-a@t.id", "Siswa A", "student");
    outsiderToken = await loginAs("chat-e-c@t.id", "Siswa C", "student");
    const course = await insertCourse({ title: "Chat Course", status: "published" });
    courseId = course.id;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  // ── Room creation edge cases ─────────────────────────────────────────
  it("rejects unknown room types", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat/rooms",
      headers: authHeaders(mentorToken),
      payload: { type: "hologram" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing courseId / mentorId for their types", async () => {
    const noCourse = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(mentorToken), payload: { type: "course" }
    });
    expect(noCourse.statusCode).toBe(400);
    const noMentor = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(mentorToken), payload: { type: "mentor" }
    });
    expect(noMentor.statusCode).toBe(400);
  });

  it("only mentors/admins can create course rooms", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(studentAToken),
      payload: { type: "course", courseId }
    });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(mentorToken),
      payload: { type: "course", courseId, name: "Diskusi Course" }
    });
    expect(ok.statusCode).toBe(201);
  });

  it("creating a course room twice returns the SAME room", async () => {
    const first = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(mentorToken),
      payload: { type: "course", courseId }
    });
    const second = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(mentorToken),
      payload: { type: "course", courseId }
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().data._id).toBe(first.json().data._id);
  });

  it("mentor rooms are deterministic 1:1 rooms", async () => {
    const mentorId = await userIdByEmail("chat-e-mentor@t.id");
    const a = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(studentAToken),
      payload: { type: "mentor", mentorId }
    });
    const b = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(studentAToken),
      payload: { type: "mentor", mentorId }
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().data._id).toBe(b.json().data._id);
  });

  it("group rooms dedupe member ids", async () => {
    const aId = await userIdByEmail("chat-e-a@t.id");
    const res = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(mentorToken),
      payload: { type: "group", name: "Grup A", memberIds: [aId, aId, aId] }
    });
    expect(res.statusCode).toBe(201);
    groupRoomId = res.json().data._id;
    expect(new Set(res.json().data.memberIds).size).toBe(2); // mentor + A
  });

  it("rejects history for unknown rooms", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/chat/rooms/no-such-room/messages", headers: authHeaders(studentAToken)
    });
    expect(res.statusCode).toBe(404);
  });

  it("markRead on an unknown room is 404", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms/no-such-room/read", headers: authHeaders(studentAToken)
    });
    expect(res.statusCode).toBe(404);
  });

  // ── WS protocol edge cases ───────────────────────────────────────────
  it("rejects bad JSON with BAD_JSON and keeps the connection alive", async () => {
    const ws = await connectWs(studentAToken, true);
    ws.send("{not json");
    const err = await waitFor(ws, "error");
    expect(err.code).toBe("BAD_JSON");
    // Connection still usable
    wsSend(ws, { type: "join", roomId: groupRoomId });
    const joined = await waitFor(ws, "joined");
    expect(joined.roomId).toBe(groupRoomId);
    ws.close();
  });

  it("rejects empty and oversized messages", async () => {
    const ws = await connectWs(studentAToken, true);
    wsSend(ws, { type: "join", roomId: groupRoomId });
    await waitFor(ws, "joined");
    // Empty body
    wsSend(ws, { type: "message", roomId: groupRoomId, body: "   " });
    const empty = await waitFor(ws, "error");
    expect(empty.code).toBe("EMPTY_MESSAGE");
    // Oversized body (2001 chars)
    wsSend(ws, { type: "message", roomId: groupRoomId, body: "x".repeat(2001) });
    const long = await waitFor(ws, "error");
    expect(long.code).toBe("MESSAGE_TOO_LONG");
    // Exactly 2000 chars is accepted
    wsSend(ws, { type: "message", roomId: groupRoomId, body: "y".repeat(2000) });
    const ack = await waitFor(ws, "ack");
    expect(ack.messageId).toBeTruthy();
    ws.close();
  });

  it("unknown event types get UNKNOWN_EVENT but keep the connection alive", async () => {
    const ws = await connectWs(studentAToken, true);
    wsSend(ws, { type: "teleport", to: "moon" });
    const err = await waitFor(ws, "error");
    expect(err.code).toBe("UNKNOWN_EVENT");
    // Still alive
    wsSend(ws, { type: "ping" });
    const pong = await waitFor(ws, "pong");
    expect(pong).toBeTruthy();
    ws.close();
  });

  it("join of a non-member room fails with JOIN_FAILED", async () => {
    const ws = await connectWs(outsiderToken, true);
    wsSend(ws, { type: "join", roomId: groupRoomId });
    const err = await waitFor(ws, "error");
    expect(err.code).toBe("JOIN_FAILED");
    ws.close();
  });

  it("sending to a room without membership fails with SEND_FAILED", async () => {
    const ws = await connectWs(outsiderToken, true);
    wsSend(ws, { type: "message", roomId: groupRoomId, body: "sneak" });
    const err = await waitFor(ws, "error");
    expect(err.code).toBe("SEND_FAILED");
    ws.close();
  });

  it("rate limits sends to 30/min (TOO_MANY_REQUESTS)", async () => {
    // Dedicated user for a clean bucket
    const spamToken = await loginAs("chat-e-spam@t.id", "Spammer", "student");
    const spamId = await userIdByEmail("chat-e-spam@t.id");
    const room = await app.inject({
      method: "POST", url: "/api/v1/chat/rooms", headers: authHeaders(mentorToken),
      payload: { type: "group", name: "Spam Room", memberIds: [spamId] }
    });
    const roomId = room.json().data._id as string;
    const ws = await connectWs(spamToken, true);
    wsSend(ws, { type: "join", roomId });
    await waitFor(ws, "joined");
    let gotLimited = false;
    for (let i = 0; i < 35; i++) {
      wsSend(ws, { type: "message", roomId, body: "spam " + i });
    }
    // Collect responses until we see TOO_MANY_REQUESTS (or 5s timeout)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !gotLimited) {
      const msg = await waitFor(ws, "error", 1000).catch(() => null);
      if (msg?.code === "TOO_MANY_REQUESTS") gotLimited = true;
    }
    expect(gotLimited).toBe(true);
    ws.close();
  });

  it("paginates history with the before-seq cursor", async () => {
    // Send 5 messages to the group room from A
    const ws = await connectWs(studentAToken, true);
    wsSend(ws, { type: "join", roomId: groupRoomId });
    await waitFor(ws, "joined");
    for (let i = 0; i < 5; i++) {
      wsSend(ws, { type: "message", roomId: groupRoomId, body: "msg-" + i });
      await waitFor(ws, "ack");
    }
    ws.close();
    const history = await app.inject({
      method: "GET", url: "/api/v1/chat/rooms/" + groupRoomId + "/messages?limit=3", headers: authHeaders(studentAToken)
    });
    expect(history.statusCode).toBe(200);
    const page = history.json().data;
    expect(page.length).toBe(3);
    // Oldest 3 (desc seq then reversed) → seqs 1,2,3 for A's earlier messages + these 5...
    // Just assert descending-then-ascending order property: sorted ascending by seq
    const seqs = page.map((m: { seq: number }) => m.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    // Before-cursor page excludes newer messages
    const before = await app.inject({
      method: "GET", url: "/api/v1/chat/rooms/" + groupRoomId + "/messages?limit=50&before=" + page[0].seq,
      headers: authHeaders(studentAToken)
    });
    const older = before.json().data;
    expect(older.every((m: { seq: number }) => m.seq < page[0].seq)).toBe(true);
  });

  it("caps history limit at 100", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/chat/rooms/" + groupRoomId + "/messages?limit=5000", headers: authHeaders(studentAToken)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeLessThanOrEqual(100);
  });

  it("has a TTL index on chat_messages.createdAt (I1 retention)", async () => {
    const db = getChatDb();
    const indexes = await db.collection("chat_messages").indexes();
    const ttl = indexes.find((i: Record<string, unknown>) => {
      const key = i.key as Record<string, number> | undefined;
      return key?.createdAt === 1 && typeof i.expireAfterSeconds === "number";
    });
    expect(ttl).toBeTruthy();
    expect(ttl!.expireAfterSeconds).toBeGreaterThan(0);
  });
});
