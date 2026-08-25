import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let studentToken: string;
let qAljabar: { id: string; optionIds: string[] };
let qPerbandingan: { id: string; optionIds: string[] };
let qGeometri: { id: string; optionIds: string[] };
let mentorId: string;

describe("M6 — Question tags", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("tg-mentor@t.id", "Tag Mentor", "mentor");
    studentToken = await loginAs("tg-student@t.id", "Tag Student", "student");
    mentorId = await userIdByEmail("tg-mentor@t.id");
    // Seed questions with mixed tags (createdBy = mentor so PATCH/DELETE owner checks pass)
    qAljabar = await insertQuestion({ text: "2x+3=7?", category: "PK", difficulty: "easy", createdBy: mentorId, options: [{ text: "x=2", isCorrect: true }, { text: "x=3", isCorrect: false }] });
    qPerbandingan = await insertQuestion({ text: "A:B=2:3?", category: "PK", difficulty: "medium", createdBy: mentorId, options: [{ text: "3:2", isCorrect: false }, { text: "2:3", isCorrect: true }] });
    qGeometri = await insertQuestion({ text: "Luas lingkaran?", category: "TPS", difficulty: "easy", createdBy: mentorId, options: [{ text: "πr²", isCorrect: true }, { text: "2πr", isCorrect: false }] });
    // Link tags directly (helper has no tag support; service path is covered by other tests)
    for (const [qid, tag] of [
      [qAljabar.id, "aljabar"], [qPerbandingan.id, "perbandingan"], [qGeometri.id, "geometri"], [qGeometri.id, "bangun-datar"]
    ] as const) {
      await getPool().query("INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [tag]);
      const tagRow = await getPool().query("SELECT id FROM tags WHERE name = $1", [tag]);
      await getPool().query("INSERT INTO question_tags (question_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [qid, tagRow.rows[0]?.id]);
    }
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  async function userIdByEmail(email: string): Promise<string> {
    const rows = await getPool().query("SELECT id FROM users WHERE email = $1", [email]);
    return rows.rows[0]?.id as string;
  }

  it("returns tags in question payloads", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/questions/${qGeometri.id}`, headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(200);
    const tags = res.json().data.tags as string[];
    expect(tags.sort()).toEqual(["bangun-datar", "geometri"]);
  });

  it("filters the bank by tag", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/questions?tag=aljabar", headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(qAljabar.id);
    // Payload includes the tag list
    expect((res.json().data as Array<{ tags: string[] }>)[0]!.tags).toEqual(["aljabar"]);
  });

  it("combines tag + category filters", async () => {
    // qPerbandingan has category PK + tag perbandingan; qAljabar is PK + aljabar
    const res = await app.inject({ method: "GET", url: "/api/v1/questions?tag=perbandingan&category=PK", headers: authHeaders(mentorToken) });
    const rows = res.json().data as Array<{ id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(qPerbandingan.id);
  });

  it("returns empty for an unknown tag", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/questions?tag=tidak-ada", headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as unknown[]).length).toBe(0);
  });

  it("creates a question with tags via the API (normalize + dedupe)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions", headers: authHeaders(mentorToken),
      payload: { text: "Tagged via API?", category: "PK", tags: ["  Aljabar ", "aljabar", "", "geometri"] }
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { id: string; tags: string[] };
    expect(data.tags.sort()).toEqual(["aljabar", "geometri"]);
    // cleanup row for other tests (list counts)
    await getPool().query("DELETE FROM questions WHERE id = $1", [data.id]);
  });

  it("updates a question's tags (replace semantics)", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/v1/questions/${qAljabar.id}`, headers: authHeaders(mentorToken),
      payload: { tags: ["aljabar", "persamaan"] }
    });
    expect(res.statusCode).toBe(200);
    const tags = (res.json().data as { tags: string[] }).tags.sort();
    expect(tags).toEqual(["aljabar", "persamaan"]);
    // Revert for later tests
    await app.inject({
      method: "PATCH", url: `/api/v1/questions/${qAljabar.id}`, headers: authHeaders(mentorToken),
      payload: { tags: ["aljabar"] }
    });
  });

  it("package questionCounts can target tags (tag: prefix)", async () => {
    // Package with 1 question from tag aljabar → session must contain ONLY tagged questions
    const pkgId = await insertPackage({ title: "Tag Pkg", status: "published", questionCounts: { "tag:aljabar": 1 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
    const res = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(201);
    const sessionId = res.json().data.sessionId as string;
    // Session detail must expose only aljabar questions (only qAljabar has it)
    const detail = await app.inject({ method: "GET", url: `/api/v1/simulations/sessions/${sessionId}`, headers: authHeaders(studentToken) });
    expect(detail.statusCode).toBe(200);
    const qs = (detail.json().data as { questions: Array<{ id: string }> }).questions;
    expect(qs.length).toBe(1);
    expect(qs[0]!.id).toBe(qAljabar.id);
  });

  it("practice start filters by tag", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { tag: "geometri", count: 10 }
    });
    expect(res.statusCode).toBe(201);
    const qs = (res.json().data as { questions: Array<{ id: string }> }).questions;
    expect(qs.length).toBe(1);
    expect(qs[0]!.id).toBe(qGeometri.id);
  });

  it("practice start with package honoring tag: keys", async () => {
    const pkgId = await insertPackage({ title: "Practice Tag Pkg", status: "published", questionCounts: { "tag:perbandingan": 1 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { packageId: pkgId }
    });
    expect(res.statusCode).toBe(201);
    const qs = (res.json().data as { questions: Array<{ id: string }> }).questions;
    expect(qs.length).toBe(1);
    expect(qs[0]!.id).toBe(qPerbandingan.id);
  });

  it("practice start with unknown tag → 400 BANK_EMPTY", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { tag: "nope" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BANK_EMPTY");
  });

  it("deleting a question cascades its tag links but keeps the tag", async () => {
    // Link an extra question to a fresh tag, delete the question, verify links gone
    const tagName = "cascade-test";
    await getPool().query("INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [tagName]);
    const tagRow = await getPool().query("SELECT id FROM tags WHERE name = $1", [tagName]);
    const q = await insertQuestion({ text: "Temp?", category: "TPS", createdBy: mentorId, options: [{ text: "A", isCorrect: true }] });
    await getPool().query("INSERT INTO question_tags (question_id, tag_id) VALUES ($1, $2)", [q.id, tagRow.rows[0]?.id]);
    const del = await app.inject({ method: "DELETE", url: `/api/v1/questions/${q.id}`, headers: authHeaders(mentorToken) });
    expect(del.statusCode).toBe(200);
    const links = await getPool().query("SELECT count(*)::int AS c FROM question_tags WHERE tag_id = $1", [tagRow.rows[0]?.id]);
    expect(links.rows[0]?.c).toBe(0);
    const tagStill = await getPool().query("SELECT count(*)::int AS c FROM tags WHERE name = $1", [tagName]);
    expect(tagStill.rows[0]?.c).toBe(1);
  });
});
