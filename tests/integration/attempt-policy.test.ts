import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage, insertSession,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let studentToken: string;
let student2Token: string;
let pkgLimit: string;    // maxAttempts=2
let pkgCooldown: string; // retakeCooldownMinutes=60
let pkgUnlimited: string; // null (default)

describe("M4 — Attempt policy", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("m4-mentor@t.id", "M4 Mentor", "mentor");
    studentToken = await loginAs("m4-student@t.id", "M4 Student", "student");
    student2Token = await loginAs("m4-student2@t.id", "M4 Student2", "student");
    // Seed a question so packages are non-empty
    await insertQuestion({ text: "M4 Q?", category: "TPS", difficulty: "easy", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    // Seed packages
    const headers = authHeaders(mentorToken);
    pkgLimit = (await app.inject({ method: "POST", url: "/api/v1/simulations/packages", headers, payload: { title: "Limited Pkg", questionCounts: { TPS: 1 }, maxAttempts: 2 } })).json().data.id;
    pkgCooldown = (await app.inject({ method: "POST", url: "/api/v1/simulations/packages", headers, payload: { title: "Cooldown Pkg", questionCounts: { TPS: 1 }, retakeCooldownMinutes: 60 } })).json().data.id;
    pkgUnlimited = (await app.inject({ method: "POST", url: "/api/v1/simulations/packages", headers, payload: { title: "Unlimited Pkg", questionCounts: { TPS: 1 } } })).json().data.id;
    // Publish all
    for (const id of [pkgLimit, pkgCooldown, pkgUnlimited]) {
      await app.inject({ method: "POST", url: `/api/v1/simulations/packages/${id}/publish`, headers });
    }
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("allows unlimited attempts when maxAttempts is null", async () => {
    const headers = authHeaders(studentToken);
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgUnlimited}/start`, headers });
      expect(res.statusCode).toBe(201);
    }
  });

  it("blocks starts when maxAttempts reached", async () => {
    const headers = authHeaders(student2Token);
    // Use 2 attempts (maxAttempts=2)
    const r1 = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgLimit}/start`, headers });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgLimit}/start`, headers });
    expect(r2.statusCode).toBe(201);
    // 3rd → 403
    const r3 = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgLimit}/start`, headers });
    expect(r3.statusCode).toBe(403);
    const body = r3.json();
    expect(body.success).toBe(false);
    const err = body.error;
    expect(err.code).toBe("ATTEMPT_LIMIT_REACHED");
    expect(err.details).toBeTruthy();
    expect(err.details.attemptsUsed).toBe(2);
    expect(err.details.maxAttempts).toBe(2);
    expect(err.details.retryAfter).toBeNull();
  });

  it("blocks start during cooldown with retryAfter timestamp", async () => {
    const headers = authHeaders(studentToken);
    // First start immediately
    const r1 = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgCooldown}/start`, headers });
    expect(r1.statusCode).toBe(201);
    // Second immediately → 403 with retryAfter in the future
    const r2 = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgCooldown}/start`, headers });
    expect(r2.statusCode).toBe(403);
    const body = r2.json();
    expect(body.error.code).toBe("ATTEMPT_LIMIT_REACHED");
    expect(body.error.details.retryAfter).toBeTruthy();
    const retryDate = new Date(body.error.details.retryAfter);
    expect(retryDate.getTime()).toBeGreaterThan(Date.now());
    expect(body.error.details.attemptsUsed).toBe(1);
    expect(body.error.details.maxAttempts).toBeNull(); // unlimited
  });

  it("allows start after cooldown expires", async () => {
    const headers = authHeaders(studentToken);
    // Fresh package with a 60-minute cooldown whose only attempt started 61 min ago
    const pkgId = await insertPackage({ title: "Expired Cooldown", status: "published", questionCounts: { TPS: 1 }, retakeCooldownMinutes: 60, scoring: { correct: 4, blank: 0, wrong: 0 } });
    const uid = (await getPool().query("SELECT id FROM users WHERE email = 'm4-student@t.id'")).rows[0].id as string;
    await insertSession({ userId: uid, packageId: pkgId, status: "graded", startedAt: new Date(Date.now() - 61 * 60_000).toISOString() });
    // Cooldown expired → start succeeds
    const r = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers });
    expect(r.statusCode).toBe(201);
  });

  it("returns attemptsUsed in list my sessions", async () => {
    const headers = authHeaders(studentToken);
    const res = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeInstanceOf(Array);
    // At least one session should have attemptsUsed > 0
    const attempts = body.data.map((s: Record<string, unknown>) => s.attemptsUsed);
    expect(attempts.some((a: number) => a > 0)).toBe(true);
  });

  it("practice sessions do not count toward simulation attempt limit", async () => {
    const headers = authHeaders(studentToken);
    // Create a package with maxAttempts=1
    const pkgId = await insertPackage({ title: "One Shot", status: "published", questionCounts: { TPS: 1 }, maxAttempts: 1, scoring: { correct: 4, blank: 0, wrong: 0 } });
    // Start a practice session first (should not count)
    const practiceRes = await app.inject({ method: "POST", url: "/api/v1/practice/start", headers, payload: { packageId: pkgId } });
    expect(practiceRes.statusCode).toBe(201);
    // Now simulation start should succeed (type=simulation not counted for practice)
    const simRes = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers });
    expect(simRes.statusCode).toBe(201);
    // Next simulation start → 403 (attemptsUsed=1)
    const blocked = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers });
    expect(blocked.statusCode).toBe(403);
    const body = blocked.json();
    expect(body.error.details.attemptsUsed).toBe(1);
  });

  it("rejects package creation with invalid maxAttempts (0 or negative)", async () => {
    const headers = authHeaders(mentorToken);
    const r1 = await app.inject({ method: "POST", url: "/api/v1/simulations/packages", headers, payload: { title: "Bad Max", maxAttempts: 0, questionCounts: { TPS: 1 } } });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({ method: "POST", url: "/api/v1/simulations/packages", headers, payload: { title: "Bad Max2", maxAttempts: -1, questionCounts: { TPS: 1 } } });
    expect(r2.statusCode).toBe(400);
  });

  it("rejects package creation with invalid retakeCooldownMinutes (negative)", async () => {
    const headers = authHeaders(mentorToken);
    const r = await app.inject({ method: "POST", url: "/api/v1/simulations/packages", headers, payload: { title: "Bad Cooldown", retakeCooldownMinutes: -5, questionCounts: { TPS: 1 } } });
    expect(r.statusCode).toBe(400);
  });
});
