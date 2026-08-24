import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { httpRequestsTotal, httpRequestDurationSeconds, promClient } from "./registry.js";

/** fp() breaks encapsulation so the onResponse hook applies to ALL routes. */
export const metricsPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  // HTTP metrics: onResponse hook captures duration + status + route pattern
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? request.url ?? "unknown";
    const method = request.method;
    const status = String(reply.statusCode);
    const duration = reply.elapsedTime / 1000;
    httpRequestsTotal.inc({ method, route, status });
    httpRequestDurationSeconds.observe({ method, route, status }, duration);
  });

  // Prometheus scrape endpoint (plain text, not envelope)
  app.get("/metrics", async (_request, reply) => {
    const metrics = await promClient.register.metrics();
    return reply.type("text/plain; charset=utf-8").send(metrics);
  });
});