import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { getDb, getReadDb } from "../../shared/db/client.js";
import {
  simulationPackages, simulationSessions, simulationAnswers, questions, questionOptions, users
} from "../../shared/db/schema/index.js";
import { NotFoundError, BadRequestError, ForbiddenError, ConflictError } from "../../shared/http/errors.js";
import { QueueName, enqueue } from "../../shared/queue/queues.js";
import { getCache } from "../../shared/cache/cache.js";
import { seededShuffle } from "./shuffle.js";
import { getLogger } from "../../shared/logger.js";

const log = getLogger();

export interface PackageInput {
  title: string;
  description?: string;
  durationMinutes?: number;
  questionCounts?: Record<string, number>;
  scoring?: { correct: number; blank: number; wrong: number };
  status?: string;
}

export const simulationsService = {
  // ── Packages ────────────────────────────────────────────────────────
  async listPackages(input: { page: number; perPage: number }) {
    const db = getDb();
    const { page, perPage } = input;
    const cacheKey = "sims:packages:" + page + ":" + perPage;
    const cached = await getCache()
      .get<{ rows: unknown[]; total: number; totalPages: number } | null>(cacheKey, async () => {
        const total = await db.select({ count: simulationPackages.id }).from(simulationPackages).where(eq(simulationPackages.status, "published"));
        const rows = await db
          .select()
          .from(simulationPackages)
          .where(eq(simulationPackages.status, "published"))
          .orderBy(desc(simulationPackages.createdAt))
          .limit(perPage)
          .offset((page - 1) * perPage);
        const totalCount = Number(total[0]?.count ?? 0);
        return { rows, total: totalCount, totalPages: Math.max(1, Math.ceil(totalCount / perPage)) };
      },
      30_000
    ).catch(() => null);
    if (cached) return cached;
    const total = await db.select({ count: simulationPackages.id }).from(simulationPackages).where(eq(simulationPackages.status, "published"));
    const rows = await db
      .select()
      .from(simulationPackages)
      .where(eq(simulationPackages.status, "published"))
      .orderBy(desc(simulationPackages.createdAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    const totalCount = Number(total[0]?.count ?? 0);
    return { rows, total: totalCount, totalPages: Math.max(1, Math.ceil(totalCount / perPage)) };
  },

  async getPackage(id: string) {
    const db = getDb();
    const row = await db.select().from(simulationPackages).where(eq(simulationPackages.id, id)).limit(1);
    const pkg = row[0];
    if (!pkg) throw new NotFoundError("Simulation package not found");
    return pkg;
  },

  async createPackage(userId: string, input: PackageInput) {
    const db = getDb();
    const [row] = await db.insert(simulationPackages).values({ ...input, createdBy: userId }).returning();
    if (!row) throw new ConflictError("Failed to create package");
    await getCache().del("sims:packages:1:10");
    return row;
  },

  async updatePackage(id: string, input: Partial<PackageInput>) {
    const db = getDb();
    const [row] = await db.update(simulationPackages).set({ ...input, updatedAt: new Date() }).where(eq(simulationPackages.id, id)).returning();
    if (!row) throw new NotFoundError("Package not found");
    await getCache().del("sims:packages:1:10");
    return row;
  },

  // ── Sessions ────────────────────────────────────────────────────────
  /** Pick questions per category and create the session + answer rows. */
  async startSession(userId: string, packageId: string) {
    const db = getDb();
    const pkg = await this.getPackage(packageId);
    if (pkg.status !== "published") throw new ForbiddenError("Package not published");
    const counts = (pkg.questionCounts ?? {}) as Record<string, number>;
    const categories = Object.keys(counts);
    if (categories.length === 0 || categories.every((c) => (counts[c] ?? 0) <= 0)) {
      throw new BadRequestError("Package has no questions configured", "PACKAGE_EMPTY");
    }

    // Pick N random questions per category (server-side, anti-cheat by design)
    const picked: { id: string; category: string }[] = [];
    for (const category of categories) {
      const wanted = counts[category] ?? 0;
      if (wanted <= 0) continue;
      const rows = await db
        .select({ id: questions.id })
        .from(questions)
        .where(and(eq(questions.category, category), eq(questions.type, "multiple_choice")))
        .orderBy(sql`random()`)
        .limit(wanted);
      picked.push(...rows.map((r) => ({ id: r.id, category })));
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

    return { sessionId: session.id, deadlineAt, durationMinutes };
  },

  /** Session detail: questions WITHOUT correct answers, options seeded-shuffled. */
  async getSession(userId: string, sessionId: string) {
    const db = getDb();
    const session = await this.getOwnedSession(userId, sessionId);
    const answerRows = await db
      .select({ questionId: simulationAnswers.questionId, selectedOptionId: simulationAnswers.selectedOptionId, sortOrder: simulationAnswers.sortOrder })
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
      };
    }).filter((q): q is NonNullable<typeof q> => q !== null);
    return { ...session, questions: questionsOut };
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
      .select({ id: simulationAnswers.id })
      .from(simulationAnswers)
      .where(and(eq(simulationAnswers.sessionId, sessionId), eq(simulationAnswers.questionId, questionId)))
      .limit(1);
    if (!answer[0]) throw new BadRequestError("Question not in this session");
    await db
      .update(simulationAnswers)
      .set({ selectedOptionId, answeredAt: new Date() })
      .where(eq(simulationAnswers.id, answer[0].id));
    return { saved: true };
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
    const pkg = await this.getPackage(session.packageId);
    const rank = await this.computeRank(session.packageId, session.score ?? 0, session.id);
    return {
      sessionId: session.id,
      packageId: session.packageId,
      packageTitle: pkg.title,
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

  async listMySessions(userId: string, page: number, perPage: number) {
    const db = getDb();
    const rows = await db
      .select({ id: simulationSessions.id, packageTitle: simulationPackages.title, status: simulationSessions.status, score: simulationSessions.score, percentile: simulationSessions.percentile, startedAt: simulationSessions.startedAt, submittedAt: simulationSessions.submittedAt })
      .from(simulationSessions)
      .innerJoin(simulationPackages, eq(simulationPackages.id, simulationSessions.packageId))
      .where(eq(simulationSessions.userId, userId))
      .orderBy(desc(simulationSessions.startedAt))
      .limit(perPage)
      .offset((page - 1) * perPage);
    return rows;
  },

  // ── Leaderboard ─────────────────────────────────────────────────────
  async getLeaderboard(packageId: string, limit = 20) {
    const db = getReadDb(); // leaderboard reads hit the replica when configured
    const cacheKey = "sims:leaderboard:" + packageId + ":" + limit;
    const cached = await getCache()
      .get<unknown[] | null>(cacheKey, async () => {
        const rows = await db
          .select({
            userId: simulationSessions.userId,
            name: users.name,
            score: simulationSessions.score,
            percentile: simulationSessions.percentile,
            submittedAt: simulationSessions.submittedAt,
          })
          .from(simulationSessions)
          .innerJoin(users, eq(users.id, simulationSessions.userId))
          .where(and(eq(simulationSessions.packageId, packageId), eq(simulationSessions.status, "graded")))
          .orderBy(desc(simulationSessions.score))
          .limit(limit);
        return rows;
      },
      30_000
    ).catch(() => null);
    if (cached) return cached;
    return db
      .select({
        userId: simulationSessions.userId,
        name: users.name,
        score: simulationSessions.score,
        percentile: simulationSessions.percentile,
        submittedAt: simulationSessions.submittedAt,
      })
      .from(simulationSessions)
      .innerJoin(users, eq(users.id, simulationSessions.userId))
      .where(and(eq(simulationSessions.packageId, packageId), eq(simulationSessions.status, "graded")))
      .orderBy(desc(simulationSessions.score))
      .limit(limit);
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
    const pkg = await this.getPackage(s.packageId);
    const scoring = (pkg.scoring ?? { correct: 4, blank: 0, wrong: 0 }) as { correct: number; blank: number; wrong: number };
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
    const score = correct * scoring.correct + wrong * scoring.wrong + blank * scoring.blank;
    const maxScore = qIds.length * scoring.correct;

    // Percentile: percentage of graded sessions with a LOWER score (standard formula)
    const peers = await db
      .select({ score: simulationSessions.score })
      .from(simulationSessions)
      .where(and(eq(simulationSessions.packageId, s.packageId), eq(simulationSessions.status, "graded")));
    const lower = peers.filter((p) => (p.score ?? 0) < score).length;
    const equal = peers.filter((p) => (p.score ?? 0) === score).length;
    const total = peers.length;
    const percentile = total === 0 ? 100 : Number((((lower + 0.5 * equal) / total) * 100).toFixed(1));

    await db
      .update(simulationSessions)
      .set({ status: "graded", score, maxScore, correctCount: correct, wrongCount: wrong, blankCount: blank, percentile })
      .where(eq(simulationSessions.id, sessionId));
    await getCache().del("sims:leaderboard:" + s.packageId + ":20");
    log.info({ sessionId, score, maxScore, correct, wrong, blank, percentile }, "session graded");
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