import { and, eq, inArray, sql, desc, count, isNotNull } from "drizzle-orm";
import { getDb, getReadDb } from "../../shared/db/client.js";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { notDeleted } from "../../shared/db/filters.js";
import { simulationPackageRepo } from "./repository.js";
import { audit } from "../../shared/audit/audit.js";
import { cacheVersion, bumpCacheVersion } from "../../shared/cache/version.js";
import { eventBus } from "../../shared/events/bus.js";
import {
  simulationPackages, simulationSessions, simulationAnswers, questions, questionOptions, users, tags, questionTags, follows
} from "../../shared/db/schema/index.js";
import { NotFoundError, BadRequestError, ForbiddenError, ConflictError } from "../../shared/http/errors.js";
import { QueueName, enqueue } from "../../shared/queue/queues.js";
import { getCache } from "../../shared/cache/cache.js";
import { presignGet } from "../../shared/s3/client.js";
import { seededShuffle } from "./shuffle.js";
import { getLogger } from "../../shared/logger.js";

const log = getLogger();

/** M4: sanity-check attempt-policy fields (ints, no negatives). */
/** A1: convert ISO schedule strings to Date (null stays null). */
function toDateOrNull(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v);
}

function validateAttemptPolicy(input: { maxAttempts?: number | null; retakeCooldownMinutes?: number | null }): void {
  if (input.maxAttempts !== undefined && input.maxAttempts !== null && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) {
    throw new BadRequestError("maxAttempts must be a positive integer or null", "VALIDATION_ERROR");
  }
  if (input.retakeCooldownMinutes !== undefined && input.retakeCooldownMinutes !== null && (!Number.isInteger(input.retakeCooldownMinutes) || input.retakeCooldownMinutes < 0)) {
    throw new BadRequestError("retakeCooldownMinutes must be a non-negative integer or null", "VALIDATION_ERROR");
  }
}

export interface PackageInput {
  title: string;
  description?: string;
  durationMinutes?: number;
  questionCounts?: Record<string, number>;
  scoring?: { correct: number; blank: number; wrong: number };
  status?: string;
  maxAttempts?: number | null;
  retakeCooldownMinutes?: number | null;
  scheduledAt?: string | Date | null;
  closesAt?: string | Date | null;
}

export const simulationsService = {
  // ── Packages ────────────────────────────────────────────────────────
  /** Cursor-paginated published packages: (createdAt DESC, id DESC) keyset. */
  async listPackages(input: { cursor?: string; limit: number }) {
    const db = getDb();
    const { limit } = input;
    const cacheKey = "sims:packages:v" + (await cacheVersion("simulation_packages")) + ":" + (input.cursor ?? "first");
    const buildWhere = () => {
      const kc = decodeCursor(input.cursor);
      const base = and(eq(simulationPackages.status, "published"), notDeleted(simulationPackages.deletedAt));
      return kc
        ? and(base, keysetCondition([
            { name: "created_at", value: kc.createdAt as string, dir: "desc" },
            { name: "id", value: kc.id as string, dir: "desc" }
          ]))
        : base;
    };
    const query = () =>
      db
        .select()
        .from(simulationPackages)
        .where(buildWhere())
        .orderBy(desc(simulationPackages.createdAt), desc(simulationPackages.id))
        .limit(limit);
    const cached = await getCache()
      .get<{ rows: unknown[]; nextCursor: string | null; limit: number } | null>(
        cacheKey,
        async () => buildPage(await query(), limit, ["createdAt", "id"]),
        30_000
      )
      .catch(() => null);
    if (cached) return cached;
    return buildPage(await query(), limit, ["createdAt", "id"]);
  },

  /** A1: scheduled tryouts — published packages with a schedule, newest window first. */
  async listTryouts(input: { cursor?: string; limit: number }) {
    const db = getDb();
    const { limit } = input;
    const kc = decodeCursor(input.cursor);
    const where = and(
      eq(simulationPackages.status, "published"),
      notDeleted(simulationPackages.deletedAt),
      isNotNull(simulationPackages.scheduledAt),
      kc
        ? keysetCondition([
            { name: "scheduled_at", value: kc.scheduledAt as string, dir: "desc" },
            { name: "id", value: kc.id as string, dir: "desc" }
          ])
        : undefined
    );
    const rows = await db
      .select({ id: simulationPackages.id, title: simulationPackages.title, description: simulationPackages.description, durationMinutes: simulationPackages.durationMinutes, questionCounts: simulationPackages.questionCounts, scoring: simulationPackages.scoring, scheduledAt: simulationPackages.scheduledAt, closesAt: simulationPackages.closesAt })
      .from(simulationPackages)
      .where(where)
      .orderBy(desc(simulationPackages.scheduledAt), desc(simulationPackages.id))
      .limit(limit);
    return buildPage(rows, limit, ["scheduledAt", "id"]);
  },

  async getPackage(id: string) {
    const row = await simulationPackageRepo.findById(id);
    const pkg = row[0];
    if (!pkg) throw new NotFoundError("Simulation package not found");
    return pkg;
  },

  async createPackage(userId: string, input: PackageInput) {
    const db = getDb();
    validateAttemptPolicy(input);
    const [row] = await db.insert(simulationPackages).values({
      title: input.title,
      description: input.description ?? null,
      durationMinutes: input.durationMinutes,
      questionCounts: input.questionCounts ?? {},
      scoring: input.scoring ?? { correct: 4, blank: 0, wrong: 0 },
      status: input.status,
      maxAttempts: input.maxAttempts ?? null,
      retakeCooldownMinutes: input.retakeCooldownMinutes ?? null,
      scheduledAt: toDateOrNull(input.scheduledAt),
      closesAt: toDateOrNull(input.closesAt),
      createdBy: userId
    }).returning();
    if (!row) throw new ConflictError("Failed to create package");
    await bumpCacheVersion("simulation_packages");
    return row;
  },

  async updatePackage(id: string, input: Partial<PackageInput>) {
    const db = getDb();
    validateAttemptPolicy(input);
    // Only touch schedule fields when explicitly provided (publish etc. must not wipe them)
    const { scheduledAt: _sched, closesAt: _closes, ...rest } = input;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.scheduledAt !== undefined) set.scheduledAt = toDateOrNull(input.scheduledAt);
    if (input.closesAt !== undefined) set.closesAt = toDateOrNull(input.closesAt);
    const [row] = await db.update(simulationPackages).set({ ...rest, ...set }).where(eq(simulationPackages.id, id)).returning();
    if (!row) throw new NotFoundError("Package not found");
    await bumpCacheVersion("simulation_packages");
    eventBus.emit("simulation_package.updated", { packageId: id });
    return row;
  },

  /** Soft delete a package (admin/mentor) + audit. */
  async removePackage(user: { id: string; roles: string[] }, id: string) {
    if (!user.roles.includes("admin") && !user.roles.includes("mentor")) throw new ForbiddenError("Insufficient permissions");
    const pkg = await simulationPackageRepo.findById(id);
    const p = pkg[0];
    if (!p) throw new NotFoundError("Package not found");
    await simulationPackageRepo.softDelete(id);
    await audit({ action: "simulation_package.delete", resourceType: "simulation_package", resourceId: id, before: { title: p.title } });
    await bumpCacheVersion("simulation_packages");
    eventBus.emit("simulation_package.deleted", { packageId: id });
    return { deleted: true, soft: true };
  },

  /** Admin restore after soft delete. */
  async restorePackage(user: { id: string; roles: string[] }, id: string) {
    if (!user.roles.includes("admin")) throw new ForbiddenError("Only admins can restore packages");
    const pkg = await simulationPackageRepo.findById(id);
    if (pkg[0]) return { restored: true, alreadyActive: true };
    const deleted = await getDb().select().from(simulationPackages).where(eq(simulationPackages.id, id)).limit(1);
    const p = deleted[0];
    if (!p) throw new NotFoundError("Package not found");
    await simulationPackageRepo.restore(id);
    await audit({ action: "simulation_package.restore", resourceType: "simulation_package", resourceId: id });
    await bumpCacheVersion("simulation_packages");
    return { restored: true };
  },

  // ── Sessions ────────────────────────────────────────────────────────
  /** Pick questions per category and create the session + answer rows. */
  async startSession(userId: string, packageId: string) {
    const db = getDb();
    const pkg = await this.getPackage(packageId);
    if (pkg.status !== "published") throw new ForbiddenError("Package not published");
    // A1: scheduled tryout window
    const now = new Date();
    if (pkg.scheduledAt && pkg.scheduledAt > now) {
      throw new ForbiddenError("Tryout has not started yet", "TRYOUT_NOT_STARTED", { startsAt: pkg.scheduledAt.toISOString() });
    }
    if (pkg.closesAt && pkg.closesAt < now) {
      throw new ForbiddenError("Tryout window has closed", "TRYOUT_EXPIRED", { closesAt: pkg.closesAt.toISOString() });
    }
    // M4: enforce attempt policy
    const attempts = await db
      .select({ startedAt: simulationSessions.startedAt })
      .from(simulationSessions)
      .where(and(eq(simulationSessions.userId, userId), eq(simulationSessions.packageId, packageId), eq(simulationSessions.type, "simulation")));
    const attemptsUsed = attempts.length;
    if (pkg.maxAttempts !== null && pkg.maxAttempts !== undefined && attemptsUsed >= pkg.maxAttempts) {
      throw new ForbiddenError("Attempt limit reached for this package", "ATTEMPT_LIMIT_REACHED", { attemptsUsed, maxAttempts: pkg.maxAttempts, retryAfter: null });
    }
    if (pkg.retakeCooldownMinutes) {
      const last = attempts.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      if (last) {
        const nextAllowed = new Date(last.startedAt.getTime() + pkg.retakeCooldownMinutes * 60_000);
        if (Date.now() < nextAllowed.getTime()) {
          throw new ForbiddenError("Retake cooldown active", "ATTEMPT_LIMIT_REACHED", { attemptsUsed, maxAttempts: pkg.maxAttempts ?? null, retryAfter: nextAllowed.toISOString() });
        }
      }
    }

    const counts = (pkg.questionCounts ?? {}) as Record<string, number>;
    const categories = Object.keys(counts);
    if (categories.length === 0 || categories.every((c) => (counts[c] ?? 0) <= 0)) {
      throw new BadRequestError("Package has no questions configured", "PACKAGE_EMPTY");
    }

    // Pick N random questions per key (server-side, anti-cheat by design).
    // Keys are categories ("TPS_PK") or tags ("tag:aljabar") — M6.
    const picked: { id: string; category: string }[] = [];
    for (const key of categories) {
      const wanted = counts[key] ?? 0;
      if (wanted <= 0) continue;
      let rows: { id: string }[];
      if (key.startsWith("tag:")) {
        rows = await db
          .select({ id: questions.id })
          .from(questions)
          .innerJoin(questionTags, eq(questionTags.questionId, questions.id))
          .innerJoin(tags, eq(tags.id, questionTags.tagId))
          .where(and(eq(tags.name, key.slice(4)), eq(questions.type, "multiple_choice"), notDeleted(questions.deletedAt)))
          .orderBy(sql.raw("random()"))
          .limit(wanted);
      } else {
        rows = await db
          .select({ id: questions.id })
          .from(questions)
          .where(and(eq(questions.category, key), eq(questions.type, "multiple_choice"), notDeleted(questions.deletedAt)))
          .orderBy(sql.raw("random()"))
          .limit(wanted);
      }
      picked.push(...rows.map((r) => ({ id: r.id, category: key })));
    }
    if (picked.length === 0) throw new BadRequestError("No matching questions in bank", "BANK_EMPTY");

    const durationMinutes = pkg.durationMinutes ?? 120;
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + durationMinutes * 60_000);
    const [session] = await db
      .insert(simulationSessions)
      .values({ userId, packageId, status: "in_progress", startedAt, deadlineAt, maxScore: 0 })
      .returning();
    if (!session) throw new ConflictError("Failed to create session");

    // Pre-create answer rows: defines this session's question set
    await db.insert(simulationAnswers).values(
      picked.map((q, i) => ({ sessionId: session.id, questionId: q.id, sortOrder: i }))
    );

    // Delayed auto-submit: guarantees grading even if the student never submits
    const delayMs = durationMinutes * 60_000 + 5_000;
    await enqueue(QueueName.Grading, { type: "auto-submit", sessionId: session.id }, {
      delay: delayMs,
      jobId: "auto-submit-" + session.id,
    });
    log.info({ sessionId: session.id, delayMs }, "auto-submit scheduled");
    // A9: analytics
    eventBus.emit("simulation.started", { sessionId: session.id, userId, type: "simulation" });

    return { sessionId: session.id, deadlineAt, durationMinutes };
  },

  /** Session detail: questions WITHOUT correct answers, options seeded-shuffled. */
  async getSession(userId: string, sessionId: string) {
    const db = getDb();
    const session = await this.getOwnedSession(userId, sessionId);
    const answerRows = await db
      .select({
        questionId: simulationAnswers.questionId,
        selectedOptionId: simulationAnswers.selectedOptionId,
        isFlagged: simulationAnswers.isFlagged,
        timeSpentMs: simulationAnswers.timeSpentMs,
        sortOrder: simulationAnswers.sortOrder,
      })
      .from(simulationAnswers)
      .where(eq(simulationAnswers.sessionId, sessionId))
      .orderBy(simulationAnswers.sortOrder);
    const qIds = answerRows.map((a) => a.questionId);
    const qRows = qIds.length ? await db.select().from(questions).where(inArray(questions.id, qIds)) : [];
    const optRows = qIds.length ? await db.select().from(questionOptions).where(inArray(questionOptions.questionId, qIds)) : [];
    const questionsOut = answerRows.map((a) => {
      const q = qRows.find((r) => r.id === a.questionId);
      if (!q) return null;
      const opts = optRows.filter((o) => o.questionId === q.id);
      return {
        id: q.id,
        text: q.text,
        category: q.category,
        difficulty: q.difficulty,
        options: seededShuffle(opts, session.id + ":" + q.id).map((o) => ({ id: o.id, text: o.text })),
        selectedOptionId: a.selectedOptionId ?? null,
        answered: a.selectedOptionId !== null,
        flagged: a.isFlagged,
        timeSpentMs: a.timeSpentMs,
      };
    }).filter((q): q is NonNullable<typeof q> => q !== null);
    // M3: warn threshold from the package (simulation-type sessions only)
    let warnAtRemainingMs: number | null = null;
    if (session.type === "simulation" && session.packageId) {
      const pkg = await db.select({ warnAtRemainingMs: simulationPackages.warnAtRemainingMs }).from(simulationPackages).where(eq(simulationPackages.id, session.packageId)).limit(1);
      warnAtRemainingMs = pkg[0]?.warnAtRemainingMs ?? null;
    }
    return { ...session, warnAtRemainingMs, questions: questionsOut };
  },

  async getOwnedSession(userId: string, sessionId: string) {
    const db = getDb();
    const row = await db.select().from(simulationSessions).where(and(eq(simulationSessions.id, sessionId), eq(simulationSessions.userId, userId))).limit(1);
    const session = row[0];
    if (!session) throw new NotFoundError("Session not found");
    return session;
  },

  /** Save an answer; lazily auto-submits when the deadline has passed. */
  async saveAnswer(userId: string, sessionId: string, questionId: string, selectedOptionId: string) {
    const session = await this.getOwnedSession(userId, sessionId);
    if (session.status !== "in_progress") throw new BadRequestError("Session is not active", "SESSION_CLOSED");
    if (Date.now() > session.deadlineAt.getTime()) {
      // Lazy auto-submit: the deadline passed, so grading is due NOW (inline —
      // no point deferring to the queue when the session is already expired).
      await this.submitSession(userId, sessionId, true);
      await this.gradeSession(sessionId);
      throw new BadRequestError("Session time expired — auto-submitted", "SESSION_EXPIRED");
    }
    const db = getDb();
    const answer = await db
      .select({ id: simulationAnswers.id, timeSpentMs: simulationAnswers.timeSpentMs })
      .from(simulationAnswers)
      .where(and(eq(simulationAnswers.sessionId, sessionId), eq(simulationAnswers.questionId, questionId)))
      .limit(1);
    if (!answer[0]) throw new BadRequestError("Question not in this session");
    // Time accounting (M3): attribute elapsed time since the latest answer
    // event in this session (or session start for the first one) to THIS
    // question. NULL answeredAt rows sort last in DESC, so the max non-null
    // timestamp (including this row on overwrites) comes back first.
    const prev = await db
      .select({ answeredAt: simulationAnswers.answeredAt })
      .from(simulationAnswers)
      .where(eq(simulationAnswers.sessionId, sessionId))
      .orderBy(desc(simulationAnswers.answeredAt))
      .limit(1);
    const base = prev[0]?.answeredAt ?? session.startedAt;
    const elapsed = Math.max(0, Date.now() - base.getTime());
    const timeSpentMs = (answer[0].timeSpentMs ?? 0) + elapsed;
    await db
      .update(simulationAnswers)
      .set({ selectedOptionId, answeredAt: new Date(), timeSpentMs })
      .where(eq(simulationAnswers.id, answer[0].id));
    return { saved: true, timeSpentMs };
  },

  /** Flag a question for review (exam UX). Only while the session is active. */
  async flagAnswer(userId: string, sessionId: string, questionId: string, isFlagged: boolean) {
    const session = await this.getOwnedSession(userId, sessionId);
    if (session.status !== "in_progress") throw new BadRequestError("Session is not active", "SESSION_CLOSED");
    const db = getDb();
    const answer = await db
      .select({ id: simulationAnswers.id })
      .from(simulationAnswers)
      .where(and(eq(simulationAnswers.sessionId, sessionId), eq(simulationAnswers.questionId, questionId)))
      .limit(1);
    if (!answer[0]) throw new BadRequestError("Question not in this session");
    await db.update(simulationAnswers).set({ isFlagged }).where(eq(simulationAnswers.id, answer[0].id));
    return { flagged: isFlagged };
  },

  /** Submit: enqueue grading (async). When silent (auto), no user-facing error. */
  async submitSession(userId: string, sessionId: string, silent = false) {
    const session = await this.getOwnedSession(userId, sessionId);
    if (session.status !== "in_progress") return { submitted: false, alreadySubmitted: true };
    const db = getDb();
    const now = new Date();
    const [updated] = await db
      .update(simulationSessions)
      .set({ status: "submitted", submittedAt: now })
      .where(and(eq(simulationSessions.id, sessionId), eq(simulationSessions.status, "in_progress")))
      .returning({ id: simulationSessions.id });
    if (!updated) return { submitted: false, alreadySubmitted: true };
    await enqueue(QueueName.Grading, { type: "grade", sessionId });
    void silent;
    return { submitted: true, alreadySubmitted: false };
  },

  async getResult(userId: string, sessionId: string) {
    const session = await this.getOwnedSession(userId, sessionId);
    if (session.status !== "graded") throw new BadRequestError("Session not graded yet", "NOT_GRADED");
    const pkg = session.packageId ? await this.getPackage(session.packageId) : null;
    const rank = session.packageId ? await this.computeRank(session.packageId, session.score ?? 0, session.id) : null;
    // A9: analytics
    eventBus.emit("results.viewed", { sessionId, userId });
    return {
      sessionId: session.id,
      packageId: session.packageId,
      packageTitle: pkg?.title ?? null,
      status: session.status,
      score: session.score,
      maxScore: session.maxScore,
      correctCount: session.correctCount,
      wrongCount: session.wrongCount,
      blankCount: session.blankCount,
      percentile: session.percentile,
      rank,
      submittedAt: session.submittedAt,
    };
  },

  /** Cursor-paginated my sessions: (startedAt DESC, id DESC) keyset. */
  async listMySessions(userId: string, cursor: string | undefined, limit: number) {
    const db = getDb();
    const kc = decodeCursor(cursor);
    const baseType = eq(simulationSessions.type, "simulation");
    const where = kc
      ? and(
          baseType,
          eq(simulationSessions.userId, userId),
          keysetCondition([
            { name: "simulation_sessions.started_at", value: kc.startedAt as string, dir: "desc" },
            { name: "simulation_sessions.id", value: kc.id as string, dir: "desc" }
          ])
        )
      : and(baseType, eq(simulationSessions.userId, userId));
    const rows = await db
      .select({ id: simulationSessions.id, packageId: simulationSessions.packageId, packageTitle: simulationPackages.title, status: simulationSessions.status, score: simulationSessions.score, percentile: simulationSessions.percentile, startedAt: simulationSessions.startedAt, submittedAt: simulationSessions.submittedAt, createdAt: simulationSessions.startedAt })
      .from(simulationSessions)
      .innerJoin(simulationPackages, eq(simulationPackages.id, simulationSessions.packageId))
      .where(where)
      .orderBy(desc(simulationSessions.startedAt), desc(simulationSessions.id))
      .limit(limit);
    // M4: per-package attempt count for the user
    const pkgIds = [...new Set(rows.map((r) => r.packageId).filter(Boolean))] as string[];
    const counts: Record<string, number> = {};
    if (pkgIds.length > 0) {
      const grouped = await db
        .select({ packageId: simulationSessions.packageId, count: count() })
        .from(simulationSessions)
        .where(and(eq(simulationSessions.userId, userId), eq(simulationSessions.type, "simulation"), inArray(simulationSessions.packageId, pkgIds)))
        .groupBy(simulationSessions.packageId);
      for (const g of grouped) counts[g.packageId ?? ""] = g.count;
    }
    const enriched = rows.map((r) => ({ ...r, attemptsUsed: counts[r.packageId ?? ""] ?? 0 }));
    return buildPage(enriched, limit, ["createdAt", "id"]);
  },

  // ── Leaderboard ─────────────────────────────────────────────────────
  /**
   * A7: leaderboard with period + friends-only filters and the requester's
   * personal rank. Returns { rows, personalRank } — rows keep the old shape.
   */
  async getLeaderboard(packageId: string, limit = 20, opts: { period?: "week" | "month" | "all"; friendIds?: string[]; userId?: string } = {}) {
    const db = getReadDb(); // leaderboard reads hit the replica when configured
    const period = opts.period ?? "all";
    const cutoff = period === "week" ? new Date(Date.now() - 7 * 24 * 3600_000) : period === "month" ? new Date(Date.now() - 30 * 24 * 3600_000) : null;
    const friendIds = opts.friendIds?.length ? opts.friendIds : undefined;
    // Friends filter is user-specific → bypass the shared cache
    const cacheable = !friendIds;
    const buildWhere = () => and(
      eq(simulationSessions.packageId, packageId),
      eq(simulationSessions.status, "graded"),
      cutoff ? sql`${simulationSessions.submittedAt} >= ${cutoff}` : undefined,
      friendIds ? inArray(simulationSessions.userId, friendIds) : undefined
    );
    void buildWhere;
    const query = () =>
      db
        .select({
          userId: simulationSessions.userId,
          name: users.name,
          score: simulationSessions.score,
          percentile: simulationSessions.percentile,
          submittedAt: simulationSessions.submittedAt,
        })
        .from(simulationSessions)
        .innerJoin(users, eq(users.id, simulationSessions.userId))
        .where(buildWhere())
        .orderBy(desc(simulationSessions.score))
        .limit(limit);
    let rows: Awaited<ReturnType<typeof query>>;
    if (cacheable) {
      const cacheKey = "sims:leaderboard:v" + (await cacheVersion("leaderboard:" + packageId)) + ":" + packageId + ":" + period + ":" + limit;
      const cached = await getCache()
        .get<typeof rows | null>(cacheKey, query, 30_000)
        .catch(() => null);
      rows = cached ?? (await query());
    } else {
      rows = await query();
    }
    // Personal rank: 1 = best score within the same filtered set (ties share rank)
    let personalRank: number | null = null;
    if (opts.userId) {
      const all = await db
        .select({ userId: simulationSessions.userId, score: simulationSessions.score })
        .from(simulationSessions)
        .where(buildWhere());
      const myScore = all.find((r) => r.userId === opts.userId)?.score ?? null;
      if (myScore !== null) {
        const higher = all.filter((r) => (r.score ?? 0) > myScore).length;
        personalRank = higher + 1;
      }
    }
    return { rows, personalRank };
  },

  /** A7: ids the user follows (used by the friends-only leaderboard filter). */
  async listFollowingIds(userId: string): Promise<string[]> {
    const rows = await getDb()
      .select({ followeeId: follows.followeeId })
      .from(follows)
      .where(eq(follows.followerId, userId));
    return rows.map((r) => r.followeeId);
  },

  /** Rank within the package: 1 = best score (ties share the rank). */
  async computeRank(packageId: string, score: number, excludeSessionId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ score: simulationSessions.score, id: simulationSessions.id })
      .from(simulationSessions)
      .where(and(eq(simulationSessions.packageId, packageId), eq(simulationSessions.status, "graded")));
    const all = rows.filter((r) => r.id !== excludeSessionId).map((r) => r.score ?? 0);
    const higher = all.filter((s) => s > score).length;
    return higher + 1;
  },

  // ── Grading (called from the BullMQ worker) ─────────────────────────
  async gradeSession(sessionId: string): Promise<void> {
    const db = getDb();
    const session = await db.select().from(simulationSessions).where(eq(simulationSessions.id, sessionId)).limit(1);
    const s = session[0];
    if (!s) return;
    if (s.status === "graded") return;
    if (s.status === "in_progress") {
      // Auto-submit path: the deadline passed, force submission
      await db.update(simulationSessions).set({ status: "submitted", submittedAt: new Date() }).where(eq(simulationSessions.id, sessionId));
    }
    const pkg = s.packageId ? await this.getPackage(s.packageId) : null;
    const scoring = (pkg?.scoring ?? { correct: 4, blank: 0, wrong: 0 }) as { correct: number; blank: number; wrong: number };
    // A2: per-category scoring override — scoring.perCategory[category] wins over the base
    const perCategory = (pkg?.scoring as { perCategory?: Record<string, { correct: number; blank: number; wrong: number }> } | undefined)?.perCategory ?? null;
    const answers = await db
      .select({ questionId: simulationAnswers.questionId, selectedOptionId: simulationAnswers.selectedOptionId })
      .from(simulationAnswers)
      .where(eq(simulationAnswers.sessionId, sessionId));
    const qIds = answers.map((a) => a.questionId);
    if (qIds.length === 0) {
      log.warn({ sessionId }, "grade: no questions in session");
      await db.update(simulationSessions).set({ status: "graded", score: 0, maxScore: 0, correctCount: 0, wrongCount: 0, blankCount: 0, percentile: 0 }).where(eq(simulationSessions.id, sessionId));
      return;
    }
    // A2: map question → category for per-question scoring
    const qCatRows = await db
      .select({ id: questions.id, category: questions.category })
      .from(questions)
      .where(inArray(questions.id, qIds));
    const categoryByQuestion = new Map(qCatRows.map((q) => [q.id, q.category ?? ""]));
    const optRows = await db.select().from(questionOptions).where(inArray(questionOptions.questionId, qIds));
    const correctByQuestion = new Map<string, string[]>();
    for (const o of optRows) {
      if (!o.isCorrect) continue;
      const list = correctByQuestion.get(o.questionId) ?? [];
      list.push(o.id);
      correctByQuestion.set(o.questionId, list);
    }
    let correct = 0, wrong = 0, blank = 0;
    const scoredAnswers = answers.map((a) => {
      const correctIds = correctByQuestion.get(a.questionId) ?? [];
      if (!a.selectedOptionId) {
        blank += 1;
        return { ...a, isCorrect: null };
      }
      const isCorrect = correctIds.includes(a.selectedOptionId);
      if (isCorrect) correct += 1;
      else wrong += 1;
      return { ...a, isCorrect };
    });
    for (const a of scoredAnswers) {
      await db
        .update(simulationAnswers)
        .set({ isCorrect: a.isCorrect })
        .where(and(eq(simulationAnswers.sessionId, sessionId), eq(simulationAnswers.questionId, a.questionId)));
    }
    // A2: aggregate per-question using the category-specific scoring when configured
    let score = 0;
    let maxScore = 0;
    for (const a of scoredAnswers) {
      const cat = categoryByQuestion.get(a.questionId) ?? "";
      const s = perCategory?.[cat] ?? scoring;
      maxScore += s.correct;
      if (a.isCorrect === true) score += s.correct;
      else if (a.isCorrect === false) score += s.wrong;
      else score += s.blank;
    }

    // Percentile: percentage of graded sessions with a LOWER score (standard formula)
    // Sessions without a package (practice) have no peers → 100.
    const peers = s.packageId
      ? await db
          .select({ score: simulationSessions.score })
          .from(simulationSessions)
          .where(and(eq(simulationSessions.packageId, s.packageId), eq(simulationSessions.status, "graded")))
      : [];
    const lower = peers.filter((p) => (p.score ?? 0) < score).length;
    const equal = peers.filter((p) => (p.score ?? 0) === score).length;
    const total = peers.length;
    const percentile = total === 0 ? 100 : Number((((lower + 0.5 * equal) / total) * 100).toFixed(1));

    await db
      .update(simulationSessions)
      .set({ status: "graded", score, maxScore, correctCount: correct, wrongCount: wrong, blankCount: blank, percentile })
      .where(eq(simulationSessions.id, sessionId));
    if (s.packageId) {
      await bumpCacheVersion("leaderboard:" + s.packageId);
      eventBus.emit("leaderboard.changed", { packageId: s.packageId });
      // Consumers: leaderboard invalidation (subscriptions) + notifications (M5)
      eventBus.emit("simulation.graded", { sessionId, packageId: s.packageId, userId: s.userId });
    }
    log.info({ sessionId, score, maxScore, correct, wrong, blank, percentile }, "session graded");
  },

  // ── Practice mode (untimed drills, instant feedback) ────────────────
  /** Pick questions by criteria and start a practice session. */
  async startPractice(userId: string, input: { packageId?: string; category?: string; difficulty?: string; count?: number; questionIds?: string[]; tag?: string }) {
    const db = getDb();
    let scoring = { correct: 4, blank: 0, wrong: 0 };
    const whereClauses = [eq(questions.type, "multiple_choice"), notDeleted(questions.deletedAt)];
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + 365 * 24 * 3600_000); // +1 year (untimed)

    // Package-driven practice: use the package's questionCounts distribution
    let picked: { id: string }[] = [];
    if (input.packageId) {
      const pkg = await this.getPackage(input.packageId);
      if (pkg.scoring) scoring = pkg.scoring as { correct: number; blank: number; wrong: number };
      const counts = (pkg.questionCounts ?? {}) as Record<string, number>;
      if (!input.category && !input.difficulty && !input.tag && Object.keys(counts).length > 0) {
        for (const [key, wanted] of Object.entries(counts)) {
          if (wanted <= 0) continue;
          let rows: { id: string }[];
          if (key.startsWith("tag:")) {
            rows = await db
              .select({ id: questions.id })
              .from(questions)
              .innerJoin(questionTags, eq(questionTags.questionId, questions.id))
              .innerJoin(tags, eq(tags.id, questionTags.tagId))
              .where(and(eq(tags.name, key.slice(4)), ...whereClauses))
              .orderBy(sql.raw("random()"))
              .limit(wanted);
          } else {
            rows = await db
              .select({ id: questions.id })
              .from(questions)
              .where(and(eq(questions.category, key), ...whereClauses))
              .orderBy(sql.raw("random()"))
              .limit(wanted);
          }
          picked.push(...rows);
        }
      }
    }
    // Fallback: generic filtering (with optional package for scoring)
    if (picked.length === 0) {
      const clauses = [...whereClauses];
      if (input.category) clauses.push(eq(questions.category, input.category));
      if (input.difficulty) clauses.push(eq(questions.difficulty, input.difficulty));
      if (input.tag) {
        const tagRows = await db
          .select({ questionId: questionTags.questionId })
          .from(questionTags)
          .innerJoin(tags, eq(tags.id, questionTags.tagId))
          .where(eq(tags.name, input.tag.trim().toLowerCase()));
        clauses.push(inArray(questions.id, tagRows.map((r) => r.questionId)));
      }
      if (input.questionIds?.length) {
        clauses.push(inArray(questions.id, input.questionIds));
      }
      const wanted = input.questionIds?.length ?? Math.min(input.count ?? 10, 100);
      const rows = await db
        .select({ id: questions.id })
        .from(questions)
        .where(and(...clauses))
        .orderBy(sql.raw("random()"))
        .limit(wanted);
      picked = rows;
    }
    if (picked.length === 0) throw new BadRequestError("No matching questions in bank", "BANK_EMPTY");

    const [session] = await db
      .insert(simulationSessions)
      .values({ userId, packageId: input.packageId ?? null, type: "practice", status: "in_progress", startedAt, deadlineAt, maxScore: picked.length * scoring.correct })
      .returning();
    if (!session) throw new ConflictError("Failed to create practice session");
    await db.insert(simulationAnswers).values(picked.map((q, i) => ({ sessionId: session.id, questionId: q.id, sortOrder: i })));
    const qRows = await db.select().from(questions).where(inArray(questions.id, picked.map(p => p.id)));
    const optRows = await db.select().from(questionOptions).where(inArray(questionOptions.questionId, picked.map(p => p.id)));
    const questionsOut = picked
      .map((r) => {
        const q = qRows.find(qq => qq.id === r.id);
        if (!q) return null;
        return { id: q.id, text: q.text, category: q.category, difficulty: q.difficulty, options: optRows.filter(o => o.questionId === q.id).map(o => ({ id: o.id, text: o.text })) };
      })
      .filter((q): q is NonNullable<typeof q> => q !== null);
    // A9: analytics
    eventBus.emit("simulation.started", { sessionId: session.id, userId, type: "practice" });
    return { practiceId: session.id, deadlineAt, questions: questionsOut, maxScore: picked.length * scoring.correct };
  },

  /** Practice answer with instant feedback. */
  async practiceAnswer(userId: string, practiceId: string, questionId: string, selectedOptionId: string) {
    const session = await this.getOwnedSession(userId, practiceId);
    if (session.type !== "practice") throw new BadRequestError("Not a practice session");
    if (session.status !== "in_progress") throw new BadRequestError("Session is not active", "SESSION_CLOSED");
    const db = getDb();
    const answer = await db
      .select({ id: simulationAnswers.id })
      .from(simulationAnswers)
      .where(and(eq(simulationAnswers.sessionId, practiceId), eq(simulationAnswers.questionId, questionId)))
      .limit(1);
    if (!answer[0]) throw new BadRequestError("Question not in this session");
    const correctOpts = await db
      .select({ id: questionOptions.id })
      .from(questionOptions)
      .where(and(eq(questionOptions.questionId, questionId), eq(questionOptions.isCorrect, true)));
    const isCorrect = correctOpts.some(o => o.id === selectedOptionId);
    const qRow = await db.select({ explanation: questions.explanation }).from(questions).where(eq(questions.id, questionId)).limit(1);
    await db.update(simulationAnswers).set({ selectedOptionId, answeredAt: new Date(), isCorrect }).where(eq(simulationAnswers.id, answer[0].id));
    return { isCorrect, correctOptionIds: correctOpts.map(o => o.id), explanation: qRow[0]?.explanation ?? null };
  },

  /** Get practice session progress. */
  async getPracticeSession(userId: string, practiceId: string) {
    const session = await this.getOwnedSession(userId, practiceId);
    if (session.type !== "practice") throw new BadRequestError("Not a practice session");
    const db = getDb();
    const answerRows = await db
      .select({ questionId: simulationAnswers.questionId, selectedOptionId: simulationAnswers.selectedOptionId, isCorrect: simulationAnswers.isCorrect, sortOrder: simulationAnswers.sortOrder })
      .from(simulationAnswers)
      .where(eq(simulationAnswers.sessionId, practiceId))
      .orderBy(simulationAnswers.sortOrder);
    const qIds = answerRows.map(a => a.questionId);
    const qRows = qIds.length ? await db.select().from(questions).where(inArray(questions.id, qIds)) : [];
    const optRows = qIds.length ? await db.select().from(questionOptions).where(inArray(questionOptions.questionId, qIds)) : [];
    const questionsOut = answerRows
      .map(a => {
        const q = qRows.find(r => r.id === a.questionId);
        if (!q) return null;
        return {
          id: q.id, text: q.text, category: q.category, difficulty: q.difficulty,
          answered: a.selectedOptionId !== null, selectedOptionId: a.selectedOptionId, isCorrect: a.isCorrect,
          options: optRows.filter(o => o.questionId === q.id).map(o => ({ id: o.id, text: o.text })),
        };
      })
      .filter((q): q is NonNullable<typeof q> => q !== null);
    const answered = answerRows.filter(a => a.selectedOptionId !== null).length;
    const correct = answerRows.filter(a => a.isCorrect === true).length;
    return { ...session, questions: questionsOut, summary: { total: answerRows.length, answered, correct } };
  },

  /** Finish a practice session: mark graded and compute score. */
  async finishPractice(userId: string, practiceId: string) {
    const session = await this.getOwnedSession(userId, practiceId);
    if (session.type !== "practice") throw new BadRequestError("Not a practice session");
    if (session.status !== "in_progress") return { finished: true, alreadyFinished: true };
    const db = getDb();
    const answers = await db
      .select({ isCorrect: simulationAnswers.isCorrect })
      .from(simulationAnswers)
      .where(eq(simulationAnswers.sessionId, practiceId));
    const correct = answers.filter(a => a.isCorrect === true).length;
    const wrong = answers.filter(a => a.isCorrect === false).length;
    const blank = answers.filter(a => a.isCorrect === null).length;
    let scoring = { correct: 4, blank: 0, wrong: 0 };
    if (session.packageId) {
      const pkg = await this.getPackage(session.packageId);
      if (pkg.scoring) scoring = pkg.scoring as { correct: number; blank: number; wrong: number };
    }
    const score = correct * scoring.correct + wrong * scoring.wrong + blank * scoring.blank;
    await db.update(simulationSessions).set({ status: "graded", score, correctCount: correct, wrongCount: wrong, blankCount: blank }).where(eq(simulationSessions.id, practiceId));
    return { finished: true, score, correct, wrong, blank, maxScore: session.maxScore };
  },

  /** Review after grading: every question with the student's answer, the
   * correct answers, and the explanation. Answers/correctness are NEVER
   * exposed before the session is graded (anti-cheat).
   */
  async getReview(userId: string, sessionId: string) {
    const db = getDb();
    const session = await this.getOwnedSession(userId, sessionId);
    if (session.status !== "graded") throw new BadRequestError("Session not graded yet", "NOT_GRADED");
    const answerRows = await db
      .select({
        questionId: simulationAnswers.questionId,
        selectedOptionId: simulationAnswers.selectedOptionId,
        isCorrect: simulationAnswers.isCorrect,
        sortOrder: simulationAnswers.sortOrder,
      })
      .from(simulationAnswers)
      .where(eq(simulationAnswers.sessionId, sessionId))
      .orderBy(simulationAnswers.sortOrder);
    const qIds = answerRows.map((a) => a.questionId);
    const qRows = qIds.length ? await db.select().from(questions).where(inArray(questions.id, qIds)) : [];
    const optRows = qIds.length ? await db.select().from(questionOptions).where(inArray(questionOptions.questionId, qIds)) : [];
    const correctByQuestion = new Map<string, string[]>();
    for (const o of optRows) {
      if (!o.isCorrect) continue;
      const list = correctByQuestion.get(o.questionId) ?? [];
      list.push(o.id);
      correctByQuestion.set(o.questionId, list);
    }
    // N3: presigned explanation-video URLs (best effort; S3 down → null)
    const videoUrlByQuestion = new Map<string, string | null>();
    for (const q of qRows) {
      if (!q.videoKey) { videoUrlByQuestion.set(q.id, null); continue; }
      try {
        videoUrlByQuestion.set(q.id, await presignGet(q.videoKey));
      } catch {
        videoUrlByQuestion.set(q.id, null);
      }
    }
    const items = answerRows
      .map((a) => {
        const q = qRows.find((r) => r.id === a.questionId);
        if (!q) return null;
        return {
          questionId: q.id,
          text: q.text,
          category: q.category,
          difficulty: q.difficulty,
          explanation: q.explanation,
          videoUrl: videoUrlByQuestion.get(q.id) ?? null,
          selectedOptionId: a.selectedOptionId ?? null,
          correctOptionIds: correctByQuestion.get(q.id) ?? [],
          isCorrect: a.isCorrect,
          options: optRows
            .filter((o) => o.questionId === q.id)
            .sort((x, y) => x.sortOrder - y.sortOrder)
            .map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect })),
        };
      })
      .filter((q): q is NonNullable<typeof q> => q !== null);
    return { sessionId: session.id, packageId: session.packageId, questions: items };
  },

  /** Auto-submit processor (delayed BullMQ job). */
  async autoSubmit(sessionId: string): Promise<void> {
    const db = getDb();
    const session = await db.select({ id: simulationSessions.id, status: simulationSessions.status }).from(simulationSessions).where(eq(simulationSessions.id, sessionId)).limit(1);
    const s = session[0];
    if (!s || s.status !== "in_progress") return;
    log.info({ sessionId }, "auto-submit: deadline passed, grading");
    await this.gradeSession(sessionId);
  },
};