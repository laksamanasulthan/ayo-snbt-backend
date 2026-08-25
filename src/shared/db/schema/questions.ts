import { sql } from "drizzle-orm";
import { pgTable, uuid, text, varchar, timestamp, integer, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const questions = pgTable("questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: varchar("type", { length: 30 }).notNull().default("multiple_choice"),
  text: text("text").notNull(),
  explanation: text("explanation"),
  difficulty: varchar("difficulty", { length: 20 }).notNull().default("medium"),
  category: varchar("category", { length: 100 }),
  // M7: sha256 of the trimmed text — bulk-import idempotency (partial unique index below)
  contentHash: varchar("content_hash", { length: 64 }),
  // A10: provenance + review workflow
  source: jsonb("source"),
  reviewStatus: varchar("review_status", { length: 20 }).notNull().default("draft"),
  imageKey: text("image_key"),
  // N3: explanation video (object key in S3; presigned in review payloads)
  videoKey: text("video_key"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  // Idempotency key for imports; partial so soft-deleted rows don't block re-import
  contentHashUq: uniqueIndex("question_content_hash_uq").on(table.contentHash).where(sql.raw("deleted_at IS NULL"))
}));

export const questionOptions = pgTable("question_options", {
  id: uuid("id").primaryKey().defaultRandom(),
  questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  isCorrect: boolean("is_correct").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0)
});
