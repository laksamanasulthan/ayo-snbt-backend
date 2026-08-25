import { pgTable, uuid, text, varchar, timestamp, jsonb, integer, uniqueIndex } from "drizzle-orm/pg-core";

export const outboxJobs = pgTable("outbox_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: varchar("type", { length: 100 }).notNull(),
  payload: jsonb("payload").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  statusIdx: uniqueIndex("ob_status_idx").on(table.status, table.availableAt)
}));
