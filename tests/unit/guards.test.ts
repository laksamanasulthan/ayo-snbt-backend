import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { csrfGuard, authGuard } from "../../src/shared/middleware/auth.js";
import { accessCookieName } from "../../src/shared/auth/index.js";
import { signAccessToken } from "../../src/shared/auth/index.js";

function minimalApp() {
  return buildApp({
    minimal: true,
    logger: false,
    degradation: new DegradationManager(),
    healthRegistry: new HealthRegistry()
  });
}

describe("CSRF guard", () => {
  it("rejects mutating request without matching csrf token", async () => {
    const app = await minimalApp();
    app.addHook("preHandler", csrfGuard);
    app.post("/test", async (_req, reply) => reply.ok({ ok: true }));
    const res = await app.inject({ method: "POST", url: "/test", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CSRF_TOKEN_MISMATCH");
  });

  it("allows mutating request with matching cookie + header", async () => {
    const app = await minimalApp();
    app.addHook("preHandler", csrfGuard);
    app.post("/test", async (_req, reply) => reply.ok({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/test",
      payload: {},
      headers: { cookie: "csrf_token=abc123", "x-csrf-token": "abc123" }
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows GET requests without csrf token", async () => {
    const app = await minimalApp();
    app.addHook("preHandler", csrfGuard);
    app.get("/test", async (_req, reply) => reply.ok({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
  });
});

describe("authGuard", () => {
  it("returns 401 without token", async () => {
    const app = await minimalApp();
    app.addHook("preHandler", authGuard);
    app.get("/test", async (_req, reply) => reply.ok({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid access token cookie and sets request.user", async () => {
    const app = await minimalApp();
    app.addHook("preHandler", authGuard);
    app.get("/test", async (req, reply) => reply.ok({ uid: req.user?.id }));
    const token = await signAccessToken({ sub: "u1", email: "a@b.c", roles: ["student"], permissions: ["user:read"] });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { cookie: accessCookieName() + "=" + token }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.uid).toBe("u1");
  });

  it("rejects an expired token", async () => {
    const app = await minimalApp();
    app.addHook("preHandler", authGuard);
    app.get("/test", async (_req, reply) => reply.ok({ ok: true }));
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { cookie: accessCookieName() + "=garbage.token.value" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TOKEN_EXPIRED");
  });
});