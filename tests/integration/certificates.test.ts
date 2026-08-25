import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse, insertLesson, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let studentToken: string;
let studentId: string;
let doneCourse: string;
let partialCourse: string;

describe("N7 — Certificates", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    studentToken = await loginAs("cf-student@t.id", "CF Student", "student");
    studentId = await userIdByEmail("cf-student@t.id");
    doneCourse = (await insertCourse({ title: "Selesai 100%", status: "published" })).id;
    partialCourse = (await insertCourse({ title: "Setengah", status: "published" })).id;
    const l1 = await insertLesson({ courseId: doneCourse, title: "L1" });
    await insertLesson({ courseId: doneCourse, title: "L2", sortOrder: 2 });
    await insertLesson({ courseId: partialCourse, title: "P1" });
    await insertLesson({ courseId: partialCourse, title: "P2", sortOrder: 2 });
    // Enroll in both
    for (const cid of [doneCourse, partialCourse]) {
      await getPool().query("INSERT INTO course_enrollments (user_id, course_id) VALUES ($1, $2)", [studentId, cid]);
    }
    // Complete ALL lessons of doneCourse, and ONE of partialCourse
    await getPool().query(
      "INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at) VALUES ($1, $2, 'completed', NOW())",
      [studentId, l1]
    );
    const l2 = (await getPool().query("SELECT id FROM lessons WHERE course_id = $1 AND sort_order = 2", [doneCourse])).rows[0]?.id;
    await getPool().query(
      "INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at) VALUES ($1, $2, 'completed', NOW())",
      [studentId, l2]
    );
    const p1 = (await getPool().query("SELECT id FROM lessons WHERE course_id = $1 AND sort_order = 1", [partialCourse])).rows[0]?.id;
    await getPool().query(
      "INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at) VALUES ($1, $2, 'completed', NOW())",
      [studentId, p1]
    );
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  it("issues a certificate only for 100% completed courses", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/certificates/mine", headers: authHeaders(studentToken) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ courseId: string; number: string; courseTitle: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.courseId).toBe(doneCourse);
    expect(rows[0]!.number).toMatch(/^AYO-/);
    expect(rows[0]!.courseTitle).toBe("Selesai 100%");
  });

  it("is idempotent (no duplicate certificates)", async () => {
    const r1 = await app.inject({ method: "GET", url: "/api/v1/certificates/mine", headers: authHeaders(studentToken) });
    const r2 = await app.inject({ method: "GET", url: "/api/v1/certificates/mine", headers: authHeaders(studentToken) });
    expect((r1.json().data as unknown[]).length).toBe(1);
    expect((r2.json().data as unknown[]).length).toBe(1);
    const rows = await getPool().query("SELECT count(*)::int AS c FROM certificates WHERE user_id = $1", [studentId]);
    expect(rows.rows[0]?.c).toBe(1);
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/certificates/mine" });
    expect(res.statusCode).toBe(401);
  });
});
