import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { hashPassword } from "../../src/shared/auth/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertOrder, insertPackage, insertCourse,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let adminToken: string;
let mentorToken: string;
let adminId: string;
let studentId: string;
let susEmail: string;
let susPassword: string;

describe("M9 — Admin module", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    adminToken = await loginAs("ad-admin@t.id", "Ad Admin", "admin");
    mentorToken = await loginAs("ad-mentor@t.id", "Ad Mentor", "mentor");
    adminId = (await getPool().query("SELECT id FROM users WHERE email = 'ad-admin@t.id'")).rows[0]?.id as string;
    studentId = (await getPool().query("SELECT id FROM users WHERE email = 'ad-mentor@t.id'")).rows[0]?.id as string;
    // A real password user for the suspension login-flow test
    susEmail = "ad-sus@t.id";
    susPassword = "S3cure!Pass1";
    await getPool().query(
      "INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, 'active', NOW()) RETURNING id",
      [susEmail, await hashPassword(susPassword), "Sus User"]
    );
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("blocks non-admins from admin routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(403);
    const anon = await app.inject({ method: "GET", url: "/api/v1/admin/stats" });
    expect(anon.statusCode).toBe(401);
  });

  it("returns dashboard stats", async () => {
    // Seed a paid order so revenue is non-zero
    const c = await insertCourse({ title: "Stats Course", status: "published" });
    await insertOrder({ userId: adminId, courseId: c.id, status: "paid", amountCents: 250_000 });
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats", headers: authHeaders(adminToken) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(typeof data.users).toBe("number");
    expect(typeof data.courses).toBe("number");
    expect(typeof data.questions).toBe("number");
    expect(typeof data.simulationSessions).toBe("number");
    expect(data.orders).toBeGreaterThanOrEqual(1);
    expect(data.revenueCents).toBeGreaterThanOrEqual(250_000);
  });

  it("lists users with roles and searches by email", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/users?q=ad-admin", headers: authHeaders(adminToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ email: string; roles: string[] }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("ad-admin@t.id");
    expect(rows[0]!.roles).toContain("admin");
  });

  it("returns a user summary with orders and sessions", async () => {
    // Give the mentor a graded simulation session
    const pkgId = await insertPackage({ title: "Adm Pkg", status: "published", questionCounts: { TPS: 1 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
    await getPool().query(
      "INSERT INTO simulation_sessions (user_id, package_id, status, started_at, deadline_at, score, percentile, max_score) VALUES ($1, $2, 'graded', NOW(), NOW() + interval '1 hour', 4, 100, 4)",
      [studentId, pkgId]
    );
    const res = await app.inject({ method: "GET", url: `/api/v1/admin/users/${studentId}`, headers: authHeaders(adminToken) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.email).toBe("ad-mentor@t.id");
    expect(data.roles).toContain("mentor");
    expect(data.simulationSessions.count).toBeGreaterThanOrEqual(1);
    expect(data.simulationSessions.bestScore).toBe(4);
    expect(typeof data.orders.count).toBe("number");
  });

  it("suspends a user → login blocked with ACCOUNT_SUSPENDED; reactivation restores login", async () => {
    const login = (pw: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: susEmail, password: pw } });
    // Works while active
    const r1 = await login(susPassword);
    expect(r1.statusCode).toBe(200);
    // Suspend
    const uid = (await getPool().query("SELECT id FROM users WHERE email = $1", [susEmail])).rows[0]?.id as string;
    const susp = await app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${uid}/status`, headers: authHeaders(adminToken),
      payload: { status: "suspended" }
    });
    expect(susp.statusCode).toBe(200);
    expect(susp.json().data.changed).toBe(true);
    // Login now blocked (403 + code)
    const r2 = await login(susPassword);
    expect(r2.statusCode).toBe(403);
    expect(r2.json().error.code).toBe("ACCOUNT_SUSPENDED");
    // Idempotent suspend
    const susp2 = await app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${uid}/status`, headers: authHeaders(adminToken),
      payload: { status: "suspended" }
    });
    expect(susp2.json().data.changed).toBe(false);
    // Reactivate → login works again
    const act = await app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${uid}/status`, headers: authHeaders(adminToken),
      payload: { status: "active" }
    });
    expect(act.statusCode).toBe(200);
    const r3 = await login(susPassword);
    expect(r3.statusCode).toBe(200);
  });

  it("rejects invalid status values and self-suspension", async () => {
    const bad = await app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${studentId}/status`, headers: authHeaders(adminToken),
      payload: { status: "banned" }
    });
    expect(bad.statusCode).toBe(400);
    const self = await app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${adminId}/status`, headers: authHeaders(adminToken),
      payload: { status: "suspended" }
    });
    expect(self.statusCode).toBe(400);
  });

  it("unknown user → 404 on summary and status", async () => {
    const missing = crypto.randomUUID();
    const s1 = await app.inject({ method: "GET", url: `/api/v1/admin/users/${missing}`, headers: authHeaders(adminToken) });
    expect(s1.statusCode).toBe(404);
    const s2 = await app.inject({
      method: "PATCH", url: `/api/v1/admin/users/${missing}/status`, headers: authHeaders(adminToken),
      payload: { status: "suspended" }
    });
    expect(s2.statusCode).toBe(404);
  });
});
