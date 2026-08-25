import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { getPool } from "../../src/shared/db/client.js";
import { accessCookieName } from "../../src/shared/auth/index.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let studentToken: string;
let courseId: string;
let orderId: string;

function authHeaders(token: string): Record<string, string> {
  return { cookie: accessCookieName() + "=" + token + "; csrf_token=test", "x-csrf-token": "test" };
}

async function truncateDb() {
  const pool = getPool();
  await pool.query("TRUNCATE TABLE course_enrollments, orders, payment_events, courses, user_roles, users RESTART IDENTITY CASCADE");
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

describe("Phase 6: payments (mock provider)", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildApp({ minimal: true, logger: false, degradation: new DegradationManager(), healthRegistry: new HealthRegistry() });
    await app.ready();
    studentToken = await loginAs("pay-student@t.id", "Pay Student", "student");
    // Create a published course with price
    const db = getPool();
    const course = await db.query("INSERT INTO courses (mentor_id, title, slug, status, price_cents) VALUES (NULL, $1, $2, $3, $4) RETURNING id", ["Kursus Berbayar", "kursus-berbayar-" + Date.now(), "published", 50000]);
    courseId = course.rows[0]?.id as string;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("rejects free course orders (enrolls directly)", async () => {
    const db = getPool();
    const free = await db.query("INSERT INTO courses (title, slug, status, price_cents) VALUES ($1, $2, $3, $4) RETURNING id", ["Kursus Gratis", "gratis-" + Date.now(), "published", 0]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: authHeaders(studentToken),
      payload: { courseId: free.rows[0].id }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.free).toBe(true);
    expect(res.json().data.enrolled).toBe(true);
  });

  it("creates a paid order with mock provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: authHeaders(studentToken),
      payload: { courseId }
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.free).toBe(false);
    expect(data.order.paymentUrl).toBeTruthy();
    expect(data.order.amountCents).toBe(50000);
    expect(data.order.status).toBe("pending");
    orderId = data.order.id;
  });

  it("lists orders for the student", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/payments/orders",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it("processes the mock paid webhook", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/mock/pay/" + (await app.inject({
        method: "GET",
        url: "/api/v1/payments/orders",
        headers: authHeaders(studentToken)
      })).json().data.find((o: { id: string }) => o.id === orderId).orderNumber
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.processed).toBe(true);
    // Order status now paid (fulfillment is async)
    const order = await app.inject({
      method: "GET",
      url: "/api/v1/payments/orders/" + orderId,
      headers: authHeaders(studentToken)
    });
    expect(order.json().data.status).toBe("paid");
  });

  it("fulfills the order (enrolls user + updates status)", async () => {
    const { processPaymentJob } = await import("../../src/modules/payments/index.js");
    await processPaymentJob({ type: "fulfill", orderId });
    const order = await app.inject({
      method: "GET",
      url: "/api/v1/payments/orders/" + orderId,
      headers: authHeaders(studentToken)
    });
    expect(order.json().data.status).toBe("fulfilled");
    // Check enrollment exists
    const db = getPool();
    const enroll = await db.query("SELECT id FROM course_enrollments WHERE user_id = (SELECT id FROM users WHERE email = $1) AND course_id = $2", ["pay-student@t.id", courseId]);
    expect(enroll.rows.length).toBe(1);
  });

  it("honors Idempotency-Key on order creation", async () => {
    const db = getPool();
    // Fresh paid course for a clean idempotency check
    const course = await db.query("INSERT INTO courses (title, slug, status, price_cents) VALUES ($1, $2, $3, $4) RETURNING id", ["Kursus Idem", "idem-" + Date.now(), "published", 25000]);
    const idemCourseId = course.rows[0]?.id as string;
    const key = "test-order-" + Date.now();
    const headers = { ...authHeaders(studentToken), "content-type": "application/json", "idempotency-key": key };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers,
      payload: { courseId: idemCourseId }
    });
    expect(first.statusCode).toBe(201);
    const firstOrderId = first.json().data.order.id;

    // Same key + same payload → replay, same order id, no new order created
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers,
      payload: { courseId: idemCourseId }
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.order.id).toBe(firstOrderId);

    // Same key + different payload → 409 IDEMPOTENCY_KEY_REUSED
    const misuse = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers,
      payload: { courseId: courseId } // different course!
    });
    expect(misuse.statusCode).toBe(409);
    expect(misuse.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("is idempotent — duplicate webhook does not re-process", async () => {
    const order = await app.inject({
      method: "GET",
      url: "/api/v1/payments/orders/" + orderId,
      headers: authHeaders(studentToken)
    });
    const orderNumber = order.json().data.orderNumber;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/mock/pay/" + orderNumber,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.processed).toBe(false); // already processed
  });
});