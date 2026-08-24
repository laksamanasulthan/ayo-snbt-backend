import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { NotFoundError, BadRequestError, UnauthorizedError, TooManyRequestsError, ForbiddenError } from "../../src/shared/http/index.js";

function minimalApp() {
  return buildApp({
    minimal: true,
    logger: false,
    degradation: new DegradationManager(),
    healthRegistry: new HealthRegistry()
  });
}

describe("Standardized JSON envelope", () => {
  it("returns 200 success envelope on ok", async () => {
    const app = await minimalApp();
    app.get("/test-ok", async (_req, reply) => reply.ok({ hello: "world" }));
    const res = await app.inject({ method: "GET", url: "/test-ok" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ hello: "world" });
    expect(body.meta.requestId).toBeDefined();
    expect(body.meta.timestamp).toBeDefined();
  });

  it("returns 201 on created", async () => {
    const app = await minimalApp();
    app.post("/test-created", async (_req, reply) => reply.created({ id: "1" }));
    const res = await app.inject({ method: "POST", url: "/test-created" });
    expect(res.statusCode).toBe(201);
    expect(res.json().success).toBe(true);
  });

  it("returns 204 on noContent", async () => {
    const app = await minimalApp();
    app.delete("/test-nc", async (_req, reply) => reply.noContent());
    const res = await app.inject({ method: "DELETE", url: "/test-nc" });
    expect(res.statusCode).toBe(204);
  });

  it("returns 404 NOT_FOUND envelope for unknown routes", async () => {
    const app = await minimalApp();
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBeDefined();
  });

  it("returns VALIDATION_ERROR on schema violation", async () => {
    const app = await minimalApp();
    app.post("/test-val", { schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } }, async (_req, reply) => reply.ok({}));
    const res = await app.inject({ method: "POST", url: "/test-val", payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toBeDefined();
  });

  it("maps AppError to correct status and code", async () => {
    const app = await minimalApp();
    app.get("/err/notfound", async () => { throw new NotFoundError("user not found"); });
    app.get("/err/bad", async () => { throw new BadRequestError("invalid input", "BAD_REQUEST"); });
    app.get("/err/unauth", async () => { throw new UnauthorizedError("login required"); });
    app.get("/err/forbidden", async () => { throw new ForbiddenError("nope"); });
    app.get("/err/429", async () => { throw new TooManyRequestsError("slow down", undefined, 30); });

    const r1 = await app.inject({ method: "GET", url: "/err/notfound" });
    expect(r1.statusCode).toBe(404);
    expect(r1.json().error.code).toBe("NOT_FOUND");

    const r2 = await app.inject({ method: "GET", url: "/err/bad" });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.code).toBe("BAD_REQUEST");

    const r3 = await app.inject({ method: "GET", url: "/err/unauth" });
    expect(r3.statusCode).toBe(401);
    const r4 = await app.inject({ method: "GET", url: "/err/forbidden" });
    expect(r4.statusCode).toBe(403);
    const r5 = await app.inject({ method: "GET", url: "/err/429" });
    expect(r5.statusCode).toBe(429);
    expect(r5.headers["retry-after"]).toBe("30");
  });

  it("returns 500 INTERNAL_ERROR on unknown errors (no leak)", async () => {
    const app = await minimalApp();
    app.get("/err/500", async () => { throw new Error("secret stuff"); });
    const res = await app.inject({ method: "GET", url: "/err/500" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
  });

  it("propagates requestId header from incoming request", async () => {
    const app = await minimalApp();
    app.get("/echo-id", async (req, reply) => reply.ok({ rid: req.id }));
    const res = await app.inject({ method: "GET", url: "/echo-id", headers: { "x-request-id": "my-custom-id" } });
    expect(res.headers["x-request-id"]).toBe("my-custom-id");
    expect(res.json().data.rid).toBe("my-custom-id");
  });

  it("health endpoint returns 200", async () => {
    const app = await minimalApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("ok");
  });
});