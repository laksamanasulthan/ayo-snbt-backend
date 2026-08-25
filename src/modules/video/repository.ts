import { and, eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { videos } from "../../shared/db/schema/index.js";
import { notDeleted } from "../../shared/db/filters.js";

export type VideoRow = typeof videos.$inferSelect;

export const videoRepo = {
  findById(id: string) {
    return getDb().select().from(videos).where(and(eq(videos.id, id), notDeleted(videos.deletedAt))).limit(1);
  },

  findByIdIncludeDeleted(id: string) {
    return getDb().select().from(videos).where(eq(videos.id, id)).limit(1);
  },

  softDelete(id: string): Promise<VideoRow | undefined> {
    return getDb().update(videos).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(videos.id, id)).returning().then((r) => r[0]);
  }
};
