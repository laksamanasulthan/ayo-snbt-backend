import { pgTable, uuid, varchar, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * A9 — product analytics events written by event-bus subscribers.
 * Event names: user.registered | user.email_verified | simulation.started |
 * results.viewed | order.paid
 */
export const analyticsEvents = pgTable("analytics_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  event: varchar("event", { length: 50 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata")
}, (table) => ({
  analyticsUserIdx: index("analytics_user_idx").on(table.userId, table.occurredAt),
  analyticsEventIdx: index("analytics_event_idx").on(table.event, table.occurredAt)
}));
