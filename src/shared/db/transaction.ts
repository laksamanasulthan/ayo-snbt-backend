import { getDb } from "./client.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema/index.js";

export type Tx = NodePgDatabase<typeof schema>;

/**
 * Run a unit of work inside a database transaction. EVERY multi-write
 * service operation must use this — partial failures roll back atomically.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction((tx) => fn(tx as Tx));
}
