import type { FastifyInstance } from "fastify";
import { authGuard, csrfGuard, requirePermission, getUser } from "../../shared/middleware/auth.js";
import { Permissions } from "../../shared/rbac/permissions.js";
import { paymentsService } from "./service.js";

export async function paymentsModule(app: FastifyInstance): Promise<void> {
  await app.addHook("preHandler", csrfGuard);

  // ── Orders (student) ────────────────────────────────────────────────
  // A8: one of courseId | bundleId, optional couponCode
  app.post("/api/v1/payments/orders", {
    preHandler: [authGuard, requirePermission(Permissions.PAYMENT_READ)],
    schema: {
      body: {
        type: "object",
        properties: { courseId: { type: "string" }, bundleId: { type: "string" }, couponCode: { type: "string" } }
      }
    },
    config: { rateLimit: { max: 10, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const body = request.body as { courseId?: string; bundleId?: string; couponCode?: string };
    const result = await paymentsService.createOrder(getUser(request).id, body);
    return reply.created(result);
  });

  // ── A8: coupons & bundles (mentor/admin) ────────────────────────────
  app.get("/api/v1/payments/coupons", { preHandler: [authGuard, requirePermission(Permissions.COURSE_UPDATE)] }, async (_request, reply) => {
    const rows = await paymentsService.listCoupons();
    return reply.ok(rows);
  });

  app.post("/api/v1/payments/coupons", {
    preHandler: [authGuard, requirePermission(Permissions.COURSE_UPDATE)],
    schema: {
      body: { type: "object", required: ["code", "percentOff"], properties: { code: { type: "string" }, percentOff: { type: "integer" }, maxUses: { type: ["integer", "null"] }, courseId: { type: ["string", "null"] }, expiresAt: { type: ["string", "null"] } } }
    }
  }, async (request, reply) => {
    const body = request.body as { code: string; percentOff: number; maxUses?: number | null; courseId?: string | null; expiresAt?: string | null };
    const coupon = await paymentsService.createCoupon(getUser(request), body);
    return reply.created(coupon);
  });

  app.get("/api/v1/payments/bundles", async (_request, reply) => {
    const rows = await paymentsService.listBundles();
    return reply.ok(rows);
  });

  app.get("/api/v1/payments/bundles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bundle = await paymentsService.getBundle(id);
    return reply.ok(bundle);
  });

  app.post("/api/v1/payments/bundles", {
    preHandler: [authGuard, requirePermission(Permissions.COURSE_UPDATE)],
    schema: {
      body: { type: "object", required: ["title", "priceCents", "courseIds"], properties: { title: { type: "string" }, description: { type: "string" }, priceCents: { type: "integer" }, courseIds: { type: "array", items: { type: "string" } } } }
    }
  }, async (request, reply) => {
    const body = request.body as { title: string; description?: string; priceCents: number; courseIds: string[] };
    const bundle = await paymentsService.createBundle(getUser(request), body);
    return reply.created(bundle);
  });

  app.patch("/api/v1/payments/bundles/:id", {
    preHandler: [authGuard, requirePermission(Permissions.COURSE_UPDATE)],
    schema: {
      body: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, priceCents: { type: "integer" }, status: { type: "string" }, courseIds: { type: "array", items: { type: "string" } } } }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; description?: string; priceCents?: number; status?: string; courseIds?: string[] };
    const bundle = await paymentsService.updateBundle(getUser(request), id, body);
    return reply.ok(bundle);
  });

  app.get("/api/v1/payments/orders", { preHandler: [authGuard] }, async (request, reply) => {
    const q = request.query as { cursor?: string; limit?: unknown };
    const limit = Number(q.limit ?? 20);
    const result = await paymentsService.listMyOrders(getUser(request).id, q.cursor, limit);
    return reply.ok(result.rows, { pagination: { nextCursor: result.nextCursor, limit: result.limit } });
  });

  app.get("/api/v1/payments/orders/:id", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await paymentsService.getOrder(getUser(request).id, id);
    return reply.ok(order);
  });

  // ── Admin refund ────────────────────────────────────────────────────
  app.post("/api/v1/payments/orders/:id/refund", {
    preHandler: [authGuard, requirePermission(Permissions.PAYMENT_REFUND)]
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await paymentsService.refundOrder(getUser(request).id, id);
    return reply.ok({ refunded: true });
  });

  // ── Provider webhooks (no auth — signature/token verified) ──────────
  app.post("/api/v1/payments/webhook/midtrans", {
    config: { csrf: false, rateLimit: { max: 60, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const result = await paymentsService.handleWebhook("midtrans", request.body as Record<string, unknown>, request.headers as unknown as Record<string, string | string[] | undefined>);
    return reply.ok(result);
  });

  app.post("/api/v1/payments/webhook/xendit", {
    config: { csrf: false, rateLimit: { max: 60, timeWindow: 60_000 } }
  }, async (request, reply) => {
    const result = await paymentsService.handleWebhook("xendit", request.body as Record<string, unknown>, request.headers as unknown as Record<string, string | string[] | undefined>);
    return reply.ok(result);
  });

  // ── Mock provider (dev only) ────────────────────────────────────────
  app.post("/api/v1/payments/mock/pay/:orderNumber", {
    config: { csrf: false },
    schema: {
      params: { type: "object", required: ["orderNumber"], properties: { orderNumber: { type: "string" } } }
    }
  }, async (request, reply) => {
    const { orderNumber } = request.params as { orderNumber: string };
    const result = await paymentsService.handleWebhook("mock", { order_number: orderNumber, status: "paid", event_id: "mock-" + orderNumber }, {});
    return reply.ok(result);
  });
}