import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, getUser } from "../../shared/middleware/auth.js";
import { usersService } from "./service.js";

export async function usersModule(app: FastifyInstance): Promise<void> {
  // All mutating routes in this module require a matching CSRF cookie+header
  await app.addHook("preHandler", csrfGuard);
  // ── Me (current user) ────────────────────────────────────────────────
  app.get("/api/v1/users/me", { preHandler: [authGuard] }, async (request, reply) => {
    const user = await usersService.getProfile(getUser(request).id);
    return reply.ok(user);
  });

  // ── Update profile ───────────────────────────────────────────────────
  app.patch("/api/v1/users/me", {
    preHandler: [authGuard],
    schema: {
      body: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false }
    }
  }, async (request, reply) => {
    const body = request.body as { name?: string };
    const user = await usersService.updateProfile(getUser(request).id, body);
    return reply.ok(user);
  });

  // ── Avatar presign ───────────────────────────────────────────────────
  app.post("/api/v1/users/me/avatar/presign", {
    preHandler: [authGuard],
    schema: {
      body: { type: "object", required: ["contentType"], properties: { contentType: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { contentType } = request.body as { contentType: string };
    const result = await usersService.presignAvatar(getUser(request).id, contentType);
    return reply.ok(result);
  });

  // ── Confirm avatar upload (client calls after PUT to S3) ─────────────
  app.post("/api/v1/users/me/avatar/confirm", {
    preHandler: [authGuard],
    schema: {
      body: { type: "object", required: ["key"], properties: { key: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { key } = request.body as { key: string };
    await usersService.updateAvatarUrl(getUser(request).id, key);
    return reply.ok({ updated: true });
  });

  // ── A7: social graph ─────────────────────────────────────────────────
  app.get("/api/v1/users/me/following", { preHandler: [authGuard] }, async (request, reply) => {
    const rows = await usersService.listFollowing(getUser(request).id);
    return reply.ok(rows);
  });

  app.post("/api/v1/users/:id/follow", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await usersService.follow(getUser(request).id, id);
    return reply.ok(result);
  });

  app.delete("/api/v1/users/:id/follow", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await usersService.unfollow(getUser(request).id, id);
    return reply.ok(result);
  });
}