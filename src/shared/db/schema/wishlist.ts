import { pgTable, uuid, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { courses } from "./courses.js";

/** N8 — course wishlist (save for later; toggle endpoints). */
export const wishlist = pgTable("wishlist", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  wishlistUq: primaryKey({ columns: [table.userId, table.courseId] }),
  wishlistCourseIdx: index("wishlist_course_idx").on(table.courseId)
}));
