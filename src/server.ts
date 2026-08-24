import { loadEnv } from "./config/index.js";
import { buildApp } from "./app.js";
import { closeRedis } from "./shared/redis/index.js";
import { closePool } from "./shared/db/client.js";
import { closeMongo } from "./shared/mongo/client.js";
import { closeS3 } from "./shared/s3/client.js";
import { closeMailer } from "./shared/mail/client.js";
import { getLogger } from "./shared/logger.js";

const env = loadEnv();
const log = getLogger();

async function main(): Promise<void> {
  const app = await buildApp();

  // ── Graceful shutdown ─────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down gracefully");
    const forceTimer = setTimeout(() => {
      log.error("forced exit after 15s");
      process.exit(1);
    }, 15_000);
    forceTimer.unref();

    try {
      // LB drain is expected to have happened before this point; we stop
      // accepting, drain in-flight requests, then close dependencies.
      await app.close();
      await closeRedis();
      await closePool();
      await closeMongo();
      await closeS3();
      await closeMailer();
      log.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    log.info(`Ayo-SNBT API listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

void main();
