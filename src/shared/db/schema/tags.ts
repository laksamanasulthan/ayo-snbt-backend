import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { questions } from "./questions.js";

/** Topic tags (M6): "perbandingan", "aljabar", "geometri" — finer than category. */
export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Normalized: trimmed + lowercase
  name: varchar("name", { length: 50 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

/** M:N question ↔ tag. Deleting a question or tag cascades its links. */
export const questionTags = pgTable("question_tags", {
  questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" })
}, (table) => ({
  qtUnique: uniqueIndex("question_tag_uq").on(table.questionId, table.tagId),
  qtTagIdx: index("question_tag_tag_idx").on(table.tagId)
}));
