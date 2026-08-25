import { pgTable, uuid, text, varchar, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id"),
  requestId: varchar("request_id", { length: 64 }),
  ip: varchar("ip", { length: 45 }),
  userAgent: text("user_agent"),
  action: varchar("action", { length: 100 }).notNull(),
  resourceType: varchar("resource_type", { length: 100 }),
  resourceId: varchar("resource_id", { length: 255 }),
  before: jsonb("before"),
  after: jsonb("after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  auditResourceIdx: index("audit_resource_idx").on(table.resourceType, table.resourceId),
  auditActorIdx: index("audit_actor_idx").on(table.actorId, table.createdAt)
}));
