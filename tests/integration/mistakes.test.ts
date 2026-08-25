import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { simulationsService } from "../../src/modules/simulations/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let qWrong: { id: string; optionIds: string[] };   // will be wrong twice
let qMixed: { id: string; optionIds: string[] };   // wrong once, right once
let qRight: { id: string; optionIds: string[] };   // always right

describe("A6 — Mistakes bank", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("mk-student@t.id", "MK Student", "student");
    qWrong = await insertQuestion({ text: "Salah terus?", category: "TPS", difficulty: "easy", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    // All questions share the TPS category so every session picks all three
    qMixed = await insertQuestion({ text: "Campur?", category: "TPS", difficulty: "medium", options: [{ text: "C", isCorrect: true }, { text: "D", isCorrect: false }] });
    qRight = await insertQuestion({ text: "Benar terus?", category: "TPS", difficulty: "hard", options: [{ text: "E", isCorrect: true }, { text: "F", isCorrect: false }] });

    // Helper: run a graded session where each question is answered as specified (null = blank)
    const runSession = async (answers: Array<{ questionId: string; optionId: string | null }>) => {
      const pkgId = await insertPackage({ title: "MK Pkg " + Math.random(), status: "published", questionCounts: { TPS: 3 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
      const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers: authHeaders(studentToken) });
      const sessionId = start.json().data.sessionId as string;
      for (const a of answers) {
        await getPool().query(
          "UPDATE simulation_answers SET selected_option_id = $1, answered_at = NOW() WHERE session_id = $2 AND question_id = $3",
          [a.optionId, sessionId, a.questionId]
        );
      }
      await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessionId]);
      await simulationsService.gradeSession(sessionId);
    };

    // Session 1: qWrong wrong, qMixed wrong, qRight right
    await runSession([
      { questionId: qWrong.id, optionId: qWrong.optionIds[1]! },
      { questionId: qMixed.id, optionId: qMixed.optionIds[1]! },
      { questionId: qRight.id, optionId: qRight.optionIds[0]! }
    ]);
    // Session 2: qWrong wrong again, qMixed right, qRight right
    await runSession([
      { questionId: qWrong.id, optionId: qWrong.optionIds[1]! },
      { questionId: qMixed.id, optionId: qMixed.optionIds[0]! },
      { questionId: qRight.id, optionId: qRight.optionIds[0]! }
    ]);
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/results/mistakes" });
    expect(res.statusCode).toBe(401);
  });

  it("lists only distinct wrong questions with frequency", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/results/mistakes", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    const wrong = rows.find((r) => r.questionId === qWrong.id);
    const mixed = rows.find((r) => r.questionId === qMixed.id);
    expect(wrong!.wrongCount).toBe(2);
    expect(mixed!.wrongCount).toBe(1);
    expect(wrong!.text).toBe("Salah terus?");
    // Correct-only question must NOT appear
    expect(rows.some((r) => r.questionId === qRight.id)).toBe(false);
    // Newest last-wrong first
    expect(rows[0]!.questionId).toBe(qWrong.id); // wrong again in session 2
  });

  it("retries mistakes via practice questionIds", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/results/mistakes", headers: authHeaders(studentToken) });
    const ids = (res.json().data as Array<{ questionId: string }>).map((r) => r.questionId);
    const practice = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { questionIds: ids }
    });
    expect(practice.statusCode).toBe(201);
    const qs = (practice.json().data as { questions: Array<{ id: string }> }).questions.map((q) => q.id).sort();
    expect(qs).toEqual([qWrong.id, qMixed.id].sort());
  });

  it("paginates mistakes with cursor", async () => {
    const p1 = await app.inject({ method: "GET", url: "/api/v1/results/mistakes?limit=1", headers: authHeaders(studentToken) });
    const meta = p1.json().meta as { pagination: { nextCursor: string | null } };
    expect(meta.pagination.nextCursor).toBeTruthy();
    const p2 = await app.inject({ method: "GET", url: `/api/v1/results/mistakes?limit=1&cursor=${meta.pagination.nextCursor}`, headers: authHeaders(studentToken) });
    expect(p2.statusCode).toBe(200);
    const d1 = p1.json().data as Array<{ questionId: string }>;
    const d2 = p2.json().data as Array<{ questionId: string }>;
    expect(d2[0]!.questionId).not.toBe(d1[0]!.questionId);
  });
});
