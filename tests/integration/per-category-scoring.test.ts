import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { simulationsService } from "../../src/modules/simulations/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let qTps: { id: string; optionIds: string[] };
let qPu: { id: string; optionIds: string[] };
let pkgId: string;

describe("A2 — Per-category scoring", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("pcs-student@t.id", "PCS Student", "student");
    qTps = await insertQuestion({ text: "TPS Q?", category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    qPu = await insertQuestion({ text: "PU Q?", category: "PU", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    // Base: correct=4; perCategory: TPS correct=10, PU correct=1
    pkgId = await insertPackage({
      title: "PerCat Pkg", status: "published",
      questionCounts: { TPS: 1, PU: 1 },
      scoring: { correct: 4, blank: 0, wrong: 0, perCategory: { TPS: { correct: 10, blank: 0, wrong: 0 }, PU: { correct: 1, blank: 0, wrong: 0 } } } as never
    });
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("grades with category-specific scoring (both correct)", async () => {
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers: authHeaders(studentToken) });
    const sessionId = start.json().data.sessionId as string;
    // Answer both correctly via DB (answer rows are pre-created)
    const answers = await getPool().query("SELECT id, question_id FROM simulation_answers WHERE session_id = $1", [sessionId]);
    for (const a of answers.rows) {
      const opt = a.question_id === qTps.id ? qTps.optionIds[0] : qPu.optionIds[0];
      await getPool().query("UPDATE simulation_answers SET selected_option_id = $1 WHERE id = $2", [opt, a.id]);
    }
    await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessionId]);
    await simulationsService.gradeSession(sessionId);
    const row = (await getPool().query("SELECT score, max_score FROM simulation_sessions WHERE id = $1", [sessionId])).rows[0];
    // 10 (TPS) + 1 (PU) = 11, max 11
    expect(row.score).toBe(11);
    expect(row.max_score).toBe(11);
  });

  it("grades with category-specific scoring (one wrong, one blank)", async () => {
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers: authHeaders(studentToken) });
    const sessionId = start.json().data.sessionId as string;
    const answers = await getPool().query("SELECT id, question_id FROM simulation_answers WHERE session_id = $1", [sessionId]);
    for (const a of answers.rows) {
      const isTps = a.question_id === qTps.id;
      if (isTps) {
        // wrong answer for TPS
        await getPool().query("UPDATE simulation_answers SET selected_option_id = $1 WHERE id = $2", [qTps.optionIds[1], a.id]);
      }
      // PU left blank
    }
    await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessionId]);
    await simulationsService.gradeSession(sessionId);
    const row = (await getPool().query("SELECT score, max_score FROM simulation_sessions WHERE id = $1", [sessionId])).rows[0];
    // TPS wrong = 0, PU blank = 0 → score 0, max 11
    expect(row.score).toBe(0);
    expect(row.max_score).toBe(11);
  });

  it("falls back to base scoring for categories without an override", async () => {
    // Package with perCategory for TPS only; PU uses base (4)
    const pkg2 = await insertPackage({
      title: "PerCat Partial", status: "published",
      questionCounts: { TPS: 1, PU: 1 },
      scoring: { correct: 4, blank: 0, wrong: 0, perCategory: { TPS: { correct: 10, blank: 0, wrong: 0 } } } as never
    });
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkg2}/start`, headers: authHeaders(studentToken) });
    const sessionId = start.json().data.sessionId as string;
    const answers = await getPool().query("SELECT id, question_id FROM simulation_answers WHERE session_id = $1", [sessionId]);
    for (const a of answers.rows) {
      const opt = a.question_id === qTps.id ? qTps.optionIds[0] : qPu.optionIds[0];
      await getPool().query("UPDATE simulation_answers SET selected_option_id = $1 WHERE id = $2", [opt, a.id]);
    }
    await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessionId]);
    await simulationsService.gradeSession(sessionId);
    const row = (await getPool().query("SELECT score, max_score FROM simulation_sessions WHERE id = $1", [sessionId])).rows[0];
    // TPS 10 + PU 4 = 14, max 14
    expect(row.score).toBe(14);
    expect(row.max_score).toBe(14);
  });

  it("works without perCategory (base scoring unchanged)", async () => {
    const pkg3 = await insertPackage({
      title: "PerCat Plain", status: "published",
      questionCounts: { TPS: 1, PU: 1 },
      scoring: { correct: 4, blank: 0, wrong: 0 }
    });
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkg3}/start`, headers: authHeaders(studentToken) });
    const sessionId = start.json().data.sessionId as string;
    const answers = await getPool().query("SELECT id, question_id FROM simulation_answers WHERE session_id = $1", [sessionId]);
    for (const a of answers.rows) {
      const opt = a.question_id === qTps.id ? qTps.optionIds[0] : qPu.optionIds[0];
      await getPool().query("UPDATE simulation_answers SET selected_option_id = $1 WHERE id = $2", [opt, a.id]);
    }
    await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessionId]);
    await simulationsService.gradeSession(sessionId);
    const row = (await getPool().query("SELECT score, max_score FROM simulation_sessions WHERE id = $1", [sessionId])).rows[0];
    expect(row.score).toBe(8);
    expect(row.max_score).toBe(8);
  });
});
