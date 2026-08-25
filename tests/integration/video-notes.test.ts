import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import { simulationsService } from "../../src/modules/simulations/index.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, insertPackage,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let qWithVid: { id: string; optionIds: string[] };
let qWithoutVid: { id: string; optionIds: string[] };
let pkgId: string;

describe("N3 — Explanation videos in review", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("vn-student@t.id", "VN Student", "student");
    qWithVid = await insertQuestion({ text: "Vid Q?", category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] });
    qWithoutVid = await insertQuestion({ text: "NoVid Q?", category: "TPS", options: [{ text: "C", isCorrect: true }, { text: "D", isCorrect: false }] });
    // Set videoKey on one question
    await getPool().query("UPDATE questions SET video_key = 'https://cdn.example.com/explainer.mp4' WHERE id = $1", [qWithVid.id]);
    pkgId = await insertPackage({ title: "VN Pkg", status: "published", questionCounts: { TPS: 2 }, scoring: { correct: 4, blank: 0, wrong: 0 } });
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("includes a presigned videoUrl in review when videoKey is set", async () => {
    const start = await app.inject({ method: "POST", url: `/api/v1/simulations/${pkgId}/start`, headers: authHeaders(studentToken) });
    const sessionId = start.json().data.sessionId as string;
    const answers = await getPool().query("SELECT id, question_id FROM simulation_answers WHERE session_id = $1", [sessionId]);
    for (const a of answers.rows) {
      const opts = a.question_id === qWithVid.id ? qWithVid.optionIds : qWithoutVid.optionIds;
      await getPool().query("UPDATE simulation_answers SET selected_option_id = $1, answered_at = NOW() WHERE id = $2", [opts[0], a.id]);
    }
    await getPool().query("UPDATE simulation_sessions SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [sessionId]);
    await simulationsService.gradeSession(sessionId);
    const review = await app.inject({ method: "GET", url: `/api/v1/simulations/sessions/${sessionId}/review`, headers: authHeaders(studentToken) });
    expect(review.statusCode).toBe(200);
    const data = review.json().data as { questions: Array<{ questionId: string; videoUrl: string | null }> };
    const items = data.questions;
    const withVid = items.find((i) => i.questionId === qWithVid.id);
    const withoutVid = items.find((i) => i.questionId === qWithoutVid.id);
    expect(withVid!.videoUrl).toBeTruthy(); // presigned or whatever was stored
    expect(withoutVid!.videoUrl).toBeNull();
  });

  it("creates a question with videoKey via API", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions", headers: authHeaders(await loginAs("vm-mentor@t.id", "VM Mentor", "mentor")),
      payload: { text: "API with vid", category: "PK", videoKey: "videos/api-test.mp4", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] }
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().data as { videoKey: string }).videoKey).toBe("videos/api-test.mp4");
  });
});
