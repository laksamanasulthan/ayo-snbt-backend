import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertQuestion, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let studentToken: string;
let otherToken: string;
let mentorId: string;
let questionId: string;

describe("A3 — Question Q&A", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("qa-mentor@t.id", "QA Mentor", "mentor");
    studentToken = await loginAs("qa-student@t.id", "QA Student", "student");
    otherToken = await loginAs("qa-other@t.id", "QA Other", "student");
    mentorId = await userIdByEmail("qa-mentor@t.id");
    questionId = (await insertQuestion({ text: "A3 Q?", category: "TPS", createdBy: mentorId, options: [{ text: "A", isCorrect: true }] })).id;
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("returns an empty thread for a fresh question", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/thread`, headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.question.id).toBe(questionId);
    expect(data.replies).toEqual([]);
  });

  it("adds replies and lists them newest-first with author names", async () => {
    const r1 = await app.inject({ method: "POST", url: `/api/v1/questions/${questionId}/replies`, headers: authHeaders(studentToken), payload: { body: "Bisa tolong dijelaskan?" } });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({ method: "POST", url: `/api/v1/questions/${questionId}/replies`, headers: authHeaders(mentorToken), payload: { body: "Tentu! Caranya begini…" } });
    expect(r2.statusCode).toBe(201);
    const thread = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/thread`, headers: authHeaders(studentToken) });
    const replies = thread.json().data.replies as Array<{ body: string; authorName: string; upvoteCount: number }>;
    expect(replies.length).toBe(2);
    expect(replies[0]!.authorName).toBe("QA Mentor"); // newest first
    expect(replies[0]!.body).toBe("Tentu! Caranya begini…");
    expect(replies[1]!.upvoteCount).toBe(0);
  });

  it("rejects empty and oversized reply bodies", async () => {
    const r1 = await app.inject({ method: "POST", url: `/api/v1/questions/${questionId}/replies`, headers: authHeaders(studentToken), payload: { body: "   " } });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({ method: "POST", url: `/api/v1/questions/${questionId}/replies`, headers: authHeaders(studentToken), payload: { body: "x".repeat(4001) } });
    expect(r2.statusCode).toBe(400);
  });

  it("404s replies for unknown questions", async () => {
    const res = await app.inject({ method: "POST", url: `/api/v1/questions/${crypto.randomUUID()}/replies`, headers: authHeaders(studentToken), payload: { body: "?" } });
    expect(res.statusCode).toBe(404);
  });

  it("upvotes idempotently and returns the count", async () => {
    const list = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/thread`, headers: authHeaders(studentToken) });
    const replyId = (list.json().data.replies as Array<{ id: string }>)[0]!.id;
    const v1 = await app.inject({ method: "POST", url: `/api/v1/replies/${replyId}/upvote`, headers: authHeaders(studentToken) });
    expect(v1.statusCode).toBe(200);
    expect(v1.json().data.upvoteCount).toBe(1);
    // Same user again → still 1
    const v2 = await app.inject({ method: "POST", url: `/api/v1/replies/${replyId}/upvote`, headers: authHeaders(studentToken) });
    expect(v2.json().data.upvoteCount).toBe(1);
    // Different user → 2
    const v3 = await app.inject({ method: "POST", url: `/api/v1/replies/${replyId}/upvote`, headers: authHeaders(otherToken) });
    expect(v3.json().data.upvoteCount).toBe(2);
  });

  it("requires auth for replies and upvotes", async () => {
    // Valid CSRF but no access token → authGuard rejects (401)
    const csrfOnly = { cookie: "csrf_token=test-csrf", "x-csrf-token": "test-csrf" };
    const r = await app.inject({ method: "POST", url: `/api/v1/questions/${questionId}/replies`, headers: csrfOnly, payload: { body: "x" } });
    expect(r.statusCode).toBe(401);
    const u = await app.inject({ method: "POST", url: `/api/v1/replies/${crypto.randomUUID()}/upvote`, headers: csrfOnly });
    expect(u.statusCode).toBe(401);
  });

  it("admin hide removes the reply from the thread (moderation)", async () => {
    const list = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/thread`, headers: authHeaders(studentToken) });
    const replies = list.json().data.replies as Array<{ id: string; body: string }>;
    const target = replies.find((r) => r.body.startsWith("Bisa tolong"));
    expect(target).toBeTruthy();
    const hide = await app.inject({ method: "POST", url: `/api/v1/admin/replies/${target!.id}/hide`, headers: authHeaders(mentorToken) });
    expect(hide.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/v1/questions/${questionId}/thread`, headers: authHeaders(studentToken) });
    const remaining = (after.json().data.replies as Array<{ id: string }>).map((r) => r.id);
    expect(remaining).not.toContain(target!.id);
    // Non-admin cannot hide
    const forbidden = await app.inject({ method: "POST", url: `/api/v1/admin/replies/${target!.id}/hide`, headers: authHeaders(studentToken) });
    expect(forbidden.statusCode).toBe(403);
  });
});
