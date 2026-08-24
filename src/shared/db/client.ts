import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getEnv } from "../../config/index.js";
import * as schema from "./schema/index.js";

let pool: pg.Pool | undefined;
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

/**
 * Create a pg Pool tuned for PgBouncer (transaction mode):
 *   - statement_cache_size: 0 → client-side unnamed prepared statements
 *     (PgBouncer tx mode rejects server-side prepared statements)
 *   - max: small per-instance pool (PgBouncer handles connection fan-out)
 *   - application_name: identify ourselves
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const env = getEnv();
    // statement_cache_size: 0 is a real node-postgres option missing from
    // @types/pg — required for PgBouncer transaction pooling (client-side
    // unnamed prepared statements only).
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      statement_cache_size: 0,
      application_name: "ayo-snbt-api",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000
    } as pg.PoolConfig);
    // Log pool errors so they don't vanish
    pool.on("error", (err) => {
      console.error("pg pool error", err);
    });
  }
  return pool;
}

/** Direct connection for migrations (bypasses PgBouncer). */
export function getDirectPool(): pg.Pool {
  const env = getEnv();
  return new pg.Pool({
    connectionString: env.DIRECT_DATABASE_URL,
    max: 5,
    statement_cache_size: 0,
    application_name: "ayo-snbt-migrate"
  } as pg.PoolConfig);
}

/** Drizzle ORM client using the schema registry. */
export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!db) {
    db = drizzle(getPool(), { schema, logger: false });
  }
  return db;
}

/** Read-only pool targeting a replica (falls back to primary when unset). */
let readPool: pg.Pool | undefined;
let readDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getReadPool(): pg.Pool {
  const env = getEnv();
  if (readPool) return readPool;
  readPool = new pg.Pool({
    connectionString: env.DATABASE_URL_REPLICA ?? env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    statement_cache_size: 0,
    application_name: "ayo-snbt-api-read",
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000
  } as pg.PoolConfig);
  readPool.on("error", (err) => {
    console.error("pg read pool error", err);
  });
  return readPool;
}

/** Drizzle client bound to the read pool (catalog/leaderboard hot reads). */
export function getReadDb(): ReturnType<typeof drizzle<typeof schema>> {
  const env = getEnv();
  if (!readDb || !env.DATABASE_URL_REPLICA) {
    // Without a replica configured, reads go to the primary pool too.
    readDb = env.DATABASE_URL_REPLICA ? drizzle(getReadPool(), { schema, logger: false }) : getDb();
  }
  return readDb;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
  if (readPool) {
    await readPool.end();
    readPool = undefined;
    readDb = undefined;
  }
}