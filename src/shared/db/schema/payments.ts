import { pgTable, uuid, text, varchar, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { courses } from "./courses.js";
import { bundles } from "./coupons.js";

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orderNumber: varchar("order_number", { length: 64 }).notNull().unique(),
  amountCents: integer("amount_cents").notNull(),
  currency: varchar("currency", { length: 8 }).notNull().default("IDR"),
  status: varchar("status", { length: 20 }).notNull().default("created"),
  provider: varchar("provider", { length: 20 }).notNull(),
  providerReference: varchar("provider_reference", { length: 255 }),
  paymentUrl: text("payment_url"),
  courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
  // A8: bundle orders enroll every course in the bundle at fulfillment
  bundleId: uuid("bundle_id").references(() => bundles.id, { onDelete: "set null" }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  orderUserIdx: index("orders_user_idx").on(table.userId, table.createdAt),
  orderStatusIdx: index("orders_status_idx").on(table.status, table.createdAt)
}));

export const paymentEvents = pgTable("payment_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: varchar("event_id", { length: 255 }).notNull().unique(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 20 }).notNull(),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull()
});
