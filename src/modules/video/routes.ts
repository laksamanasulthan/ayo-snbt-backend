import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { videoService } from "./service.js";

export async function videoModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  // ── Upload flow ──────────────────────────────────────────────────────
  app.post("/api/v1/videos", {
    preHandler: [authGuard, requirePermission(Permissions.VIDEO_UPLOAD)],
    schema: {
      body: { type: "object", required: ["title"], properties: { title: { type: "string" }, originalName: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { title, originalName } = request.body as { title: string; originalName?: string };
    const video = await videoService.create(getUser(request).id, { title, originalName });
    return reply.created(video);
  });

  app.post("/api/v1/videos/:id/upload-url", {
    preHandler: [authGuard, requirePermission(Permissions.VIDEO_UPLOAD)],
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", required: ["contentType"], properties: { contentType: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { contentType } = request.body as { contentType: string };
    const result = await videoService.presignUpload(id, contentType);
    return reply.ok(result);
  });

  app.post("/api/v1/videos/:id/confirm", {
    preHandler: [authGuard, requirePermission(Permissions.VIDEO_TRANSCODE)],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await videoService.confirmUpload(id);
    return reply.accepted(result);
  });

  // ── Status ───────────────────────────────────────────────────────────
  app.get("/api/v1/videos/:id", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const video = await videoService.getById(id);
    return reply.ok(video);
  });

  // ── Streaming (auth-checked 307 → presigned S3) ─────────────────────
  app.get("/api/v1/videos/:id/master.m3u8", {
    preHandler: [authGuard],
    config: { rateLimit: { max: 120, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await videoService.assertCanStream(getUser(request).id, id, getUser(request).roles);
    const url = await videoService.streamMasterPlaylist(id);
    return reply.redirect(url, 307);
  });

  app.get("/api/v1/videos/:id/segments/*", {
    preHandler: [authGuard],
    config: { rateLimit: { max: 300, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const filePath = (request.params as { "*": string })["*"];
    await videoService.assertCanStream(getUser(request).id, id, getUser(request).roles);
    const url = await videoService.streamSegment(id, filePath);
    return reply.redirect(url, 307);
  });
}