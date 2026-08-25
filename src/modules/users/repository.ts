import { and, eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { users } from "../../shared/db/schema/index.js";
import { notDeleted } from "../../shared/db/filters.js";

export type UserRow = typeof users.$inferSelect;

export const userRepo = {
  findActiveById(id: string) {
    return getDb().select().from(users).where(and(eq(users.id, id), notDeleted(users.deletedAt))).limit(1);
  },

  findActiveByEmail(email: string) {
    return getDb().select().from(users).where(and(eq(users.email, email), notDeleted(users.deletedAt))).limit(1);
  }
};
