import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { simulationAnswers, simulationSessions, questions, questionTags, tags } from "../../shared/db/schema/index.js";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { NotFoundError } from "../../shared/http/errors.js";

/**
 * A6 — results views: mistakes bank (distinct wrong questions with
 * frequency), retryable via practice with questionIds.
 */
export const resultsService = {
  /**
   * Distinct questions the user answered WRONG across graded sessions.
   * Keyset pagination: (lastWrongAt DESC, questionId DESC) — the keyset
   * predicate lives in HAVING because it references aggregates.
   */
  async listMistakes(userId: string, cursor: string | undefined, limit: number) {
    const db = getDb();
    const kc = decodeCursor(cursor);
    const where = and(
      eq(simulationSessions.userId, userId),
      eq(simulationSessions.status, "graded"),
      eq(simulationAnswers.isCorrect, false)
    );
    const having = kc
      ? keysetCondition([
          { name: "MAX(simulation_answers.answered_at)", value: kc.lastWrongAt as string, dir: "desc" },
          { name: "simulation_answers.question_id", value: kc.questionId as string, dir: "desc" }
        ])
      : undefined;
    const rows = await db
      .select({
        questionId: simulationAnswers.questionId,
        wrongCount: sql.raw("count(*)::int"),
        lastWrongAt: sql.raw("MAX(simulation_answers.answered_at)")
      })
      .from(simulationAnswers)
      .innerJoin(simulationSessions, eq(simulationSessions.id, simulationAnswers.sessionId))
      .where(where)
      .groupBy(simulationAnswers.questionId)
      .having(having)
      .orderBy(sql.raw("MAX(simulation_answers.answered_at) DESC"), desc(simulationAnswers.questionId))
      .limit(limit);
    // Enrich with question details + tags (batched)
    const ids = rows.map((r) => r.questionId);
    const qRows = ids.length
      ? await db
          .select({ id: questions.id, text: questions.text, category: questions.category, difficulty: questions.difficulty })
          .from(questions)
          .where(inArray(questions.id, ids))
      : [];
    const tagRows = ids.length
      ? await db
          .select({ questionId: questionTags.questionId, name: tags.name })
          .from(questionTags)
          .innerJoin(tags, eq(tags.id, questionTags.tagId))
          .where(inArray(questionTags.questionId, ids))
      : [];
    const tagsByQ = new Map<string, string[]>();
    for (const t of tagRows) {
      const list = tagsByQ.get(t.questionId) ?? [];
      list.push(t.name);
      tagsByQ.set(t.questionId, list);
    }
    const enriched = rows.map((r) => {
      const q = qRows.find((qq) => qq.id === r.questionId);
      return {
        questionId: r.questionId,
        text: q?.text ?? null,
        category: q?.category ?? null,
        difficulty: q?.difficulty ?? null,
        tags: tagsByQ.get(r.questionId) ?? [],
        wrongCount: r.wrongCount,
        lastWrongAt: r.lastWrongAt
      };
    });
    return buildPage(enriched, limit, ["lastWrongAt", "questionId"]);
  },

  /**
   * N4 — predicted score banding from the user's graded simulation
   * sessions: average/best score, percentile range and an easy band.
   */
  async banding(userId: string) {
    const db = getDb();
    const rows = await db
      .select({ score: simulationSessions.score, percentile: simulationSessions.percentile, submittedAt: simulationSessions.submittedAt })
      .from(simulationSessions)
      .where(and(eq(simulationSessions.userId, userId), eq(simulationSessions.status, "graded"), eq(simulationSessions.type, "simulation"), sql.raw("score IS NOT NULL")))
      .orderBy(desc(simulationSessions.submittedAt))
      .limit(100);
    if (rows.length === 0) throw new NotFoundError("No graded simulation sessions yet");
    const scores = rows.map((r) => r.score ?? 0);
    const percentiles = rows.map((r) => r.percentile ?? 0);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const avgPercentile = Math.round(percentiles.reduce((a, b) => a + b, 0) / percentiles.length);
    const band = avgPercentile < 40 ? "rendah" : avgPercentile <= 70 ? "menengah" : "tinggi";
    return {
      sessions: rows.length,
      averageScore: avgScore,
      bestScore: Math.max(...scores),
      averagePercentile: avgPercentile,
      percentileRange: [Math.min(...percentiles), Math.max(...percentiles)],
      band,
      bands: { rendah: "< 40", menengah: "40–70", tinggi: "> 70" }
    };
  },

  /**
   * N5 — time-usage analytics from graded simulation answers (M3 data):
   * avg time per question, flagged rate, per-category timing.
   */
  async timeAnalysis(userId: string) {
    const db = getDb();
    const rows = await db
      .select({
        category: questions.category,
        timeSpentMs: simulationAnswers.timeSpentMs,
        isFlagged: simulationAnswers.isFlagged,
        answered: simulationAnswers.selectedOptionId,
      })
      .from(simulationAnswers)
      .innerJoin(simulationSessions, eq(simulationSessions.id, simulationAnswers.sessionId))
      .innerJoin(questions, eq(questions.id, simulationAnswers.questionId))
      .where(and(
        eq(simulationSessions.userId, userId),
        eq(simulationSessions.status, "graded"),
        eq(simulationSessions.type, "simulation")
      ));
    const total = rows.length;
    const answeredRows = rows.filter((r) => r.answered !== null);
    const totalTimeMs = answeredRows.reduce((a, r) => a + (r.timeSpentMs ?? 0), 0);
    const flagged = rows.filter((r) => r.isFlagged).length;
    // Per category
    const byCat = new Map<string, { count: number; answered: number; timeMs: number; flagged: number }>();
    for (const r of rows) {
      const key = r.category ?? "(tanpa kategori)";
      const e = byCat.get(key) ?? { count: 0, answered: 0, timeMs: 0, flagged: 0 };
      e.count += 1;
      if (r.answered !== null) { e.answered += 1; e.timeMs += r.timeSpentMs ?? 0; }
      if (r.isFlagged) e.flagged += 1;
      byCat.set(key, e);
    }
    const perCategory = [...byCat.entries()].map(([category, s]) => ({
      category,
      answers: s.count,
      answered: s.answered,
      avgTimeMs: s.answered === 0 ? 0 : Math.round(s.timeMs / s.answered),
      flaggedRate: s.count === 0 ? 0 : Number(((s.flagged / s.count) * 100).toFixed(1))
    })).sort((a, b) => b.answers - a.answers);
    return {
      totalAnswers: total,
      answered: answeredRows.length,
      avgTimePerQuestionMs: answeredRows.length === 0 ? 0 : Math.round(totalTimeMs / answeredRows.length),
      flaggedRate: total === 0 ? 0 : Number(((flagged / total) * 100).toFixed(1)),
      perCategory
    };
  }
};
