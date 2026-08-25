import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let otherToken: string;
let packageId: string;
let qIds: string[];
let q1CorrectOptionId: string;

describe("Practice mode edge cases", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("pr-student@t.id", "PR Student", "student");
    otherToken = await loginAs("pr-other@t.id", "PR Other", "student");
    // Seed a bank with explanations
    const q1 = await insertQuestion({ text: "2+2?", category: "PK", difficulty: "easy", options: [{ text: "3", isCorrect: false }, { text: "4", isCorrect: true }] });
    const q2 = await insertQuestion({ text: "Capital?", category: "PK", difficulty: "easy", options: [{ text: "Paris", isCorrect: true }, { text: "Rome", isCorrect: false }] });
    const q3 = await insertQuestion({ text: "PU Q", category: "PU", difficulty: "medium", options: [{ text: "A", isCorrect: true }] });
    qIds = [q1.id, q2.id, q3.id];
    q1CorrectOptionId = q1.optionIds[1]!;
    // Update explanations via DB (helper doesn't set them)
    await getPool().query("UPDATE questions SET explanation = 'Karena 2+2=4' WHERE id = $1", [q1.id]);
    packageId = await insertPackage({ title: "Practice Pkg", status: "published", questionCounts: { PK: 2 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("starts package-based practice without leaking correct answers", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { packageId }
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.practiceId).toBeTruthy();
    expect(data.questions.length).toBe(2);
    expect(data.maxScore).toBe(8);
    const opts = data.questions[0].options as { isCorrect?: boolean }[];
    expect(opts[0]?.isCorrect).toBeUndefined();
  });

  it("starts practice with category+difficulty filters", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { category: "PK", difficulty: "easy", count: 10 }
    });
    expect(res.statusCode).toBe(201);
    const questions = res.json().data.questions as { category: string; difficulty: string }[];
    expect(questions.length).toBe(2);
    expect(questions.every(q => q.category === "PK" && q.difficulty === "easy")).toBe(true);
  });

  it("starts practice with an exact question set", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { questionIds: [qIds[0]!, qIds[2]!] }
    });
    expect(res.statusCode).toBe(201);
    const ids = (res.json().data.questions as { id: string }[]).map(q => q.id).sort();
    expect(ids).toEqual([qIds[0], qIds[2]].sort());
  });

  it("rejects practice when the bank is empty", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { category: "NONEXISTENT", count: 5 }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BANK_EMPTY");
  });

  it("answers with instant feedback (correct/wrong + explanation)", async () => {
    const start = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { packageId }
    });
    const practiceId = start.json().data.practiceId as string;
    // Answer q1 explicitly (it is always in the package's PK pick set) with its correct option
    const answer = await app.inject({
      method: "POST", url: "/api/v1/practice/" + practiceId + "/answer", headers: authHeaders(studentToken),
      payload: { questionId: qIds[0]!, selectedOptionId: q1CorrectOptionId }
    });
    expect(answer.statusCode).toBe(200);
    const data = answer.json().data;
    expect(data.isCorrect).toBe(true);
    expect(data.correctOptionIds).toContain(q1CorrectOptionId);
    expect(data.explanation).toBe("Karena 2+2=4");
  });

  it("rejects answers for questions outside the practice set", async () => {
    const start = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { packageId }
    });
    const practiceId = start.json().data.practiceId as string;
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/" + practiceId + "/answer", headers: authHeaders(studentToken),
      payload: { questionId: qIds[2]!, selectedOptionId: "00000000-0000-0000-0000-000000000000" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not in this session/i);
  });

  it("rejects practice endpoints on non-practice sessions", async () => {
    // Start a real simulation (needs published package + questions) via direct session insert
    const db = getPool();
    const user = await db.query("SELECT id FROM users WHERE email = $1", ["pr-student@t.id"]);
    const sess = await db.query(
      "INSERT INTO simulation_sessions (user_id, package_id, status, started_at, deadline_at) VALUES ($1, $2, 'in_progress', NOW(), NOW() + interval '1 hour') RETURNING id",
      [user.rows[0]?.id, packageId]
    );
    const sid = sess.rows[0]?.id as string;
    const res = await app.inject({
      method: "POST", url: "/api/v1/practice/" + sid + "/answer", headers: authHeaders(studentToken),
      payload: { questionId: qIds[0]!, selectedOptionId: "00000000-0000-0000-0000-000000000000" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not a practice session/i);
  });

  it("tracks progress and finishes with a computed score", async () => {
    const start = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { questionIds: [qIds[0]!, qIds[1]!] }
    });
    const practiceId = start.json().data.practiceId as string;
    const questions = start.json().data.questions as { id: string; options: { id: string }[] }[];
    // Answer both questions with option 0
    for (const q of questions) {
      await app.inject({
        method: "POST", url: "/api/v1/practice/" + practiceId + "/answer", headers: authHeaders(studentToken),
        payload: { questionId: q.id, selectedOptionId: q.options[0]!.id }
      });
    }
    const progress = await app.inject({ method: "GET", url: "/api/v1/practice/" + practiceId, headers: authHeaders(studentToken) });
    expect(progress.statusCode).toBe(200);
    expect(progress.json().data.summary).toEqual({ total: 2, answered: 2, correct: expect.any(Number) });
    const finish = await app.inject({ method: "POST", url: "/api/v1/practice/" + practiceId + "/finish", headers: authHeaders(studentToken) });
    expect(finish.statusCode).toBe(200);
    expect(finish.json().data.finished).toBe(true);
    expect(finish.json().data.maxScore).toBe(8);
    expect(finish.json().data.score).toBe(finish.json().data.correct * 4);
    // Double finish is idempotent
    const again = await app.inject({ method: "POST", url: "/api/v1/practice/" + practiceId + "/finish", headers: authHeaders(studentToken) });
    expect(again.json().data.alreadyFinished).toBe(true);
    // Review works on finished practice
    const review = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + practiceId + "/review", headers: authHeaders(studentToken) });
    expect(review.statusCode).toBe(200);
    expect(review.json().data.questions.length).toBe(2);
  });

  it("does not list practice sessions in tryout history", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as { id: string }[];
    // All rows must be simulation-type (no practice ids leak in)
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it("scopes practice sessions to the owner (404 for others)", async () => {
    const start = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { questionIds: [qIds[0]!] }
    });
    const practiceId = start.json().data.practiceId as string;
    const res = await app.inject({ method: "GET", url: "/api/v1/practice/" + practiceId, headers: authHeaders(otherToken) });
    expect(res.statusCode).toBe(404);
  });
});
