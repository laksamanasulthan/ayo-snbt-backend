import { and, eq, desc, inArray, count } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { learningPaths, pathCourses, pathEnrollments, courses, lessons, lessonProgress } from "../../shared/db/schema/index.js";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { NotFoundError, BadRequestError, ConflictError, ForbiddenError } from "../../shared/http/errors.js";
import { notDeleted } from "../../shared/db/filters.js";
import { audit } from "../../shared/audit/audit.js";
import { bumpCacheVersion } from "../../shared/cache/version.js";

/**
 * A5 — learning paths: ordered course collections with enrollment +
 * progress rollup. Management: mentor/admin; enroll: any authed user.
 */
export const pathsService = {
  /** Cursor-paginated published paths with courseCount. */
  async list(input: { cursor?: string; limit: number }) {
    const db = getDb();
    const { limit } = input;
    const kc = decodeCursor(input.cursor);
    const where = and(
      eq(learningPaths.status, "published"),
      notDeleted(learningPaths.deletedAt),
      kc
        ? keysetCondition([
            { name: "created_at", value: kc.createdAt as string, dir: "desc" },
            { name: "id", value: kc.id as string, dir: "desc" }
          ])
        : undefined
    );
    const rows = await db
      .select({ id: learningPaths.id, title: learningPaths.title, description: learningPaths.description, createdAt: learningPaths.createdAt })
      .from(learningPaths)
      .where(where)
      .orderBy(desc(learningPaths.createdAt), desc(learningPaths.id))
      .limit(limit);
    // courseCount per path (batched)
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await db
          .select({ pathId: pathCourses.pathId, c: count() })
          .from(pathCourses)
          .where(inArray(pathCourses.pathId, ids))
          .groupBy(pathCourses.pathId)
      : [];
    const byId = new Map(counts.map((r) => [r.pathId, r.c]));
    const enriched = rows.map((r) => ({ ...r, courseCount: byId.get(r.id) ?? 0 }));
    return buildPage(enriched, limit, ["createdAt", "id"]);
  },

  /** Path detail with ordered courses (+ progress when authed). */
  async getById(id: string, userId?: string) {
    const db = getDb();
    const path = (await db.select().from(learningPaths).where(and(eq(learningPaths.id, id), notDeleted(learningPaths.deletedAt))).limit(1))[0];
    if (!path) throw new NotFoundError("Path not found");
    const items = await db
      .select({ courseId: courses.id, title: courses.title, slug: courses.slug, priceCents: courses.priceCents, sortOrder: pathCourses.sortOrder })
      .from(pathCourses)
      .innerJoin(courses, eq(courses.id, pathCourses.courseId))
      .where(eq(pathCourses.pathId, id))
      .orderBy(pathCourses.sortOrder);
    const enrolled = userId
      ? (await db.select({ id: pathEnrollments.id }).from(pathEnrollments).where(and(eq(pathEnrollments.userId, userId), eq(pathEnrollments.pathId, id))).limit(1)).length > 0
      : false;
    // Progress rollup (when enrolled): completed/total lessons across path courses
    let progress = null;
    if (userId && enrolled && items.length > 0) {
      const courseIds = items.map((c) => c.courseId);
      const lessonRows = await db
        .select({ id: lessons.id, courseId: lessons.courseId })
        .from(lessons)
        .where(and(inArray(lessons.courseId, courseIds), notDeleted(lessons.deletedAt)));
      const done = await db
        .select({ lessonId: lessonProgress.lessonId })
        .from(lessonProgress)
        .where(and(eq(lessonProgress.userId, userId), eq(lessonProgress.status, "completed"), inArray(lessonProgress.lessonId, lessonRows.map((l) => l.id))));
      const totalLessons = lessonRows.length;
      const completedLessons = done.length;
      progress = {
        completedLessons,
        totalLessons,
        percentComplete: totalLessons === 0 ? 0 : Math.round((completedLessons / totalLessons) * 100)
      };
    }
    return { ...path, courses: items, enrolled, progress };
  },

  /** Mentor/admin: create a path with ordered courseIds. */
  async create(user: { id: string; roles: string[] }, input: { title: string; description?: string; courseIds?: string[]; status?: string }) {
    const db = getDb();
    const title = input.title?.trim();
    if (!title) throw new BadRequestError("Path title is required", "VALIDATION_ERROR");
    const [row] = await db
      .insert(learningPaths)
      .values({ title, description: input.description ?? null, status: input.status ?? "draft", createdBy: user.id })
      .returning();
    if (!row) throw new ConflictError("Failed to create path");
    if (input.courseIds?.length) {
      await db.insert(pathCourses).values(input.courseIds.map((courseId, i) => ({ pathId: row.id, courseId, sortOrder: i }))).onConflictDoNothing();
    }
    await audit({ action: "path.create", resourceType: "path", resourceId: row.id, after: { courseCount: input.courseIds?.length ?? 0 } });
    await bumpCacheVersion("learning_paths");
    return row;
  },

  /** Mentor/admin: replace the path's courses + fields. */
  async update(user: { id: string; roles: string[] }, id: string, input: { title?: string; description?: string; courseIds?: string[]; status?: string }) {
    const db = getDb();
    const existing = (await db.select().from(learningPaths).where(eq(learningPaths.id, id)).limit(1))[0];
    if (!existing) throw new NotFoundError("Path not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && existing.createdBy !== user.id) throw new ForbiddenError("Only the path owner or admin can update");
    const fields: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) fields.title = input.title;
    if (input.description !== undefined) fields.description = input.description ?? null;
    if (input.status !== undefined) fields.status = input.status;
    await db.update(learningPaths).set(fields).where(eq(learningPaths.id, id));
    if (input.courseIds !== undefined) {
      await db.delete(pathCourses).where(eq(pathCourses.pathId, id));
      if (input.courseIds.length) {
        await db.insert(pathCourses).values(input.courseIds.map((courseId, i) => ({ pathId: id, courseId, sortOrder: i }))).onConflictDoNothing();
      }
    }
    await audit({ action: "path.update", resourceType: "path", resourceId: id, before: { title: existing.title }, after: fields });
    await bumpCacheVersion("learning_paths");
    return this.getById(id);
  },

  /** Enroll (idempotent). */
  async enroll(userId: string, pathId: string) {
    const db = getDb();
    const path = (await db.select({ id: learningPaths.id }).from(learningPaths).where(and(eq(learningPaths.id, pathId), eq(learningPaths.status, "published"), notDeleted(learningPaths.deletedAt))).limit(1))[0];
    if (!path) throw new NotFoundError("Path not found");
    await db.insert(pathEnrollments).values({ userId, pathId }).onConflictDoNothing();
    return { enrolled: true };
  }
};
