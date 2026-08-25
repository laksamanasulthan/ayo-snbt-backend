import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let mentorId: string;
let q1: { id: string };

describe("A4 — Question search", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("qs-mentor@t.id", "QS Mentor", "mentor");
    mentorId = (await getPool().query("SELECT id FROM users WHERE email = 'qs-mentor@t.id'")).rows[0]?.id as string;
    q1 = await insertQuestion({ text: "Berapa hasil 12 dikali 12?", category: "PK", difficulty: "easy", createdBy: mentorId, options: [{ text: "144", isCorrect: true }, { text: "121", isCorrect: false }] });
    await insertQuestion({ text: "Ibu kota Prancis?", category: "PU", difficulty: "medium", createdBy: mentorId, options: [{ text: "Paris", isCorrect: true }, { text: "Lyon", isCorrect: false }] });
    await insertQuestion({ text: "Rumus luas lingkaran?", category: "TPS", difficulty: "easy", createdBy: mentorId, options: [{ text: "pi*r^2", isCorrect: true }, { text: "2*pi*r", isCorrect: false }] });
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("searches by substring in question text", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/questions?q=dikali", headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(q1.id);
  });

  it("combines search with category", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/questions?q=luas&category=PK", headers: authHeaders(mentorToken) });
    expect((res.json().data as unknown[]).length).toBe(0);
    const res2 = await app.inject({ method: "GET", url: "/api/v1/questions?q=luas&category=TPS", headers: authHeaders(mentorToken) });
    expect((res2.json().data as unknown[]).length).toBe(1);
  });

  it("returns empty for unmatched terms", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/questions?q=zzzzznope", headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as unknown[]).length).toBe(0);
  });

  it("is case-insensitive", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/questions?q=PRANCIS", headers: authHeaders(mentorToken) });
    expect((res.json().data as unknown[]).length).toBe(1);
  });
});
