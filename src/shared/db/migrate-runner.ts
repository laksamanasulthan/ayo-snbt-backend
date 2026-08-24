import { loadEnv } from "../../config/env.js";
import { getDirectPool } from "./client.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { getLogger } from "../logger.js";

const env = loadEnv();
const log = getLogger();
const pool = getDirectPool();
const db = drizzle(pool, { logger: false });
log.info("running migrations...");
await migrate(db, { migrationsFolder: "drizzle" });
log.info("migrations applied");
await pool.end();

void env;