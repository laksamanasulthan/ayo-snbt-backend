import { and, eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { questions, questionOptions } from "../../shared/db/schema/index.js";
import { notDeleted } from "../../shared/db/filters.js";

export type QuestionRow = typeof questions.$inferSelect;
export type QuestionOptionRow = typeof questionOptions.$inferSelect;

export const questionRepo = {
  findById(id: string) {
    return getDb().select().from(questions).where(and(eq(questions.id, id), notDeleted(questions.deletedAt))).limit(1);
  },

  findByIdIncludeDeleted(id: string) {
    return getDb().select().from(questions).where(eq(questions.id, id)).limit(1);
  },

  findOptions(questionId: string) {
    return getDb().select().from(questionOptions).where(eq(questionOptions.questionId, questionId)).orderBy(questionOptions.sortOrder);
  },

  softDelete(id: string): Promise<QuestionRow | undefined> {
    return getDb().update(questions).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(questions.id, id)).returning().then((r) => r[0]);
  },

  restore(id: string): Promise<QuestionRow | undefined> {
    return getDb().update(questions).set({ deletedAt: null, updatedAt: new Date() }).where(eq(questions.id, id)).returning().then((r) => r[0]);
  }
};
