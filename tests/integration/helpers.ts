/**
 * Shared test utilities for integration suites.
 * Requires the compose stack (postgres, pgbouncer, redis, mongo, minio, mailpit).
 */
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { DegradationManager } from "../../src/shared/redis/index.js";
import { HealthRegistry } from "../../src/modules/system/index.js";
import { getPool } from "../../src/shared/db/client.js";
import { getRedis } from "../../src/shared/redis/client.js";
import { accessCookieName } from "../../src/shared/auth/index.js";
import { issueAccessToken } from "../../src/modules/auth/index.js";

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

/** All tables that integration tests touch (order matters for FK cascades). */
const ALL_TABLES = [
  "simulation_answers", "simulation_sessions", "simulation_packages",
  "lesson_progress", "course_enrollments", "lessons", "videos",
  "question_options", "questions", "courses",
  "orders", "payment_events",
  "audit_logs", "refresh_tokens", "email_verifications", "password_resets",
  "user_identities", "user_roles", "users",
  "notifications", "tags", "question_tags", "follows",
  "coupons", "bundles", "bundle_courses",
  "analytics_events", "daily_challenges", "question_notes",
  "certificates", "wishlist",
  "points_events", "badges", "user_badges",
];

/** Truncate the PostgreSQL tables used by tests (RESTART IDENTITY, CASCADE). */
export async function truncateDb(tables: string[] = ALL_TABLES): Promise<void> {
  const pool = getPool();
  await pool.query("TRUNCATE TABLE " + tables.join(", ") + " RESTART IDENTITY CASCADE");
}

/** Build the app in minimal mode (no cache binding) and await readiness. */
export async function buildTestApp(): Promise<TestApp> {
  const app = await buildApp({
    minimal: true,
    logger: false,
    degradation: new DegradationManager(),
    healthRegistry: new HealthRegistry(),
  });
  await app.ready();
  return app;
}

/** Create a user + role in the DB and return a signed access token. */
export async function loginAs(email: string, name: string, role: string): Promise<string> {
  const db = getPool();
  const user = await db.query(
    "INSERT INTO users (email, password_hash, name, status, email_verified_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id",
    [email, "ignored", name, "active"]
  );
  const userId = user.rows[0]?.id as string;
  const roleRow = await db.query("SELECT id FROM roles WHERE name = $1", [role]);
  if (roleRow.rows[0]) {
    await db.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleRow.rows[0].id]);
  }
  return issueAccessToken(userId, email);
}

/** Auth + CSRF headers for mutating requests (double-submit token). */
export function authHeaders(token: string): Record<string, string> {
  return { cookie: accessCookieName() + "=" + token + "; csrf_token=test-csrf", "x-csrf-token": "test-csrf" };
}

/** Read a single cookie value out of a Set-Cookie header. */
export function cookieValue(setCookieHeader: string | string[] | undefined, name: string): string | null {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader.join(",") : setCookieHeader;
  if (!header) return null;
  for (const part of header.split(",")) {
    const [pair] = part.trim().split(";");
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return null;
}

/**
 * Wait for the shared Redis client to be connected.
 * The app client uses enableOfflineQueue: false — commands issued before the
 * connection is established reject immediately (and our .catch() would make
 * cleanup silently no-op). The client is created with lazyConnect: false, so
 * it starts connecting at construction; the first connection attempt can fail
 * (e.g. IPv6->IPv4 fallback) and retry with backoff — we must WAIT for the
 * ready event, not just fire commands. Always await before Redis cleanup.
 */
export async function ensureRedisConnected(timeoutMs = 8000): Promise<void> {
  const redis = getRedis();
  if (redis.status === "ready") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      redis.off("ready", onReady);
      resolve();
    };
    const onReady = () => finish();
    const timer = setTimeout(() => finish(), timeoutMs);
    redis.once("ready", onReady);
    // Kick the connection (may reject with "already connecting" — swallow)
    redis.connect().catch(() => {});
  });
  await redis.ping().catch(() => {});
}

/** Delete every rate-limit bucket in Redis (route-scoped keys share "asbt:rl" prefix). */
export async function clearRateLimitBuckets(): Promise<void> {
  await ensureRedisConnected();
  const redis = getRedis();
  try {
    const keys = await redis.keys("asbt:rl*");
    if (keys.length) await redis.del(...keys);
  } catch {
    /* Redis down — buckets fall back to in-memory, nothing to clear */
  }
}

export interface DbCourseOpts {
  title?: string;
  status?: string;
  priceCents?: number;
  mentorId?: string | null;
  deletedAt?: string | null;
  slug?: string;
}

/** Insert a course directly in the DB (fast fixture setup). */
export async function insertCourse(opts: DbCourseOpts = {}): Promise<{ id: string; slug: string }> {
  const slug = opts.slug ?? "course-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const db = getPool();
  const rows = await db.query(
    `INSERT INTO courses (mentor_id, title, slug, status, price_cents, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, slug`,
    [opts.mentorId ?? null, opts.title ?? "Course", slug, opts.status ?? "published", opts.priceCents ?? 0, opts.deletedAt ?? null]
  );
  return { id: rows.rows[0]?.id as string, slug };
}

export interface DbQuestionOpts {
  text?: string;
  category?: string;
  type?: string;
  difficulty?: string;
  createdBy?: string | null;
  deletedAt?: string | null;
  options?: { text: string; isCorrect: boolean }[];
}

/** Insert a question (+options) directly in the DB. */
export async function insertQuestion(opts: DbQuestionOpts = {}): Promise<{ id: string; optionIds: string[] }> {
  const db = getPool();
  const rows = await db.query(
    `INSERT INTO questions (text, category, type, difficulty, created_by, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.text ?? "Question?", opts.category ?? "TPS", opts.type ?? "multiple_choice", opts.difficulty ?? "medium", opts.createdBy ?? null, opts.deletedAt ?? null]
  );
  const id = rows.rows[0]?.id as string;
  const optionIds: string[] = [];
  for (const [i, o] of (opts.options ?? []).entries()) {
    const opt = await db.query(
      "INSERT INTO question_options (question_id, text, is_correct, sort_order) VALUES ($1, $2, $3, $4) RETURNING id",
      [id, o.text, o.isCorrect, i]
    );
    optionIds.push(opt.rows[0]?.id as string);
  }
  return { id, optionIds };
}

export interface DbVideoOpts {
  title?: string;
  status?: string;
  rawKey?: string | null;
  hlsPrefix?: string | null;
  masterPlaylistKey?: string | null;
  deletedAt?: string | null;
}

/** Insert a video directly in the DB. */
export async function insertVideo(opts: DbVideoOpts = {}): Promise<string> {
  const db = getPool();
  const rows = await db.query(
    `INSERT INTO videos (title, status, raw_key, hls_prefix, master_playlist_key, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.title ?? "Video", opts.status ?? "uploaded", opts.rawKey ?? null, opts.hlsPrefix ?? null, opts.masterPlaylistKey ?? null, opts.deletedAt ?? null]
  );
  return rows.rows[0]?.id as string;
}

export interface DbLessonOpts {
  courseId: string;
  title?: string;
  videoId?: string | null;
  isFree?: boolean;
  sortOrder?: number;
  deletedAt?: string | null;
}

/** Insert a lesson directly in the DB. */
export async function insertLesson(opts: DbLessonOpts): Promise<string> {
  const db = getPool();
  const rows = await db.query(
    `INSERT INTO lessons (course_id, title, video_id, is_free, sort_order, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.courseId, opts.title ?? "Lesson", opts.videoId ?? null, opts.isFree ?? false, opts.sortOrder ?? 1, opts.deletedAt ?? null]
  );
  return rows.rows[0]?.id as string;
}

export interface DbPackageOpts {
  title?: string;
  status?: string;
  durationMinutes?: number;
  questionCounts?: Record<string, number>;
  scoring?: { correct: number; blank: number; wrong: number };
  createdBy?: string | null;
  deletedAt?: string | null;
  maxAttempts?: number | null;
  retakeCooldownMinutes?: number | null;
}

/** Insert a simulation package directly in the DB. */
export async function insertPackage(opts: DbPackageOpts = {}): Promise<string> {
  const db = getPool();
  const rows = await db.query(
    `INSERT INTO simulation_packages (title, status, duration_minutes, question_counts, scoring, created_by, deleted_at, max_attempts, retake_cooldown_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [opts.title ?? "Paket Try Out", opts.status ?? "draft", opts.durationMinutes ?? 30, JSON.stringify(opts.questionCounts ?? { TPS: 2 }), JSON.stringify(opts.scoring ?? { correct: 4, blank: 0, wrong: 0 }), opts.createdBy ?? null, opts.deletedAt ?? null, opts.maxAttempts ?? null, opts.retakeCooldownMinutes ?? null]
  );
  return rows.rows[0]?.id as string;
}

export interface DbOrderOpts {
  userId: string;
  courseId: string;
  status?: string;
  amountCents?: number;
  createdAt?: string;
}

/** Insert a payment order directly in the DB. */
export async function insertOrder(opts: DbOrderOpts): Promise<{ id: string; orderNumber: string }> {
  const orderNumber = "TEST-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const db = getPool();
  const rows = await db.query(
    `INSERT INTO orders (user_id, order_number, amount_cents, status, provider, course_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, 'mock', $5, $6, $7) RETURNING id, order_number`,
    [opts.userId, orderNumber, opts.amountCents ?? 1000, opts.status ?? "pending", opts.courseId, JSON.stringify({ courseTitle: "Test Course" }), opts.createdAt ?? new Date().toISOString()]
  );
  return { id: rows.rows[0]?.id as string, orderNumber: rows.rows[0]?.order_number as string };
}

export interface DbSessionOpts {
  userId: string;
  packageId: string;
  status?: string;
  startedAt?: string;
  deadlineAt?: string;
  score?: number | null;
  percentile?: number | null;
}

/** Insert a simulation session directly in the DB. */
export async function insertSession(opts: DbSessionOpts): Promise<string> {
  const db = getPool();
  const rows = await db.query(
    `INSERT INTO simulation_sessions (user_id, package_id, status, started_at, deadline_at, score, percentile, max_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING id`,
    [opts.userId, opts.packageId, opts.status ?? "in_progress", opts.startedAt ?? new Date().toISOString(), opts.deadlineAt ?? new Date(Date.now() + 3600_000).toISOString(), opts.score ?? null, opts.percentile ?? null]
  );
  return rows.rows[0]?.id as string;
}

/** Get a user's id by email. */
export async function userIdByEmail(email: string): Promise<string> {
  const db = getPool();
  const rows = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  return rows.rows[0]?.id as string;
}

export type { FastifyInstance };
