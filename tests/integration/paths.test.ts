import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse, insertLesson, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let studentToken: string;
let studentId: string;
let courseA: string;
let courseB: string;
let lessonA1: string;
let pathId: string;

describe("A5 — Learning paths", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("lp-mentor@t.id", "LP Mentor", "mentor");
    studentToken = await loginAs("lp-student@t.id", "LP Student", "student");
    studentId = await userIdByEmail("lp-student@t.id");
    courseA = (await insertCourse({ title: "Matematika Dasar", status: "published" })).id;
    courseB = (await insertCourse({ title: "Bahasa Indonesia", status: "published" })).id;
    lessonA1 = await insertLesson({ courseId: courseA, title: "L1" });
    await insertLesson({ courseId: courseA, title: "L2", sortOrder: 2 });
    await insertLesson({ courseId: courseB, title: "B1" });
    // Mentor creates the path
    const created = await app.inject({
      method: "POST", url: "/api/v1/paths", headers: authHeaders(mentorToken),
      payload: { title: "SNBT 2026 Master Plan", description: "Dari nol", courseIds: [courseB, courseA] }
    });
    expect(created.statusCode).toBe(201);
    pathId = created.json().data.id as string;
    const published = await app.inject({
      method: "PATCH", url: `/api/v1/paths/${pathId}`, headers: authHeaders(mentorToken),
      payload: { status: "published" }
    });
    expect(published.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("lists published paths with courseCount", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/paths" });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; courseCount: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.courseCount).toBe(2);
  });

  it("returns path detail with ordered courses", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/paths/${pathId}` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.courses.length).toBe(2);
    expect(data.courses[0]!.title).toBe("Bahasa Indonesia"); // sortOrder 0 first
    expect(data.enrolled).toBe(false);
    expect(data.progress).toBeNull();
  });

  it("enrolls idempotently and unlocks progress rollup", async () => {
    const r1 = await app.inject({ method: "POST", url: `/api/v1/paths/${pathId}/enroll`, headers: authHeaders(studentToken) });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.enrolled).toBe(true);
    // Idempotent second enroll
    const r2 = await app.inject({ method: "POST", url: `/api/v1/paths/${pathId}/enroll`, headers: authHeaders(studentToken) });
    expect(r2.statusCode).toBe(200);
    // Complete one lesson in course A
    await getPool().query(
      "INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at) VALUES ($1, $2, 'completed', NOW())",
      [studentId, lessonA1]
    );
    const detail = await app.inject({ method: "GET", url: `/api/v1/paths/${pathId}`, headers: authHeaders(studentToken) });
    const data = detail.json().data;
    expect(data.enrolled).toBe(true);
    expect(data.progress.totalLessons).toBe(3); // A(2) + B(1)
    expect(data.progress.completedLessons).toBe(1);
    expect(data.progress.percentComplete).toBe(33);
  });

  it("404s enrolling in unpublished/unknown paths", async () => {
    const draftPath = await app.inject({
      method: "POST", url: "/api/v1/paths", headers: authHeaders(mentorToken),
      payload: { title: "Draft Path", courseIds: [courseA] }
    });
    const draftId = draftPath.json().data.id as string;
    const res = await app.inject({ method: "POST", url: `/api/v1/paths/${draftId}/enroll`, headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(404);
    const missing = await app.inject({ method: "POST", url: `/api/v1/paths/${crypto.randomUUID()}/enroll`, headers: authHeaders(studentToken) });
    expect(missing.statusCode).toBe(404);
  });

  it("blocks non-mentors from managing paths", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/paths", headers: authHeaders(studentToken), payload: { title: "Nope" } });
    expect(res.statusCode).toBe(403);
  });

  it("replaces path courses via PATCH", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/v1/paths/${pathId}`, headers: authHeaders(mentorToken),
      payload: { courseIds: [courseA] }
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.courses.length).toBe(1);
    expect(data.courses[0]!.courseId).toBe(courseA);
    // Restore for the other tests' ordering assumptions (courseB first)
    await app.inject({
      method: "PATCH", url: `/api/v1/paths/${pathId}`, headers: authHeaders(mentorToken),
      payload: { courseIds: [courseB, courseA] }
    });
  });
});
