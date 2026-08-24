import { pino } from "pino";
import { getEnv } from "../config/index.js";

/**
 * Application logger. Request-scoped logging is handled by Fastify's
 * built-in pino integration (request.log) — this is the bare logger for
 * non-request contexts (workers, bootstrap, background jobs).
 */
let logger: ReturnType<typeof pino> | undefined;

export function getLogger() {
  if (!logger) {
    const env = getEnv();
    logger = pino({
      level: env.LOG_LEVEL,
      base: { service: "ayo-snbt-backend" },
      ...(env.NODE_ENV === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "SYS:standard" }
            }
          }
        : {})
    });
  }
  return logger;
}
