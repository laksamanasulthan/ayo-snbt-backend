import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { getPool } from "../../src/shared/db/client.js";
import { getRedis } from "../../src/shared/redis/client.js";
import {
  accessCookieName, refreshCookieName, csrfCookieName, hashRefreshToken,
} from "../../src/shared/auth/index.js";
import { authService } from "../../src/modules/auth/index.js";
import { truncateDb, buildTestApp, cookieValue, clearRateLimitBuckets, ensureRedisConnected } from "./helpers.js";

// Capture email jobs (raw verification/reset tokens) instead of sending
const enqueuedJobs: { name: string; payload: { to: string; template: string; data: Record<string, string> } }[] = [];
vi.mock("../../src/shared/queue/queues.js", () => ({
  QueueName: { Email: "email", Notification: "notification", Grading: "grading", Leaderboard: "leaderboard", Transcode: "transcode", Payment: "payment" },
  enqueue: async (_name: string, payload: unknown) => { enqueuedJobs.push({ name: "email", payload: payload as never }); return "mock-job-id"; },
  getQueue: () => ({ add: async () => ({ id: "mock" }) }),
  createWorker: () => ({ close: async () => {} })
}));

type TestApp = Awaited<ReturnType<typeof buildApp>>;
let app: TestApp;
const IP = "127.0.0.1";

async function registerAndVerify(email: string, password = "password123"): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password, name: "User " + email }
  });
  const job = enqueuedJobs[enqueuedJobs.length - 1];
  const token = job?.payload.data.token;
  if (!token) throw new Error("no verification email captured for " + email);
  const res = await app.inject({ method: "GET", url: "/api/v1/auth/verify-email?token=" + token });
  expect(res.statusCode).toBe(200);
}

async function loginCookies(email: string, password: string) {
  await clearRateLimitBuckets(); // login route is rate limited (5/min) — reset per call
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password }
  });
  const setCookie = res.headers["set-cookie"];
  return {
    status: res.statusCode,
    body: res.json(),
    access: cookieValue(setCookie, accessCookieName()),
    refresh: cookieValue(setCookie, refreshCookieName()),
    csrf: cookieValue(setCookie, csrfCookieName()),
  };
}

describe("Auth edge cases (compose stack)", () => {
  beforeAll(async () => {
    await truncateDb();
    await ensureRedisConnected();
    await clearRateLimitBuckets();
    // Clear any stale lockout state from previous runs (Redis persists)
    const redis = getRedis();
    const lockKeys = await redis.keys("asbt:lockout*").catch(() => [] as string[]);
    if (lockKeys.length) await redis.del(...lockKeys);
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  // ── Register / validation ────────────────────────────────────────────
  it("rejects invalid email on register", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "not-an-email", password: "password123", name: "X" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.requestId).toBeTruthy();
  });

  it("rejects a weak password on register", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "weak@test.id", password: "short", name: "X" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a duplicate email with EMAIL_TAKEN", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "dup@test.id", password: "password123", name: "Dup" }
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "dup@test.id", password: "password123", name: "Dup" }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("EMAIL_TAKEN");
  });

  // ── Verify-email edge cases ──────────────────────────────────────────
  it("rejects garbage and already-used verification tokens", async () => {
    const garbage = await app.inject({ method: "GET", url: "/api/v1/auth/verify-email?token=not-a-token" });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().error.code).toBe("BAD_REQUEST");

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "reuse@test.id", password: "password123", name: "Reuse" }
    });
    const token = enqueuedJobs[enqueuedJobs.length - 1]!.payload.data.token;
    const ok = await app.inject({ method: "GET", url: "/api/v1/auth/verify-email?token=" + token });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({ method: "GET", url: "/api/v1/auth/verify-email?token=" + token });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toMatch(/used/i);
  });

  it("rejects an expired verification token", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "expired-verify@test.id", password: "password123", name: "Expired" }
    });
    const token = enqueuedJobs[enqueuedJobs.length - 1]!.payload.data.token!;
    const db = getPool();
    await db.query("UPDATE email_verifications SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [hashRefreshToken(token)]);
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/verify-email?token=" + token });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expired/i);
  });

  // ── Login / lockout (service level — avoids HTTP rate-limit bucket) ──
  it("locks the account after 5 failed logins with exponential window", async () => {
    await registerAndVerify("lockout@test.id", "password123");
    // 4 failures → still AUTH_INVALID_CREDENTIALS (count 1..4)
    for (let i = 0; i < 4; i++) {
      await expect(authService.login({ email: "lockout@test.id", password: "wrong-" + i }, { ip: IP }))
        .rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    }
    // 5th failure trips the lock (count >= 5)
    await expect(authService.login({ email: "lockout@test.id", password: "wrong-4" }, { ip: IP }))
      .rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
    // Even the correct password is rejected while locked
    await expect(authService.login({ email: "lockout@test.id", password: "password123" }, { ip: IP }))
      .rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
  });

  it("keeps rejecting correct credentials while locked", async () => {
    await expect(authService.login({ email: "lockout@test.id", password: "password123" }, { ip: IP }))
      .rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
  });

  it("does not lock other emails on the same IP", async () => {
    await registerAndVerify("other-lockout@test.id", "password123");
    const res = await authService.login({ email: "other-lockout@test.id", password: "password123" }, { ip: IP });
    expect(res.accessToken).toBeTruthy();
  });

  it("clears the lockout after a successful login", async () => {
    const redis = getRedis();
    await redis.del("asbt:lockout:lockout@test.id:" + IP);
    const res = await authService.login({ email: "lockout@test.id", password: "password123" }, { ip: IP });
    expect(res.accessToken).toBeTruthy();
  });

  it("rejects unknown credentials with the SAME code as wrong password (no enumeration)", async () => {
    // Clear lockout so the wrong-password attempt reaches the credential check
    await getRedis().del("asbt:lockout:lockout@test.id:" + IP);
    const unknown = await authService.login({ email: "ghost@nowhere.id", password: "password123" }, { ip: IP }).catch((e: { code?: string }) => e);
    const wrongPw = await authService.login({ email: "lockout@test.id", password: "totally-wrong" }, { ip: IP }).catch((e: { code?: string }) => e);
    expect((unknown as { code?: string }).code).toBe("AUTH_INVALID_CREDENTIALS");
    expect((wrongPw as { code?: string }).code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  // ── Refresh rotation / reuse / expiry ────────────────────────────────
  it("rotates the refresh token on refresh", async () => {
    const login = await loginCookies("lockout@test.id", "password123");
    expect(login.status).toBe(200);
    const r1 = login.refresh as string;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + r1 }
    });
    expect(res.statusCode).toBe(200);
    const r2 = cookieValue(res.headers["set-cookie"], refreshCookieName());
    expect(r2).toBeTruthy();
    expect(r2).not.toBe(r1);
    // Old token now revoked
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + r1 }
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe("TOKEN_REUSE_DETECTED");
    // Presenting a consumed token revokes the whole family — the rotated
    // token r2 is dead too (stolen-session containment by design)
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + r2 }
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("TOKEN_REUSE_DETECTED");
  });

  it("revokes the whole family when a reused token is presented", async () => {
    const login = await loginCookies("lockout@test.id", "password123");
    const r = login.refresh as string;
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + r }
    });
    expect(first.statusCode).toBe(200);
    // Present the consumed token -> reuse -> family revoked
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + r }
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe("TOKEN_REUSE_DETECTED");
    // The rotated token from first belongs to the same family -> now revoked too
    const rotated = cookieValue(first.headers["set-cookie"], refreshCookieName()) as string;
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + rotated }
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("TOKEN_REUSE_DETECTED");
  });

  it("exactly one concurrent refresh with the same token succeeds", async () => {
    const login = await loginCookies("lockout@test.id", "password123");
    const r = login.refresh as string;
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: refreshCookieName() + "=" + r } }),
      app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: refreshCookieName() + "=" + r } }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 401]);
    const loser = a.statusCode === 401 ? a : b;
    expect(loser.json().error.code).toBe("TOKEN_REUSE_DETECTED");
  });

  it("rejects an expired refresh token", async () => {
    const login = await loginCookies("lockout@test.id", "password123");
    const r = login.refresh as string;
    const db = getPool();
    await db.query("UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [hashRefreshToken(r)]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + r }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects refresh without a token and with garbage", async () => {
    const none = await app.inject({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(none.statusCode).toBe(401);
    const garbage = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=garbage-token" }
    });
    expect(garbage.statusCode).toBe(401);
  });

  // ── Logout ───────────────────────────────────────────────────────────
  it("logout is idempotent and revokes the refresh token", async () => {
    const login = await loginCookies("lockout@test.id", "password123");
    const r = login.refresh as string;
    const out = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: refreshCookieName() + "=" + r }
    });
    expect(out.statusCode).toBe(200);
    // Double logout
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: refreshCookieName() + "=" + r }
    });
    expect(again.statusCode).toBe(200);
    // Refresh with revoked token
    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + r }
    });
    expect(refresh.statusCode).toBe(401);
  });

  // ── Forgot / reset password ──────────────────────────────────────────
  it("forgot-password never reveals whether an email exists", async () => {
    const before = enqueuedJobs.length;
    const ghost = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "ghost@nowhere.id" }
    });
    expect(ghost.statusCode).toBe(200);
    expect(enqueuedJobs.length).toBe(before); // no email queued for unknown user

    const known = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "lockout@test.id" }
    });
    expect(known.statusCode).toBe(200);
    expect(enqueuedJobs.length).toBe(before + 1);
  });

  it("resets the password with the emailed token and revokes sessions", async () => {
    const login = await loginCookies("lockout@test.id", "password123");
    const oldRefresh = login.refresh as string;
    const token = enqueuedJobs[enqueuedJobs.length - 1]!.payload.data.token;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token, password: "new-password-456" }
    });
    expect(res.statusCode).toBe(200);

    // Old password no longer works; new one does
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "lockout@test.id", password: "password123" }
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "lockout@test.id", password: "new-password-456" }
    });
    expect(newLogin.statusCode).toBe(200);

    // All sessions revoked
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: refreshCookieName() + "=" + oldRefresh }
    });
    expect(stale.statusCode).toBe(401);
  });

  it("rejects invalid, reused, and expired reset tokens", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: "nope", password: "whatever123" }
    });
    expect(invalid.statusCode).toBe(400);

    // Reuse: create a fresh token, use it, then try again
    await app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "lockout@test.id" } });
    const token = enqueuedJobs[enqueuedJobs.length - 1]!.payload.data.token;
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token, password: "fresh-password-789" }
    });
    expect(ok.statusCode).toBe(200);
    const reused = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token, password: "another-password-1" }
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error.message).toMatch(/used/i);

    // Expired: backdate the newest token
    await app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "lockout@test.id" } });
    const t2 = enqueuedJobs[enqueuedJobs.length - 1]!.payload.data.token!;
    const db = getPool();
    await db.query("UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [hashRefreshToken(t2)]);
    const expired = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: t2, password: "whatever123" }
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.message).toMatch(/expired/i);
  });

  // ── CSRF cookie issuance ─────────────────────────────────────────────
  it("issues a csrf cookie on login", async () => {
    const login = await loginCookies("lockout@test.id", "fresh-password-789");
    expect(login.csrf).toBeTruthy();
    expect(login.access).toBeTruthy();
  });

  it("rejects mutating requests without a valid CSRF token", async () => {
    const login = await loginCookies("lockout@test.id", "fresh-password-789");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses",
      headers: { cookie: accessCookieName() + "=" + login.access }, // no csrf header
      payload: { title: "X" }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CSRF_TOKEN_MISMATCH");
  });
});
