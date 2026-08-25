import { pgTable, uuid, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** A7 — social graph: user follows another user (friends-only leaderboard). */
export const follows = pgTable("follows", {
  followerId: uuid("follower_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  followeeId: uuid("followee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  followUq: primaryKey({ columns: [table.followerId, table.followeeId] }),
  followeeIdx: index("follows_followee_idx").on(table.followeeId)
}));
