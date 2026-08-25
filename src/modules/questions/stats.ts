import { eq, sql, isNotNull } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { simulationAnswers, questionTags, tags } from "../../shared/db/schema/index.js";

/**
 * A10 — difficulty calibration: per-tag accuracy from graded answers.
 * Admin-facing: content teams see which tags students struggle with.
 */
export async function tagAccuracyStats(): Promise<Array<{ tag: string; attempts: number; correct: number; accuracy: number }>> {
  const db = getDb();
  const rows = await db
    .select({
      tag: tags.name,
      attempts: sql.raw("count(*)::int"),
      correct: sql.raw("count(*) FILTER (WHERE simulation_answers.is_correct = true)::int")
    })
    .from(simulationAnswers)
    .innerJoin(questionTags, eq(questionTags.questionId, simulationAnswers.questionId))
    .innerJoin(tags, eq(tags.id, questionTags.tagId))
    .where(isNotNull(simulationAnswers.isCorrect))
    .groupBy(tags.name)
    .orderBy(sql.raw("count(*) DESC"));
  return rows.map((r) => ({
    tag: r.tag,
    attempts: r.attempts as number,
    correct: r.correct as number,
    accuracy: (r.attempts as number) === 0 ? 0 : Number((((r.correct as number) / (r.attempts as number)) * 100).toFixed(1))
  }));
}
