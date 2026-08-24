import { and, eq } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { orders, paymentEvents, courseEnrollments, courses, users } from "../../shared/db/schema/index.js";
import { NotFoundError, BadRequestError, ConflictError } from "../../shared/http/errors.js";
import { getPaymentProvider } from "./provider.js";
import { QueueName, enqueue } from "../../shared/queue/queues.js";
import { getLogger } from "../../shared/logger.js";

const log = getLogger();

const ORDER_EXPIRY_MS = 24 * 3600_000;

function makeOrderNumber(): string {
  return "AYOSNBT-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

export const paymentsService = {
  /**
   * Create an order for a paid course and obtain the provider payment URL.
   * Free courses enroll immediately (no order).
   */
  async createOrder(userId: string, courseId: string) {
    const db = getDb();
    const course = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    const c = course[0];
    if (!c) throw new NotFoundError("Course not found");
    if (c.status !== "published") throw new BadRequestError("Course not available");
    if ((c.priceCents ?? 0) <= 0) {
      // Free course: enroll directly, no payment
      await db.insert(courseEnrollments).values({ userId, courseId }).onConflictDoNothing();
      return { free: true, enrolled: true };
    }
    const user = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user[0]) throw new NotFoundError("User not found");

    const orderNumber = makeOrderNumber();
    const provider = getPaymentProvider();
    const payment = await provider.createPayment({
      orderNumber,
      amountCents: c.priceCents,
      email: user[0].email,
      courseTitle: c.title,
    });

    const [order] = await db
      .insert(orders)
      .values({
        userId,
        orderNumber,
        amountCents: c.priceCents,
        status: "pending",
        provider: provider.name,
        providerReference: payment.providerReference,
        paymentUrl: payment.paymentUrl,
        courseId,
        metadata: { courseTitle: c.title },
      })
      .returning();
    if (!order) throw new ConflictError("Failed to create order");
    return { free: false, order };
  },

  async getOrder(userId: string, orderId: string) {
    const db = getDb();
    const row = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, userId))).limit(1);
    const order = row[0];
    if (!order) throw new NotFoundError("Order not found");
    // Lazy expiry: pending orders older than 24h become expired
    if (order.status === "pending" && Date.now() - order.createdAt.getTime() > ORDER_EXPIRY_MS) {
      await db.update(orders).set({ status: "expired", updatedAt: new Date() }).where(eq(orders.id, orderId));
      order.status = "expired";
    }
    return order;
  },

  async listMyOrders(userId: string) {
    const db = getDb();
    return db.select().from(orders).where(eq(orders.userId, userId)).orderBy(orders.createdAt);
  },

  /**
   * Provider webhook entry: verify → idempotency (eventId) → state machine.
   * Returns true when the event was newly processed.
   */
  async handleWebhook(providerName: string, parsed: Record<string, unknown>, headers: Record<string, string | string[] | undefined>): Promise<{ processed: boolean; orderId?: string; status: string }> {
    const db = getDb();
    const provider = getPaymentProvider();
    const verified = provider.verifyWebhook(parsed, headers);
    if (!verified) throw new BadRequestError("Invalid webhook signature", "WEBHOOK_SIGNATURE_INVALID");
    const order = await db.select().from(orders).where(eq(orders.orderNumber, verified.orderNumber)).limit(1);
    const o = order[0];
    if (!o) throw new NotFoundError("Order not found for webhook");

    // Idempotency: same eventId processed before → no-op
    const existing = await db.select({ id: paymentEvents.id }).from(paymentEvents).where(eq(paymentEvents.eventId, verified.eventId)).limit(1);
    if (existing[0]) return { processed: false, orderId: o.id, status: o.status };

    await db.insert(paymentEvents).values({
      eventId: verified.eventId,
      orderId: o.id,
      provider: providerName,
      eventType: verified.paid ? "paid" : "not_paid",
      payload: parsed as never,
    });

    if (!verified.paid) {
      // e.g. midtrans status_code 201 (pending) / 202 (denied) — keep state
      return { processed: true, orderId: o.id, status: o.status };
    }

    // State machine: created/pending → paid → (job) fulfilled → refunded
    if (o.status === "paid" || o.status === "fulfilled" || o.status === "refunded") {
      return { processed: true, orderId: o.id, status: o.status }; // already advanced
    }
    await db.update(orders).set({ status: "paid", paidAt: new Date(), updatedAt: new Date() }).where(eq(orders.id, o.id));

    // Async fulfillment: enroll + receipt email via BullMQ
    await enqueue(QueueName.Payment, { type: "fulfill", orderId: o.id }, { jobId: "pay-fulfill-" + o.id });
    log.info({ orderId: o.id, orderNumber: o.orderNumber }, "order paid — fulfillment queued");
    return { processed: true, orderId: o.id, status: "paid" };
  },

  /** BullMQ fulfillment processor: enroll user + receipt email + mark fulfilled. */
  async fulfillOrder(orderId: string): Promise<void> {
    const db = getDb();
    const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    const o = order[0];
    if (!o || o.status !== "paid") {
      log.warn({ orderId }, "fulfill skipped (not in paid state)");
      return;
    }
    if (o.courseId) {
      await db.insert(courseEnrollments).values({ userId: o.userId, courseId: o.courseId }).onConflictDoNothing();
    }
    const user = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, o.userId)).limit(1);
    if (user[0]) {
      const title = (o.metadata as { courseTitle?: string } | null)?.courseTitle ?? "kursus";
      await enqueue(QueueName.Email, {
        to: user[0].email,
        template: "payment-receipt",
        data: { name: user[0].name, orderNumber: o.orderNumber, amount: (o.amountCents / 100).toLocaleString("id-ID"), courseTitle: title },
      });
    }
    await db.update(orders).set({ status: "fulfilled", updatedAt: new Date() }).where(eq(orders.id, orderId));
    log.info({ orderId }, "order fulfilled — enrollment + receipt sent");
  },

  /** Admin refund: mark refunded (payment provider refund API is out of scope here). */
  async refundOrder(adminId: string, orderId: string): Promise<void> {
    void adminId;
    const db = getDb();
    const order = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    const o = order[0];
    if (!o) throw new NotFoundError("Order not found");
    if (o.status !== "paid" && o.status !== "fulfilled") throw new BadRequestError("Only paid orders can be refunded");
    await db.update(orders).set({ status: "refunded", refundedAt: new Date(), updatedAt: new Date() }).where(eq(orders.id, orderId));
    return;
  },
};