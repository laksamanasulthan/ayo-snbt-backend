import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { certificates, courseEnrollments, courses, lessons, lessonProgress } from "../../shared/db/schema/index.js";
import { notDeleted } from "../../shared/db/filters.js";
import { getLogger } from "../../shared/logger.js";

const log = getLogger();

/**
 * N7 — certificates of completion. Issued lazily: listMine() upserts a
 * certificate for every enrolled course the user completed 100%.
 * PDF generation via a worker is a follow-up (queue reserved).
 */
export const certificatesService = {
  /** Courses where the user completed ALL lessons. */
  async completedCourses(userId: string): Promise<string[]> {
    const db = getDb();
    const enrolled = await db
      .select({ courseId: courseEnrollments.courseId })
      .from(courseEnrollments)
      .where(and(eq(courseEnrollments.userId, userId), eq(courseEnrollments.status, "active")));
    const courseIds = enrolled.map((r) => r.courseId);
    if (courseIds.length === 0) return [];
    const lessonRows = await db
      .select({ id: lessons.id, courseId: lessons.courseId })
      .from(lessons)
      .where(and(inArray(lessons.courseId, courseIds), notDeleted(lessons.deletedAt)));
    const byCourse = new Map<string, string[]>();
    for (const l of lessonRows) {
      const list = byCourse.get(l.courseId) ?? [];
      list.push(l.id);
      byCourse.set(l.courseId, list);
    }
    const done = await db
      .select({ lessonId: lessonProgress.lessonId })
      .from(lessonProgress)
      .where(and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, "completed"),
        inArray(lessonProgress.lessonId, lessonRows.map((l) => l.id))
      ));
    const doneSet = new Set(done.map((r) => r.lessonId));
    const completed: string[] = [];
    for (const [courseId, ids] of byCourse) {
      if (ids.length > 0 && ids.every((id) => doneSet.has(id))) completed.push(courseId);
    }
    return completed;
  },

  /** My certificates (lazy issue on completed courses). */
  async listMine(userId: string) {
    const db = getDb();
    const completed = await this.completedCourses(userId);
    for (const courseId of completed) {
      await db
        .insert(certificates)
        .values({ userId, courseId, number: "AYO-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase() })
        .onConflictDoNothing()
        .catch((err) => log.warn({ err, courseId }, "certificate issue failed"));
    }
    const rows = await db
      .select({ id: certificates.id, number: certificates.number, issuedAt: certificates.issuedAt, courseId: certificates.courseId, courseTitle: courses.title })
      .from(certificates)
      .innerJoin(courses, eq(courses.id, certificates.courseId))
      .where(eq(certificates.userId, userId))
      .orderBy(certificates.issuedAt);
    return rows;
  }
};
