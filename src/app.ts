import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import compress from "@fastify/compress";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import scalarApiReference from "@scalar/fastify-api-reference";
import { randomUUID } from "node:crypto";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { getEnv, type Env } from "./config/index.js";
import { httpKernelPlugin } from "./shared/http/index.js";
import { createRedisRateLimitStore } from "./shared/http/rate-limit-store.js";
import {
  DegradationManager,
  RedisHealthMonitor,
  getRedis,
  type HealthSample,
  type GateName
} from "./shared/redis/index.js";
import { getPool } from "./shared/db/client.js";
import { getMongoClient } from "./shared/mongo/client.js";
import { getS3Client } from "./shared/s3/client.js";
import { getLogger } from "./shared/logger.js";
import { bindCache } from "./shared/cache/cache.js";
import { metricsPlugin, setMetricDegradation, startQueueMetricsPolling } from "./shared/metrics/index.js";
import { systemModule, HealthRegistry } from "./modules/system/index.js";
import { authModule } from "./modules/auth/index.js";
import { usersModule } from "./modules/users/index.js";
import { iamModule } from "./modules/iam/index.js";
import { coursesModule } from "./modules/courses/index.js";
import { videoModule } from "./modules/video/index.js";
import { questionsModule } from "./modules/questions/index.js";
import { simulationsModule } from "./modules/simulations/index.js";
import { chatModule } from "./modules/chat/index.js";
import { paymentsModule } from "./modules/payments/index.js";

declare module "fastify" {
  interface FastifyInstance {
    degradation: DegradationManager;
  }
}

export interface BuildAppOptions {
  env?: Env;
  logger?: FastifyServerOptions["logger"];
  degradation?: DegradationManager;
  healthRegistry?: HealthRegistry;
  /** Disable docs/rate-limit for fast unit tests. */
  minimal?: boolean;
}

/** Real Redis health sampling used by production monitors. */
function buildRedisSample(monitorName: GateName): () => Promise<HealthSample> {
  return async () => {
    const started = Date.now();
    try {
      // Never let a hung command freeze the health monitor
      const pong = await Promise.race([
        getRedis().ping(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("redis ping timed out")), 2_500))
      ]);
      let memoryPercent: number | undefined;
      try {
        const info = await getRedis().info("memory");
        const used = /used_memory:(\d+)/.exec(info);
        const max = /maxmemory:(\d+)/.exec(info);
        if (used && max && Number(max[1]) > 0) {
          memoryPercent = Number(used[1]) / Number(max[1]);
        }
      } catch {
        /* memory info is best-effort */
      }
      void monitorName;
      return { ok: pong === "PONG", latencyMs: Date.now() - started, memoryPercent };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** Production degradation manager with live monitors. */
export function buildRealDegradation(): DegradationManager {
  const mk = (name: GateName) => new RedisHealthMonitor(name, { sample: buildRedisSample(name) });
  const mgr = new DegradationManager({ cache: mk("cache"), rateLimit: mk("rateLimit"), queue: mk("queue"), presence: mk("presence") });
  for (const m of [mgr.cache, mgr.rateLimit, mgr.queue, mgr.presence]) m.start();
  return mgr;
}

/** Production health registry wired to real components. */
export function buildRealHealthRegistry(degradation: DegradationManager): HealthRegistry {
  const registry = new HealthRegistry();
  const timeout = (p: Promise<unknown>, ms = 3_000) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("check timed out")), ms))]);

  registry.register("database", async () => {
    await timeout(getPool().query("SELECT 1"));
    return { name: "database", ok: true };
  });
  registry.register("redis", async () => {
    const gate = degradation.getGate("cache");
    if (gate.mode !== "redis") return { name: "redis", ok: true, detail: gate.reason };
    await timeout(getRedis().ping());
    return { name: "redis", ok: true };
  });
  registry.register("mongodb", async () => {
    await timeout(getMongoClient().db().command({ ping: 1 }));
    return { name: "mongodb", ok: true };
  });
  registry.register("s3", async () => {
    await timeout(getS3Client().send(new ListBucketsCommand({})));
    return { name: "s3", ok: true };
  });
  registry.register("queue", async () => {
    const gate = degradation.getGate("queue");
    if (gate.mode !== "redis") return { name: "queue", ok: true, detail: gate.reason };
    await timeout(getRedis().ping());
    return { name: "queue", ok: true };
  });
  return registry;
}

/**
 * Application factory. Registers the cross-cutting kernel, infra plugins,
 * API docs (Scalar), and the vertical-slice modules.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? getEnv();
  const degradation = opts.degradation ?? (opts.minimal ? new DegradationManager() : buildRealDegradation());
  const log = getLogger();

  const app = Fastify({
    logger: opts.logger ?? {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } } }
        : {})
    },
    genReqId: (req) => {
      const header = req.headers["x-request-id"];
      return typeof header === "string" && header.length > 0 ? header : randomUUID();
    },
    disableRequestLogging: false,
    bodyLimit: 1024 * 1024, // 1MB default; media goes via presigned S3 anyway
    // Behind HAProxy: honor X-Forwarded-For for rate limiting, audit, clientIp
    trustProxy: env.TRUST_PROXY
  });

  app.decorate("degradation", degradation);
  bindCache(degradation);
  setMetricDegradation(degradation);

  // ── Infrastructure plugins ────────────────────────────────────────────
  await app.register(cookie);
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Scalar API docs inject inline styles; everything else is 'self'
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false // Scalar uses same-origin assets only
  });
  await app.register(compress, { global: true });

  if (!opts.minimal) {
    await app.register(rateLimit, {
      global: true,
      max: env.RATE_LIMIT_GLOBAL_MAX,
      timeWindow: env.RATE_LIMIT_GLOBAL_WINDOW_MS,
      store: createRedisRateLimitStore(degradation, getRedis() as never),
      enableDraftSpec: false
    });
  }

  if (!opts.minimal && env.DOCS_ENABLED) {
    // Swagger at ROOT: the OpenAPI spec must see every route, so it cannot
    // live inside the encapsulated docs scope below (encapsulation would
    // limit it to docs-scope routes only → empty paths).
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Ayo-SNBT API",
          description:
            "Simulation-based SNBT exam prep platform. Standard envelope: success → { success, data, meta }; error → { success: false, error: { code, message, statusCode, requestId } }.",
          version: "0.1.0"
        },
        servers: [{ url: `http://localhost:${env.PORT}` }],
        components: {
          securitySchemes: {
            cookieAuth: { type: "apiKey", in: "cookie", name: "access_token", description: "JWT access token cookie" },
            oauth2: {
              type: "oauth2",
              description: "Google OAuth2 authorization-code flow",
              flows: {
                authorizationCode: {
                  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
                  tokenUrl: "https://oauth2.googleapis.com/token",
                  scopes: { openid: "OpenID Connect", email: "email", profile: "profile" }
                }
              }
            }
          }
        }
      }
    });

    // Scalar UI in an encapsulated scope: relax CSP for /docs only (Scalar
    // injects an inline bootstrap script; the strict global CSP would blank
    // the page). The spec it renders is built from the root-level swagger.
    await app.register(async (docsApp) => {
      docsApp.addHook("onSend", async (request, reply) => {
        if (request.url.startsWith("/docs")) {
          reply.header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' https: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
          );
        }
      });
      await docsApp.register(scalarApiReference, {
        routePrefix: "/docs",
        configuration: { theme: "default" }
      });
    });
  }

  // ── Cross-cutting kernel (envelope, error/404 handlers, reply helpers) ─
  await app.register(httpKernelPlugin);
  await app.register(metricsPlugin);

  // ── Vertical slice modules ────────────────────────────────────────────
  const registry = opts.healthRegistry ?? buildRealHealthRegistry(degradation);
  await app.register(systemModule, { registry });
  await app.register(authModule);
  await app.register(usersModule);
  await app.register(iamModule);
  await app.register(coursesModule);
  await app.register(videoModule);
  await app.register(questionsModule);
  await app.register(simulationsModule);
  await app.register(chatModule);
  await app.register(paymentsModule);

  startQueueMetricsPolling();
  app.addHook("onClose", async () => {
    log.info("application closing — draining dependencies");
    for (const m of [degradation.cache, degradation.rateLimit, degradation.queue, degradation.presence]) m.stop();
  });

  return app;
}