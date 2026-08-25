import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { simulationsService } from "../../src/modules/simulations/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let aliceToken: string;
let bobToken: string;
let carolToken: string;
let aliceId: string;
let bobId: string;
let carolId: string;
let pkgId: string;

/** Grade a session for user with the given score (direct answer manipulation). */
async function gradeFor(userId: string, score: number, submittedAt: Date): Promise<void> {
  const start = await app.inject({
    method: "POST", url: `/api/v1/simulations/${pkgId}/start`,
    headers: authHeaders(await tokenFor(userId))
  });
  const sessionId = start.json().data.sessionId as string;
  // Answer correctly the right number of times to hit the score (4 pts each),
  // each with ITS OWN question's correct option
  const correctCount = Math.floor(score / 4);
  const answers = await getPool().query("SELECT id, question_id FROM simulation_answers WHERE session_id = $1 ORDER BY sort_order LIMIT $2", [sessionId, correctCount]);
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
  await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = $1 WHERE id = $2", [submittedAt.toISOString(), sessionId]);
  await simulationsService.gradeSession(sessionId);
}

async function tokenFor(userId: string): Promise<string> {
  return userId === aliceId ? aliceToken : userId === bobId ? bobToken : carolToken;
}

describe("A7 — Leaderboard periods + friends", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    aliceToken = await loginAs("lb-alice@t.id", "LB Alice", "student");
    bobToken = await loginAs("lb-bob@t.id", "LB Bob", "student");
    carolToken = await loginAs("lb-carol@t.id", "LB Carol", "student");
    aliceId = await userIdByEmail("lb-alice@t.id");
    bobId = await userIdByEmail("lb-bob@t.id");
    carolId = await userIdByEmail("lb-carol@t.id");
    await insertQuestion({ text: "LB Q?", category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    // 4 more TPS questions so every session contains 5 answerable questions
    for (let i = 1; i <= 4; i++) {
      await insertQuestion({ text: "LB Q" + i + "?", category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    }
    pkgId = await insertPackage({ title: "LB Pkg", status: "published", questionCounts: { TPS: 5 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
    // Scores: alice 16 (2w ago), bob 12 (yesterday), carol 8 (2 days ago)
    await gradeFor(aliceId, 16, new Date(Date.now() - 14 * 24 * 3600_000));
    await gradeFor(bobId, 12, new Date(Date.now() - 24 * 3600_000));
    await gradeFor(carolId, 8, new Date(Date.now() - 2 * 24 * 3600_000));
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("returns all periods by default (all)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/simulations/leaderboard?packageId=" + pkgId });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ userId: string; score: number }>;
    expect(rows.length).toBe(3);
    expect(rows[0]!.userId).toBe(aliceId); // highest score first
  });

  it("filters by week period (last 7 days)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/simulations/leaderboard?packageId=${pkgId}&period=week` });
    const rows = res.json().data as Array<{ userId: string }>;
    expect(rows.length).toBe(2); // alice's 14d-old submission excluded
    expect(rows.some((r) => r.userId === aliceId)).toBe(false);
    expect(rows.some((r) => r.userId === bobId)).toBe(true);
  });

  it("filters by month period (last 30 days)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/simulations/leaderboard?packageId=${pkgId}&period=month` });
    expect((res.json().data as unknown[]).length).toBe(3);
  });

  it("returns personal rank in meta for authed requests", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/simulations/leaderboard?packageId=${pkgId}`, headers: authHeaders(bobToken) });
    const meta = res.json().meta as { leaderboard: { personalRank: number | null } };
    expect(meta.leaderboard.personalRank).toBe(2); // bob is #2 behind alice
    // Alice is #1
    const res2 = await app.inject({ method: "GET", url: `/api/v1/simulations/leaderboard?packageId=${pkgId}`, headers: authHeaders(aliceToken) });
    expect((res2.json().meta as { leaderboard: { personalRank: number | null } }).leaderboard.personalRank).toBe(1);
    // Anon → no personalRank
    const anon = await app.inject({ method: "GET", url: `/api/v1/simulations/leaderboard?packageId=${pkgId}` });
    expect((anon.json().meta as { leaderboard?: { personalRank: number | null } }).leaderboard?.personalRank).toBeNull();
  });

  it("follows/unfollows users and lists following", async () => {
    // Bob follows Alice and Carol
    const f1 = await app.inject({ method: "POST", url: `/api/v1/users/${aliceId}/follow`, headers: authHeaders(bobToken) });
    expect(f1.statusCode).toBe(200);
    expect(f1.json().data.following).toBe(true);
    await app.inject({ method: "POST", url: `/api/v1/users/${carolId}/follow`, headers: authHeaders(bobToken) });
    const list = await app.inject({ method: "GET", url: "/api/v1/users/me/following", headers: authHeaders(bobToken) });
    const following = list.json().data as Array<{ id: string }>;
    expect(following.length).toBe(2);
    // Unfollow Alice
    const uf = await app.inject({ method: "DELETE", url: `/api/v1/users/${aliceId}/follow`, headers: authHeaders(bobToken) });
    expect(uf.json().data.following).toBe(false);
    // Cannot follow yourself
    const self = await app.inject({ method: "POST", url: `/api/v1/users/${bobId}/follow`, headers: authHeaders(bobToken) });
    expect(self.statusCode).toBe(400);
    // Unknown user → 404
    const missing = await app.inject({ method: "POST", url: `/api/v1/users/${crypto.randomUUID()}/follow`, headers: authHeaders(bobToken) });
    expect(missing.statusCode).toBe(404);
  });

  it("friends=true shows only followed users", async () => {
    // Bob now follows only Carol
    const res = await app.inject({ method: "GET", url: `/api/v1/simulations/leaderboard?packageId=${pkgId}&friends=true`, headers: authHeaders(bobToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ userId: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(carolId);
    // Bob has no session among his follows (he doesn't follow himself) → null
    const meta = res.json().meta as { leaderboard: { personalRank: number | null } };
    expect(meta.leaderboard.personalRank).toBeNull();
  });
});
