import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { simulationsService } from "../../src/modules/simulations/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;

describe("N4 — Score banding", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("bd-student@t.id", "BD Student", "student");
    await insertQuestion({ text: "BD Q?", category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    // Create a graded session with score 16 (4 correct)
    const pkgId = await insertPackage({ title: "BD Pkg", status: "published", questionCounts: { TPS: 5 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
    for (let i = 0; i < 4; i++) {
      await insertQuestion({ text: "BD extra " + i + "?", category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    }
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers: authHeaders(studentToken) });
    const sessionId = start.json().data.sessionId as string;
    const answers = await getPool().query("SELECT id, question_id FROM simulation_answers WHERE session_id = $1 ORDER BY sort_order LIMIT 4", [sessionId]);
    const correctOpts = await getPool().query(
      "SELECT question_id, id FROM question_options WHERE is_correct = true AND question_id IN (SELECT question_id FROM simulation_answers WHERE session_id = $1)",
      [sessionId]
    );
    const correctByQ = new Map((correctOpts.rows as Array<{ question_id: string; id: string }>).map((r) => [r.question_id, r.id]));
    for (const a of answers.rows as Array<{ id: string; question_id: string }>) {
      const opt = correctByQ.get(a.question_id);
      if (!opt) continue;
      await getPool().query("UPDATE simulation_answers SET selected_option_id = $1, answered_at = NOW() WHERE id = $2", [opt, a.id]);
    }
    await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessionId]);
    await simulationsService.gradeSession(sessionId);
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("returns banding for a user with graded sessions", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/results/banding", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.sessions).toBe(1);
    expect(data.averageScore).toBeGreaterThan(0);
    expect(data.band).toBe("tinggi"); // percentile 100
    expect(data.percentileRange).toEqual([100, 100]);
  });

  it("404s for users with no graded sessions", async () => {
    const other = await loginAs("bd-none@t.id", "BD None", "student");
    const res = await app.inject({ method: "GET", url: "/api/v1/results/banding", headers: authHeaders(other) });
    expect(res.statusCode).toBe(404);
  });
});
