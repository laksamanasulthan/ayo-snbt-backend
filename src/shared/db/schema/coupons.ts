import { pgTable, uuid, varchar, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { courses } from "./courses.js";

/** A8 — discount coupons applied at order creation. */
export const coupons = pgTable("coupons", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  percentOff: integer("percent_off").notNull(),
  maxUses: integer("max_uses"),
  usesCount: integer("uses_count").notNull().default(0),
  // null = applies to every course; else only this course
  courseId: uuid("course_id").references(() => courses.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

/** A8 — bundles: multiple courses, one price; fulfillment enrolls all. */
export const bundles = pgTable("bundles", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  priceCents: integer("price_cents").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const bundleCourses = pgTable("bundle_courses", {
  bundleId: uuid("bundle_id").notNull().references(() => bundles.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0)
}, (table) => ({
  bundleCourseUq: uniqueIndex("bundle_course_uq").on(table.bundleId, table.courseId),
  bundleCourseIdx: index("bundle_course_bundle_idx").on(table.bundleId)
}));
