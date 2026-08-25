import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { simulationsService } from "../../src/modules/simulations/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let q: { id: string; optionIds: string[] };

describe("N5 — Time-usage analytics", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("ta-student@t.id", "TA Student", "student");
    q = await insertQuestion({ text: "TA Q?", category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    // One graded session with known time + one flagged answer
    const q2 = await insertQuestion({ text: "TA Q2?", category: "PK", options: [{ text: "C", isCorrect: true }, { text: "D", isCorrect: false }] });
    const pkgId = await insertPackage({ title: "TA Pkg", status: "published", questionCounts: { TPS: 1, PK: 1 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers: authHeaders(studentToken) });
    const sessionId = start.json().data.sessionId as string;
    const answers = await getPool().query("SELECT id, question_id FROM simulation_answers WHERE session_id = $1", [sessionId]);
    // Answer q correctly with 120s spent; answer q2 correctly with 60s; flag q
    for (const a of answers.rows) {
      const isQ = a.question_id === q.id;
      const opt = isQ ? q.optionIds[0] : q2.optionIds[0];
      const spentMs = isQ ? 120_000 : 60_000;
      await getPool().query(
        "UPDATE simulation_answers SET selected_option_id = $1, answered_at = NOW(), time_spent_ms = $2, is_flagged = $3 WHERE id = $4",
        [opt, spentMs, isQ, a.id]
      );
    }
    await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessionId]);
    await simulationsService.gradeSession(sessionId);
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("reports avg time, flagged rate and per-category timing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/results/time-analysis", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totalAnswers).toBe(2);
    expect(data.answered).toBe(2);
    expect(data.avgTimePerQuestionMs).toBe(90_000); // (120k + 60k) / 2
    expect(data.flaggedRate).toBe(50); // 1 of 2 flagged
    expect(data.perCategory.length).toBe(2);
    const tps = data.perCategory.find((c: { category: string }) => c.category === "TPS");
    const pk = data.perCategory.find((c: { category: string }) => c.category === "PK");
    expect(tps!.avgTimeMs).toBe(120_000);
    expect(tps!.flaggedRate).toBe(100);
    expect(pk!.avgTimeMs).toBe(60_000);
    expect(pk!.flaggedRate).toBe(0);
  });

  it("handles empty history", async () => {
    const other = await loginAs("ta-none@t.id", "TA None", "student");
    const res = await app.inject({ method: "GET", url: "/api/v1/results/time-analysis", headers: authHeaders(other) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totalAnswers).toBe(0);
    expect(data.avgTimePerQuestionMs).toBe(0);
    expect(data.perCategory).toEqual([]);
  });
});
