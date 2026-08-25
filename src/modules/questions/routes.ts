import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { questionsService } from "./service.js";
import { parseCsv, csvToImportRows, type ImportQuestionRow } from "./csv.js";

export async function questionsModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);
  const manageGuard = [authGuard, requirePermission(Permissions.QUESTION_MANAGE)];

  app.get("/api/v1/questions", {
    preHandler: manageGuard,
    schema: {
      querystring: { type: "object", properties: { cursor: { type: "string" }, limit: { type: "integer" }, category: { type: "string" }, tag: { type: "string" }, q: { type: "string" } } }
    }
  }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown; category?: string; tag?: string; q?: string };
    const limit = Number(q.limit ?? 20);
    const result = await questionsService.list({ cursor: q.cursor, limit, category: q.category, tag: q.tag, q: q.q });
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit: result.limit } });
  });

  app.get("/api/v1/questions/:id", {
    preHandler: manageGuard
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const question = await questionsService.getById(id);
    return reply.ok(question);
  });

  // M7: bulk import — JSON body or raw CSV (text/csv, text/plain)
  app.post("/api/v1/questions/import", {
    preHandler: manageGuard,
    schema: {
      body: {
        oneOf: [
          { type: "object", properties: { dryRun: { type: "boolean" }, questions: { type: "array", items: { type: "object", required: ["text"], properties: { text: { type: "string" }, category: { type: "string" }, difficulty: { type: "string" }, explanation: { type: "string" }, tags: { type: "array", items: { type: "string" } }, options: { type: "array", items: { type: "object", required: ["text"], properties: { text: { type: "string" }, isCorrect: { type: "boolean" } } } } } } } } },
          { type: "string" }
        ]
      }
    }
  }, async (request, reply) => {
    const contentType = (request.headers["content-type"] ?? "").toLowerCase();
    const isCsv = contentType.includes("text/csv") || contentType.includes("text/plain");
    const raw = request.body;
    let rows: ImportQuestionRow[];
    let dryRun = false;
    if (isCsv || typeof raw === "string") {
      rows = csvToImportRows(parseCsv(typeof raw === "string" ? raw : String(raw)));
    } else {
      const body = raw as { dryRun?: boolean; questions?: ImportQuestionRow[] };
      dryRun = body.dryRun === true;
      rows = body.questions ?? [];
    }
    const result = await questionsService.importQuestions(getUser(request), { dryRun, questions: rows });
    return reply.ok(result);
  });

  app.post("/api/v1/questions", {
    preHandler: manageGuard,
    schema: {
      body: { type: "object", required: ["text"], properties: { text: { type: "string" }, type: { type: "string" }, explanation: { type: "string" }, difficulty: { type: "string" }, category: { type: "string" }, options: { type: "array", items: { type: "object", properties: { text: { type: "string" }, isCorrect: { type: "boolean" } } } }, tags: { type: "array", items: { type: "string" } }, source: { type: ["object", "null"], properties: { origin: { type: "string" }, year: { type: "integer" } } }, reviewStatus: { type: ["string", "null"] } } }
    }
  }, async (request, reply) => {
    const body = request.body as Parameters<typeof questionsService.create>[1];
    const question = await questionsService.create(getUser(request).id, body);
    return reply.created(question);
  });

  app.patch("/api/v1/questions/:id", {
    preHandler: manageGuard,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const question = await questionsService.update(getUser(request), id, body as unknown as Parameters<typeof questionsService.update>[2]);
    return reply.ok(question);
  });

  app.post("/api/v1/questions/:id/restore", { preHandler: manageGuard }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await questionsService.restore(getUser(request), id);
    return reply.ok(result);
  });

  app.delete("/api/v1/questions/:id", {
    preHandler: manageGuard,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await questionsService.remove(getUser(request), id);
    return reply.ok(result);
  });
}