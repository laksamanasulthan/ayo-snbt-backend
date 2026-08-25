import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { simulationsService } from "../../src/modules/simulations/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let adminToken: string;
let studentToken: string;
let mentorId: string;
let qAljabar: { id: string; optionIds: string[] };
let qGeometri: { id: string; optionIds: string[] };

describe("A10 — Content quality", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("cq-mentor@t.id", "CQ Mentor", "mentor");
    adminToken = await loginAs("cq-admin@t.id", "CQ Admin", "admin");
    studentToken = await loginAs("cq-student@t.id", "CQ Student", "student");
    mentorId = await userIdByEmail("cq-mentor@t.id");
    qAljabar = await insertQuestion({ text: "Aljabar Q?", category: "TPS", createdBy: mentorId, options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    qGeometri = await insertQuestion({ text: "Geometri Q?", category: "TPS", createdBy: mentorId, options: [{ text: "C", isCorrect: true }, { text: "D", isCorrect: false }] });
    // Tags
    for (const [qid, tag] of [[qAljabar.id, "aljabar"], [qGeometri.id, "geometri"]] as const) {
      await getPool().query("INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [tag]);
      const t = await getPool().query("SELECT id FROM tags WHERE name = $1", [tag]);
      await getPool().query("INSERT INTO question_tags (question_id, tag_id) VALUES ($1, $2)", [qid, t.rows[0]?.id]);
    }
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("accepts source + reviewStatus on create", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions", headers: authHeaders(mentorToken),
      payload: { text: "Source Q?", category: "PK", source: { origin: "utbk-2023", year: 2023 }, reviewStatus: "in_review", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] }
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.source).toEqual({ origin: "utbk-2023", year: 2023 });
    expect(data.reviewStatus).toBe("in_review");
    // Cleanup
    await getPool().query("DELETE FROM questions WHERE id = $1", [data.id]);
  });

  it("updates reviewStatus and source (null reviewStatus → draft)", async () => {
    const up = await app.inject({
      method: "PATCH", url: `/api/v1/questions/${qAljabar.id}`, headers: authHeaders(mentorToken),
      payload: { source: { origin: "tryout-1" }, reviewStatus: null }
    });
    expect(up.statusCode).toBe(200);
    const data = up.json().data;
    expect(data.source).toEqual({ origin: "tryout-1" });
    expect(data.reviewStatus).toBe("draft");
  });

  it("imports source/reviewStatus via JSON import", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import", headers: { ...authHeaders(mentorToken), "content-type": "application/json" },
      payload: { questions: [{ text: "Import Source Q " + Date.now(), category: "TPS", source: { origin: "custom" }, reviewStatus: "published", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] }] }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.imported).toBe(1);
  });

  it("rejects bad reviewStatus and source on import", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import", headers: { ...authHeaders(mentorToken), "content-type": "application/json" },
      payload: { questions: [
        { text: "Bad status " + Date.now(), options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }], reviewStatus: "banana" },
        { text: "Bad source " + Date.now(), options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }], source: { origin: "" } }
      ] }
    });
    const data = res.json().data;
    expect(data.imported).toBe(0);
    expect(data.failed.length).toBe(2);
  });

  it("computes per-tag accuracy from graded answers", async () => {
    // One practice session per tagged question: aljabar correct, geometri wrong
    const runSession = async (questionId: string, optionId: string | undefined) => {
      const start = await app.inject({
        method: "POST", url: "/api/v1/practice/start", headers: authHeaders(studentToken),
        payload: { questionIds: [questionId] }
      });
      const practiceId = start.json().data.practiceId as string;
      if (optionId) {
        await app.inject({
          method: "POST", url: "/api/v1/practice/" + practiceId + "/answer", headers: authHeaders(studentToken),
          payload: { questionId, selectedOptionId: optionId }
        });
      }
      await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [practiceId]);
      await simulationsService.gradeSession(practiceId);
    };
    await runSession(qAljabar.id, qAljabar.optionIds[0]);
    await runSession(qGeometri.id, qGeometri.optionIds[1]);

    const res = await app.inject({ method: "GET", url: "/api/v1/admin/questions/stats/tag-accuracy", headers: authHeaders(adminToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ tag: string; attempts: number; accuracy: number }>;
    const aljabar = rows.find((r) => r.tag === "aljabar");
    const geometri = rows.find((r) => r.tag === "geometri");
    expect(aljabar!.attempts).toBe(1);
    expect(aljabar!.accuracy).toBe(100);
    expect(geometri!.attempts).toBe(1);
    expect(geometri!.accuracy).toBe(0);
    // Non-admin blocked
    const forbidden = await app.inject({ method: "GET", url: "/api/v1/admin/questions/stats/tag-accuracy", headers: authHeaders(mentorToken) });
    expect(forbidden.statusCode).toBe(403);
  });
});
