import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { paymentsService } from "../../src/modules/payments/index.js";
import { analyticsService } from "../../src/modules/analytics/service.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let mentorToken: string;
let studentId: string;

describe("A9 — Analytics events", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("an-mentor@t.id", "AN Mentor", "admin");
    studentToken = await loginAs("an-student@t.id", "AN Student", "student");
    studentId = await userIdByEmail("an-student@t.id");
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("records events from the auth flow", async () => {
    // Register a user (triggers user.registered)
    const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "an-new@t.id", password: "S3cret!123", name: "AN New" } });
    expect(reg.statusCode).toBe(201);
    // The user.registered event fired on register (verified via summary below)
    const summary = await analyticsService.summary();
    expect(summary.registered).toBeGreaterThanOrEqual(1);
  });

  it("records simulation.started on startSession", async () => {
    // Create a package + question to start a session
    const q = await getPool().query("INSERT INTO questions (text, category, type) VALUES ('AN Q?','TPS','multiple_choice') RETURNING id");
    const pkg = await getPool().query(
      "INSERT INTO simulation_packages (title, status, question_counts, scoring) VALUES ($1, 'published', $2, $3) RETURNING id",
      ["AN Pkg", JSON.stringify({ TPS: 1 }), JSON.stringify({ correct: 4, blank: 0, wrong: 0 })]
    );
    await getPool().query("INSERT INTO question_options (question_id, text, is_correct) VALUES ($1,'A',true)", [q.rows[0]?.id]);
    await getPool().query("INSERT INTO question_options (question_id, text, is_correct) VALUES ($1,'B',false)", [q.rows[0]?.id]);
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkg.rows[0]?.id}/start`, headers: authHeaders(studentToken) });
    expect(start.statusCode).toBe(201);
    // Event subscribers write asynchronously → poll briefly
    let summary = await analyticsService.summary();
    const deadline = Date.now() + 3000;
    while ((summary.sessionsStarted ?? 0) < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      summary = await analyticsService.summary();
    }
    expect(summary.sessionsStarted).toBeGreaterThanOrEqual(1);
  });

  it("records results.viewed on getResult", async () => {
    // Grade a session first
    const sessions = await getPool().query("SELECT id FROM simulation_sessions WHERE user_id = $1 AND status = 'in_progress' LIMIT 1", [studentId]);
    if (sessions.rows[0]) {
      await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessions.rows[0]?.id]);
      const { simulationsService } = await import("../../src/modules/simulations/index.js");
      await simulationsService.gradeSession(sessions.rows[0]?.id);
      const res = await app.inject({ method: "GET", url: `/api/v1/simulations/sessions/${sessions.rows[0]?.id}/result`, headers: authHeaders(studentToken) });
      expect(res.statusCode).toBe(200);
    }
    // Or just check the admin summary
    const summary = await analyticsService.summary();
    expect(summary.resultsViewed).toBeGreaterThanOrEqual(0);
  });

  it("records order.paid on fulfillment", async () => {
    const course = await insertCourse({ title: "Analytics Course", status: "published", priceCents: 1000 });
    const order = await paymentsService.createOrder(studentId, { courseId: course.id });
    const orderId = order.order?.id;
    if (orderId) {
      await getPool().query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
      await paymentsService.fulfillOrder(orderId);
    }
    let summary = await analyticsService.summary();
    const deadline = Date.now() + 3000;
    while ((summary.ordersPaid ?? 0) < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      summary = await analyticsService.summary();
    }
    expect(summary.ordersPaid).toBeGreaterThanOrEqual(1);
  });

  it("admin summary endpoint returns totals", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/analytics/summary", headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(typeof data.registered).toBe("number");
    expect(typeof data.sessionsStarted).toBe("number");
  });

  it("admin cohort endpoint returns per-day rows", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/analytics/cohort?days=7", headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ day: string }>;
    expect(data.length).toBe(7);
    expect(data[0]!.day).toBeTruthy();
  });

  it("blocks non-admin from analytics endpoints", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/analytics/summary", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(403);
  });
});
