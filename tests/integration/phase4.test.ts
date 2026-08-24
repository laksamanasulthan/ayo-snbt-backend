import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { getPool } from "../../src/shared/db/client.js";
import { accessCookieName } from "../../src/shared/auth/index.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let mentorToken: string;
let studentToken: string;
let packageId: string;
let sessionId: string;

function authHeaders(token: string): Record<string, string> {
  return { cookie: accessCookieName() + "=" + token + "; csrf_token=test", "x-csrf-token": "test" };
}

async function truncateDb() {
  const pool = getPool();
  await pool.query("TRUNCATE TABLE simulation_answers, simulation_sessions, simulation_packages, question_options, questions, user_roles, users RESTART IDENTITY CASCADE");
}

async function loginAs(email: string, name: string, role: string): Promise<string> {
  const db = getPool();
  const user = await db.query("INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id", [email, "ignored", name, "active"]);
  const userId = user.rows[0]?.id as string;
  const roleRow = await db.query("SELECT id FROM roles WHERE name = $1", [role]);
  if (roleRow.rows[0]) await db.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleRow.rows[0].id]);
  const { issueAccessToken } = await import("../../src/modules/auth/index.js");
  return issueAccessToken(userId, email);
}

describe("Phase 4: SNBT simulations", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildApp({ minimal: true, logger: false, degradation: new DegradationManager(), healthRegistry: new HealthRegistry() });
    await app.ready();
    mentorToken = await loginAs("sim-mentor@t.id", "Sim Mentor", "mentor");
    studentToken = await loginAs("sim-student@t.id", "Sim Student", "student");
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("creates 4 questions in the bank (mentor)", async () => {
    const qs = [
      { text: "2 + 2 = ?", category: "TPS_PK", difficulty: "easy", options: [{ text: "3", isCorrect: false }, { text: "4", isCorrect: true }, { text: "5", isCorrect: false }] },
      { text: "Ibukota Indonesia?", category: "TPS_PK", difficulty: "easy", options: [{ text: "Bandung", isCorrect: false }, { text: "Jakarta", isCorrect: true }] },
      { text: "Akar dari 9?", category: "TPS_PK", difficulty: "easy", options: [{ text: "2", isCorrect: false }, { text: "3", isCorrect: true }] },
      { text: "Siapa presiden pertama RI?", category: "TPS_PK", difficulty: "medium", options: [{ text: "Sukarno", isCorrect: true }, { text: "Suharto", isCorrect: false }] }
    ];
    for (const q of qs) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/questions",
        headers: authHeaders(mentorToken),
        payload: q
      });
      expect(res.statusCode).toBe(201);
    }
  });

  it("creates and publishes a simulation package", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/packages",
      headers: authHeaders(mentorToken),
      payload: { title: "Simulasi TPS 1", durationMinutes: 30, questionCounts: { TPS_PK: 4 }, scoring: { correct: 4, blank: 0, wrong: 0 } }
    });
    expect(res.statusCode).toBe(201);
    packageId = res.json().data.id;
    const pub = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/packages/" + packageId + "/publish",
      headers: authHeaders(mentorToken)
    });
    expect(pub.statusCode).toBe(200);
  });

  it("starts a session with server-assigned questions (no correct answers leaked)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/" + packageId + "/start",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(201);
    sessionId = res.json().data.sessionId;
    expect(res.json().data.deadlineAt).toBeTruthy();
    expect(res.json().data.durationMinutes).toBe(30);

    const sess = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + sessionId,
      headers: authHeaders(studentToken)
    });
    expect(sess.statusCode).toBe(200);
    const questionsOut = sess.json().data.questions;
    expect(questionsOut.length).toBe(4);
    for (const q of questionsOut) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(q.options[0].isCorrect).toBeUndefined();
      expect(q.options[0].id).toBeTruthy();
    }
    // Stable question order across fetches (seeded per session)
    const sess2 = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + sessionId,
      headers: authHeaders(studentToken)
    });
    const firstOrder = questionsOut.map((q: { id: string }) => q.id).join(",");
    const secondOrder = sess2.json().data.questions.map((q: { id: string }) => q.id).join(",");
    expect(secondOrder).toBe(firstOrder);
  });

  it("answers questions, submits, and grades via the processor", async () => {
    const sess = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + sessionId,
      headers: authHeaders(studentToken)
    });
    const questionsOut = sess.json().data.questions;
    for (const q of questionsOut) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/simulations/sessions/" + sessionId + "/answers",
        headers: authHeaders(studentToken),
        payload: { questionId: q.id, selectedOptionId: q.options[0].id }
      });
      expect(res.statusCode).toBe(200);
    }

    const sub = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sessions/" + sessionId + "/submit",
      headers: authHeaders(studentToken)
    });
    expect(sub.statusCode).toBe(202);

    const { processGradingJob } = await import("../../src/modules/simulations/index.js");
    await processGradingJob({ type: "grade", sessionId });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + sessionId + "/result",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().data;
    expect(result.status).toBe("graded");
    expect(result.maxScore).toBe(16); // 4 questions x 4 points
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.percentile).toBeGreaterThanOrEqual(0);
    expect(result.rank).toBe(1);
  });

  it("shows the student on the leaderboard", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/leaderboard?packageId=" + packageId
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThanOrEqual(1);
    expect(res.json().data[0].name).toBe("Sim Student");
  });

  it("auto-submits expired sessions via the delayed processor", async () => {
    const db = getPool();
    const userRow = await db.query("SELECT id FROM users WHERE email = $1", ["sim-student@t.id"]);
    const userId = userRow.rows[0]?.id as string;
    const INTERVAL_2H = "NOW() - INTERVAL '2 hours'";
    const sess = await db.query("INSERT INTO simulation_sessions (user_id, package_id, status, started_at, deadline_at) VALUES ($1, $2, $3, " + INTERVAL_2H + ", NOW() - INTERVAL '1 hour') RETURNING id", [userId, packageId, "in_progress"]);
    const expiredId = sess.rows[0]?.id as string;
    const { processGradingJob } = await import("../../src/modules/simulations/index.js");
    await processGradingJob({ type: "auto-submit", sessionId: expiredId });
    const after = await db.query("SELECT status FROM simulation_sessions WHERE id = $1", [expiredId]);
    expect(after.rows[0]?.status).toBe("graded");
  });

  it("lazily auto-submits when answering past the deadline", async () => {
    const db = getPool();
    const userRow = await db.query("SELECT id FROM users WHERE email = $1", ["sim-student@t.id"]);
    const userId = userRow.rows[0]?.id as string;
    const INTERVAL_2H = "NOW() - INTERVAL '2 hours'";
    const sess = await db.query("INSERT INTO simulation_sessions (user_id, package_id, status, started_at, deadline_at) VALUES ($1, $2, $3, " + INTERVAL_2H + ", NOW() - INTERVAL '1 hour') RETURNING id", [userId, packageId, "in_progress"]);
    const expiredId = sess.rows[0]?.id as string;
    // Give the session one question (answer row) so the session has content
    const qRow = await db.query("SELECT id FROM questions LIMIT 1");
    await db.query("INSERT INTO simulation_answers (session_id, question_id, sort_order) VALUES ($1, $2, 0)", [expiredId, qRow.rows[0].id]);
    const view = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + expiredId,
      headers: authHeaders(studentToken)
    });
    const q = view.json().data.questions[0];
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sessions/" + expiredId + "/answers",
      headers: authHeaders(studentToken),
      payload: { questionId: q.id, selectedOptionId: q.options[0].id }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SESSION_EXPIRED");
    const after = await db.query("SELECT status FROM simulation_sessions WHERE id = $1", [expiredId]);
    expect(after.rows[0]?.status).toBe("graded");
  });
});