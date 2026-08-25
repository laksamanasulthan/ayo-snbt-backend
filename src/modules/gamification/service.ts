import { eq, sql } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { pointsEvents, badges, userBadges } from "../../shared/db/schema/index.js";
import { getLogger } from "../../shared/logger.js";

const log = getLogger();

/** Points awarded per event (N9). */
const POINTS: Record<string, number> = {
  "user.registered": 10,
  "user.email_verified": 20,
  "simulation.started": 5,
  "simulation.graded": 50,
  "results.viewed": 2,
  "order.paid": 30,
};

export const gamificationService = {
  /** Award points for an event (fire-and-forget from subscribers). */
  async award(userId: string, event: string): Promise<void> {
    const pts = POINTS[event];
    if (!pts) return;
    try {
      await getDb().insert(pointsEvents).values({ userId, event, points: pts });
      // Check & grant badges by total points (lazy threshold check)
      await this.checkBadges(userId);
    } catch (err) {
      log.warn({ err, userId, event }, "gamification award failed");
    }
  },

  /** Grant any unearned badges whose pointsRequired <= total points. */
  async checkBadges(userId: string): Promise<void> {
    const db = getDb();
    const total = await db
      .select({ total: sql.raw("COALESCE(SUM(points), 0)::int") })
      .from(pointsEvents)
      .where(eq(pointsEvents.userId, userId));
    const totalPts = Number(total[0]?.total ?? 0);
    const allBadges = await db.select().from(badges);
    const earned = await db
      .select({ badgeId: userBadges.badgeId })
      .from(userBadges)
      .where(eq(userBadges.userId, userId));
    const earnedSet = new Set(earned.map((r) => r.badgeId));
    for (const badge of allBadges) {
      if (totalPts >= badge.pointsRequired && !earnedSet.has(badge.id)) {
        await db.insert(userBadges).values({ userId, badgeId: badge.id }).onConflictDoNothing();
      }
    }
  },

  /** Total points. */
  async points(userId: string) {
    const db = getDb();
    const total = await db
      .select({ total: sql.raw("COALESCE(SUM(points), 0)::int") })
      .from(pointsEvents)
      .where(eq(pointsEvents.userId, userId));
    const recent = await db
      .select({ event: pointsEvents.event, points: pointsEvents.points, createdAt: pointsEvents.createdAt })
      .from(pointsEvents)
      .where(eq(pointsEvents.userId, userId))
      .orderBy(pointsEvents.createdAt)
      .limit(50);
    return { total: Number(total[0]?.total ?? 0), recent };
  },

  /** Badges: all definitions + earned flags for the user. */
  async allBadges(userId: string) {
    const db = getDb();
    const all = await db.select().from(badges).orderBy(badges.pointsRequired);
    const earned = await db
      .select({ badgeId: userBadges.badgeId, earnedAt: userBadges.earnedAt })
      .from(userBadges)
      .where(eq(userBadges.userId, userId));
    const earnedMap = new Map(earned.map((r) => [r.badgeId, r.earnedAt]));
    return all.map((b) => ({
      ...b,
      earned: earnedMap.has(b.id),
      earnedAt: earnedMap.get(b.id) ?? null,
    }));
  },

  /** Admin: define a badge. */
  async createBadge(input: { code: string; name: string; description?: string; pointsRequired: number }) {
    const db = getDb();
    const [row] = await db.insert(badges).values(input).returning();
    return row;
  },
};
