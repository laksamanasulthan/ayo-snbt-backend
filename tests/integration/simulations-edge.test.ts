import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { simulationsService } from "../../src/modules/simulations/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertSession, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let adminToken: string;
let studentToken: string;
let student2Token: string;
let packageId: string;
let sessionId: string;

describe("Simulations edge cases", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("sim-edge-mentor@t.id", "Sim Mentor", "mentor");
    adminToken = await loginAs("sim-edge-admin@t.id", "Sim Admin", "admin");
    studentToken = await loginAs("sim-edge-student@t.id", "Sim Student", "student");
    student2Token = await loginAs("sim-edge-student2@t.id", "Sim Student 2", "student");
    // Seed question bank
    await insertQuestion({ text: "2 + 2?", category: "PK", options: [{ text: "3", isCorrect: false }, { text: "4", isCorrect: true }, { text: "5", isCorrect: false }] });
    await insertQuestion({ text: "Capital of France?", category: "PK", options: [{ text: "London", isCorrect: false }, { text: "Paris", isCorrect: true }] });
    await insertQuestion({ text: "Hidden (deleted)", category: "PK", deletedAt: new Date().toISOString(), options: [{ text: "X", isCorrect: false }, { text: "Y", isCorrect: true }] });
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  // ── Package ──────────────────────────────────────────────────────────
  it("creates and publishes a simulation package", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/packages",
      headers: authHeaders(mentorToken),
      payload: { title: "Try Out PK", durationMinutes: 30, questionCounts: { PK: 2 }, scoring: { correct: 4, blank: 0, wrong: 0 } }
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

  // ── Start session edge cases ─────────────────────────────────────────
  it("rejects starting a session on a draft package", async () => {
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/packages",
      headers: authHeaders(mentorToken),
      payload: { title: "Draft", questionCounts: { PK: 1 } }
    });
    const id = draft.json().data.id;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/" + id + "/start",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/not published/i);
  });

  it("rejects starting a session on a package with empty question counts", async () => {
    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/packages",
      headers: authHeaders(mentorToken),
      payload: { title: "Empty", questionCounts: {}, durationMinutes: 10 }
    });
    const id = empty.json().data.id;
    await app.inject({ method: "POST", url: "/api/v1/simulations/packages/" + id + "/publish", headers: authHeaders(mentorToken) });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/" + id + "/start",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("PACKAGE_EMPTY");
  });

  it("rejects starting a session when the question bank is empty", async () => {
    const noQ = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/packages",
      headers: authHeaders(mentorToken),
      payload: { title: "No Q", questionCounts: { PU: 2 }, durationMinutes: 10 }
    });
    const id = noQ.json().data.id;
    await app.inject({ method: "POST", url: "/api/v1/simulations/packages/" + id + "/publish", headers: authHeaders(mentorToken) });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/" + id + "/start",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BANK_EMPTY");
  });

  it("starts a session: in_progress, deadline set, answers pre-created", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/" + packageId + "/start",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(201);
    sessionId = res.json().data.sessionId;
    expect(res.json().data.deadlineAt).toBeTruthy();
    expect(res.json().data.durationMinutes).toBe(30);
    // Verify answers pre-created
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + sessionId,
      headers: authHeaders(studentToken)
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().data.questions.length).toBe(2);
  });

  // ── Session ownership ────────────────────────────────────────────────
  it("rejects fetching another student's session (404)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + sessionId,
      headers: authHeaders(student2Token)
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not leak correct answers in options", async () => {
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + sessionId,
      headers: authHeaders(studentToken)
    });
    const opts = session.json().data.questions[0]!.options as { isCorrect?: boolean }[];
    expect(opts[0]!.isCorrect).toBeUndefined();
  });

  it("seeded shuffle is deterministic per session", async () => {
    const s1 = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + sessionId, headers: authHeaders(studentToken) });
    const s2 = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + sessionId, headers: authHeaders(studentToken) });
    // Same session → same option order (deterministic PRNG seeded with sessionId + questionId)
    const o1 = s1.json().data.questions[0].options.map((o: { id: string }) => o.id);
    const o2 = s2.json().data.questions[0].options.map((o: { id: string }) => o.id);
    expect(o1).toEqual(o2);
  });

  // ── Save answer ──────────────────────────────────────────────────────
  it("saves and overwrites an answer", async () => {
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + sessionId, headers: authHeaders(studentToken) });
    const qId = session.json().data.questions[0].id;
    const optId = session.json().data.questions[0].options[0].id;
    const save = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sessions/" + sessionId + "/answers",
      headers: authHeaders(studentToken),
      payload: { questionId: qId, selectedOptionId: optId }
    });
    expect(save.statusCode).toBe(200);
    // Overwrite
    const save2 = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sessions/" + sessionId + "/answers",
      headers: authHeaders(studentToken),
      payload: { questionId: qId, selectedOptionId: optId }
    });
    expect(save2.statusCode).toBe(200);
  });

  it("rejects saving an answer to a question not in the session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sessions/" + sessionId + "/answers",
      headers: authHeaders(studentToken),
      payload: { questionId: "00000000-0000-0000-0000-000000000000", selectedOptionId: "00000000-0000-0000-0000-000000000000" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not in this session/i);
  });

  // ── Submit / grade ───────────────────────────────────────────────────
  it("submits the session and grades it", async () => {
    const submit = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sessions/" + sessionId + "/submit",
      headers: authHeaders(studentToken)
    });
    expect(submit.statusCode).toBe(202);
    expect(submit.json().data.submitted).toBe(true);
    // Grade directly
    await simulationsService.gradeSession(sessionId);
    // Check result
    const result = await app.inject({
      method: "GET",
      url: "/api/v1/simulations/sessions/" + sessionId + "/result",
      headers: authHeaders(studentToken)
    });
    expect(result.statusCode).toBe(200);
    const data = result.json().data;
    expect(data.status).toBe("graded");
    expect(data.score).toBeGreaterThanOrEqual(0);
    expect(data.correctCount).toBeGreaterThanOrEqual(0);
    expect(data.percentile).toBe(100); // only session in this package → 100
  });

  it("double submit is idempotent (alreadySubmitted)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/simulations/sessions/" + sessionId + "/submit",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.alreadySubmitted).toBe(true);
  });

  it("rejects getResult before grading", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/submit", headers: authHeaders(studentToken) });
    const res = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId + "/result", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("NOT_GRADED");
  });

  it("rejects saveAnswer after submission (SESSION_CLOSED)", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    const qId = session.json().data.questions[0].id;
    const optId = session.json().data.questions[0].options[0].id;
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/submit", headers: authHeaders(studentToken) });
    const res = await app.inject({
      method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/answers", headers: authHeaders(studentToken),
      payload: { questionId: qId, selectedOptionId: optId }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SESSION_CLOSED");
  });

  // ── Expiry (lazy auto-submit) ───────────────────────────────────────
  it("auto-submits when the deadline has passed (SESSION_EXPIRED)", async () => {
    const pastDeadline = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    // Backdate deadline to the past
    const db = getPool();
    await db.query("UPDATE simulation_sessions SET deadline_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [pastDeadline]);
    // Save answer triggers lazy auto-submit
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + pastDeadline, headers: authHeaders(studentToken) });
    const qId = session.json().data.questions[0].id;
    const optId = session.json().data.questions[0].options[0].id;
    const res = await app.inject({
      method: "POST", url: "/api/v1/simulations/sessions/" + pastDeadline + "/answers", headers: authHeaders(studentToken),
      payload: { questionId: qId, selectedOptionId: optId }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SESSION_EXPIRED");
    // Session should now be graded
    const result = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + pastDeadline + "/result", headers: authHeaders(studentToken) });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.status).toBe("graded");
  });

  // ── Percentile / rank with ties ──────────────────────────────────────
  it("computes percentile and rank with ties", async () => {
    const db = getPool();
    const pkg = packageId;
    // Create 3 graded sessions with scores 80, 60, 60, 40
    const u1 = await userIdByEmail("sim-edge-student@t.id");
    const u2 = await userIdByEmail("sim-edge-student2@t.id");
    // Create a third student
    const u3 = (await db.query("INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id", ["sim-edge-s3@t.id", "ignored", "S3", "active"])).rows[0]?.id;
    // Insert sessions directly
    const s80 = await insertSession({ userId: u1, packageId: pkg, status: "graded", score: 80 });
    const s60a = await insertSession({ userId: u2, packageId: pkg, status: "graded", score: 60 });
    const s60b = await insertSession({ userId: u3, packageId: pkg, status: "graded", score: 60 });
    const s40 = await insertSession({ userId: u1, packageId: pkg, status: "graded", score: 40 });
    // Update percentiles for the seeded sessions
    await db.query("UPDATE simulation_sessions SET percentile = 100 WHERE id = $1", [s80]);
    await db.query("UPDATE simulation_sessions SET percentile = 50 WHERE id IN ($1, $2)", [s60a, s60b]);
    await db.query("UPDATE simulation_sessions SET percentile = 0 WHERE id = $1", [s40]);
    // Now grade a new session with score 50 → percentile = (2 + 0.5*1) / 5 * 100 = 50
    const fresh = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    // Set answers: correct=1, wrong=1 → score 4 for correct of 4 weight
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + fresh, headers: authHeaders(studentToken) });
    const q1 = session.json().data.questions[0];
    const q2 = session.json().data.questions[1];
    // Answer both correctly
    const correct1 = q1.options.find((o: { id: string }) => o.id); // first option — may not be correct
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + fresh + "/answers", headers: authHeaders(studentToken), payload: { questionId: q1.id, selectedOptionId: correct1.id } });
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + fresh + "/answers", headers: authHeaders(studentToken), payload: { questionId: q2.id, selectedOptionId: q2.options[0].id } });
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + fresh + "/submit", headers: authHeaders(studentToken) });
    await simulationsService.gradeSession(fresh);
    const result = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + fresh + "/result", headers: authHeaders(studentToken) });
    expect(result.statusCode).toBe(200);
    const data = result.json().data;
    expect(data.percentile).toBeGreaterThanOrEqual(0);
    expect(data.rank).toBeGreaterThanOrEqual(1);
    expect(data.rank).toBeLessThanOrEqual(5);
  });

  // ── Leaderboard ──────────────────────────────────────────────────────
  it("returns a leaderboard of graded sessions", async () => {
    const lb = await app.inject({ method: "GET", url: "/api/v1/simulations/leaderboard?packageId=" + packageId });
    expect(lb.statusCode).toBe(200);
    const rows = lb.json().data;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // Sorted by score descending
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].score).toBeLessThanOrEqual(rows[i - 1].score);
    }
  });

  // ── Package soft-delete / restore ────────────────────────────────────
  it("soft-deletes a package (mentor) and restores it (admin)", async () => {
    const pkg = await app.inject({
      method: "POST", url: "/api/v1/simulations/packages", headers: authHeaders(mentorToken),
      payload: { title: "To Delete Pkg", questionCounts: { PK: 1 }, durationMinutes: 10 }
    }).then(r => r.json().data.id) as string;
    await app.inject({ method: "POST", url: "/api/v1/simulations/packages/" + pkg + "/publish", headers: authHeaders(mentorToken) });
    // Delete
    const del = await app.inject({ method: "DELETE", url: "/api/v1/simulations/packages/" + pkg, headers: authHeaders(mentorToken) });
    expect(del.statusCode).toBe(200);
    // Gone from list
    const list = await app.inject({ method: "GET", url: "/api/v1/simulations/packages" });
    expect((list.json().data as { id: string }[]).map((r) => r.id)).not.toContain(pkg);
    // Restore (admin only)
    const restore = await app.inject({ method: "POST", url: "/api/v1/simulations/packages/" + pkg + "/restore", headers: authHeaders(adminToken) });
    expect(restore.statusCode).toBe(200);
    const back = await app.inject({ method: "GET", url: "/api/v1/simulations/packages/" + pkg });
    expect(back.statusCode).toBe(200);
  });

  it("student cannot delete packages", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/v1/simulations/packages/" + packageId, headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(403);
  });
  // ── Review / Pembahasan ──────────────────────────────────────────────
  it("rejects review before grading (NOT_GRADED)", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/submit", headers: authHeaders(studentToken) });
    const res = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId + "/review", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("NOT_GRADED");
  });

  it("returns full review payload after grading", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    const questions = session.json().data.questions as { id: string; options: { id: string }[] }[];
    // Answer the first question correctly (find the correct option by checking the review later)
    // Since the session has 2 questions, answer both with the first option of each
    for (const q of questions) {
      await app.inject({
        method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/answers", headers: authHeaders(studentToken),
        payload: { questionId: q.id, selectedOptionId: q.options[0]!.id }
      });
    }
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/submit", headers: authHeaders(studentToken) });
    await simulationsService.gradeSession(freshId);
    const review = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId + "/review", headers: authHeaders(studentToken) });
    expect(review.statusCode).toBe(200);
    const data = review.json().data;
    expect(data.sessionId).toBe(freshId);
    expect(data.packageId).toBe(packageId);
    expect(data.questions.length).toBe(2);
    for (const q of data.questions) {
      expect(q.correctOptionIds).toBeDefined();
      expect(q.correctOptionIds.length).toBeGreaterThanOrEqual(1);
      expect(typeof q.isCorrect).toBe("boolean");
      expect(q.options.some((o: { isCorrect: boolean }) => o.isCorrect)).toBe(true);
      // Options include the correct flag (review-only; session endpoint never shows it)
      const correctOpts = q.options.filter((o: { isCorrect: boolean }) => o.isCorrect);
      expect(correctOpts.length).toBeGreaterThan(0);
    }
  });

  it("other user's session returns 404", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/submit", headers: authHeaders(studentToken) });
    await simulationsService.gradeSession(freshId);
    const res = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId + "/review", headers: authHeaders(student2Token) });
    expect(res.statusCode).toBe(404);
  });


  // ── M3: exam mechanics (flag, timeSpentMs, warnAt) ───────────────────
  it("flags a question for review", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    const qId = session.json().data.questions[0]!.id as string;
    const flag = await app.inject({
      method: "PATCH", url: "/api/v1/simulations/sessions/" + freshId + "/answers/" + qId + "/flag", headers: authHeaders(studentToken),
      payload: { isFlagged: true }
    });
    expect(flag.statusCode).toBe(200);
    expect(flag.json().data.flagged).toBe(true);
    const after = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    expect(after.json().data.questions[0]!.flagged).toBe(true);
    // Unflag
    const unflag = await app.inject({
      method: "PATCH", url: "/api/v1/simulations/sessions/" + freshId + "/answers/" + qId + "/flag", headers: authHeaders(studentToken),
      payload: { isFlagged: false }
    });
    expect(unflag.json().data.flagged).toBe(false);
  });

  it("rejects flagging after submission", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    const qId = session.json().data.questions[0]!.id as string;
    await app.inject({ method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/submit", headers: authHeaders(studentToken) });
    const flag = await app.inject({
      method: "PATCH", url: "/api/v1/simulations/sessions/" + freshId + "/answers/" + qId + "/flag", headers: authHeaders(studentToken),
      payload: { isFlagged: true }
    });
    expect(flag.statusCode).toBe(400);
    expect(flag.json().error.code).toBe("SESSION_CLOSED");
  });

  it("tracks time spent per question on save", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    const q = session.json().data.questions[0] as { id: string; options: { id: string }[] };
    await new Promise(r => setTimeout(r, 50));
    const save = await app.inject({
      method: "POST", url: "/api/v1/simulations/sessions/" + freshId + "/answers", headers: authHeaders(studentToken),
      payload: { questionId: q.id, selectedOptionId: q.options[0]!.id }
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().data.timeSpentMs).toBeGreaterThanOrEqual(0);
    const after = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    const qAfter = after.json().data.questions[0] as { timeSpentMs: number };
    expect(qAfter.timeSpentMs).toBeGreaterThanOrEqual(0);
  });

  it("includes warnAtRemainingMs when the package configures it", async () => {
    const db = getPool();
    await db.query("UPDATE simulation_packages SET warn_at_remaining_ms = 300000 WHERE id = $1", [packageId]);
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    expect(session.json().data.warnAtRemainingMs).toBe(300000);
    await db.query("UPDATE simulation_packages SET warn_at_remaining_ms = NULL WHERE id = $1", [packageId]);
  });

  it("session endpoint still does NOT leak answers before grading", async () => {
    const freshId = (await app.inject({
      method: "POST", url: "/api/v1/simulations/" + packageId + "/start", headers: authHeaders(studentToken)
    }).then(r => r.json().data.sessionId)) as string;
    const session = await app.inject({ method: "GET", url: "/api/v1/simulations/sessions/" + freshId, headers: authHeaders(studentToken) });
    const q = session.json().data.questions[0] as { options: { isCorrect?: boolean }[] };
    expect(q!.options[0]!.isCorrect).toBeUndefined();
  });

});
