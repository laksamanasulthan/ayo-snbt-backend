import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { getPool } from "../../src/shared/db/client.js";
import { questionsService } from "../../src/modules/questions/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, ensureRedisConnected, clearRateLimitBuckets,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof buildApp>>;
let app: TestApp;
/** Rate limiting is registered only when !minimal — separate app for those tests. */
let rlApp: TestApp;
let mentorToken: string;
let studentToken: string;

describe("Resilience edge cases", () => {
  beforeAll(async () => {
    await truncateDb();
    await ensureRedisConnected();
    await clearRateLimitBuckets();
    app = await buildTestApp();
    rlApp = await buildApp({
      minimal: false,
      logger: false,
      degradation: new DegradationManager(),
      healthRegistry: new HealthRegistry(),
    });
    await rlApp.ready();
    mentorToken = await loginAs("res-mentor@t.id", "Res Mentor", "mentor");
    studentToken = await loginAs("res-student@t.id", "Res Student", "student");
  });

  afterAll(async () => {
    await app.close();
    await rlApp.close();
    await getPool().end();
  });

  // ── Envelope contract ────────────────────────────────────────────────
  it("returns standardized envelopes with requestId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.pagination.limit).toBeGreaterThan(0);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("echoes an incoming x-request-id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses", headers: { "x-request-id": "my-trace-123" } });
    expect(res.headers["x-request-id"]).toBe("my-trace-123");
  });

  it("returns NOT_FOUND envelopes for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/definitely/not/a/route" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBeTruthy();
  });

  it("returns VALIDATION_ERROR details for malformed bodies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses",
      headers: authHeaders(mentorToken),
      payload: { title: { not: "a string" } } // object cannot be coerced to string
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.issues.length).toBeGreaterThan(0);
    expect(body.error.requestId).toBeTruthy();
  });

  it("rejects non-uuid ids everywhere with 400 INVALID_ID (never 500)", async () => {
    const cases: { method: "GET" | "PATCH" | "DELETE"; url: string; headers: Record<string, string> }[] = [
      { method: "GET", url: "/api/v1/courses/not-a-uuid", headers: {} }, // optionalAuth
      { method: "PATCH", url: "/api/v1/questions/not-a-uuid", headers: authHeaders(mentorToken) },
      { method: "GET", url: "/api/v1/simulations/sessions/not-a-uuid", headers: authHeaders(studentToken) },
      { method: "GET", url: "/api/v1/payments/orders/not-a-uuid", headers: authHeaders(studentToken) },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: c.method, url: c.url, headers: c.headers });
      expect(res.statusCode, c.method + " " + c.url).toBe(400);
      expect(res.json().error.code, c.method + " " + c.url).toBe("INVALID_ID");
    }
  });

  // ── Health / readiness ───────────────────────────────────────────────
  it("exposes liveness and readiness endpoints", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().data.status).toBe("ok");
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data).toBeTruthy();
  });

  // ── Rate limiting (non-minimal app → real plugin + Redis store) ──────
  it("rate limits login (429 + Retry-After) and isolates routes", async () => {
    await ensureRedisConnected();
    await clearRateLimitBuckets();
    for (let i = 0; i < 5; i++) {
      const res = await rlApp.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "res-student@t.id", password: "wrong-" + i }
      });
      expect(res.statusCode, "attempt " + i).toBe(401);
    }
    const limited = await rlApp.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "res-student@t.id", password: "wrong-5" }
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("TOO_MANY_REQUESTS");
    expect(limited.headers["retry-after"]).toBeTruthy();
    // Route isolation: the courses catalog bucket is untouched
    const courses = await rlApp.inject({ method: "GET", url: "/api/v1/courses" });
    expect(courses.statusCode).toBe(200);
  });

  it("forgot-password has its own rate limit bucket", async () => {
    await clearRateLimitBuckets();
    for (let i = 0; i < 5; i++) {
      const res = await rlApp.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "x" + i + "@t.id" } });
      expect(res.statusCode).toBe(200);
    }
    const limited = await rlApp.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "y@t.id" } });
    expect(limited.statusCode).toBe(429);
    // And the login bucket is untouched (its own counter)
    const login = await rlApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "res-student@t.id", password: "whatever" } });
    expect(login.statusCode).toBe(401);
  });

  // ── Transaction rollback ─────────────────────────────────────────────
  it("rolls back the whole transaction when a step fails", async () => {
    const mentorId = (await getPool().query("SELECT id FROM users WHERE email = $1", ["res-mentor@t.id"])).rows[0]?.id;
    const { id: qId } = await insertQuestion({ text: "Before", category: "PK", createdBy: mentorId, options: [{ text: "A", isCorrect: true }] });
    // Update with a null option text → PG NOT NULL violation → tx must roll back
    await expect(
      questionsService.update({ id: mentorId, roles: ["mentor"] }, qId, {
        text: "After",
        options: [{ text: null as unknown as string, isCorrect: false }]
      })
    ).rejects.toBeTruthy();
    const row = await getPool().query("SELECT text FROM questions WHERE id = $1", [qId]);
    expect(row.rows[0]?.text).toBe("Before");
    const opts = await getPool().query("SELECT text FROM question_options WHERE question_id = $1", [qId]);
    expect(opts.rows.length).toBe(1);
    expect(opts.rows[0]?.text).toBe("A");
  });

  // ── Idempotency-Key edge cases ───────────────────────────────────────
  it("replays idempotent order creation and rejects over-long keys", async () => {
    await ensureRedisConnected();
    const db = getPool();
    const course = await db.query("INSERT INTO courses (title, slug, status, price_cents) VALUES ($1, $2, 'published', 1000) RETURNING id", ["Idem E", "idem-e-" + Date.now()]);
    const courseId = course.rows[0]?.id as string;
    const key = "resilience-key-" + Date.now();
    const headers = { ...authHeaders(studentToken), "content-type": "application/json", "idempotency-key": key };
    const res = await app.inject({ method: "POST", url: "/api/v1/payments/orders", headers, payload: { courseId } });
    expect(res.statusCode).toBe(201);
    const replay = await app.inject({ method: "POST", url: "/api/v1/payments/orders", headers, payload: { courseId } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.order.id).toBe(res.json().data.order.id);
    // Over-long key → 400
    const longKey = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: { ...authHeaders(studentToken), "idempotency-key": "k".repeat(200) },
      payload: { courseId }
    });
    expect(longKey.statusCode).toBe(400);
  });

  // ── CSRF on all mutating modules ─────────────────────────────────────
  it("csrf guard applies to payments module too", async () => {
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/payments/orders",
      headers: { cookie: "access_token=x" }, // no csrf
      payload: { courseId: "00000000-0000-0000-0000-000000000000" }
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("CSRF_TOKEN_MISMATCH");
  });

  // ── Concurrency: parallel enroll of the same free course ─────────────
  it("parallel enrolls of the same course converge to one enrollment", async () => {
    const db = getPool();
    const course = await db.query("INSERT INTO courses (title, slug, status, price_cents) VALUES ($1, $2, 'published', 0) RETURNING id", ["Concurrent", "conc-" + Date.now()]);
    const courseId = course.rows[0]?.id as string;
    const results = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/courses/" + courseId + "/enroll", headers: authHeaders(studentToken) }),
      app.inject({ method: "POST", url: "/api/v1/courses/" + courseId + "/enroll", headers: authHeaders(studentToken) }),
    ]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const count = await db.query("SELECT COUNT(*)::int AS c FROM course_enrollments WHERE course_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)", [courseId, "res-student@t.id"]);
    expect(count.rows[0]?.c).toBe(1);
  });
});
