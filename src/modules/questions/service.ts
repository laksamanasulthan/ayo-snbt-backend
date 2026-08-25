import { and, eq, desc } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { questions, questionOptions } from "../../shared/db/schema/index.js";
import { questionRepo } from "./repository.js";
import { withTx } from "../../shared/db/transaction.js";
import { notDeleted } from "../../shared/db/filters.js";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { NotFoundError, ForbiddenError } from "../../shared/http/errors.js";
import { audit } from "../../shared/audit/audit.js";
import { bumpCacheVersion } from "../../shared/cache/version.js";
import { eventBus } from "../../shared/events/bus.js";

export interface QuestionInput {
  text: string;
  type?: string;
  explanation?: string;
  difficulty?: string;
  category?: string;
  imageKey?: string;
  options?: { text: string; isCorrect: boolean }[];
}

export interface AuthUser {
  id: string;
  roles: string[];
}

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes("admin");
}

async function assertCanManage(user: AuthUser, questionId: string): Promise<{ id: string; createdBy: string | null }> {
  const row = await questionRepo.findByIdIncludeDeleted(questionId);
  const q = row[0];
  if (!q) throw new NotFoundError("Question not found");
  if (!isAdmin(user) && q.createdBy !== user.id) {
    throw new ForbiddenError("Only the creator or an admin can manage this question");
  }
  return { id: q.id, createdBy: q.createdBy };
}

export const questionsService = {
  /** Cursor-paginated question bank: (createdAt DESC, id DESC) keyset. */
  async list(input: { cursor?: string; limit: number; category?: string }) {
    const db = getDb();
    const { limit } = input;
    const buildWhere = () => {
      const kc = decodeCursor(input.cursor);
      const base = input.category
        ? and(eq(questions.category, input.category), notDeleted(questions.deletedAt))
        : notDeleted(questions.deletedAt);
      return kc
        ? and(base, keysetCondition([
            { name: "created_at", value: kc.createdAt as string, dir: "desc" },
            { name: "id", value: kc.id as string, dir: "desc" }
          ]))
        : base;
    };
    const rows = await db.select().from(questions).where(buildWhere()).orderBy(desc(questions.createdAt), desc(questions.id)).limit(limit);
    return buildPage(rows, limit, ["createdAt", "id"]);
  },

  async getById(id: string) {
    const row = await questionRepo.findById(id);
    const q = row[0];
    if (!q) throw new NotFoundError("Question not found");
    const options = await questionRepo.findOptions(id);
    return { ...q, options };
  },

  async create(userId: string, input: QuestionInput) {
    return withTx(async (tx) => {
      const [row] = await tx
        .insert(questions)
        .values({ text: input.text, type: input.type, explanation: input.explanation, difficulty: input.difficulty, category: input.category, imageKey: input.imageKey, createdBy: userId })
        .returning();
      if (!row) throw new NotFoundError("Failed to create question");
      if (input.options?.length) {
        await tx.insert(questionOptions).values(input.options.map((o, i) => ({ questionId: row.id, text: o.text, isCorrect: o.isCorrect, sortOrder: i })));
      }
      await audit({ action: "question.create", resourceType: "question", resourceId: row.id, after: { optionCount: input.options?.length ?? 0 } });
      await bumpCacheVersion("questions");
      // Read back via the SAME tx connection (other connections can't see uncommitted rows)
      const optRows = await tx.select().from(questionOptions).where(eq(questionOptions.questionId, row.id)).orderBy(questionOptions.sortOrder);
      return { ...row, options: optRows };
    });
  },

  async update(user: AuthUser, id: string, input: Partial<QuestionInput>) {
    await assertCanManage(user, id);
    return withTx(async (tx) => {
      const { options, ...fields } = input;
      if (Object.keys(fields).length > 0) {
        await tx.update(questions).set({ ...fields, updatedAt: new Date() }).where(eq(questions.id, id));
      }
      let optionSnapshot: unknown;
      if (options) {
        const existing = await tx.select().from(questionOptions).where(eq(questionOptions.questionId, id));
        optionSnapshot = existing.map((o) => ({ text: o.text, isCorrect: o.isCorrect }));
        await tx.delete(questionOptions).where(eq(questionOptions.questionId, id));
        await tx.insert(questionOptions).values(options.map((o, i) => ({ questionId: id, text: o.text, isCorrect: o.isCorrect, sortOrder: i })));
      }
      await audit({ action: "question.update", resourceType: "question", resourceId: id, before: { fields, options: optionSnapshot }, after: { fields, options } });
      await bumpCacheVersion("questions");
      eventBus.emit("question.updated", { questionId: id });
      const updated = (await tx.select().from(questions).where(eq(questions.id, id)))[0];
      const updatedOpts = await tx.select().from(questionOptions).where(eq(questionOptions.questionId, id)).orderBy(questionOptions.sortOrder);
      return { ...updated, options: updatedOpts };
    });
  },

  /** Soft delete (recoverable) + audit. Options follow the parent. */
  async remove(user: AuthUser, id: string) {
    await assertCanManage(user, id);
    return withTx(async (tx) => {
      const before = (await questionRepo.findByIdIncludeDeleted(id))[0];
      // Soft delete the question; options follow the parent (reads filter at the question level).
      await tx.update(questions).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(questions.id, id));
      await audit({ action: "question.delete", resourceType: "question", resourceId: id, before: { text: before?.text } });
      await bumpCacheVersion("questions");
      eventBus.emit("question.deleted", { questionId: id });
      return { deleted: true, soft: true };
    });
  },

  /** Admin restore after soft delete. */
  async restore(user: AuthUser, id: string) {
    await assertCanManage(user, id);
    return withTx(async (tx) => {
      await tx.update(questions).set({ deletedAt: null, updatedAt: new Date() }).where(eq(questions.id, id));
      await audit({ action: "question.restore", resourceType: "question", resourceId: id });
      await bumpCacheVersion("questions");
      return { restored: true };
    });
  }
};