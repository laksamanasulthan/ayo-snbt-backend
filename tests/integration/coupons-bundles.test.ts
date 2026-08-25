import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { paymentsService } from "../../src/modules/payments/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let studentToken: string;
let courseA: string;
let courseB: string;
let bundleId: string;

describe("A8 — Coupons & bundles", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("cb-mentor@t.id", "CB Mentor", "mentor");
    studentToken = await loginAs("cb-student@t.id", "CB Student", "student");
    courseA = (await insertCourse({ title: "Kursus Mahal", status: "published", priceCents: 100_000 })).id;
    courseB = (await insertCourse({ title: "Kursus Kedua", status: "published", priceCents: 50_000 })).id;
    // Mentor creates a bundle [A, B] for 120_000
    const created = await app.inject({
      method: "POST", url: "/api/v1/payments/bundles", headers: authHeaders(mentorToken),
      payload: { title: "Bundle SNBT", priceCents: 120_000, courseIds: [courseA, courseB] }
    });
    expect(created.statusCode).toBe(201);
    bundleId = created.json().data.id as string;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("blocks students from managing coupons/bundles", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/payments/coupons", headers: authHeaders(studentToken),
      payload: { code: "HACK10", percentOff: 10 }
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates a coupon and applies it to an order", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/v1/payments/coupons", headers: authHeaders(mentorToken),
      payload: { code: " diskon10 ", percentOff: 10 }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.code).toBe("DISKON10"); // normalized uppercase
    const order = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { courseId: courseA, couponCode: "DISKON10" }
    });
    expect(order.statusCode).toBe(201);
    const data = order.json().data;
    expect(data.free).toBe(false);
    expect(data.order.amountCents).toBe(90_000); // 100k - 10%
    expect(data.order.courseId).toBe(courseA);
    expect((data.order.metadata as { couponCode: string }).couponCode).toBe("DISKON10");
  });

  it("rejects invalid, expired, exhausted and course-scoped coupons", async () => {
    const bad = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { courseId: courseA, couponCode: "NOPE" }
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("COUPON_INVALID");
    // Expired coupon
    await app.inject({
      method: "POST", url: "/api/v1/payments/coupons", headers: authHeaders(mentorToken),
      payload: { code: "OLD", percentOff: 5, expiresAt: new Date(Date.now() - 3600_000).toISOString() }
    });
    const expired = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { courseId: courseA, couponCode: "OLD" }
    });
    expect(expired.json().error.code).toBe("COUPON_EXPIRED");
    // Exhausted (maxUses 1, first use consumes it)
    await app.inject({
      method: "POST", url: "/api/v1/payments/coupons", headers: authHeaders(mentorToken),
      payload: { code: "ONCE", percentOff: 5, maxUses: 1 }
    });
    const first = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { courseId: courseA, couponCode: "ONCE" }
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { courseId: courseA, couponCode: "ONCE" }
    });
    expect(second.json().error.code).toBe("COUPON_EXHAUSTED");
    // Course-scoped coupon doesn't work on another course
    await app.inject({
      method: "POST", url: "/api/v1/payments/coupons", headers: authHeaders(mentorToken),
      payload: { code: "SCOPED", percentOff: 10, courseId: courseB }
    });
    const scoped = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { courseId: courseA, couponCode: "SCOPED" }
    });
    expect(scoped.json().error.code).toBe("COUPON_INVALID");
    const ok = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { courseId: courseB, couponCode: "SCOPED" }
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.order.amountCents).toBe(45_000);
  });

  it("creates a bundle order and fulfillment enrolls every course", async () => {
    // Publish the bundle
    const pub = await app.inject({
      method: "PATCH", url: `/api/v1/payments/bundles/${bundleId}`, headers: authHeaders(mentorToken),
      payload: { status: "published" }
    });
    expect(pub.statusCode).toBe(200);
    // Public listing shows it
    const list = await app.inject({ method: "GET", url: "/api/v1/payments/bundles" });
    const rows = list.json().data as Array<{ id: string; courseCount: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.courseCount).toBe(2);
    // Order by bundle
    const order = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { bundleId }
    });
    expect(order.statusCode).toBe(201);
    const data = order.json().data;
    expect(data.order.amountCents).toBe(120_000);
    expect(data.order.bundleId).toBe(bundleId);
    // Pay + fulfill (as the worker would)
    const uid = (await getPool().query("SELECT id FROM users WHERE email = 'cb-student@t.id'")).rows[0]?.id as string;
    await getPool().query("UPDATE orders SET status = 'paid' WHERE id = $1", [data.order.id]);
    await paymentsService.fulfillOrder(data.order.id);
    const enrolled = await getPool().query("SELECT course_id FROM course_enrollments WHERE user_id = $1", [uid]);
    const enrolledIds = enrolled.rows.map((r) => r.course_id);
    expect(enrolledIds).toContain(courseA);
    expect(enrolledIds).toContain(courseB);
  });

  it("publishes only through PATCH; drafts are invisible publicly", async () => {
    const draft = await app.inject({
      method: "POST", url: "/api/v1/payments/bundles", headers: authHeaders(mentorToken),
      payload: { title: "Draft Bundle", priceCents: 1_000, courseIds: [courseA] }
    });
    expect(draft.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: "/api/v1/payments/bundles" });
    expect((list.json().data as unknown[]).length).toBe(1);
    // Draft bundle order → 404
    const order = await app.inject({
      method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken),
      payload: { bundleId: draft.json().data.id }
    });
    expect(order.statusCode).toBe(404);
  });

  it("validates order body (one of courseId|bundleId) and coupon params", async () => {
    const none = await app.inject({ method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken), payload: {} });
    expect(none.statusCode).toBe(400);
    const both = await app.inject({ method: "POST", url: "/api/v1/payments/orders", headers: authHeaders(studentToken), payload: { courseId: courseA, bundleId } });
    expect(both.statusCode).toBe(400);
    const badPct = await app.inject({
      method: "POST", url: "/api/v1/payments/coupons", headers: authHeaders(mentorToken),
      payload: { code: "BADPCT", percentOff: 0 }
    });
    expect(badPct.statusCode).toBe(400);
    const badCode = await app.inject({
      method: "POST", url: "/api/v1/payments/coupons", headers: authHeaders(mentorToken),
      payload: { code: "!!", percentOff: 10 }
    });
    expect(badCode.statusCode).toBe(400);
  });
});
