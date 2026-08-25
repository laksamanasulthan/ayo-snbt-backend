import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse, insertLesson,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let otherToken: string;
let studentId: string;
let courseA: string;
let courseB: string;
let lessonA1: string;

describe("M8 — My courses + enrollment visibility", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("mc-student@t.id", "MC Student", "student");
    otherToken = await loginAs("mc-other@t.id", "MC Other", "student");
    studentId = (await getPool().query("SELECT id FROM users WHERE email = 'mc-student@t.id'")).rows[0]?.id as string;
    courseA = (await insertCourse({ title: "Kursus A", status: "published", priceCents: 0 })).id;
    courseB = (await insertCourse({ title: "Kursus B", status: "published", priceCents: 0 })).id;
    lessonA1 = await insertLesson({ courseId: courseA, title: "L1" });
    await insertLesson({ courseId: courseA, title: "L2", sortOrder: 2 });
    // Enroll the student in A and B
    for (const cid of [courseA, courseB]) {
      await getPool().query("INSERT INTO course_enrollments (user_id, course_id) VALUES ($1, $2)", [studentId, cid]);
    }
    // Complete one of two lessons in course A
    await getPool().query(
      "INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at) VALUES ($1, $2, 'completed', now())",
      [studentId, lessonA1]
    );
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("requires auth on /courses/mine", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses/mine" });
    expect(res.statusCode).toBe(401);
  });

  it("lists my enrolled courses with progress rollup", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses/mine", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    const slugA = (await getPool().query("SELECT slug FROM courses WHERE id = $1", [courseA])).rows[0]?.slug;
    const a = rows.find((r) => r.slug === slugA);
    expect(a).toBeTruthy();
    expect(a!.enrolledAt).toBeTruthy();
    expect(a!.expiresAt).toBeNull();
    expect(a!.totalLessons).toBe(2);
    expect(a!.completedLessons).toBe(1);
    expect(a!.percentComplete).toBe(50);
    const b = rows.find((r) => r.title === "Kursus B");
    expect(b!.totalLessons).toBe(0);
    expect(b!.percentComplete).toBe(0);
  });

  it("paginates /courses/mine with cursor", async () => {
    const p1 = await app.inject({ method: "GET", url: "/api/v1/courses/mine?limit=1", headers: authHeaders(studentToken) });
    expect(p1.statusCode).toBe(200);
    const meta = p1.json().meta as { pagination: { nextCursor: string | null } };
    expect(meta.pagination.nextCursor).toBeTruthy();
    const p2 = await app.inject({ method: "GET", url: `/api/v1/courses/mine?limit=1&cursor=${meta.pagination.nextCursor}`, headers: authHeaders(studentToken) });
    expect(p2.statusCode).toBe(200);
    const d1 = p1.json().data as Array<{ id: string }>;
    const d2 = p2.json().data as Array<{ id: string }>;
    expect(d2[0]!.id).not.toBe(d1[0]!.id);
  });

  it("flags enrolled courses in the public catalog when authed", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ title: string; enrolled: boolean }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const a = rows.find((r) => r.title === "Kursus A");
    expect(a?.enrolled).toBe(true);
    const b = rows.find((r) => r.title === "Kursus B");
    expect(b?.enrolled).toBe(true);
  });

  it("does NOT flag enrolled when anonymous (no enrolled key)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses" });
    const rows = res.json().data as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect("enrolled" in rows[0]!).toBe(false);
  });

  it("other users are not flagged as enrolled", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses", headers: authHeaders(otherToken) });
    const rows = res.json().data as Array<{ title: string; enrolled: boolean }>;
    const a = rows.find((r) => r.title === "Kursus A");
    expect(a?.enrolled).toBe(false);
  });

  it("course detail includes enrolled for the viewer", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/courses/${courseA}`, headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { enrolled: boolean }).enrolled).toBe(true);
    const anon = await app.inject({ method: "GET", url: `/api/v1/courses/${courseA}` });
    expect((anon.json().data as { enrolled: boolean }).enrolled).toBe(false);
  });
});
