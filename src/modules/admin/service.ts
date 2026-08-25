import { and, eq, desc, inArray, ilike, sql, count, or } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { users, userRoles, roles, orders, simulationSessions, courses, questions } from "../../shared/db/schema/index.js";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { NotFoundError, BadRequestError } from "../../shared/http/errors.js";
import { audit } from "../../shared/audit/audit.js";
import { notDeleted } from "../../shared/db/filters.js";

/**
 * M9 — admin console backend: user management + dashboard stats.
 * Every route is additionally guarded by an admin-role check (requireAdmin).
 */
export const adminService = {
  /** Dashboard counts. Cheap aggregate reads, no cache (admin-only). */
  async getStats() {
    const db = getDb();
    const one = async (table: AnyPgTable) => {
      const rows = await db.select({ c: count() }).from(table);
      return rows[0]?.c ?? 0;
    };
    const [userCount, courseCount, questionCount, sessionCount, orderCount] = await Promise.all([
      one(users), one(courses), one(questions), one(simulationSessions), one(orders),
    ]);
    const revenue = await db
      .select({ total: sql.raw("COALESCE(SUM(amount_cents), 0)::int") })
      .from(orders)
      .where(eq(orders.status, "paid"));
    return {
      users: userCount,
      courses: courseCount,
      questions: questionCount,
      simulationSessions: sessionCount,
      orders: orderCount,
      revenueCents: parseInt(String(revenue[0]?.total ?? "0"), 10)
    };
  },

  /** Cursor-paginated users with roles; optional q = email/name ILIKE. */
  async listUsers(input: { cursor?: string; limit: number; q?: string }) {
    const db = getDb();
    const { limit } = input;
    const kc = decodeCursor(input.cursor);
    const search = input.q?.trim();
    const where = and(
      notDeleted(users.deletedAt),
      search ? or(ilike(users.email, "%" + search + "%"), ilike(users.name, "%" + search + "%")) : undefined,
      kc
        ? keysetCondition([
            { name: "created_at", value: kc.createdAt as string, dir: "desc" },
            { name: "id", value: kc.id as string, dir: "desc" }
          ])
        : undefined
    );
    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name, status: users.status, emailVerifiedAt: users.emailVerifiedAt, createdAt: users.createdAt })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit);
    // Attach roles (batched)
    const ids = rows.map((r) => r.id);
    const roleRows = ids.length
      ? await db
          .select({ userId: userRoles.userId, name: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(inArray(userRoles.userId, ids))
      : [];
    const rolesByUser = new Map<string, string[]>();
    for (const r of roleRows) {
      const list = rolesByUser.get(r.userId) ?? [];
      list.push(r.name);
      rolesByUser.set(r.userId, list);
    }
    const enriched = rows.map((r) => ({ ...r, roles: rolesByUser.get(r.id) ?? [] }));
    return buildPage(enriched, limit, ["createdAt", "id"]);
  },

  /** One user's admin summary: profile + roles + orders + sim sessions. */
  async getUserSummary(userId: string) {
    const db = getDb();
    const row = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = row[0];
    if (!user) throw new NotFoundError("User not found");
    const roleRows = await db
      .select({ name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));
    const orderCount = (await db.select({ c: count() }).from(orders).where(eq(orders.userId, userId)))[0]?.c ?? 0;
    const orderTotal = await db
      .select({ total: sql.raw("COALESCE(SUM(amount_cents), 0)::int") })
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.status, "paid")));
    const sessionCount = (await db.select({ c: count() }).from(simulationSessions).where(eq(simulationSessions.userId, userId)))[0]?.c ?? 0;
    const bestScore = await db
      .select({ score: simulationSessions.score })
      .from(simulationSessions)
      .where(and(eq(simulationSessions.userId, userId), eq(simulationSessions.status, "graded")))
      .orderBy(desc(simulationSessions.score))
      .limit(1);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
      roles: roleRows.map((r) => r.name),
      orders: { count: orderCount, paidCents: parseInt(String(orderTotal[0]?.total ?? "0"), 10) },
      simulationSessions: { count: sessionCount, bestScore: bestScore[0]?.score ?? null }
    };
  },

  /** Suspend / activate a user. Audit trails the change. */
  async setUserStatus(adminId: string, userId: string, status: string) {
    if (status !== "active" && status !== "suspended") {
      throw new BadRequestError("status must be 'active' or 'suspended'", "VALIDATION_ERROR");
    }
    if (adminId === userId) throw new BadRequestError("Cannot change your own status", "VALIDATION_ERROR");
    const db = getDb();
    const row = await db.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    const user = row[0];
    if (!user) throw new NotFoundError("User not found");
    if (user.status === status) return { userId, status, changed: false };
    await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
    await audit({ action: "user.status", resourceType: "user", resourceId: userId, before: { status: user.status }, after: { status } });
    return { userId, status, changed: true };
  }
};
