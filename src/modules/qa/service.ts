import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { questionReplies, replyUpvotes, questions, users } from "../../shared/db/schema/index.js";
import { NotFoundError, BadRequestError } from "../../shared/http/errors.js";
import { notDeleted } from "../../shared/db/filters.js";

/**
 * A3 — per-question discussion threads. Replies are public, ordered
 * newest-first; hidden (moderated) replies are excluded for everyone.
 */
export const qaService = {
  /** Thread = question + its visible replies (with author name + upvote count). */
  async getThread(questionId: string) {
    const db = getDb();
    const q = (await db.select({ id: questions.id, text: questions.text }).from(questions).where(and(eq(questions.id, questionId), notDeleted(questions.deletedAt))).limit(1))[0];
    if (!q) throw new NotFoundError("Question not found");
    const replies = await db
      .select({
        id: questionReplies.id,
        body: questionReplies.body,
        upvoteCount: questionReplies.upvoteCount,
        createdAt: questionReplies.createdAt,
        authorName: users.name,
        authorId: questionReplies.userId
      })
      .from(questionReplies)
      .innerJoin(users, eq(users.id, questionReplies.userId))
      .where(and(eq(questionReplies.questionId, questionId), eq(questionReplies.isHidden, false)))
      .orderBy(desc(questionReplies.createdAt), desc(questionReplies.id));
    return { question: q, replies };
  },

  /** Add a reply. Returns the created row with author name. */
  async addReply(userId: string, questionId: string, body: string) {
    const text = body?.trim();
    if (!text) throw new BadRequestError("Reply body is required", "VALIDATION_ERROR");
    if (text.length > 4000) throw new BadRequestError("Reply too long (max 4000 chars)", "VALIDATION_ERROR");
    const db = getDb();
    const q = (await db.select({ id: questions.id }).from(questions).where(and(eq(questions.id, questionId), notDeleted(questions.deletedAt))).limit(1))[0];
    if (!q) throw new NotFoundError("Question not found");
    const [row] = await db.insert(questionReplies).values({ questionId, userId, body: text }).returning();
    if (!row) throw new BadRequestError("Failed to create reply");
    return row;
  },

  /** Idempotent upvote. Returns the new total. */
  async upvote(userId: string, replyId: string) {
    const db = getDb();
    const reply = (await db.select({ id: questionReplies.id, isHidden: questionReplies.isHidden }).from(questionReplies).where(eq(questionReplies.id, replyId)).limit(1))[0];
    if (!reply) throw new NotFoundError("Reply not found");
    // Idempotent: unique (replyId, userId)
    await db.insert(replyUpvotes).values({ replyId, userId }).onConflictDoNothing();
    await db
      .update(questionReplies)
      .set({ upvoteCount: await countUpvotes(db, replyId) })
      .where(eq(questionReplies.id, replyId));
    const updated = (await db.select({ upvoteCount: questionReplies.upvoteCount }).from(questionReplies).where(eq(questionReplies.id, replyId)).limit(1))[0];
    return { upvoted: true, upvoteCount: updated?.upvoteCount ?? 0 };
  },

  /** Admin moderation: hide a reply (kept in DB, excluded from threads). */
  async hideReply(adminId: string, replyId: string) {
    const db = getDb();
    const reply = (await db.select({ id: questionReplies.id }).from(questionReplies).where(eq(questionReplies.id, replyId)).limit(1))[0];
    if (!reply) throw new NotFoundError("Reply not found");
    await db.update(questionReplies).set({ isHidden: true }).where(eq(questionReplies.id, replyId));
    return { hidden: true };
  }
};

async function countUpvotes(db: ReturnType<typeof getDb>, replyId: string): Promise<number> {
  const rows = await db.select({ id: replyUpvotes.replyId }).from(replyUpvotes).where(eq(replyUpvotes.replyId, replyId)).limit(1000);
  return rows.length;
}
