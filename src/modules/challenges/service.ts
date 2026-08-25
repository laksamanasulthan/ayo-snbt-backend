import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { dailyChallenges, questions, questionOptions, simulationSessions, simulationAnswers } from "../../shared/db/schema/index.js";
import { NotFoundError, BadRequestError } from "../../shared/http/errors.js";
import { notDeleted } from "../../shared/db/filters.js";

/**
 * N1 — daily challenge (soal harian) + streak.
 * The challenge answer flows through the existing practice endpoints (M2);
 * this slice serves the question of the day and computes the streak from
 * practice answer history.
 */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export const challengesService = {
  /** Question of the day: pinned challenge, else a random published one. */
  async getToday() {
    const db = getDb();
    const pinned = (await db
      .select({ questionId: dailyChallenges.questionId })
      .from(dailyChallenges)
      .where(eq(dailyChallenges.date, todayKey()))
      .limit(1))[0];
    let questionId = pinned?.questionId;
    if (!questionId) {
      const random = await db
        .select({ id: questions.id })
        .from(questions)
        .where(and(eq(questions.type, "multiple_choice"), notDeleted(questions.deletedAt)))
        .orderBy(sql.raw("random()"))
        .limit(1);
      questionId = random[0]?.id;
    }
    if (!questionId) throw new NotFoundError("No questions in the bank");
    const q = (await db.select().from(questions).where(eq(questions.id, questionId)).limit(1))[0];
    if (!q) throw new NotFoundError("Question not found");
    const opts = await db
      .select({ id: questionOptions.id, text: questionOptions.text })
      .from(questionOptions)
      .where(eq(questionOptions.questionId, questionId))
      .orderBy(questionOptions.sortOrder);
    return { date: todayKey(), question: { id: q.id, text: q.text, category: q.category, difficulty: q.difficulty, options: opts } };
  },

  /** Consecutive-day streak from practice answers (today counts if active). */
  async streak(userId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ answeredAt: simulationAnswers.answeredAt })
      .from(simulationAnswers)
      .innerJoin(simulationSessions, eq(simulationSessions.id, simulationAnswers.sessionId))
      .where(and(eq(simulationSessions.userId, userId), eq(simulationSessions.type, "practice")));
    const days = new Set<string>();
    for (const r of rows) {
      if (!r.answeredAt) continue;
      days.add(r.answeredAt.toISOString().slice(0, 10));
    }
    if (days.size === 0) return 0;
    // Start from today; if not active today, a streak may still run from yesterday
    const cursor = new Date();
    if (!days.has(todayKey())) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    let streak = 0;
    while (days.has(cursor.toISOString().slice(0, 10))) {
      streak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return streak;
  },

  /** Admin: pin today's (or any) challenge question. */
  async pinChallenge(adminId: string, date: string, questionId: string) {
    const db = getDb();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestError("date must be YYYY-MM-DD", "VALIDATION_ERROR");
    const q = (await db.select({ id: questions.id }).from(questions).where(eq(questions.id, questionId)).limit(1))[0];
    if (!q) throw new NotFoundError("Question not found");
    await db
      .insert(dailyChallenges)
      .values({ date, questionId, createdBy: adminId })
      .onConflictDoUpdate({ target: [dailyChallenges.date], set: { questionId } });
    return { date, questionId };
  }
};
