import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let studentToken: string;
let futurePkg: string;   // starts in 1 hour
let openPkg: string;     // started 1h ago, closes in 1h
let closedPkg: string;   // closed 1h ago
let plainPkg: string;    // no schedule

const headers = (t: string) => authHeaders(t);
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("A1 — Scheduled tryouts", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("tr-mentor@t.id", "Tryout Mentor", "mentor");
    studentToken = await loginAs("tr-student@t.id", "Tryout Student", "student");
    await insertQuestion({ text: "TQ?", category: "TPS", options: [{ text: "A", isCorrect: true }] });
    const mk = async (title: string, extra: Record<string, unknown>) => {
      const res = await app.inject({
        method: "POST", url: "/api/v1/simulations/packages", headers: headers(mentorToken),
        payload: { title, questionCounts: { TPS: 1 }, ...extra }
      });
      expect(res.statusCode).toBe(201);
      const id = res.json().data.id as string;
      await app.inject({ method: "POST", url: `/api/v1/simulations/packages/${id}/publish`, headers: headers(mentorToken) });
      return id;
    };
    futurePkg = await mk("Tryout Future", { scheduledAt: iso(3600_000) });
    openPkg = await mk("Tryout Open", { scheduledAt: iso(-3600_000), closesAt: iso(3600_000) });
    closedPkg = await mk("Tryout Closed", { scheduledAt: iso(-7200_000), closesAt: iso(-3600_000) });
    plainPkg = await mk("Tryout Plain", {});
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("lists only scheduled tryouts (future + open), never plain packages", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/simulations/tryouts" });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; scheduledAt: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(futurePkg);
    expect(ids).toContain(openPkg);
    expect(ids).toContain(closedPkg);
    expect(ids).not.toContain(plainPkg);
    expect(rows.every((r) => typeof r.scheduledAt === "string")).toBe(true);
  });

  it("blocks starting before the window opens (TRYOUT_NOT_STARTED)", async () => {
    const res = await app.inject({ method: "POST", url: `/api/v1/simulations/${futurePkg}/start`, headers: headers(studentToken) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TRYOUT_NOT_STARTED");
    expect(res.json().error.details.startsAt).toBeTruthy();
  });

  it("allows starting inside the open window", async () => {
    const res = await app.inject({ method: "POST", url: `/api/v1/simulations/${openPkg}/start`, headers: headers(studentToken) });
    expect(res.statusCode).toBe(201);
  });

  it("blocks starting after the window closes (TRYOUT_EXPIRED)", async () => {
    const res = await app.inject({ method: "POST", url: `/api/v1/simulations/${closedPkg}/start`, headers: headers(studentToken) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TRYOUT_EXPIRED");
    expect(res.json().error.details.closesAt).toBeTruthy();
  });

  it("plain packages (no schedule) are unaffected", async () => {
    const res = await app.inject({ method: "POST", url: `/api/v1/simulations/${plainPkg}/start`, headers: headers(studentToken) });
    expect(res.statusCode).toBe(201);
  });

  it("paginates the tryout list", async () => {
    const p1 = await app.inject({ method: "GET", url: "/api/v1/simulations/tryouts?limit=1" });
    const meta = p1.json().meta as { pagination: { nextCursor: string | null } };
    expect(meta.pagination.nextCursor).toBeTruthy();
    const p2 = await app.inject({ method: "GET", url: `/api/v1/simulations/tryouts?limit=1&cursor=${meta.pagination.nextCursor}` });
    expect(p2.statusCode).toBe(200);
    const d1 = p1.json().data as Array<{ id: string }>;
    const d2 = p2.json().data as Array<{ id: string }>;
    expect(d2[0]!.id).not.toBe(d1[0]!.id);
  });

  it("clearing the schedule removes the package from the tryout list", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/v1/simulations/packages/${futurePkg}`, headers: headers(mentorToken),
      payload: { scheduledAt: null, closesAt: null }
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/v1/simulations/tryouts" });
    const ids = (list.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(futurePkg);
    // And the package starts fine now
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${futurePkg}/start`, headers: headers(studentToken) });
    expect(start.statusCode).toBe(201);
  });
});
