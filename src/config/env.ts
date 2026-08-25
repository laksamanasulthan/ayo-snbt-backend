import "dotenv/config";
import { z } from "zod";

/**
 * Central environment schema. Every env var is validated at boot —
 * the process refuses to start on invalid/missing config.
 *
 * NOTE: z.coerce.boolean() would turn the string "false" into true
 * (Boolean("false") === true) — use boolFromEnv for real env parsing.
 */
const boolFromEnv = z.preprocess(
  (v) => (typeof v === "string" ? v === "true" || v === "1" : v),
  z.boolean()
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: boolFromEnv.default(false),
  LOG_LEVEL: z.string().default("info"),

  // Database — DATABASE_URL goes through PgBouncer; DIRECT bypasses it (migrations).
  // Dev defaults match the docker-compose stack; production overrides via .env.
  DATABASE_URL: z.string().min(1).default("postgres://ayosnbt:ayosnbt@localhost:6432/ayosnbt"),
  DIRECT_DATABASE_URL: z.string().min(1).default("postgres://ayosnbt:ayosnbt@localhost:5432/ayosnbt"),
  DATABASE_URL_REPLICA: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  REDIS_MAXMEMORY_MB: z.coerce.number().int().positive().default(256),
  QUEUE_PREFIX: z.string().default("ayosnbt"),

  // MongoDB (chat)
  MONGO_URL: z.string().min(1).default("mongodb://localhost:27017/ayosnbt_chat"),

  // S3-compatible object storage
  S3_ENDPOINT: z.string().min(1).default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1).default("minioadmin"),
  S3_SECRET_KEY: z.string().min(1).default("minioadmin"),
  S3_FORCE_PATH_STYLE: boolFromEnv.default(true),
  S3_BUCKET_IMAGES: z.string().default("ayosnbt-images"),
  S3_BUCKET_VIDEOS: z.string().default("ayosnbt-videos"),
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  // Auth
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, "JWT_ACCESS_SECRET must be at least 32 chars")
    .default("dev-only-jwt-access-secret-change-me-0123456789"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: boolFromEnv.default(false),
  COOKIE_DOMAIN: z.string().optional(),
  CSRF_ENABLED: boolFromEnv.default(true),

  // SMTP
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("Ayo-SNBT <no-reply@ayo-snbt.id>"),
  SMTP_SECURE: boolFromEnv.default(false),

  // OAuth2
  OAUTH_ENABLED: boolFromEnv.default(false),
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OAUTH_GOOGLE_CALLBACK_URL: z.string().optional(),
  OAUTH_FRONTEND_REDIRECT_URL: z.string().default("http://localhost:5173"),

  // API docs
DOCS_ENABLED: boolFromEnv.default(true),

  // Frontend base URL — used in email templates (verify/reset links).
  // Dev default matches the Vite dev server; production must point at the
  // real frontend origin.
  FRONTEND_URL: z.string().min(1).default("http://localhost:5173"),

  // Rate limiting defaults
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Payments
  PAYMENT_PROVIDER: z.enum(["mock", "midtrans", "xendit"]).default("mock"),
  MIDTRANS_SERVER_KEY: z.string().optional(),
  MIDTRANS_CLIENT_KEY: z.string().optional(),
  MIDTRANS_BASE_URL: z.string().default("https://app.sandbox.midtrans.com"),
  XENDIT_SECRET_KEY: z.string().optional(),
  XENDIT_CALLBACK_TOKEN: z.string().optional(),
  XENDIT_BASE_URL: z.string().default("https://api.xendit.co"),
  PAYMENT_BASE_URL: z.string().default("http://localhost:3000"),

  // CORS
  CORS_ORIGIN: z.string().default("http://localhost:5173")
});

export type Env = z.infer<typeof envSchema>;

const DEV_SECRETS = [
  "dev-only-jwt-access-secret-change-me-0123456789",
  "minioadmin",
  "postgres://ayosnbt:ayosnbt@localhost:6432/ayosnbt",
  "postgres://ayosnbt:ayosnbt@localhost:5432/ayosnbt"
];

export function assertSecureInProduction(env: Env): void {
  if (env.NODE_ENV !== "production") return;
  for (const [key, value] of Object.entries(env)) {
    if (DEV_SECRETS.includes(String(value))) {
      throw new Error(`Refusing to start in production with dev default for ${key} — set it in .env`);
    }
  }
}

let cached: Env | undefined;

/** Parse and cache env. Throws with a readable report on invalid config. */
export function loadEnv(overrides: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(overrides);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertSecureInProduction(parsed.data);
  cached = parsed.data;
  return cached;
}

export function getEnv(): Env {
  if (!cached) return loadEnv();
  return cached;
}