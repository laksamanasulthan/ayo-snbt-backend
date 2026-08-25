import { and, eq } from "drizzle-orm";
import { getDb, getReadDb } from "../../shared/db/client.js";
import { simulationPackages, questions } from "../../shared/db/schema/index.js";
import { notDeleted } from "../../shared/db/filters.js";

export type SimulationPackageRow = typeof simulationPackages.$inferSelect;

export const simulationPackageRepo = {
  findById(id: string, opts: { readReplica?: boolean } = {}) {
    const db = opts.readReplica ? getReadDb() : getDb();
    return db.select().from(simulationPackages).where(and(eq(simulationPackages.id, id), notDeleted(simulationPackages.deletedAt))).limit(1);
  },

  /** Question-bank picks must exclude soft-deleted questions. */
  activeQuestionsByCategory(category: string, limit: number) {
    return getDb()
      .select({ id: questions.id })
      .from(questions)
      .where(and(eq(questions.category, category), eq(questions.type, "multiple_choice"), notDeleted(questions.deletedAt)))
      .orderBy(questions.deletedAt) // placeholder — replaced with random() in service
      .limit(limit);
  },

  softDelete(id: string): Promise<SimulationPackageRow | undefined> {
    return getDb().update(simulationPackages).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(simulationPackages.id, id)).returning().then((r) => r[0]);
  },

  restore(id: string): Promise<SimulationPackageRow | undefined> {
    return getDb().update(simulationPackages).set({ deletedAt: null, updatedAt: new Date() }).where(eq(simulationPackages.id, id)).returning().then((r) => r[0]);
  }
};
