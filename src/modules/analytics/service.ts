import { and, eq, gte, count } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { analyticsEvents, users } from "../../shared/db/schema/index.js";

/**
 * A9 — analytics. Rows are written ONLY by event-bus subscribers
 * (record()). Admin reads: per-event totals + a D7 cohort summary.
 */
export const analyticsService = {
  /** Fire-and-forget write, used by event subscribers. */
  async record(userId: string, event: string, metadata?: Record<string, unknown>): Promise<void> {
    await getDb()
      .insert(analyticsEvents)
      .values({ userId, event, metadata: (metadata as Record<string, unknown> | null) ?? null })
      .onConflictDoNothing();
  },

  /** Totals per event (admin). */
  async summary() {
    const db = getDb();
    const rows = await db
      .select({ event: analyticsEvents.event, total: count() })
      .from(analyticsEvents)
      .groupBy(analyticsEvents.event)
      .orderBy(analyticsEvents.event);
    const totals: Record<string, number> = {};
    for (const r of rows) totals[r.event] = r.total;
    return {
      events: totals,
      registered: totals["user.registered"] ?? 0,
      verified: totals["user.email_verified"] ?? 0,
      sessionsStarted: totals["simulation.started"] ?? 0,
      resultsViewed: totals["results.viewed"] ?? 0,
      ordersPaid: totals["order.paid"] ?? 0,
    };
  },

  /**
   * D7 cohort summary over the last N days: for each calendar day, how many
   * users registered that day and how many of them had a simulation.started
   * event within 7 days of registering (retained).
   */
  async cohort(days = 14) {
    const db = getDb();
    const start = new Date(Date.now() - (days - 1) * 24 * 3600_000);
    start.setHours(0, 0, 0, 0);
    // Registrations per day
    const regs = await db
      .select({ createdAt: users.createdAt, id: users.id })
      .from(users)
      .where(and(gte(users.createdAt, start), eq(users.status, "active")));
    const regByDay = new Map<string, number>();
    for (const r of regs) {
      const key = r.createdAt.toISOString().slice(0, 10);
      regByDay.set(key, (regByDay.get(key) ?? 0) + 1);
    }
    // Started events per user per day
    const starts = await db
      .select({ userId: analyticsEvents.userId, occurredAt: analyticsEvents.occurredAt })
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.event, "simulation.started"), gte(analyticsEvents.occurredAt, start)));
    // For each registered user, did they start within 7 days?
    const retained = new Set<string>();
    for (const s of starts) {
      const u = regs.find((r) => r.id === s.userId);
      if (u && s.occurredAt.getTime() - u.createdAt.getTime() <= 7 * 24 * 3600_000) retained.add(s.userId);
    }
    const out: Array<{ day: string; registered: number; retained: number; retentionRate: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 24 * 3600_000);
      const key = d.toISOString().slice(0, 10);
      const registered = regByDay.get(key) ?? 0;
      const dayRegs = regs.filter((r) => r.createdAt.toISOString().slice(0, 10) === key);
      const dayRetained = dayRegs.filter((r) => retained.has(r.id)).length;
      out.push({ day: key, registered, retained: dayRetained, retentionRate: registered === 0 ? 0 : Number(((dayRetained / registered) * 100).toFixed(1)) });
    }
    return out;
  },
};
