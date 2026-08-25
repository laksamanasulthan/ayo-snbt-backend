import { pgTable, uuid, text, varchar, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { courses } from "./courses.js";

/** A5 — learning paths: ordered collections of courses (study plans). */
export const learningPaths = pgTable("learning_paths", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const pathCourses = pgTable("path_courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  pathId: uuid("path_id").notNull().references(() => learningPaths.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0)
}, (table) => ({
  pathCourseUq: uniqueIndex("path_course_uq").on(table.pathId, table.courseId),
  pathCourseIdx: index("path_course_path_idx").on(table.pathId, table.sortOrder)
}));

export const pathEnrollments = pgTable("path_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  pathId: uuid("path_id").notNull().references(() => learningPaths.id, { onDelete: "cascade" }),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  pathEnrollUq: uniqueIndex("path_enroll_uq").on(table.userId, table.pathId)
}));
