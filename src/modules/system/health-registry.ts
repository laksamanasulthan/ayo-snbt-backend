import type { FastifyInstance } from "fastify";
import { getLogger } from "../../shared/logger.js";

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

export type HealthChecker = () => Promise<HealthCheckResult>;

/**
 * Registry of component checks (db, redis, mongo, s3, queue).
 * Tests inject fake checkers → deterministic /health and /ready.
 */
export class HealthRegistry {
  private readonly checkers = new Map<string, HealthChecker>();
  private readonly log = getLogger();

  register(name: string, checker: HealthChecker): void {
    this.checkers.set(name, checker);
  }

  async runAll(): Promise<HealthCheckResult[]> {
    const results = await Promise.all(
      [...this.checkers.entries()].map(async ([name, checker]) => {
        const started = performance.now();
        try {
          const res = await checker();
          return { ...res, latencyMs: Math.round(performance.now() - started) };
        } catch (err) {
          return {
            name,
            ok: false,
            latencyMs: Math.round(performance.now() - started),
            detail: err instanceof Error ? err.message : String(err)
          };
        }
      })
    );
    for (const r of results) {
      if (!r.ok) this.log.warn({ component: r.name, detail: r.detail }, "health check failed");
    }
    return results;
  }
}

export function declareHealth(app: FastifyInstance, registry: HealthRegistry): void {
  // Liveness: process is up and able to serve
  app.get("/health", async (_req, reply) => {
    return reply.ok({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  });

  // Readiness: dependencies reachable + degradation snapshot
  app.get("/ready", async (_req, reply) => {
    const checks = await registry.runAll();
    const ok = checks.every((c) => c.ok);
    const status = ok ? "ready" : "not_ready";
    const body = {
      status,
      checks,
      degraded: app.degradation.snapshot()
    };
    return reply.code(ok ? 200 : 503).send({
      success: ok,
      data: body,
      meta: { requestId: _req.id, timestamp: new Date().toISOString() }
    });
  });
}
