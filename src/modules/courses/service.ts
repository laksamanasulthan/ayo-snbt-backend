import { and, eq, desc } from "drizzle-orm";
import { getDb, getReadDb } from "../../shared/db/client.js";
import { courseRepo } from "./repository.js";
import { notDeleted } from "../../shared/db/filters.js";
import { audit } from "../../shared/audit/audit.js";
import { courses, lessons, courseEnrollments, lessonProgress, videos, users } from "../../shared/db/schema/index.js";
import { NotFoundError, ConflictError, ForbiddenError } from "../../shared/http/errors.js";

import { getCache } from "../../shared/cache/cache.js";
import { cacheVersion, bumpCacheVersion } from "../../shared/cache/version.js";
import { eventBus } from "../../shared/events/bus.js";
import { decodeCursor, keysetCondition, buildPage, type PageResult } from "../../shared/pagination.js";
import { slugify } from "./slug.js";

export interface CourseInput {
  title: string;
  description?: string;
  category?: string;
  level?: string;
  priceCents?: number;
  imageKey?: string;
  status?: string;
}

export const coursesService = {
  /** Cursor-paginated catalog: stable (createdAt DESC, id DESC) keyset. */
  async list(input: { cursor?: string; limit: number; status?: string }): Promise<PageResult<unknown>> {
    const db = getReadDb(); // catalog reads hit the replica when configured
    const { limit } = input;
    const status = input.status ?? "published";
    const keys = decodeCursor(input.cursor);
    const cacheKey = "courses:list:v" + (await cacheVersion("courses")) + ":" + status + ":" + (input.cursor ?? "first");
    const cursorWhere = (_dbRef: typeof db) =>
      keys ? keysetCondition([
        { name: "created_at", value: keys.createdAt as string, dir: "desc" },
        { name: "id", value: keys.id as string, dir: "desc" }
      ]) : undefined;
    void cursorWhere;
    const buildWhere = () => {
      const kc = decodeCursor(input.cursor);
      return and(
        eq(courses.status, status),
        notDeleted(courses.deletedAt),
        ...(kc ? [keysetCondition([
          // Fully-qualified names: the query JOINs users (which also has
          // created_at/id) — unqualified columns are ambiguous → 500.
          { name: "courses.created_at", value: kc.createdAt as string, dir: "desc" },
          { name: "courses.id", value: kc.id as string, dir: "desc" }
        ])] : [])
      );
    };
    const runQuery = async (): Promise<PageResult<unknown>> => {
      const rows = await db
        .select({ id: courses.id, title: courses.title, slug: courses.slug, description: courses.description, category: courses.category, level: courses.level, priceCents: courses.priceCents, imageKey: courses.imageKey, createdAt: courses.createdAt, mentorName: users.name })
        .from(courses)
        .leftJoin(users, eq(users.id, courses.mentorId))
        .where(buildWhere())
        .orderBy(desc(courses.createdAt), desc(courses.id))
        .limit(limit);
      return buildPage(rows, limit, ["createdAt", "id"]);
    };
    const cached = await getCache()
      .get<PageResult<unknown> | null>(cacheKey, runQuery, 30_000)
      .catch(() => null);
    if (cached) return cached;
    return runQuery();
  },

  async getById(id: string) {
    const row = await courseRepo.findById(id);
    const found = row[0];
    if (!found) throw new NotFoundError("Course not found");
    const db = getDb();
    const lessonRows = await db
      .select({ id: lessons.id, title: lessons.title, sortOrder: lessons.sortOrder, durationSeconds: lessons.durationSeconds, isFree: lessons.isFree, videoStatus: videos.status })
      .from(lessons)
      .leftJoin(videos, eq(videos.id, lessons.videoId))
      .where(and(eq(lessons.courseId, id), notDeleted(lessons.deletedAt)))
      .orderBy(lessons.sortOrder);
    return { ...found, lessons: lessonRows };
  },

  async create(userId: string, input: CourseInput) {
    const db = getDb();
    const [row] = await db
      .insert(courses)
      .values({ mentorId: userId, ...input, slug: slugify(input.title) + "-" + Date.now().toString(36) })
      .returning();
    if (!row) throw new ConflictError("Failed to create course");
    await bumpCacheVersion("courses");
    return row;
  },

  async update(user: { id: string; roles: string[] }, id: string, input: Partial<CourseInput>) {
    const db = getDb();
    const existing = await courseRepo.findById(id);
    if (!existing[0]) throw new NotFoundError("Course not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && existing[0].mentorId !== user.id) throw new ForbiddenError("Only the course owner or admin can update");
    const [row] = await db
      .update(courses)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(courses.id, id))
      .returning();
    if (!row) throw new NotFoundError("Course not found");
    await bumpCacheVersion("courses");
    return row;
  },

  async publish(user: { id: string; roles: string[] }, id: string) {
    const result = await this.update(user, id, { status: "published" });
    eventBus.emit("course.published", { courseId: id });
    return result;
  },

  async enroll(userId: string, courseId: string) {
    const db = getDb();
    const course = await db.select({ id: courses.id, priceCents: courses.priceCents }).from(courses).where(and(eq(courses.id, courseId), notDeleted(courses.deletedAt))).limit(1);
    if (!course[0]) throw new NotFoundError("Course not found");
    // Already enrolled (e.g. via payment fulfillment) → no-op success
    const existing = await db.select({ id: courseEnrollments.id }).from(courseEnrollments).where(and(eq(courseEnrollments.userId, userId), eq(courseEnrollments.courseId, courseId))).limit(1);
    if (existing[0]) return { enrolled: true, alreadyEnrolled: true };
    if (course[0].priceCents > 0) throw new ForbiddenError("Paid courses require payment", "PAYMENT_REQUIRED");
    // onConflictDoNothing: two parallel enrolls must converge to ONE row
    // (otherwise the second insert hits the unique constraint → 500)
    await db.insert(courseEnrollments).values({ userId, courseId }).onConflictDoNothing();
    return { enrolled: true, alreadyEnrolled: false };
  },

  async isEnrolled(userId: string, courseId: string): Promise<boolean> {
    const db = getDb();
    const row = await db.select({ id: courseEnrollments.id }).from(courseEnrollments).where(and(eq(courseEnrollments.userId, userId), eq(courseEnrollments.courseId, courseId))).limit(1);
    return row.length > 0;
  },

  async addLesson(user: { id: string; roles: string[] }, courseId: string, input: { title: string; description?: string; videoId?: string; isFree?: boolean }) {
    const db = getDb();
    const course = await courseRepo.findById(courseId);
    const c = course[0];
    if (!c) throw new NotFoundError("Course not found");
    // Ownership: only the course owner or an admin may add lessons
    if (!user.roles.includes("admin") && c.mentorId !== user.id) {
      throw new ForbiddenError("Only the course owner or an admin can add lessons");
    }
    const maxOrder = await db.select({ max: lessons.sortOrder }).from(lessons).where(and(eq(lessons.courseId, courseId), notDeleted(lessons.deletedAt)));
    const [row] = await db
      .insert(lessons)
      .values({ courseId, ...input, sortOrder: (maxOrder[0]?.max ?? 0) + 1 })
      .returning();
    await audit({ action: "lesson.create", resourceType: "lesson", resourceId: row?.id, after: { courseId, title: input.title } });
    return row;
  },

  async updateLesson(user: { id: string; roles: string[] }, lessonId: string, input: Partial<{ title: string; description: string; videoId: string; isFree: boolean }>) {
    const db = getDb();
    const lesson = await courseRepo.findLessonById(lessonId);
    const l = lesson[0];
    if (!l) throw new NotFoundError("Lesson not found");
    const course = await courseRepo.findById(l.courseId);
    const c = course[0];
    if (!c) throw new NotFoundError("Course not found");
    if (!user.roles.includes("admin") && c.mentorId !== user.id) {
      throw new ForbiddenError("Only the course owner or an admin can update lessons");
    }
    const [row] = await db.update(lessons).set({ ...input, updatedAt: new Date() }).where(eq(lessons.id, lessonId)).returning();
    await audit({ action: "lesson.update", resourceType: "lesson", resourceId: lessonId, after: input });
    return row;
  },

  async recordProgress(userId: string, lessonId: string, input: { status?: string; progressPercent?: number; lastPositionSeconds?: number }) {
    const db = getDb();
    const lesson = await db.select({ id: lessons.id }).from(lessons).where(and(eq(lessons.id, lessonId), notDeleted(lessons.deletedAt))).limit(1);
    if (!lesson[0]) throw new NotFoundError("Lesson not found");
    const existing = await db.select({ id: lessonProgress.id }).from(lessonProgress).where(and(eq(lessonProgress.userId, userId), eq(lessonProgress.lessonId, lessonId))).limit(1);
    const completedAt = input.status === "completed" ? new Date() : undefined;
    if (existing[0]) {
      await db
        .update(lessonProgress)
        .set({ ...input, completedAt, updatedAt: new Date() })
        .where(eq(lessonProgress.id, existing[0].id));
    } else {
      await db.insert(lessonProgress).values({ userId, lessonId, ...input, completedAt });
    }
    return { recorded: true };
  },

  /** Soft delete a course (owner or admin) + audit. */
  async remove(user: { id: string; roles: string[] }, id: string) {
    const existing = await courseRepo.findById(id);
    const course = existing[0];
    if (!course) throw new NotFoundError("Course not found");
    if (!user.roles.includes("admin") && course.mentorId !== user.id) {
      throw new ForbiddenError("Only the course owner or an admin can delete this course");
    }
    const removed = await courseRepo.softDelete(id);
    await audit({ action: "course.delete", resourceType: "course", resourceId: id, before: { title: removed?.title } });
    await bumpCacheVersion("courses");
    eventBus.emit("course.deleted", { courseId: id });
    return { deleted: true, soft: true };
  },

  /** Admin restore after soft delete. */
  async restore(user: { id: string; roles: string[] }, id: string) {
    if (!user.roles.includes("admin")) throw new ForbiddenError("Only admins can restore courses");
    const existing = await courseRepo.findByIdIncludeDeleted(id);
    const course = existing[0];
    if (!course) throw new NotFoundError("Course not found");
    if (!course.deletedAt) return { restored: true, alreadyActive: true };
    await courseRepo.restore(id);
    await audit({ action: "course.restore", resourceType: "course", resourceId: id });
    await bumpCacheVersion("courses");
    eventBus.emit("course.restored", { courseId: id });
    return { restored: true };
  },

  async listProgress(userId: string, courseId: string) {
    const db = getDb();
    const rows = await db
      .select({ lessonId: lessonProgress.lessonId, status: lessonProgress.status, progressPercent: lessonProgress.progressPercent, lastPositionSeconds: lessonProgress.lastPositionSeconds, updatedAt: lessonProgress.updatedAt })
      .from(lessonProgress)
      .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
      .where(and(eq(lessonProgress.userId, userId), eq(lessons.courseId, courseId), notDeleted(lessons.deletedAt)));
    return rows;
  }
};