import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, getUser } from "../../shared/middleware/auth.js";
import { resultsService } from "./service.js";

export async function resultsModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  // A6: mistakes bank (distinct wrong questions, cursor-paginated)
  app.get("/api/v1/results/mistakes", { preHandler: [authGuard] }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown };
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    const result = await resultsService.listMistakes(getUser(request).id, q.cursor, limit);
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit } });
  });

  // N4: predicted score banding
  app.get("/api/v1/results/banding", { preHandler: [authGuard] }, async (request, reply) => {
    const result = await resultsService.banding(getUser(request).id);
    return reply.ok(result);
  });

  // N5: time-usage analytics
  app.get("/api/v1/results/time-analysis", { preHandler: [authGuard] }, async (request, reply) => {
    const result = await resultsService.timeAnalysis(getUser(request).id);
    return reply.ok(result);
  });
}
