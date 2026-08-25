import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let courseA: string;
let courseB: string;

describe("N8 — Wishlist", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("ws-student@t.id", "WS Student", "student");
    courseA = (await insertCourse({ title: "Mau Beli", status: "published", priceCents: 99_000 })).id;
    courseB = (await insertCourse({ title: "Nanti Dulu", status: "published", priceCents: 50_000 })).id;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses/wishlist" });
    expect(res.statusCode).toBe(401);
  });

  it("adds courses to the wishlist idempotently", async () => {
    const r1 = await app.inject({ method: "POST", url: `/api/v1/courses/${courseA}/wishlist`, headers: authHeaders(studentToken) });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.wishlisted).toBe(true);
    await app.inject({ method: "POST", url: `/api/v1/courses/${courseB}/wishlist`, headers: authHeaders(studentToken) });
    await app.inject({ method: "POST", url: `/api/v1/courses/${courseA}/wishlist`, headers: authHeaders(studentToken) }); // duplicate
    const list = await app.inject({ method: "GET", url: "/api/v1/courses/wishlist", headers: authHeaders(studentToken) });
    const rows = list.json().data as Array<{ id: string }>;
    expect(rows.length).toBe(2);
  });

  it("removes from the wishlist", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/v1/courses/${courseA}/wishlist`, headers: authHeaders(studentToken) });
    expect(del.json().data.wishlisted).toBe(false);
    const list = await app.inject({ method: "GET", url: "/api/v1/courses/wishlist", headers: authHeaders(studentToken) });
    const rows = list.json().data as Array<{ id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(courseB);
  });

  it("404s for unknown courses", async () => {
    const res = await app.inject({ method: "POST", url: `/api/v1/courses/${crypto.randomUUID()}/wishlist`, headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(404);
  });
});
