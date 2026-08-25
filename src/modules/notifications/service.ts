import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { notifications } from "../../shared/db/schema/index.js";
import { NotFoundError } from "../../shared/http/errors.js";

/**
 * In-app notifications (M5). Rows are created by event subscribers
 * (see shared/events/subscriptions.ts) — this service only reads and
 * acknowledges them.
 */
export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
}

export const notificationsService = {
  /** Cursor-paginated (createdAt DESC, id DESC) — newest first. */
  async list(userId: string, cursor: string | undefined, limit: number, onlyUnread = false) {
    const db = getDb();
    const kc = decodeCursor(cursor);
    const base = and(
      eq(notifications.userId, userId),
      onlyUnread ? isNull(notifications.readAt) : undefined
    );
    const where = kc
      ? and(base, keysetCondition([
          { name: "created_at", value: kc.createdAt as string, dir: "desc" },
          { name: "id", value: kc.id as string, dir: "desc" }
        ]))
      : base;
    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        payload: notifications.payload,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt
      })
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);
    return buildPage(rows, limit, ["createdAt", "id"]);
  },

  async unreadCount(userId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .limit(1000);
    return rows.length;
  },

  /** Mark one notification read. Ownership-scoped: another user's id → 404. */
  async markRead(userId: string, id: string) {
    const db = getDb();
    const [row] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    if (!row) {
      // Either not owned, or already read (idempotent success for owned ids)
      const exists = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
        .limit(1);
      if (exists.length === 0) throw new NotFoundError("Notification not found");
    }
    return { read: true };
  },

  async markAllRead(userId: string) {
    const db = getDb();
    const result = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { updated: result.length };
  },

  /** Internal: called by event subscribers only. */
  async create(input: CreateNotificationInput) {
    const db = getDb();
    const [row] = await db
      .insert(notifications)
      .values({ userId: input.userId, type: input.type, title: input.title, body: input.body ?? null, payload: (input.payload as Record<string, unknown> | undefined) ?? null })
      .returning({ id: notifications.id });
    return row;
  }
};
