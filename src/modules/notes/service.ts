import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { questionNotes, questions } from "../../shared/db/schema/index.js";
import { NotFoundError, BadRequestError } from "../../shared/http/errors.js";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { notDeleted } from "../../shared/db/filters.js";

/** N2 — personal notes per question (one per user+question, upsert). */
export const notesService = {
  async get(userId: string, questionId: string) {
    const db = getDb();
    const q = (await db.select({ id: questions.id }).from(questions).where(and(eq(questions.id, questionId), notDeleted(questions.deletedAt))).limit(1))[0];
    if (!q) throw new NotFoundError("Question not found");
    const note = (await db.select().from(questionNotes).where(and(eq(questionNotes.userId, userId), eq(questionNotes.questionId, questionId))).limit(1))[0];
    return { questionId, note: note ?? null };
  },

  async upsert(userId: string, questionId: string, body: string) {
    const text = body?.trim();
    if (!text) throw new BadRequestError("Note body is required", "VALIDATION_ERROR");
    if (text.length > 4000) throw new BadRequestError("Note too long (max 4000 chars)", "VALIDATION_ERROR");
    const db = getDb();
    const q = (await db.select({ id: questions.id }).from(questions).where(and(eq(questions.id, questionId), notDeleted(questions.deletedAt))).limit(1))[0];
    if (!q) throw new NotFoundError("Question not found");
    const [row] = await db
      .insert(questionNotes)
      .values({ userId, questionId, body: text })
      .onConflictDoUpdate({ target: [questionNotes.userId, questionNotes.questionId], set: { body: text, updatedAt: new Date() } })
      .returning();
    return row;
  },

  async remove(userId: string, questionId: string) {
    await getDb().delete(questionNotes).where(and(eq(questionNotes.userId, userId), eq(questionNotes.questionId, questionId)));
    return { deleted: true };
  },

  /** My notes with question text, cursor-paginated (updatedAt DESC). */
  async listMine(userId: string, cursor: string | undefined, limit: number) {
    const db = getDb();
    const kc = decodeCursor(cursor);
    const where = and(
      eq(questionNotes.userId, userId),
      kc
        ? keysetCondition([
            { name: "question_notes.updated_at", value: kc.updatedAt as string, dir: "desc" },
            { name: "question_notes.id", value: kc.id as string, dir: "desc" }
          ])
        : undefined
    );
    const rows = await db
      .select({ id: questionNotes.id, questionId: questionNotes.questionId, body: questionNotes.body, updatedAt: questionNotes.updatedAt, questionText: questions.text })
      .from(questionNotes)
      .innerJoin(questions, eq(questions.id, questionNotes.questionId))
      .where(where)
      .orderBy(desc(questionNotes.updatedAt), desc(questionNotes.id))
      .limit(limit);
    return buildPage(rows, limit, ["updatedAt", "id"]);
  }
};
