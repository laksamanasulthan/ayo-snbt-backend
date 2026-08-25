import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { eventBus } from "../../src/shared/events/bus.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let adminToken: string;
let studentId: string;

/** Poll until fn() is truthy (event subscribers write asynchronously). */
async function eventually(fn: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("N9 — Gamification", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    adminToken = await loginAs("gm-admin@t.id", "GM Admin", "admin");
    studentToken = await loginAs("gm-student@t.id", "GM Student", "student");
    studentId = await userIdByEmail("gm-student@t.id");
    // Define badges
    const b1 = await app.inject({ method: "POST", url: "/api/v1/admin/badges", headers: authHeaders(adminToken), payload: { code: "pemula", name: "Pemula", pointsRequired: 10 } });
    expect(b1.statusCode).toBe(201);
    await app.inject({ method: "POST", url: "/api/v1/admin/badges", headers: authHeaders(adminToken), payload: { code: "rajin", name: "Rajin", pointsRequired: 70 } });
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("awards points on events and unlocks threshold badges", async () => {
    // Emit: registered (10) + email_verified (20) + started (5) = 35 → pemula badge
    eventBus.emit("user.registered", { userId: studentId });
    eventBus.emit("user.email_verified", { userId: studentId });
    eventBus.emit("simulation.started", { sessionId: crypto.randomUUID(), userId: studentId, type: "simulation" });
    const ok = await eventually(async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/users/me/points", headers: authHeaders(studentToken) });
      return (res.json().data.total ?? 0) >= 35;
    });
    expect(ok).toBe(true);
    const points = await app.inject({ method: "GET", url: "/api/v1/users/me/points", headers: authHeaders(studentToken) });
    expect(points.json().data.total).toBe(35);
    expect(points.json().data.recent.length).toBeGreaterThanOrEqual(3);
    // pemula badge earned
    const badges = await app.inject({ method: "GET", url: "/api/v1/users/me/badges", headers: authHeaders(studentToken) });
    const rows = badges.json().data as Array<{ code: string; earned: boolean }>;
    const pemula = rows.find((r) => r.code === "pemula");
    expect(pemula!.earned).toBe(true);
    const rajin = rows.find((r) => r.code === "rajin");
    expect(rajin!.earned).toBe(false);
  });

  it("awards simulation.graded points (50) and unlocks the 70-point badge", async () => {
    eventBus.emit("simulation.graded", { sessionId: crypto.randomUUID(), packageId: crypto.randomUUID(), userId: studentId });
    const ok = await eventually(async () => {
      const badgesRes = await app.inject({ method: "GET", url: "/api/v1/users/me/badges", headers: authHeaders(studentToken) });
      const rajin = (badgesRes.json().data as Array<{ code: string; earned: boolean }>).find((r) => r.code === "rajin");
      return rajin?.earned === true;
    });
    expect(ok).toBe(true);
  });

  it("requires auth and admin for badge management", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/users/me/points" });
    expect(anon.statusCode).toBe(401);
    const forbidden = await app.inject({ method: "POST", url: "/api/v1/admin/badges", headers: authHeaders(studentToken), payload: { code: "x", name: "x", pointsRequired: 1 } });
    expect(forbidden.statusCode).toBe(403);
  });
});
