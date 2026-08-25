import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { eventBus } from "../../src/shared/events/bus.js";
import { getQueue, QueueName } from "../../src/shared/queue/queues.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage, insertOrder, insertCourse,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let aliceToken: string;
let bobToken: string;
let aliceId: string;
let packageId: string;
let sessionId: string;
let courseId: string;
let orderId: string;

/** Poll until fn() is truthy or timeout (event handlers are async fire-and-forget). */
async function eventually(fn: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("M5 — Notifications", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    aliceToken = await loginAs("nt-alice@t.id", "Notif Alice", "student");
    bobToken = await loginAs("nt-bob@t.id", "Notif Bob", "student");
    aliceId = await userIdByEmail("nt-alice@t.id");
    await userIdByEmail("nt-bob@t.id");
    // Seed domain objects the events reference
    await insertQuestion({ text: "NQ?", category: "TPS", difficulty: "easy", options: [{ text: "A", isCorrect: true }] });
    packageId = await insertPackage({ title: "Notif Pkg", status: "published", questionCounts: { TPS: 1 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
    sessionId = crypto.randomUUID();
    courseId = (await insertCourse({ title: "Kursus Notifikasi" })).id;
    orderId = (await insertOrder({ userId: aliceId, courseId })).id;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("requires auth on every notification route", async () => {
    // GETs without any credentials → 401
    const g1 = await app.inject({ method: "GET", url: "/api/v1/notifications" });
    expect(g1.statusCode).toBe(401);
    const g2 = await app.inject({ method: "GET", url: "/api/v1/notifications/unread-count" });
    expect(g2.statusCode).toBe(401);
    // Mutations with valid CSRF but no access token → 401 (csrfGuard passes, authGuard rejects)
    const csrfOnly = { cookie: "csrf_token=test-csrf", "x-csrf-token": "test-csrf" };
    const p1 = await app.inject({ method: "POST", url: "/api/v1/notifications/read-all", headers: csrfOnly });
    expect(p1.statusCode).toBe(401);
    const p2 = await app.inject({ method: "POST", url: `/api/v1/notifications/${crypto.randomUUID()}/read`, headers: csrfOnly });
    expect(p2.statusCode).toBe(401);
  });

  it("creates a notification on simulation.graded for the session owner", async () => {
    eventBus.emit("simulation.graded", { sessionId, packageId, userId: aliceId });
    const ok = await eventually(async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: authHeaders(aliceToken) });
      return res.statusCode === 200 && (res.json().data as unknown[]).length >= 1;
    });
    expect(ok).toBe(true);
    const res = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: authHeaders(aliceToken) });
    const first = (res.json().data as Array<Record<string, unknown>>)[0];
    expect(first?.type).toBe("simulation.graded");
    expect(first?.title).toContain("tryout");
    expect((first?.payload as Record<string, unknown>)?.sessionId).toBe(sessionId);
    expect(first?.readAt).toBeNull();
  });

  it("tracks unread count per user", async () => {
    const a = await app.inject({ method: "GET", url: "/api/v1/notifications/unread-count", headers: authHeaders(aliceToken) });
    expect(a.json().data.count).toBeGreaterThanOrEqual(1);
    // Bob has nothing
    const b = await app.inject({ method: "GET", url: "/api/v1/notifications/unread-count", headers: authHeaders(bobToken) });
    expect(b.json().data.count).toBe(0);
  });

  it("fan-outs course.published to every active user with the course title", async () => {
    eventBus.emit("course.published", { courseId });
    const ok = await eventually(async () => {
      const a = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: authHeaders(aliceToken) });
      const b = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: authHeaders(bobToken) });
      const rowsA = a.json().data as Array<Record<string, unknown>>;
      const rowsB = b.json().data as Array<Record<string, unknown>>;
      return rowsA.some((r) => r.type === "course.published") && rowsB.some((r) => r.type === "course.published");
    });
    expect(ok).toBe(true);
    const a = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: authHeaders(bobToken) });
    const row = (a.json().data as Array<Record<string, unknown>>).find((r) => r.type === "course.published");
    expect((row?.title as string).includes("Kursus Notifikasi")).toBe(true);
  });

  it("creates a notification on order.fulfilled for the buyer and queues the email job", async () => {
    eventBus.emit("order.fulfilled", { orderId, userId: aliceId, courseId });
    const ok = await eventually(async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: authHeaders(aliceToken) });
      return (res.json().data as Array<Record<string, unknown>>).some((r) => r.type === "order.fulfilled");
    });
    expect(ok).toBe(true);
    // Reserved notification queue received the email job
    const queue = getQueue(QueueName.Notification);
    const counts = await eventually(async () => {
      const c = await queue.getJobCounts("waiting", "delayed");
      return (c.waiting ?? 0) + (c.delayed ?? 0) >= 1;
    });
    expect(counts).toBe(true);
    await queue.close();
  });

  it("marks a notification read (idempotent) and updates unread-count", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: authHeaders(aliceToken) });
    const rows = list.json().data as Array<{ id: string; readAt: string | null }>;
    const target = rows.find((r) => r.readAt === null);
    expect(target).toBeTruthy();
    const r1 = await app.inject({ method: "POST", url: `/api/v1/notifications/${target!.id}/read`, headers: authHeaders(aliceToken) });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.read).toBe(true);
    // Idempotent: second read also 200
    const r2 = await app.inject({ method: "POST", url: `/api/v1/notifications/${target!.id}/read`, headers: authHeaders(aliceToken) });
    expect(r2.statusCode).toBe(200);
    const count = await app.inject({ method: "GET", url: "/api/v1/notifications/unread-count", headers: authHeaders(aliceToken) });
    const unread = count.json().data.count as number;
    expect(unread).toBeLessThan(rows.length);
    // unread=true filter hides read rows
    const unreadOnly = await app.inject({ method: "GET", url: "/api/v1/notifications?unread=true", headers: authHeaders(aliceToken) });
    expect((unreadOnly.json().data as unknown[]).every((r) => (r as { readAt: string | null }).readAt === null)).toBe(true);
  });

  it("hides other users' notifications (404 on foreign id)", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: authHeaders(aliceToken) });
    const aliceNotifId = (list.json().data as Array<{ id: string }>)[0]!.id;
    const res = await app.inject({ method: "POST", url: `/api/v1/notifications/${aliceNotifId}/read`, headers: authHeaders(bobToken) });
    expect(res.statusCode).toBe(404);
  });

  it("marks all read and paginates with cursor", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/notifications/read-all", headers: authHeaders(aliceToken) });
    expect(res.statusCode).toBe(200);
    const count = await app.inject({ method: "GET", url: "/api/v1/notifications/unread-count", headers: authHeaders(aliceToken) });
    expect(count.json().data.count).toBe(0);
    // Pagination: limit=1 yields nextCursor; second page continues
    const p1 = await app.inject({ method: "GET", url: "/api/v1/notifications?limit=1", headers: authHeaders(aliceToken) });
    expect(p1.statusCode).toBe(200);
    const meta = p1.json().meta as { pagination: { nextCursor: string | null } };
    expect(meta.pagination.nextCursor).toBeTruthy();
    const p2 = await app.inject({ method: "GET", url: `/api/v1/notifications?limit=1&cursor=${meta.pagination.nextCursor}`, headers: authHeaders(aliceToken) });
    expect(p2.statusCode).toBe(200);
    const d1 = p1.json().data as Array<{ id: string }>;
    const d2 = p2.json().data as Array<{ id: string }>;
    expect(d2[0]!.id).not.toBe(d1[0]!.id);
    // Total > 1 → a nextCursor exists on page 2 or no more pages
  });
});

async function userIdByEmail(email: string): Promise<string> {
  const db = getPool();
  const rows = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  return rows.rows[0]?.id as string;
}
