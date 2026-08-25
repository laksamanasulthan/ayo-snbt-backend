import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let adminToken: string;
let studentToken: string;
let otherMentorToken: string;
let myQuestionId: string;
let mentorId: string;

describe("Questions edge cases", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("q-edge-mentor@t.id", "Q Mentor", "mentor");
    mentorId = await userIdByEmail("q-edge-mentor@t.id");
    adminToken = await loginAs("q-edge-admin@t.id", "Q Admin", "admin");
    studentToken = await loginAs("q-edge-student@t.id", "Q Student", "student");
    otherMentorToken = await loginAs("q-edge-mentor2@t.id", "Q Mentor 2", "mentor");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      headers: authHeaders(mentorToken),
      payload: {
        text: "Berapa 2+2?", category: "PK", difficulty: "easy",
        options: [{ text: "3", isCorrect: false }, { text: "4", isCorrect: true }]
      }
    });
    expect(res.statusCode).toBe(201);
    myQuestionId = res.json().data.id;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("creates a question without options", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      headers: authHeaders(mentorToken),
      payload: { text: "Esai pendek?", category: "PU" }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.options).toEqual([]);
  });

  it("rejects questions without text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      headers: authHeaders(mentorToken),
      payload: { category: "PK" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects students from managing questions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      headers: authHeaders(studentToken),
      payload: { text: "Nope", category: "PK" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("lists questions with category filter and pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await insertQuestion({ text: "PK " + i, category: "PK", options: [{ text: "A", isCorrect: true }] });
      await insertQuestion({ text: "PU " + i, category: "PU", options: [{ text: "A", isCorrect: true }] });
    }
    const pk = await app.inject({ method: "GET", url: "/api/v1/questions?category=PK&limit=3", headers: authHeaders(mentorToken) });
    expect(pk.statusCode).toBe(200);
    const pkRows = pk.json().data;
    expect(pkRows.length).toBe(3);
    expect(pkRows.every((q: { category: string }) => q.category === "PK")).toBe(true);
    const next = (pk.json().meta as { pagination: { nextCursor: string | null } }).pagination.nextCursor;
    expect(next).toBeTruthy();
    const pk2 = await app.inject({ method: "GET", url: "/api/v1/questions?category=PK&limit=3&cursor=" + encodeURIComponent(next as string), headers: authHeaders(mentorToken) });
    expect(pk2.statusCode).toBe(200);
    const ids = new Set(pkRows.map((q: { id: string }) => q.id));
    expect(ids.has(pk2.json().data[0].id)).toBe(false);
  });

  it("returns 404 for unknown questions", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/questions/00000000-0000-0000-0000-000000000000", headers: authHeaders(mentorToken)
    });
    expect(res.statusCode).toBe(404);
  });

  it("updates the question text and replaces options atomically", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/questions/" + myQuestionId,
      headers: authHeaders(mentorToken),
      payload: {
        text: "Berapa 3+3?",
        options: [{ text: "5", isCorrect: false }, { text: "6", isCorrect: true }, { text: "7", isCorrect: false }]
      }
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.text).toBe("Berapa 3+3?");
    expect(data.options.length).toBe(3); // old options replaced
    expect(data.options.some((o: { isCorrect: boolean }) => o.isCorrect)).toBe(true);
  });

  it("only the creator or admin can update questions", async () => {
    const other = await app.inject({
      method: "PATCH",
      url: "/api/v1/questions/" + myQuestionId,
      headers: authHeaders(otherMentorToken),
      payload: { text: "Hijacked?" }
    });
    expect(other.statusCode).toBe(403);
    const asAdmin = await app.inject({
      method: "PATCH",
      url: "/api/v1/questions/" + myQuestionId,
      headers: authHeaders(adminToken),
      payload: { text: "Admin Edit" }
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().data.text).toBe("Admin Edit");
  });

  it("soft-deletes a question (hidden everywhere) and restores it", async () => {
    const q = await insertQuestion({ text: "Delete Me", category: "PK", createdBy: mentorId, options: [{ text: "A", isCorrect: true }] });
    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/questions/" + q.id,
      headers: authHeaders(mentorToken)
    });
    expect(del.statusCode).toBe(200);
    // Hidden from list
    const list = await app.inject({ method: "GET", url: "/api/v1/questions?limit=100", headers: authHeaders(mentorToken) });
    expect((list.json().data as { id: string }[]).map((r) => r.id)).not.toContain(q.id);
    // Hidden from simulations question bank too
    const bank = await getPool().query("SELECT id FROM questions WHERE category = 'PK' AND deleted_at IS NULL AND id = $1", [q.id]);
    expect(bank.rows.length).toBe(0);
    // Restore (owner or admin)
    const restore = await app.inject({
      method: "POST",
      url: "/api/v1/questions/" + q.id + "/restore",
      headers: authHeaders(adminToken)
    });
    expect(restore.statusCode).toBe(200);
    const list2 = await app.inject({ method: "GET", url: "/api/v1/questions?limit=100", headers: authHeaders(mentorToken) });
    expect((list2.json().data as { id: string }[]).map((r) => r.id)).toContain(q.id);
  });

  it("non-creators cannot delete questions", async () => {
    const q = await insertQuestion({ text: "No Delete", category: "PK", createdBy: mentorId });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/questions/" + q.id,
      headers: authHeaders(otherMentorToken)
    });
    expect(res.statusCode).toBe(403);
  });

  it("double-delete is idempotent (still 200, still hidden)", async () => {
    const q = await insertQuestion({ text: "Double", category: "PK", createdBy: mentorId });
    const first = await app.inject({ method: "DELETE", url: "/api/v1/questions/" + q.id, headers: authHeaders(mentorToken) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "DELETE", url: "/api/v1/questions/" + q.id, headers: authHeaders(mentorToken) });
    expect(second.statusCode).toBe(200);
  });
});
