import { and, eq, desc, inArray } from "drizzle-orm";
import { getDb, getReadDb } from "../../shared/db/client.js";
import { courseRepo } from "./repository.js";
import { notDeleted } from "../../shared/db/filters.js";
import { audit } from "../../shared/audit/audit.js";
import { courses, lessons, courseEnrollments, lessonProgress, videos, users, wishlist } from "../../shared/db/schema/index.js";
import { NotFoundError, ConflictError, ForbiddenError, BadRequestError } from "../../shared/http/errors.js";

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
  async list(input: { cursor?: string; limit: number; status?: string; userId?: string }): Promise<PageResult<unknown>> {
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
    const page = (await getCache()
      .get<PageResult<unknown> | null>(cacheKey, runQuery, 30_000)
      .catch(() => null)) ?? (await runQuery());
    // M8: per-user enrollment flag — never cached (user-specific)
    if (input.userId && page.rows.length > 0) {
      const ids = page.rows.map((r) => (r as { id: string }).id);
      const enr = await getDb()
        .select({ courseId: courseEnrollments.courseId })
        .from(courseEnrollments)
        .where(and(eq(courseEnrollments.userId, input.userId), eq(courseEnrollments.status, "active"), inArray(courseEnrollments.courseId, ids)));
      const enrolledSet = new Set(enr.map((e) => e.courseId));
      page.rows = page.rows.map((r) => ({ ...(r as Record<string, unknown>), enrolled: enrolledSet.has((r as { id: string }).id) }));
    }
    return page;
  },

  async getById(id: string, userId?: string) {
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
    // M8: enrollment flag for the viewer
    let enrolled = false;
    if (userId) {
      const enr = await db
        .select({ id: courseEnrollments.id })
        .from(courseEnrollments)
        .where(and(eq(courseEnrollments.userId, userId), eq(courseEnrollments.courseId, id), eq(courseEnrollments.status, "active")))
        .limit(1);
      enrolled = enr.length > 0;
    }
    return { ...found, lessons: lessonRows, enrolled };
  },

  /** N8: add to my wishlist (idempotent). */
  async addWishlist(userId: string, courseId: string) {
    const db = getDb();
    const c = (await db.select({ id: courses.id, status: courses.status }).from(courses).where(and(eq(courses.id, courseId), notDeleted(courses.deletedAt))).limit(1))[0];
    if (!c) throw new NotFoundError("Course not found");
    if (c.status !== "published") throw new BadRequestError("Course not available");
    await db.insert(wishlist).values({ userId, courseId }).onConflictDoNothing();
    return { wishlisted: true };
  },

  /** N8: remove from my wishlist (idempotent). */
  async removeWishlist(userId: string, courseId: string) {
    await getDb().delete(wishlist).where(and(eq(wishlist.userId, userId), eq(wishlist.courseId, courseId)));
    return { wishlisted: false };
  },

  /** N8: my wishlist with course details. */
  async listWishlist(userId: string) {
    const db = getDb();
    const rows = await db
      .select({ id: courses.id, title: courses.title, slug: courses.slug, priceCents: courses.priceCents, category: courses.category, imageKey: courses.imageKey, addedAt: wishlist.createdAt })
      .from(wishlist)
      .innerJoin(courses, eq(courses.id, wishlist.courseId))
      .where(and(eq(wishlist.userId, userId), notDeleted(courses.deletedAt)))
      .orderBy(desc(wishlist.createdAt));
    return rows;
  },

  /** M8: my enrolled courses with progress rollup (enrolledAt DESC keyset). */
  async listMine(userId: string, cursor: string | undefined, limit: number) {
    const db = getDb();
    const kc = decodeCursor(cursor);
    const where = and(
      eq(courseEnrollments.userId, userId),
      eq(courseEnrollments.status, "active"),
      notDeleted(courses.deletedAt),
      kc
        ? keysetCondition([
            { name: "course_enrollments.enrolled_at", value: kc.enrolledAt as string, dir: "desc" },
            { name: "course_enrollments.course_id", value: kc.courseId as string, dir: "desc" }
          ])
        : undefined
    );
    const rows = await db
      .select({
        courseId: courseEnrollments.courseId,
        id: courses.id,
        title: courses.title,
        slug: courses.slug,
        description: courses.description,
        category: courses.category,
        level: courses.level,
        priceCents: courses.priceCents,
        imageKey: courses.imageKey,
        mentorName: users.name,
        enrolledAt: courseEnrollments.enrolledAt,
        expiresAt: courseEnrollments.expiresAt
      })
      .from(courseEnrollments)
      .innerJoin(courses, eq(courses.id, courseEnrollments.courseId))
      .leftJoin(users, eq(users.id, courses.mentorId))
      .where(where)
      .orderBy(desc(courseEnrollments.enrolledAt), desc(courseEnrollments.courseId))
      .limit(limit);
    // Progress rollup: lesson totals + completed counts (batched)
    const courseIds = rows.map((r) => r.courseId);
    const lessonCounts = new Map<string, number>();
    const completedCounts = new Map<string, number>();
    if (courseIds.length > 0) {
      const lessonRows = await db
        .select({ id: lessons.id, courseId: lessons.courseId })
        .from(lessons)
        .where(and(inArray(lessons.courseId, courseIds), notDeleted(lessons.deletedAt)));
      for (const l of lessonRows) lessonCounts.set(l.courseId, (lessonCounts.get(l.courseId) ?? 0) + 1);
      if (lessonRows.length > 0) {
        const completed = await db
          .select({ lessonId: lessonProgress.lessonId })
          .from(lessonProgress)
          .where(and(
            eq(lessonProgress.userId, userId),
            eq(lessonProgress.status, "completed"),
            inArray(lessonProgress.lessonId, lessonRows.map((l) => l.id))
          ));
        const lessonCourse = new Map(lessonRows.map((l) => [l.id, l.courseId]));
        for (const c of completed) {
          const cid = lessonCourse.get(c.lessonId);
          if (cid) completedCounts.set(cid, (completedCounts.get(cid) ?? 0) + 1);
        }
      }
    }
    const enriched = rows.map((r) => {
      const totalLessons = lessonCounts.get(r.courseId) ?? 0;
      const completedLessons = completedCounts.get(r.courseId) ?? 0;
      const percentComplete = totalLessons === 0 ? 0 : Math.round((completedLessons / totalLessons) * 100);
      return { ...r, completedLessons, totalLessons, percentComplete };
    });
    return buildPage(enriched, limit, ["enrolledAt", "courseId"]);
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