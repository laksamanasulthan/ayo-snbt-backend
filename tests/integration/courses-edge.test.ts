import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs, insertCourse, userIdByEmail,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let adminToken: string;
let studentToken: string;
let outsiderToken: string;
let courseId: string;
let lessonId: string;

async function createCourse(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/courses",
    headers: authHeaders(mentorToken),
    payload: { title, description: "d", category: "TPS", level: "beginner", ...extra }
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.id as string;
}

describe("Courses edge cases", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("c-edge-mentor@t.id", "Mentor", "mentor");
    adminToken = await loginAs("c-edge-admin@t.id", "Admin", "admin");
    studentToken = await loginAs("c-edge-student@t.id", "Student", "student");
    outsiderToken = await loginAs("c-edge-outsider@t.id", "Outsider", "student");
    courseId = await createCourse("Course Edge Main");
    lessonId = await (async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/courses/" + courseId + "/lessons",
        headers: authHeaders(mentorToken),
        payload: { title: "Lesson 1", description: "d", isFree: true }
      });
      expect(res.statusCode).toBe(201);
      return res.json().data.id as string;
    })();
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  // ── Validation ───────────────────────────────────────────────────────
  it("rejects creating a course without a title", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses",
      headers: authHeaders(mentorToken),
      payload: { description: "no title" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("generates unique slugs even for identical titles", async () => {
    const a = await createCourse("Same Title");
    const b = await createCourse("Same Title");
    // Draft courses are only visible to owner/mentor/admin — use owner headers
    const a1 = await app.inject({ method: "GET", url: "/api/v1/courses/" + a, headers: authHeaders(mentorToken) });
    const b1 = await app.inject({ method: "GET", url: "/api/v1/courses/" + b, headers: authHeaders(mentorToken) });
    expect(a1.json().data.slug).not.toBe(b1.json().data.slug);
  });

  // ── Cursor pagination walk ───────────────────────────────────────────
  it("walks a 25-course catalog with limit 10: no dups, no gaps, full coverage", async () => {
    const db = getPool();
    // Insert 25 published courses directly (fast) — catalog order is (createdAt DESC, id DESC)
    for (let i = 0; i < 25; i++) {
      await db.query(
        "INSERT INTO courses (title, slug, status, price_cents, created_at) VALUES ($1, $2, 'published', 0, NOW() - ($3 || ' seconds')::interval) RETURNING id",
        ["Walk " + i, "walk-" + Date.now() + "-" + i, String(i)]
      );
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = "/api/v1/courses?limit=10" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { id: string }[];
      const meta = res.json().meta as { pagination?: { nextCursor: string | null } };
      for (const row of data) {
        expect(seen.has(row.id)).toBe(false); // no duplicates across pages
        seen.add(row.id);
      }
      pages += 1;
      cursor = meta.pagination?.nextCursor ?? undefined;
      if (!cursor) break;
      expect(pages).toBeLessThan(10); // safety: must terminate
    }
    expect(pages).toBe(3); // 25 published walk courses → 10/10/5
    expect(seen.size).toBe(25);
  });

  it("rejects tampered cursors", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses?cursor=not-a-cursor" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CURSOR");
  });

  it("rejects invalid limit values and caps huge ones", async () => {
    const zero = await app.inject({ method: "GET", url: "/api/v1/courses?limit=0" });
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.code).toBe("INVALID_LIMIT");
    const abc = await app.inject({ method: "GET", url: "/api/v1/courses?limit=abc" });
    expect(abc.statusCode).toBe(400);
    const huge = await app.inject({ method: "GET", url: "/api/v1/courses?limit=1000" });
    expect(huge.statusCode).toBe(200);
    expect(huge.json().data.length).toBeLessThanOrEqual(100);
  });

  it("a cursor beyond the last row yields an empty page (no error)", async () => {
    // DESC order: a cursor older than every row matches nothing (keyset strictly-after)
    const { encodeCursor } = await import("../../src/shared/pagination.js");
    const beyond = encodeCursor({ createdAt: "2000-01-01T00:00:00.000Z", id: "00000000-0000-0000-0000-000000000000" });
    const res = await app.inject({ method: "GET", url: "/api/v1/courses?limit=5&cursor=" + encodeURIComponent(beyond) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
    expect(res.json().meta.pagination.nextCursor).toBeNull();
  });

  // ── Visibility / draft / soft-delete ─────────────────────────────────
  it("keeps draft courses out of the public catalog", async () => {
    const draftId = await createCourse("Draft Course", { status: "draft" });
    const list = await app.inject({ method: "GET", url: "/api/v1/courses?limit=100" });
    const ids = (list.json().data as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(draftId);
    // But the owner can fetch it by id
    const detail = await app.inject({ method: "GET", url: "/api/v1/courses/" + draftId, headers: authHeaders(mentorToken) });
    expect(detail.statusCode).toBe(200);
  });

  it("soft-deletes a course: hidden everywhere, restorable by admin", async () => {
    const target = await createCourse("To Delete");
    // Route gate: course:delete is admin-only, so the OWNING mentor still gets 403
    const asOwner = await app.inject({
      method: "DELETE",
      url: "/api/v1/courses/" + target,
      headers: authHeaders(mentorToken)
    });
    expect(asOwner.statusCode).toBe(403);
    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/courses/" + target,
      headers: authHeaders(adminToken)
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.soft).toBe(true);

    // Gone from public list
    const list = await app.inject({ method: "GET", url: "/api/v1/courses?limit=100" });
    expect((list.json().data as { id: string }[]).map((r) => r.id)).not.toContain(target);
    // Gone by id even for the owner
    const detail = await app.inject({ method: "GET", url: "/api/v1/courses/" + target, headers: authHeaders(mentorToken) });
    expect(detail.statusCode).toBe(404);
    // Enroll → 404
    const enroll = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + target + "/enroll",
      headers: authHeaders(studentToken)
    });
    expect(enroll.statusCode).toBe(404);

    // Restore (admin) → visible again
    const restore = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + target + "/restore",
      headers: authHeaders(adminToken)
    });
    expect(restore.statusCode).toBe(200);
    // Draft course — owner/mentor headers required for visibility
    const back = await app.inject({ method: "GET", url: "/api/v1/courses/" + target, headers: authHeaders(mentorToken) });
    expect(back.statusCode).toBe(200);
  });

  it("restore of an active course is a no-op success; unknown restore is 404", async () => {
    const active = await createCourse("Active Again");
    const noop = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + active + "/restore",
      headers: authHeaders(adminToken)
    });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().data.alreadyActive).toBe(true);
    const ghost = await app.inject({
      method: "POST",
      url: "/api/v1/courses/00000000-0000-0000-0000-000000000000/restore",
      headers: authHeaders(adminToken)
    });
    expect(ghost.statusCode).toBe(404);
  });

  it("delete is admin-only at the route gate, regardless of ownership", async () => {
    const owner2 = await loginAs("c-edge-mentor2@t.id", "Mentor 2", "mentor");
    const owner2Id = await userIdByEmail("c-edge-mentor2@t.id");
    const foreign = await insertCourse({ title: "Foreign", mentorId: owner2Id });
    // Owner cannot delete (lacks course:delete)
    const asOwner = await app.inject({
      method: "DELETE",
      url: "/api/v1/courses/" + foreign.id,
      headers: authHeaders(owner2)
    });
    expect(asOwner.statusCode).toBe(403);
    // Another mentor cannot either
    const other = await app.inject({
      method: "DELETE",
      url: "/api/v1/courses/" + foreign.id,
      headers: authHeaders(mentorToken)
    });
    expect(other.statusCode).toBe(403);
    // Admin bypasses ownership entirely
    const asAdmin = await app.inject({
      method: "DELETE",
      url: "/api/v1/courses/" + foreign.id,
      headers: authHeaders(adminToken)
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  // ── Enroll ───────────────────────────────────────────────────────────
  it("enrolls free courses; idempotent re-enroll; blocks paid without payment", async () => {
    const free = await insertCourse({ title: "Free Enroll" });
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + free.id + "/enroll",
      headers: authHeaders(studentToken)
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.enrolled).toBe(true);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + free.id + "/enroll",
      headers: authHeaders(studentToken)
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.alreadyEnrolled).toBe(true);

    const paid = await insertCourse({ title: "Paid Enroll", priceCents: 100000 });
    const paidRes = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + paid.id + "/enroll",
      headers: authHeaders(studentToken)
    });
    expect(paidRes.statusCode).toBe(403);
    expect(paidRes.json().error.code).toBe("PAYMENT_REQUIRED");
  });

  it("enrolling an unknown course is 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses/00000000-0000-0000-0000-000000000000/enroll",
      headers: authHeaders(studentToken)
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Lessons ──────────────────────────────────────────────────────────
  it("only the owner or admin can add lessons", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + courseId + "/lessons",
      headers: authHeaders(studentToken),
      payload: { title: "Nope" }
    });
    expect(res.statusCode).toBe(403);
    const asAdmin = await app.inject({
      method: "POST",
      url: "/api/v1/courses/" + courseId + "/lessons",
      headers: authHeaders(adminToken),
      payload: { title: "Admin Lesson" }
    });
    expect(asAdmin.statusCode).toBe(201);
  });

  it("adding a lesson to an unknown course is 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/courses/00000000-0000-0000-0000-000000000000/lessons",
      headers: authHeaders(mentorToken),
      payload: { title: "X" }
    });
    expect(res.statusCode).toBe(404);
  });

  it("updating a lesson requires course ownership", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/lessons/" + lessonId,
      headers: authHeaders(studentToken),
      payload: { title: "Hijacked" }
    });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({
      method: "PATCH",
      url: "/api/v1/lessons/" + lessonId,
      headers: authHeaders(mentorToken),
      payload: { title: "Lesson 1 Updated" }
    });
    expect(ok.statusCode).toBe(200);
  });

  // ── Progress ─────────────────────────────────────────────────────────
  it("records and lists progress with status transitions", async () => {
    const p1 = await app.inject({
      method: "POST",
      url: "/api/v1/lessons/" + lessonId + "/progress",
      headers: authHeaders(studentToken),
      payload: { progressPercent: 50, lastPositionSeconds: 120 }
    });
    expect(p1.statusCode).toBe(200);
    const p2 = await app.inject({
      method: "POST",
      url: "/api/v1/lessons/" + lessonId + "/progress",
      headers: authHeaders(studentToken),
      payload: { status: "completed", progressPercent: 100 }
    });
    expect(p2.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/courses/" + courseId + "/progress",
      headers: authHeaders(studentToken)
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().data as { lessonId: string; status: string; progressPercent: number }[];
    const mine = rows.find((r) => r.lessonId === lessonId);
    expect(mine?.status).toBe("completed");
    expect(mine?.progressPercent).toBe(100);
  });

  it("progress on an unknown lesson is 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/lessons/00000000-0000-0000-0000-000000000000/progress",
      headers: authHeaders(studentToken),
      payload: { progressPercent: 10 }
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects non-integer progress payloads (schema validation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/lessons/" + lessonId + "/progress",
      headers: authHeaders(studentToken),
      payload: { progressPercent: "100%" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("does not leak other students' progress", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/courses/" + courseId + "/progress",
      headers: authHeaders(outsiderToken)
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBe(0);
  });

  // ── Detail ───────────────────────────────────────────────────────────
  it("returns 404 for unknown course ids", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404);
  });

  it("course detail includes its lessons ordered by sortOrder", async () => {
    // Main course is still draft — mentor (owner) headers required
    const res = await app.inject({ method: "GET", url: "/api/v1/courses/" + courseId, headers: authHeaders(mentorToken) });
    expect(res.statusCode).toBe(200);
    const lessons = res.json().data.lessons as { id: string; sortOrder: number }[];
    expect(lessons.length).toBeGreaterThanOrEqual(2);
    const orders = lessons.map((l) => l.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("rejects non-uuid course ids gracefully (never 500)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses/not-a-uuid" });
    // PG 22P02 is mapped to 400 INVALID_ID by the global error handler
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ID");
    expect(res.json().error.requestId).toBeTruthy();
  });
});
