import { and, eq } from "drizzle-orm";
import { getDb, getReadDb } from "../../shared/db/client.js";
import { courses, lessons } from "../../shared/db/schema/index.js";
import { notDeleted } from "../../shared/db/filters.js";

export type CourseRow = typeof courses.$inferSelect;
export type LessonRow = typeof lessons.$inferSelect;

/** Data access for courses/lessons — soft-delete filters are baked in. */
export const courseRepo = {
  findById(id: string, opts: { readReplica?: boolean } = {}) {
    const db = opts.readReplica ? getReadDb() : getDb();
    return db.select().from(courses).where(and(eq(courses.id, id), notDeleted(courses.deletedAt))).limit(1);
  },

  findByIdIncludeDeleted(id: string) {
    return getDb().select().from(courses).where(eq(courses.id, id)).limit(1);
  },

  findLessons(courseId: string) {
    return getDb().select().from(lessons).where(and(eq(lessons.courseId, courseId), notDeleted(lessons.deletedAt))).orderBy(lessons.sortOrder);
  },

  findLessonById(id: string) {
    return getDb().select().from(lessons).where(and(eq(lessons.id, id), notDeleted(lessons.deletedAt))).limit(1);
  },

  softDelete(id: string): Promise<CourseRow | undefined> {
    return getDb().update(courses).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(courses.id, id)).returning().then((r) => r[0]);
  },

  restore(id: string): Promise<CourseRow | undefined> {
    return getDb().update(courses).set({ deletedAt: null, updatedAt: new Date() }).where(eq(courses.id, id)).returning().then((r) => r[0]);
  }
};