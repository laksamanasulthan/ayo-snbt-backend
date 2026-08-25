import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let studentToken: string;
let studentId: string;
let qA: { id: string; optionIds: string[] };
let qB: { id: string; optionIds: string[] };

describe("N1 — Daily challenge + streak", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("ch-mentor@t.id", "CH Mentor", "mentor");
    studentToken = await loginAs("ch-student@t.id", "CH Student", "student");
    studentId = await userIdByEmail("ch-student@t.id");
    qA = await insertQuestion({ text: "Ch A?", category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    qB = await insertQuestion({ text: "Ch B?", category: "PK", options: [{ text: "C", isCorrect: true }, { text: "D", isCorrect: false }] });
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("requires auth on challenge endpoints", async () => {
    const r1 = await app.inject({ method: "GET", url: "/api/v1/challenges/today" });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({ method: "GET", url: "/api/v1/challenges/streak" });
    expect(r2.statusCode).toBe(401);
  });

  it("serves a random question of the day without leaking answers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/challenges/today", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.question.id).toBeTruthy();
    const opts = data.question.options as Array<{ isCorrect?: boolean }>;
    expect(opts[0]?.isCorrect).toBeUndefined(); // no correct flags
  });

  it("pins today's question as admin and serves it", async () => {
    const pin = await app.inject({
      method: "POST", url: "/api/v1/admin/challenges/today", headers: authHeaders(mentorToken),
      payload: { questionId: qB.id }
    });
    expect(pin.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/v1/challenges/today", headers: authHeaders(studentToken) });
    expect(res.json().data.question.id).toBe(qB.id);
  });

  it("computes streak from practice answers", async () => {
    const s0 = await app.inject({ method: "GET", url: "/api/v1/challenges/streak", headers: authHeaders(studentToken) });
    expect(s0.json().data.streak).toBe(0);
    // Answer one practice question today
    const start = await app.inject({
      method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
      payload: { questionIds: [qA.id] }
    });
    const practiceId = start.json().data.practiceId as string;
    await app.inject({
      method: "POST", url: "/api/v1/practice/" + practiceId + "/answer", headers: authHeaders(studentToken),
      payload: { questionId: qA.id, selectedOptionId: qA.optionIds[0] }
    });
    const s1 = await app.inject({ method: "GET", url: "/api/v1/challenges/streak", headers: authHeaders(studentToken) });
    expect(s1.json().data.streak).toBe(1);
    // Yesterday's answer → streak 2 (today + yesterday)
    const y = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
    await getPool().query(
      "INSERT INTO simulation_sessions (user_id, type, status, started_at, deadline_at) VALUES ($1, 'practice', 'in_progress', $2::date, NOW() + interval '1 day') RETURNING id",
      [studentId, y]
    ).then(async (r) => {
      const sid = r.rows[0]?.id;
      await getPool().query(
        "INSERT INTO simulation_answers (session_id, question_id, selected_option_id, answered_at) VALUES ($1, $2, $3, $4::date)",
        [sid, qB.id, qB.optionIds[0], y]
      );
    });
    const s2 = await app.inject({ method: "GET", url: "/api/v1/challenges/streak", headers: authHeaders(studentToken) });
    expect(s2.json().data.streak).toBe(2);
  });
});
