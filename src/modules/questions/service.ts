import { eq, desc } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { questions, questionOptions } from "../../shared/db/schema/index.js";
import { NotFoundError } from "../../shared/http/errors.js";

export interface QuestionInput {
  text: string;
  type?: string;
  explanation?: string;
  difficulty?: string;
  category?: string;
  imageKey?: string;
  options?: { text: string; isCorrect: boolean }[];
}

export const questionsService = {
  async list(input: { page: number; perPage: number; category?: string }) {
    const db = getDb();
    const { page, perPage } = input;
    const where = input.category ? eq(questions.category, input.category) : undefined;
    const total = where ? await db.select({ count: questions.id }).from(questions).where(where) : await db.select({ count: questions.id }).from(questions);
    const rows = where
      ? await db.select().from(questions).where(where).orderBy(desc(questions.createdAt)).limit(perPage).offset((page - 1) * perPage)
      : await db.select().from(questions).orderBy(desc(questions.createdAt)).limit(perPage).offset((page - 1) * perPage);
    const totalCount = Number(total[0]?.count ?? 0);
    return { rows, total: totalCount, page, perPage, totalPages: Math.max(1, Math.ceil(totalCount / perPage)) };
  },

  async getById(id: string) {
    const db = getDb();
    const row = await db.select().from(questions).where(eq(questions.id, id)).limit(1);
    if (!row[0]) throw new NotFoundError("Question not found");
    const options = await db.select().from(questionOptions).where(eq(questionOptions.questionId, id)).orderBy(questionOptions.sortOrder);
    return { ...row[0], options };
  },

  async create(userId: string, input: QuestionInput) {
    const db = getDb();
    const [row] = await db
      .insert(questions)
      .values({ text: input.text, type: input.type, explanation: input.explanation, difficulty: input.difficulty, category: input.category, imageKey: input.imageKey, createdBy: userId })
      .returning();
    if (!row) throw new NotFoundError("Failed to create question");
    if (input.options?.length) {
      await db.insert(questionOptions).values(input.options.map((o, i) => ({ questionId: row.id, text: o.text, isCorrect: o.isCorrect, sortOrder: i })));
    }
    return this.getById(row.id);
  },

  async update(id: string, input: Partial<QuestionInput>) {
    const db = getDb();
    const existing = await db.select({ id: questions.id }).from(questions).where(eq(questions.id, id)).limit(1);
    if (!existing[0]) throw new NotFoundError("Question not found");
    const { options, ...fields } = input;
    if (Object.keys(fields).length > 0) {
      await db.update(questions).set({ ...fields, updatedAt: new Date() }).where(eq(questions.id, id));
    }
    if (options) {
      await db.delete(questionOptions).where(eq(questionOptions.questionId, id));
      await db.insert(questionOptions).values(options.map((o, i) => ({ questionId: id, text: o.text, isCorrect: o.isCorrect, sortOrder: i })));
    }
    return this.getById(id);
  },

  async remove(id: string) {
    const db = getDb();
    await db.delete(questionOptions).where(eq(questionOptions.questionId, id));
    await db.delete(questions).where(eq(questions.id, id));
    return { deleted: true };
  }
};