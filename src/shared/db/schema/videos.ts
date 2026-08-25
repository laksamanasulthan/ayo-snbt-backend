import { pgTable, uuid, text, varchar, timestamp, integer } from "drizzle-orm/pg-core";

export const videos = pgTable("videos", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("uploaded"),
  rawKey: text("raw_key"),
  hlsPrefix: text("hls_prefix"),
  masterPlaylistKey: text("master_playlist_key"),
  durationSeconds: integer("duration_seconds"),
  posterKey: text("poster_key"),
  error: text("error"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});
