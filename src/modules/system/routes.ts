import type { FastifyInstance } from "fastify";
import { HealthRegistry, declareHealth } from "./health-registry.js";

export interface SystemModuleOptions {
  registry: HealthRegistry;
}

/** System slice: /health (liveness) + /ready (readiness + degradation). */
export async function systemModule(app: FastifyInstance, opts: SystemModuleOptions): Promise<void> {
  declareHealth(app, opts.registry);
}
