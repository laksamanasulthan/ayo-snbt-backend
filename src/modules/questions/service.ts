import { createHash } from "node:crypto";
import { and, eq, desc, inArray, or, ilike } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { questions, questionOptions, tags, questionTags } from "../../shared/db/schema/index.js";
import { questionRepo } from "./repository.js";
import { withTx, type Tx } from "../../shared/db/transaction.js";
import { notDeleted } from "../../shared/db/filters.js";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { NotFoundError, ForbiddenError, BadRequestError } from "../../shared/http/errors.js";
import type { ImportQuestionRow } from "./csv.js";
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
  /** Topic tags (M6): normalized to trimmed lowercase, deduped. */
  tags?: string[];
  /** A10: provenance { origin, year? } + review workflow status. */
  source?: { origin: string; year?: number } | null;
  reviewStatus?: string | null;
  /** N3: explanation video object key (S3). */
  videoKey?: string | null;
}

export interface AuthUser {
  id: string;
  roles: string[];
}

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes("admin");
}

/** Normalize a tag name: trim + lowercase, drop empties, dedupe. */
function normalizeTags(list: string[] | undefined): string[] {
  if (!list) return [];
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

/** Replace a question's tag links (create-or-reuse tags by name). */
async function syncQuestionTags(tx: Tx, questionId: string, tagNames: string[]): Promise<void> {
  await tx.delete(questionTags).where(eq(questionTags.questionId, questionId));
  for (const name of tagNames) {
    // Reuse existing tag or create; unique(name) makes this race-safe
    await tx
      .insert(tags)
      .values({ name })
      .onConflictDoNothing();
    const tagRow = (await tx.select({ id: tags.id }).from(tags).where(eq(tags.name, name)).limit(1))[0];
    if (tagRow) {
      await tx.insert(questionTags).values({ questionId, tagId: tagRow.id }).onConflictDoNothing();
    }
  }
}

/** Map questionId → tag names for a set of questions. */
async function tagsByQuestion(txOrDb: Tx | ReturnType<typeof getDb>, questionIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (questionIds.length === 0) return map;
  const rows = await txOrDb
    .select({ questionId: questionTags.questionId, name: tags.name })
    .from(questionTags)
    .innerJoin(tags, eq(tags.id, questionTags.tagId))
    .where(inArray(questionTags.questionId, questionIds));
  for (const r of rows) {
    const list = map.get(r.questionId) ?? [];
    list.push(r.name);
    map.set(r.questionId, list);
  }
  return map;
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
  async list(input: { cursor?: string; limit: number; category?: string; tag?: string; q?: string }) {
    const db = getDb();
    const { limit } = input;
    // M6: tag filter → restrict to question ids linked to that tag
    let tagIds: string[] | null = null;
    if (input.tag) {
      const tagRows = await db
        .select({ questionId: questionTags.questionId })
        .from(questionTags)
        .innerJoin(tags, eq(tags.id, questionTags.tagId))
        .where(eq(tags.name, input.tag.trim().toLowerCase()));
      tagIds = tagRows.map((r) => r.questionId);
    }
    // A4: free-text search over question text + explanation
    const searchTerm = input.q?.trim();
    const buildWhere = () => {
      const kc = decodeCursor(input.cursor);
      const base = and(
        notDeleted(questions.deletedAt),
        input.category ? eq(questions.category, input.category) : undefined,
        tagIds ? inArray(questions.id, tagIds) : undefined,
        searchTerm ? or(ilike(questions.text, "%" + searchTerm + "%"), ilike(questions.explanation, "%" + searchTerm + "%")) : undefined
      );
      return kc
        ? and(base, keysetCondition([
            { name: "created_at", value: kc.createdAt as string, dir: "desc" },
            { name: "id", value: kc.id as string, dir: "desc" }
          ]))
        : base;
    };
    const rows = await db.select().from(questions).where(buildWhere()).orderBy(desc(questions.createdAt), desc(questions.id)).limit(limit);
    // Attach tags per row (single batched query)
    const tagMap = await tagsByQuestion(db, rows.map((r) => r.id));
    const enriched = rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));
    return buildPage(enriched, limit, ["createdAt", "id"]);
  },

  async getById(id: string) {
    const row = await questionRepo.findById(id);
    const q = row[0];
    if (!q) throw new NotFoundError("Question not found");
    const options = await questionRepo.findOptions(id);
    const tagMap = await tagsByQuestion(getDb(), [id]);
    return { ...q, options, tags: tagMap.get(id) ?? [] };
  },

  async create(userId: string, input: QuestionInput) {
    return withTx(async (tx) => {
      const [row] = await tx
        .insert(questions)
        .values({ text: input.text, type: input.type, explanation: input.explanation, difficulty: input.difficulty, category: input.category, source: input.source ?? null, reviewStatus: input.reviewStatus ?? "draft", imageKey: input.imageKey, videoKey: input.videoKey ?? null, createdBy: userId })
        .returning();
      if (!row) throw new NotFoundError("Failed to create question");
      if (input.options?.length) {
        await tx.insert(questionOptions).values(input.options.map((o, i) => ({ questionId: row.id, text: o.text, isCorrect: o.isCorrect, sortOrder: i })));
      }
      const tagNames = normalizeTags(input.tags);
      if (tagNames.length > 0) await syncQuestionTags(tx, row.id, tagNames);
      await audit({ action: "question.create", resourceType: "question", resourceId: row.id, after: { optionCount: input.options?.length ?? 0, tags: tagNames } });
      await bumpCacheVersion("questions");
      // Read back via the SAME tx connection (other connections can't see uncommitted rows)
      const optRows = await tx.select().from(questionOptions).where(eq(questionOptions.questionId, row.id)).orderBy(questionOptions.sortOrder);
      const tagMap = await tagsByQuestion(tx, [row.id]);
      return { ...row, options: optRows, tags: tagMap.get(row.id) ?? [] };
    });
  },

  /**
   * M7: bulk question import with a validation report. Idempotent per row
   * via contentHash (sha256 of trimmed text). dryRun validates without
   * writing. Never throws on bad rows — they land in `failed`.
   */
  async importQuestions(user: AuthUser, input: { dryRun?: boolean; questions: ImportQuestionRow[] }) {
    const MAX_ROWS = 2000;
    if (input.questions.length > MAX_ROWS) {
      throw new BadRequestError("Import limited to " + MAX_ROWS + " rows per request", "IMPORT_TOO_LARGE");
    }
    const failed: { row: number; errors: string[] }[] = [];
    const skipped: { row: number; reason: string }[] = [];
    const valid: { row: number; data: ImportQuestionRow; hash: string }[] = [];
    const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);

    input.questions.forEach((q, idx) => {
      const errors: string[] = [];
      const text = (q.text ?? "").trim();
      if (!text) errors.push("text is required");
      const options = (q.options ?? []).map((o) => ({ text: (o.text ?? "").trim(), isCorrect: !!o.isCorrect }))
        .filter((o) => o.text.length > 0);
      if (options.length < 2) errors.push("at least 2 options are required");
      else if (!options.some((o) => o.isCorrect)) errors.push("at least one correct option is required");
      if (q.difficulty && !VALID_DIFFICULTIES.has(q.difficulty)) errors.push("difficulty must be easy|medium|hard");
      if (q.reviewStatus && !["draft", "in_review", "published"].includes(q.reviewStatus)) errors.push("reviewStatus must be draft|in_review|published");
      if (q.source && (typeof q.source.origin !== "string" || !q.source.origin.trim())) errors.push("source.origin must be a non-empty string");
      const tags = normalizeTags(q.tags);
      if (errors.length > 0) {
        failed.push({ row: idx + 1, errors });
        return;
      }
      valid.push({ row: idx + 1, data: { ...q, text, options, tags: tags.length ? tags : undefined }, hash: createHash("sha256").update(text).digest("hex") });
    });

    if (input.dryRun) {
      return {
        dryRun: true,
        wouldImport: valid.length,
        imported: 0,
        skipped,
        failed,
      };
    }

    let imported = 0;
    if (valid.length > 0) {
      await withTx(async (tx) => {
        for (const v of valid) {
          const [row] = await tx
            .insert(questions)
            .values({
              text: v.data.text,
              category: v.data.category ?? null,
              difficulty: v.data.difficulty ?? "medium",
              explanation: v.data.explanation ?? null,
              contentHash: v.hash,
              source: v.data.source ?? null,
              reviewStatus: v.data.reviewStatus ?? "draft",
              createdBy: user.id
            })
            .onConflictDoNothing()
            .returning({ id: questions.id });
          if (!row) {
            // Same content hash already exists (active row) → idempotent skip
            skipped.push({ row: v.row, reason: "duplicate (already imported)" });
            continue;
          }
          await tx.insert(questionOptions).values(
            v.data.options.map((o, i) => ({ questionId: row.id, text: o.text, isCorrect: o.isCorrect, sortOrder: i }))
          );
          if (v.data.tags && v.data.tags.length > 0) {
            await syncQuestionTags(tx, row.id, v.data.tags);
          }
          eventBus.emit("question.created", { questionId: row.id });
          imported += 1;
        }
      });
      await bumpCacheVersion("questions");
      await audit({ action: "question.import", resourceType: "question", resourceId: "batch", after: { imported, failed: failed.length, skipped: skipped.length } });
    }
    return { dryRun: false, imported, skipped, failed };
  },

  async update(user: AuthUser, id: string, input: Partial<QuestionInput>) {
    await assertCanManage(user, id);
    return withTx(async (tx) => {
      const { options, tags: _tg, ...fields } = input;
      // A10: normalize reviewStatus: null → 'draft' (column is NOT NULL)
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (fields.text !== undefined) set.text = fields.text;
      if (fields.type !== undefined) set.type = fields.type;
      if (fields.explanation !== undefined) set.explanation = fields.explanation;
      if (fields.difficulty !== undefined) set.difficulty = fields.difficulty;
      if (fields.category !== undefined) set.category = fields.category;
      if (fields.imageKey !== undefined) set.imageKey = fields.imageKey;
      if (fields.videoKey !== undefined) set.videoKey = fields.videoKey;
      if (fields.source !== undefined) set.source = fields.source;
      if (fields.reviewStatus !== undefined) set.reviewStatus = fields.reviewStatus ?? "draft";
      if (Object.keys(set).length > 1) { // more than just updatedAt
        await tx.update(questions).set(set).where(eq(questions.id, id));
      }
      let optionSnapshot: unknown;
      if (options) {
        const existing = await tx.select().from(questionOptions).where(eq(questionOptions.questionId, id));
        optionSnapshot = existing.map((o) => ({ text: o.text, isCorrect: o.isCorrect }));
        await tx.delete(questionOptions).where(eq(questionOptions.questionId, id));
        await tx.insert(questionOptions).values(options.map((o, i) => ({ questionId: id, text: o.text, isCorrect: o.isCorrect, sortOrder: i })));
      }
      const tagNames = normalizeTags(input.tags);
      if (input.tags !== undefined) await syncQuestionTags(tx, id, tagNames);
      await audit({ action: "question.update", resourceType: "question", resourceId: id, before: { fields, options: optionSnapshot }, after: { fields, options, tags: tagNames } });
      await bumpCacheVersion("questions");
      eventBus.emit("question.updated", { questionId: id });
      const updated = (await tx.select().from(questions).where(eq(questions.id, id)))[0];
      const updatedOpts = await tx.select().from(questionOptions).where(eq(questionOptions.questionId, id)).orderBy(questionOptions.sortOrder);
      const tagMap = await tagsByQuestion(tx, [id]);
      return { ...updated, options: updatedOpts, tags: tagMap.get(id) ?? [] };
    });
  },

  /** Soft delete (recoverable) + audit. Options follow the parent. */
  async remove(user: AuthUser, id: string) {
    await assertCanManage(user, id);
    return withTx(async (tx) => {
      const before = (await questionRepo.findByIdIncludeDeleted(id))[0];
      // Soft delete the question; options follow the parent (reads filter at the question level).
      await tx.update(questions).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(questions.id, id));
      // M6: drop tag links too (tag rows themselves survive for reuse)
      await tx.delete(questionTags).where(eq(questionTags.questionId, id));
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