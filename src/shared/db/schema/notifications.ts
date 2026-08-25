import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * In-app notifications (M5). Rows are created by event-bus subscribers
 * (simulation.graded, course.published, order.fulfilled) — slices never
 * write here directly.
 */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // "simulation.graded" | "course.published" | "order.fulfilled"
  type: varchar("type", { length: 40 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  body: text("body"),
  // Deep-link context for the frontend: { sessionId?, packageId?, courseId?, orderId? }
  payload: jsonb("payload"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  notifUserIdx: index("notif_user_idx").on(table.userId, table.readAt, table.createdAt)
}));
