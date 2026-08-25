import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, getUser } from "../../shared/middleware/auth.js";
import { simulationsService } from "./service.js";

export async function practiceModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  // ── Start a practice session ─────────────────────────────────────────
  app.post("/api/v1/practice/start", {
    preHandler: [authGuard],
    schema: {
      body: { type: "object", properties: { packageId: { type: "string" }, category: { type: "string" }, difficulty: { type: "string" }, count: { type: "integer" }, questionIds: { type: "array", items: { type: "string" } }, tag: { type: "string" } } }
    }
  }, async (request, reply) => {
    const body = request.body as { packageId?: string; category?: string; difficulty?: string; count?: number; questionIds?: string[] };
    const result = await simulationsService.startPractice(getUser(request).id, body);
    return reply.created(result);
  });

  // ── Answer with instant feedback ─────────────────────────────────────
  app.post("/api/v1/practice/:id/answer", {
    preHandler: [authGuard],
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["questionId", "selectedOptionId"], properties: { questionId: { type: "string" }, selectedOptionId: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { questionId, selectedOptionId } = request.body as { questionId: string; selectedOptionId: string };
    const result = await simulationsService.practiceAnswer(getUser(request).id, id, questionId, selectedOptionId);
    return reply.ok(result);
  });

  // ── Practice progress ────────────────────────────────────────────────
  app.get("/api/v1/practice/:id", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await simulationsService.getPracticeSession(getUser(request).id, id);
    return reply.ok(result);
  });

  // ── Finish practice ──────────────────────────────────────────────────
  app.post("/api/v1/practice/:id/finish", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await simulationsService.finishPractice(getUser(request).id, id);
    return reply.ok(result);
  });
}
