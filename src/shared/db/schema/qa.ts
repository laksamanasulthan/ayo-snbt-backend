import { pgTable, uuid, text, integer, boolean, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { questions } from "./questions.js";

/**
 * A3 — per-question discussion thread. One implicit thread per question
 * (replies reference the question directly); upvotes are a separate M:N.
 */
export const questionReplies = pgTable("question_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  upvoteCount: integer("upvote_count").notNull().default(0),
  // Moderation: hidden replies are excluded from public threads
  isHidden: boolean("is_hidden").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  threadIdx: index("question_reply_thread_idx").on(table.questionId, table.createdAt)
}));

export const replyUpvotes = pgTable("reply_upvotes", {
  replyId: uuid("reply_id").notNull().references(() => questionReplies.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" })
}, (table) => ({
  upvoteUnique: primaryKey({ columns: [table.replyId, table.userId] })
}));
