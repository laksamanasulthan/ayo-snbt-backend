import { pgTable, uuid, varchar, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** N9 — points ledger entries (one row per awarded event). */
export const pointsEvents = pgTable("points_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  event: varchar("event", { length: 50 }).notNull(),
  points: integer("points").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  pointsUserIdx: index("points_user_idx").on(table.userId, table.createdAt)
}));

/** N9 — badge definitions (thresholds on total points). */
export const badges = pgTable("badges", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  pointsRequired: integer("points_required").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

/** N9 — earned badges per user. */
export const userBadges = pgTable("user_badges", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  badgeId: uuid("badge_id").notNull().references(() => badges.id, { onDelete: "cascade" }),
  earnedAt: timestamp("earned_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  userBadgeUq: uniqueIndex("user_badge_uq").on(table.userId, table.badgeId)
}));
