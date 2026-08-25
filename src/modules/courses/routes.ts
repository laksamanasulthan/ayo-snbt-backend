import type { FastifyInstance } from "fastify";
import { authGuard, optionalAuth, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { coursesService } from "./service.js";
import { ForbiddenError } from "../../shared/http/errors.js";
import { parseLimit } from "../../shared/pagination.js";

export async function coursesModule(app: FastifyInstance): Promise<void> {
  // Encapsulated plugin: mutating routes need CSRF; auth routes unaffected
  await app.addHook("preHandler", csrfGuard);

  // ── Catalog ──────────────────────────────────────────────────────────
  app.get("/api/v1/courses", {
    preHandler: [optionalAuth],
    schema: {
      querystring: { type: "object", properties: { cursor: { type: "string" }, limit: { type: "integer" } } }
    }
  }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown };
    const limit = parseLimit(q.limit, 20);
    const result = await coursesService.list({ cursor: q.cursor, limit });
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit: result.limit } });
  });

  app.get("/api/v1/courses/:id", { preHandler: [optionalAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const course = await coursesService.getById(id);
    // TS narrows: getById throws on missing, so course is defined here
    // Only published courses are visible publicly
    if (course.status !== "published") {
      const canView = request.user?.roles.includes("admin") || request.user?.roles.includes("mentor") || course.mentorId === request.user?.id;
      if (!canView) throw new ForbiddenError("Course not published");
    }
    return reply.ok(course);
  });

  // ── Mentor / admin management ────────────────────────────────────────
  app.post("/api/v1/courses", {
    preHandler: [authGuard, requirePermission(Permissions.COURSE_CREATE)],
    schema: {
      body: { type: "object", required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, category: { type: "string" }, level: { type: "string" }, priceCents: { type: "integer" } } }
    }
  }, async (request, reply) => {
    const body = request.body as { title: string; description?: string; category?: string; level?: string; priceCents?: number };
    const course = await coursesService.create(getUser(request).id, body);
    return reply.created(course);
  });

  app.patch("/api/v1/courses/:id", {
    preHandler: [authGuard, requirePermission(Permissions.COURSE_UPDATE)],
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, category: { type: "string" }, level: { type: "string" }, priceCents: { type: "integer" }, imageKey: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const course = await coursesService.update(getUser(request), id, body);
    return reply.ok(course);
  });

  app.post("/api/v1/courses/:id/publish", {
    preHandler: [authGuard, requirePermission(Permissions.COURSE_PUBLISH)],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const course = await coursesService.publish(getUser(request), id);
    return reply.ok({ published: course.status === "published" });
  });

  // ── Enrollment ───────────────────────────────────────────────────────
  app.post("/api/v1/courses/:id/enroll", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await coursesService.enroll(getUser(request).id, id);
    return reply.ok(result);
  });

  // ── Soft delete / restore (owner or admin) ───────────────────────────
  app.delete("/api/v1/courses/:id", { preHandler: [authGuard, requirePermission(Permissions.COURSE_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await coursesService.remove(getUser(request), id);
    return reply.ok(result);
  });

  app.post("/api/v1/courses/:id/restore", { preHandler: [authGuard, requirePermission(Permissions.COURSE_DELETE)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await coursesService.restore(getUser(request), id);
    return reply.ok(result);
  });

  // ── Lessons ──────────────────────────────────────────────────────────
  app.post("/api/v1/courses/:id/lessons", {
    preHandler: [authGuard, requirePermission(Permissions.COURSE_UPDATE)],
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["title"], properties: { title: { type: "string" }, description: { type: "string" }, videoId: { type: "string" }, isFree: { type: "boolean" } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title: string; description?: string; videoId?: string; isFree?: boolean };
    const lesson = await coursesService.addLesson(getUser(request), id, body);
    return reply.created(lesson);
  });

  app.patch("/api/v1/lessons/:id", {
    preHandler: [authGuard, requirePermission(Permissions.COURSE_UPDATE)],
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, videoId: { type: "string" }, isFree: { type: "boolean" } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const lesson = await coursesService.updateLesson(getUser(request), id, body);
    return reply.ok(lesson);
  });

  // ── Progress ─────────────────────────────────────────────────────────
  app.post("/api/v1/lessons/:id/progress", {
    preHandler: [authGuard],
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", properties: { status: { type: "string" }, progressPercent: { type: "integer" }, lastPositionSeconds: { type: "integer" } } }
    },
    config: { rateLimit: { max: 60, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; progressPercent?: number; lastPositionSeconds?: number };
    const result = await coursesService.recordProgress(getUser(request).id, id, body);
    return reply.ok(result);
  });

  app.get("/api/v1/courses/:id/progress", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const rows = await coursesService.listProgress(getUser(request).id, id);
    return reply.ok(rows);
  });
}