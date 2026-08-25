import { sql } from "drizzle-orm";
import { pgTable, uuid, text, varchar, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { videos } from "./videos.js";

export const courses = pgTable("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  mentorId: uuid("mentor_id").references(() => users.id, { onDelete: "set null" }),
  title: varchar("title", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 100 }),
  level: varchar("level", { length: 20 }).notNull().default("all"),
  priceCents: integer("price_cents").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  imageKey: text("image_key"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  slugIdx: uniqueIndex("courses_slug_unique").on(table.slug).where(sql.raw("deleted_at IS NULL"))
}));

export const lessons = pgTable("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  videoId: uuid("video_id").references(() => videos.id, { onDelete: "set null" }),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  isFree: boolean("is_free").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const courseEnrollments = pgTable("course_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
}, (table) => ({
  enrollmentUnique: uniqueIndex("enrollment_user_course_idx").on(table.userId, table.courseId)
}));

export const lessonProgress = pgTable("lesson_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lessonId: uuid("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 20 }).notNull().default("in_progress"),
  progressPercent: integer("progress_percent").notNull().default(0),
  lastPositionSeconds: integer("last_position_seconds").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  progressUnique: uniqueIndex("progress_user_lesson_idx").on(table.userId, table.lessonId)
}));
