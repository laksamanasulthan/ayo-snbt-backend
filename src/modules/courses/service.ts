import { and, eq, desc } from "drizzle-orm";
import { getDb, getReadDb } from "../../shared/db/client.js";
import { courses, lessons, courseEnrollments, lessonProgress, videos, users } from "../../shared/db/schema/index.js";
import { NotFoundError, ConflictError, ForbiddenError } from "../../shared/http/errors.js";
import { getCache } from "../../shared/cache/cache.js";
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
  async list(input: { page: number; perPage: number; status?: string }) {
    const db = getReadDb(); // catalog reads hit the replica when configured
    const { page, perPage } = input;
    const status = input.status ?? "published";
    const cacheKey = "courses:list:" + status + ":" + page + ":" + perPage;
    // Cache-aside with stampede protection; bypassed automatically when Redis degrades
    const cached = await getCache()
      .get<{ rows: unknown[]; total: number; page: number; perPage: number; totalPages: number } | null>(
        cacheKey,
        async () => {
          const total = await db.select({ count: courses.id }).from(courses).where(eq(courses.status, status));
          const rows = await db
            .select({ id: courses.id, title: courses.title, slug: courses.slug, description: courses.description, category: courses.category, level: courses.level, priceCents: courses.priceCents, imageKey: courses.imageKey, mentorName: users.name })
            .from(courses)
            .leftJoin(users, eq(users.id, courses.mentorId))
            .where(eq(courses.status, status))
            .orderBy(desc(courses.createdAt))
            .limit(perPage)
            .offset((page - 1) * perPage);
          const totalCount = Number(total[0]?.count ?? 0);
          return { rows, total: totalCount, page, perPage, totalPages: Math.max(1, Math.ceil(totalCount / perPage)) };
        },
        30_000 // 30s TTL — catalog reads are hot
      )
      .catch(() => null);
    if (cached) return cached;
    // Fallback (cache miss path) — same query without cache
    const total = await db.select({ count: courses.id }).from(courses).where(eq(courses.status, status));
    const rows = await db
      .select({ id: courses.id, title: courses.title, slug: courses.slug, description: courses.description, category: courses.category, level: courses.level, priceCents: courses.priceCents, imageKey: courses.imageKey, mentorName: users.name })
      .from(courses)
      .leftJoin(users, eq(users.id, courses.mentorId))
      .where(eq(courses.status, status))
      .orderBy(desc(courses.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const totalCount = Number(total[0]?.count ?? 0);
    return { rows, total: totalCount, page, perPage, totalPages: Math.max(1, Math.ceil(totalCount / perPage)) };
  },

  async getById(id: string) {
    const db = getDb();
    const row = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
    const found = row[0];
    if (!found) throw new NotFoundError("Course not found");
    const lessonRows = await db
      .select({ id: lessons.id, title: lessons.title, sortOrder: lessons.sortOrder, durationSeconds: lessons.durationSeconds, isFree: lessons.isFree, videoStatus: videos.status })
      .from(lessons)
      .leftJoin(videos, eq(videos.id, lessons.videoId))
      .where(eq(lessons.courseId, id))
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
    await getCache().del("courses:list:published:" + 1 + ":" + 10);
    return row;
  },

  async update(user: { id: string; roles: string[] }, id: string, input: Partial<CourseInput>) {
    const db = getDb();
    const existing = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
    if (!existing[0]) throw new NotFoundError("Course not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && existing[0].mentorId !== user.id) throw new ForbiddenError("Only the course owner or admin can update");
    const [row] = await db
      .update(courses)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(courses.id, id))
      .returning();
    await getCache().del("courses:list:published:" + 1 + ":" + 10);
    if (!row) throw new NotFoundError("Course not found");
    return row;
  },

  async publish(user: { id: string; roles: string[] }, id: string) {
    return this.update(user, id, { status: "published" });
  },

  async enroll(userId: string, courseId: string) {
    const db = getDb();
    const course = await db.select({ id: courses.id, priceCents: courses.priceCents }).from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course[0]) throw new NotFoundError("Course not found");
    // Already enrolled (e.g. via payment fulfillment) → no-op success
    const existing = await db.select({ id: courseEnrollments.id }).from(courseEnrollments).where(and(eq(courseEnrollments.userId, userId), eq(courseEnrollments.courseId, courseId))).limit(1);
    if (existing[0]) return { enrolled: true, alreadyEnrolled: true };
    if (course[0].priceCents > 0) throw new ForbiddenError("Paid courses require payment", "PAYMENT_REQUIRED");
    await db.insert(courseEnrollments).values({ userId, courseId });
    return { enrolled: true, alreadyEnrolled: false };
  },

  async isEnrolled(userId: string, courseId: string): Promise<boolean> {
    const db = getDb();
    const row = await db.select({ id: courseEnrollments.id }).from(courseEnrollments).where(and(eq(courseEnrollments.userId, userId), eq(courseEnrollments.courseId, courseId))).limit(1);
    return row.length > 0;
  },

  async addLesson(courseId: string, input: { title: string; description?: string; videoId?: string; isFree?: boolean }) {
    const db = getDb();
    const course = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course[0]) throw new NotFoundError("Course not found");
    const maxOrder = await db.select({ max: lessons.sortOrder }).from(lessons).where(eq(lessons.courseId, courseId));
    const [row] = await db
      .insert(lessons)
      .values({ courseId, ...input, sortOrder: (maxOrder[0]?.max ?? 0) + 1 })
      .returning();
    return row;
  },

  async updateLesson(lessonId: string, input: Partial<{ title: string; description: string; videoId: string; isFree: boolean }>) {
    const db = getDb();
    const [row] = await db.update(lessons).set({ ...input, updatedAt: new Date() }).where(eq(lessons.id, lessonId)).returning();
    if (!row) throw new NotFoundError("Lesson not found");
    return row;
  },

  async recordProgress(userId: string, lessonId: string, input: { status?: string; progressPercent?: number; lastPositionSeconds?: number }) {
    const db = getDb();
    const lesson = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.id, lessonId)).limit(1);
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

  async listProgress(userId: string, courseId: string) {
    const db = getDb();
    const rows = await db
      .select({ lessonId: lessonProgress.lessonId, status: lessonProgress.status, progressPercent: lessonProgress.progressPercent, lastPositionSeconds: lessonProgress.lastPositionSeconds, updatedAt: lessonProgress.updatedAt })
      .from(lessonProgress)
      .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
      .where(and(eq(lessonProgress.userId, userId), eq(lessons.courseId, courseId)));
    return rows;
  }
};