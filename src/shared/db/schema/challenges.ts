import { pgTable, uuid, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { questions } from "./questions.js";

/** N1 — daily challenge: the day's pinned question (optional; random fallback). */
export const dailyChallenges = pgTable("daily_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  // ISO date (YYYY-MM-DD, UTC)
  date: varchar("date", { length: 10 }).notNull(),
  questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  challengeDateUq: uniqueIndex("challenge_date_uq").on(table.date)
}));
