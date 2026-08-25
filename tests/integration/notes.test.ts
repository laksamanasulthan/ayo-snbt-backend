import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let otherToken: string;
let questionId: string;

describe("N2 — Personal notes", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("nt2-student@t.id", "NT2 Student", "student");
    otherToken = await loginAs("nt2-other@t.id", "NT2 Other", "student");
    questionId = (await insertQuestion({ text: "Note Q?", category: "TPS", options: [{ text: "A", isCorrect: true }] })).id;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("returns null note initially", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.note).toBeNull();
  });

  it("creates and updates a note (upsert)", async () => {
    const r1 = await app.inject({ method: "PUT", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(studentToken), payload: { body: "Ingat: cara cepat!" } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.body).toBe("Ingat: cara cepat!");
    const r2 = await app.inject({ method: "PUT", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(studentToken), payload: { body: "Update: rumus lain" } });
    expect(r2.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(studentToken) });
    expect(get.json().data.note.body).toBe("Update: rumus lain");
    // One row only
    const rows = await getPool().query("SELECT count(*)::int AS c FROM question_notes WHERE question_id = $1", [questionId]);
    expect(rows.rows[0]?.c).toBe(1);
  });

  it("is private per user", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(otherToken) });
    expect(res.json().data.note).toBeNull();
  });

  it("validates body and unknown questions", async () => {
    const empty = await app.inject({ method: "PUT", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(studentToken), payload: { body: "  " } });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({ method: "PUT", url: `/api/v1/questions/${crypto.randomUUID()}/note`, headers: authHeaders(studentToken), payload: { body: "x" } });
    expect(missing.statusCode).toBe(404);
  });

  it("deletes the note", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(studentToken) });
    expect(del.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(studentToken) });
    expect(get.json().data.note).toBeNull();
  });

  it("lists my notes with question text", async () => {
    await app.inject({ method: "PUT", url: `/api/v1/questions/${questionId}/note`, headers: authHeaders(studentToken), payload: { body: "Listed note" } });
    const res = await app.inject({ method: "GET", url: "/api/v1/users/me/notes", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ questionText: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.questionText).toBe("Note Q?");
  });
});
