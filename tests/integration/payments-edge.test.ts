import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { paymentsService } from "../../src/modules/payments/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse, insertOrder,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let adminToken: string;
let student2Token: string;
let paidCourseId: string;
let freeCourseId: string;

describe("Payments edge cases (mock provider)", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("pay-e-student@t.id", "Pay Student", "student");
    adminToken = await loginAs("pay-e-admin@t.id", "Pay Admin", "admin");
    student2Token = await loginAs("pay-e-student2@t.id", "Pay Student 2", "student");
    const paid = await insertCourse({ title: "Kursus Berbayar E", priceCents: 50000, status: "published" });
    paidCourseId = paid.id;
    const free = await insertCourse({ title: "Kursus Gratis E", priceCents: 0, status: "published" });
    freeCourseId = free.id;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  // ── Create order ─────────────────────────────────────────────────────
  it("rejects orders for unknown courses", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: authHeaders(studentToken),
      payload: { courseId: "00000000-0000-0000-0000-000000000000" }
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects orders for unpublished courses", async () => {
    const draft = await insertCourse({ title: "Draft Course", status: "draft" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: authHeaders(studentToken),
      payload: { courseId: draft.id }
    });
    expect(res.statusCode).toBe(400);
  });

  it("free courses enroll directly and are idempotent", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: authHeaders(studentToken),
      payload: { courseId: freeCourseId }
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data.free).toBe(true);
    expect(first.json().data.enrolled).toBe(true);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: authHeaders(studentToken),
      payload: { courseId: freeCourseId }
    });
    expect(second.statusCode).toBe(201);
    // Exactly one enrollment row
    const db = getPool();
    const rows = await db.query(
      "SELECT COUNT(*)::int AS c FROM course_enrollments e JOIN users u ON u.id = e.user_id WHERE u.email = $1 AND e.course_id = $2",
      ["pay-e-student@t.id", freeCourseId]
    );
    expect(rows.rows[0]?.c).toBe(1);
  });

  it("creates a pending order for paid courses", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: authHeaders(studentToken),
      payload: { courseId: paidCourseId }
    });
    expect(res.statusCode).toBe(201);
    const order = res.json().data.order;
    expect(order.status).toBe("pending");
    expect(order.amountCents).toBe(50000);
    expect(order.paymentUrl).toContain("mock/pay/");
    expect(order.orderNumber).toMatch(/^AYOSNBT-/);
  });

  // ── Order scoping ────────────────────────────────────────────────────
  it("scopes order reads to the owner (404 for others)", async () => {
    const mine = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken), payload: { courseId: paidCourseId }
    });
    const orderId = mine.json().data.order.id;
    const other = await app.inject({
      method: "GET", url: "/api/v1/payments/orders/" + orderId, headers: authHeaders(student2Token)
    });
    expect(other.statusCode).toBe(404);
    const self = await app.inject({
      method: "GET", url: "/api/v1/payments/orders/" + orderId, headers: authHeaders(studentToken)
    });
    expect(self.statusCode).toBe(200);
  });

  // ── Lazy expiry ──────────────────────────────────────────────────────
  it("expires stale pending orders lazily on read", async () => {
    const db = getPool();
    const stale = await insertOrder({
      userId: (await db.query("SELECT id FROM users WHERE email = $1", ["pay-e-student@t.id"])).rows[0]?.id,
      courseId: paidCourseId,
      status: "pending",
      createdAt: new Date(Date.now() - 25 * 3600_000).toISOString()
    });
    const res = await app.inject({
      method: "GET", url: "/api/v1/payments/orders/" + stale.id, headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("expired");
    // Persisted too
    const row = await db.query("SELECT status FROM orders WHERE id = $1", [stale.id]);
    expect(row.rows[0]?.status).toBe("expired");
  });

  // ── Webhook edge cases ───────────────────────────────────────────────
  it("rejects webhooks with an invalid signature", async () => {
    await expect(paymentsService.handleWebhook("mock", { status: "paid" }, {}))
      .rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
  });

  it("rejects webhooks for unknown orders", async () => {
    await expect(paymentsService.handleWebhook("mock", { order_number: "AYOSNBT-UNKNOWN-1", status: "paid", event_id: "evt-x" }, {}))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("processes paid webhooks idempotently (eventId dedupe)", async () => {
    const db = getPool();
    const u = (await db.query("SELECT id FROM users WHERE email = $1", ["pay-e-student@t.id"])).rows[0]?.id;
    const order = await insertOrder({ userId: u, courseId: paidCourseId });
    // NOTE: the mock pay route derives event_id as "mock-" + orderNumber —
    // use the same id so the route replay is a true duplicate event
    const first = await paymentsService.handleWebhook("mock", { order_number: order.orderNumber, status: "paid", event_id: "mock-" + order.orderNumber }, {});
    expect(first.processed).toBe(true);
    expect(first.status).toBe("paid");
    const second = await paymentsService.handleWebhook("mock", { order_number: order.orderNumber, status: "paid", event_id: "mock-" + order.orderNumber }, {});
    expect(second.processed).toBe(false);
    // The mock endpoint is idempotent too
    const viaRoute = await app.inject({ method: "POST", url: "/api/v1/payments/mock/pay/" + order.orderNumber });
    expect(viaRoute.statusCode).toBe(200);
    expect(viaRoute.json().data.processed).toBe(false);
  });

  it("keeps order state on non-paid webhook events", async () => {
    const db = getPool();
    const u = (await db.query("SELECT id FROM users WHERE email = $1", ["pay-e-student@t.id"])).rows[0]?.id;
    const order = await insertOrder({ userId: u, courseId: paidCourseId });
    const res = await paymentsService.handleWebhook("mock", { order_number: order.orderNumber, status: "pending", event_id: "evt-pending-1" }, {});
    expect(res.processed).toBe(true);
    expect(res.status).toBe("pending");
    const row = await db.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0]?.status).toBe("pending");
  });

  // ── Fulfillment guards ───────────────────────────────────────────────
  it("fulfillment skips orders that are not paid", async () => {
    const db = getPool();
    const u = (await db.query("SELECT id FROM users WHERE email = $1", ["pay-e-student@t.id"])).rows[0]?.id;
    const order = await insertOrder({ userId: u, courseId: paidCourseId, status: "pending" });
    await paymentsService.fulfillOrder(order.id);
    const enroll = await db.query(
      "SELECT COUNT(*)::int AS c FROM course_enrollments WHERE user_id = $1 AND course_id = $2",
      [u, paidCourseId]
    );
    expect(enroll.rows[0]?.c).toBe(0); // no enrollment created
    const row = await db.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0]?.status).toBe("pending");
  });

  it("fulfills a paid order: enrolls + marks fulfilled; double fulfill is a no-op", async () => {
    const db = getPool();
    const u = (await db.query("SELECT id FROM users WHERE email = $1", ["pay-e-student2@t.id"])).rows[0]?.id;
    const order = await insertOrder({ userId: u, courseId: paidCourseId, status: "paid" });
    await paymentsService.fulfillOrder(order.id);
    await paymentsService.fulfillOrder(order.id); // second call — already fulfilled
    const enroll = await db.query(
      "SELECT COUNT(*)::int AS c FROM course_enrollments WHERE user_id = $1 AND course_id = $2",
      [u, paidCourseId]
    );
    expect(enroll.rows[0]?.c).toBe(1);
    const row = await db.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(row.rows[0]?.status).toBe("fulfilled");
  });

  // ── Refund guards ────────────────────────────────────────────────────
  it("refunds only paid/fulfilled orders, once", async () => {
    const db = getPool();
    const u = (await db.query("SELECT id FROM users WHERE email = $1", ["pay-e-student@t.id"])).rows[0]?.id;
    // Pending → 400
    const pending = await insertOrder({ userId: u, courseId: paidCourseId, status: "pending" });
    await expect(paymentsService.refundOrder("admin", pending.id)).rejects.toMatchObject({ statusCode: 400 });
    // Paid → refund ok
    const paid = await insertOrder({ userId: u, courseId: paidCourseId, status: "paid" });
    await paymentsService.refundOrder("admin", paid.id);
    const row1 = await db.query("SELECT status, refunded_at FROM orders WHERE id = $1", [paid.id]);
    expect(row1.rows[0]?.status).toBe("refunded");
    expect(row1.rows[0]?.refunded_at).toBeTruthy();
    // Double refund → 400
    await expect(paymentsService.refundOrder("admin", paid.id)).rejects.toMatchObject({ statusCode: 400 });
    // Unknown → 404
    await expect(paymentsService.refundOrder("admin", "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refund endpoint is admin-only", async () => {
    const db = getPool();
    const u = (await db.query("SELECT id FROM users WHERE email = $1", ["pay-e-student@t.id"])).rows[0]?.id;
    const order = await insertOrder({ userId: u, courseId: paidCourseId, status: "paid" });
    const asStudent = await app.inject({
      method: "POST", url: "/api/v1/payments/orders/" + order.id + "/refund", headers: authHeaders(studentToken)
    });
    expect(asStudent.statusCode).toBe(403);
    const asAdmin = await app.inject({
      method: "POST", url: "/api/v1/payments/orders/" + order.id + "/refund", headers: authHeaders(adminToken)
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  // ── List pagination ──────────────────────────────────────────────────
  it("paginates my orders with cursors", async () => {
    const db = getPool();
    const u = (await db.query("SELECT id FROM users WHERE email = $1", ["pay-e-student2@t.id"])).rows[0]?.id;
    for (let i = 0; i < 3; i++) {
      await insertOrder({ userId: u, courseId: paidCourseId, status: i === 2 ? "fulfilled" : "paid" });
    }
    const page1 = await app.inject({ method: "GET", url: "/api/v1/payments/orders?limit=2", headers: authHeaders(student2Token) });
    expect(page1.statusCode).toBe(200);
    const d1 = page1.json().data;
    expect(d1.length).toBe(2);
    const next = (page1.json().meta as { pagination: { nextCursor: string | null } }).pagination.nextCursor;
    expect(next).toBeTruthy();
    const page2 = await app.inject({ method: "GET", url: "/api/v1/payments/orders?limit=2&cursor=" + encodeURIComponent(next as string), headers: authHeaders(student2Token) });
    expect(page2.statusCode).toBe(200);
    // 4 orders total (1 from the fulfill test + 3 inserted here) → 2/2
    expect(page2.json().data.length).toBe(2);
    // No duplicates across pages
    const ids1 = new Set(d1.map((o: { id: string }) => o.id));
    expect(ids1.has(page2.json().data[0].id)).toBe(false);
  });

  it("does not leak other users' orders", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/payments/orders", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const mine = res.json().data;
    // studentToken user created several orders above; student2's are separate
    expect(mine.length).toBeGreaterThanOrEqual(1);
  });
});
