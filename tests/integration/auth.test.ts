import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { getPool, getDirectPool } from "../../src/shared/db/client.js";
import { accessCookieName, refreshCookieName, csrfCookieName } from "../../src/shared/auth/index.js";

// Capture email jobs (raw verification/reset tokens) instead of sending
const enqueuedJobs: { name: string; payload: { to: string; template: string; data: Record<string, string> } }[] = [];
vi.mock("../../src/shared/queue/queues.js", () => ({
  QueueName: { Email: "email", Notification: "notification", Grading: "grading", Leaderboard: "leaderboard", Transcode: "transcode", Payment: "payment" },
  enqueue: async (_name: string, payload: unknown) => { enqueuedJobs.push({ name: "email", payload: payload as never }); return "mock-job-id"; },
  getQueue: () => ({ add: async () => ({ id: "mock" }) }),
  createWorker: () => ({ close: async () => {} })
}));

let app: Awaited<ReturnType<typeof buildApp>>;

async function truncateDb() {
  const pool = getPool();
  await pool.query("TRUNCATE TABLE refresh_tokens, email_verifications, password_resets, user_identities, user_roles, users RESTART IDENTITY CASCADE");
}

function cookieValue(setCookieHeader: string | string[] | undefined, name: string): string | null {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader.join(",") : setCookieHeader;
  if (!header) return null;
  const parts = header.split(",");
  for (const part of parts) {
    const [pair] = part.trim().split(";");
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return null;
}

describe("Auth integration (compose stack)", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildApp({
      minimal: true,
      logger: false,
      degradation: new DegradationManager(),
      healthRegistry: new HealthRegistry()
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("registers a user and emails a verification token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "student@test.id", password: "password123", name: "Student Satu" }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().success).toBe(true);
    expect(enqueuedJobs.length).toBeGreaterThan(0);
    expect(enqueuedJobs[0]!.payload.template).toBe("verify-email");
    expect(enqueuedJobs[0]!.payload.data.token).toBeTruthy();
  });

  it("rejects login before email verification", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "student@test.id", password: "password123" }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("verifies the email with the emailed token", async () => {
    const token = enqueuedJobs[0]!.payload.data.token;
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/verify-email?token=" + token });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.verified).toBe(true);
  });

  it("logs in and issues access + refresh + csrf cookies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "student@test.id", password: "password123" }
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const access = cookieValue(setCookie, accessCookieName());
    const refresh = cookieValue(setCookie, refreshCookieName());
    const csrf = cookieValue(setCookie, csrfCookieName());
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    expect(csrf).toBeTruthy();
    expect(res.json().data.user.roles).toContain("student");
    // store for later tests
    (globalThis as Record<string, unknown>).accessToken = access;
    (globalThis as Record<string, unknown>).refreshToken = refresh;
    (globalThis as Record<string, unknown>).csrfToken = csrf;
  });

  it("returns the current user via /users/me", async () => {
    const access = (globalThis as Record<string, unknown>).accessToken as string;
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { cookie: accessCookieName() + "=" + access }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.email).toBe("student@test.id");
  });

  it("rotates the refresh token on /auth/refresh", async () => {
    const oldRefresh = (globalThis as Record<string, unknown>).refreshToken as string;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + oldRefresh }
    });
    expect(res.statusCode).toBe(200);
    const newRefresh = cookieValue(res.headers["set-cookie"], refreshCookieName());
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(oldRefresh);
    // store the new one
    (globalThis as Record<string, unknown>).refreshToken = newRefresh;
    (globalThis as Record<string, unknown>).oldRefreshToken = oldRefresh;
  });

  it("detects refresh token reuse and revokes the whole family", async () => {
    const oldRefresh = (globalThis as Record<string, unknown>).oldRefreshToken as string;
    // Present the already-rotated (revoked) token again
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + oldRefresh }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TOKEN_REUSE_DETECTED");
    // The current (new) token of the same family must also be dead
    const current = (globalThis as Record<string, unknown>).refreshToken as string;
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + current }
    });
    expect(res2.statusCode).toBe(401);
  });

  it("logs out and revokes the session", async () => {
    // login again for a fresh session
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "student@test.id", password: "password123" }
    });
    const refresh = cookieValue(login.headers["set-cookie"], refreshCookieName());
    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: refreshCookieName() + "=" + refresh }
    });
    expect(logout.statusCode).toBe(200);
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + refresh }
    });
    expect(after.statusCode).toBe(401);
  });

  it("resets the password via emailed token", async () => {
    const forgot = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "student@test.id" }
    });
    expect(forgot.statusCode).toBe(200);
    const resetJob = enqueuedJobs[enqueuedJobs.length - 1];
    expect(resetJob!.payload.template).toBe("reset-password");
    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: resetJob!.payload.data.token, password: "new-password-123" }
    });
    expect(reset.statusCode).toBe(200);
    // old password fails, new works
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "student@test.id", password: "password123" }
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "student@test.id", password: "new-password-123" }
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("enforces RBAC: student cannot access IAM endpoints", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "student@test.id", password: "new-password-123" }
    });
    const access = cookieValue(login.headers["set-cookie"], accessCookieName());
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/iam/roles",
      headers: { cookie: accessCookieName() + "=" + access }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("grants admin access to IAM endpoints after role assignment", async () => {
    // Create an admin user directly + assign admin role
    const direct = getDirectPool();
    const roleRow = await direct.query("SELECT id FROM roles WHERE name = 'admin' LIMIT 1");
    const roleId = roleRow.rows[0]?.id as string;
    expect(roleId).toBeTruthy();
    const userRow = await direct.query("INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id", ["admin@test.id", "not-argon2-for-test", "Admin Satu", "active"]);
    const userId = userRow.rows[0]?.id as string;
    await direct.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleId]);
    // Sign a token with admin claims (claims come from DB roles)
    const { issueAccessToken } = await import("../../src/modules/auth/index.js");
    const token = await issueAccessToken(userId, "admin@test.id");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/iam/roles",
      headers: { cookie: accessCookieName() + "=" + token }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThanOrEqual(3);
    await direct.end();
  });
});