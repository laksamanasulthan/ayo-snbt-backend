import { and, eq, desc, lt, inArray, count, sql } from "drizzle-orm";
import { getDb } from "../../shared/db/client.js";
import { orders, paymentEvents, courseEnrollments, courses, users, coupons, bundles, bundleCourses } from "../../shared/db/schema/index.js";
import { NotFoundError, BadRequestError, ConflictError, ForbiddenError } from "../../shared/http/errors.js";
import { audit } from "../../shared/audit/audit.js";
import { getPaymentProvider } from "./provider.js";
import { QueueName, enqueue } from "../../shared/queue/queues.js";
import { decodeCursor, keysetCondition, buildPage } from "../../shared/pagination.js";
import { getLogger } from "../../shared/logger.js";
import { eventBus } from "../../shared/events/bus.js";

const log = getLogger();

const ORDER_EXPIRY_MS = 24 * 3600_000;

function makeOrderNumber(): string {
  return "AYOSNBT-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

export const paymentsService = {
  /**
   * A8: create an order for a paid course OR a bundle, with an optional
   * coupon. Free courses enroll immediately (no order). Coupon validation
   * happens here; usesCount increments when the order is created.
   */
  async createOrder(userId: string, input: { courseId?: string; bundleId?: string; couponCode?: string }) {
    const db = getDb();
    const { courseId, bundleId, couponCode } = input;
    if (!courseId && !bundleId) throw new BadRequestError("courseId or bundleId is required", "VALIDATION_ERROR");
    if (courseId && bundleId) throw new BadRequestError("Provide either courseId or bundleId, not both", "VALIDATION_ERROR");

    const targetCourseId: string | null = courseId ?? null;
    let title = "";
    let basePriceCents = 0;
    let orderBundleId: string | null = null;

    if (courseId) {
      const course = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
      const c = course[0];
      if (!c) throw new NotFoundError("Course not found");
      if (c.status !== "published") throw new BadRequestError("Course not available");
      if ((c.priceCents ?? 0) <= 0) {
        // Free course: enroll directly, no payment
        await db.insert(courseEnrollments).values({ userId, courseId }).onConflictDoNothing();
        return { free: true, enrolled: true };
      }
      title = c.title;
      basePriceCents = c.priceCents ?? 0;
    } else if (bundleId) {
      const b = (await db.select().from(bundles).where(and(eq(bundles.id, bundleId), eq(bundles.status, "published"))).limit(1))[0];
      if (!b) throw new NotFoundError("Bundle not found");
      title = b.title;
      basePriceCents = b.priceCents;
      orderBundleId = bundleId;
    }

    // A8: coupon application (percentOff, scoped by course when set)
    let couponCodeUsed: string | null = null;
    let percentOff = 0;
    if (couponCode) {
      const coupon = (await db.select().from(coupons).where(eq(coupons.code, couponCode.trim().toUpperCase())).limit(1))[0];
      if (!coupon) throw new BadRequestError("Invalid coupon code", "COUPON_INVALID");
      if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new BadRequestError("Coupon expired", "COUPON_EXPIRED");
      if (coupon.maxUses !== null && coupon.usesCount >= coupon.maxUses) throw new BadRequestError("Coupon usage limit reached", "COUPON_EXHAUSTED");
      if (coupon.courseId && coupon.courseId !== targetCourseId) throw new BadRequestError("Coupon not valid for this course", "COUPON_INVALID");
      // Race-safe increment: conditional on maxUses when set
      const bumped = coupon.maxUses === null
        ? await db.update(coupons).set({ usesCount: sql.raw("uses_count + 1"), updatedAt: new Date() }).where(eq(coupons.id, coupon.id)).returning({ id: coupons.id })
        : await db.update(coupons).set({ usesCount: sql.raw("uses_count + 1"), updatedAt: new Date() }).where(and(eq(coupons.id, coupon.id), lt(coupons.usesCount, coupon.maxUses))).returning({ id: coupons.id });
      if (bumped.length === 0) throw new BadRequestError("Coupon usage limit reached", "COUPON_EXHAUSTED");
      percentOff = coupon.percentOff;
      couponCodeUsed = coupon.code;
    }
    const amountCents = Math.round((basePriceCents * (100 - percentOff)) / 100);

    const user = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user[0]) throw new NotFoundError("User not found");

    const orderNumber = makeOrderNumber();
    const provider = getPaymentProvider();
    const payment = await provider.createPayment({
      orderNumber,
      amountCents,
      email: user[0].email,
      courseTitle: title,
    });

    const [order] = await db
      .insert(orders)
      .values({
        userId,
        orderNumber,
        amountCents,
        status: "pending",
        provider: provider.name,
        providerReference: payment.providerReference,
        paymentUrl: payment.paymentUrl,
        courseId: targetCourseId,
        bundleId: orderBundleId,
        metadata: { courseTitle: title, ...(couponCodeUsed ? { couponCode: couponCodeUsed, percentOff } : {}) },
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

  /** Cursor-paginated my orders: (createdAt DESC, id DESC) keyset. */
  async listMyOrders(userId: string, cursor?: string, limit = 20) {
    const db = getDb();
    const kc = decodeCursor(cursor);
    const where = kc
      ? and(
          eq(orders.userId, userId),
          keysetCondition([
            { name: "created_at", value: kc.createdAt as string, dir: "desc" },
            { name: "id", value: kc.id as string, dir: "desc" }
          ])
        )
      : eq(orders.userId, userId);
    const rows = await db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit);
    return buildPage(rows, limit, ["createdAt", "id"]);
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
      payload: parsed as unknown,
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
    // A8: enroll the course, or EVERY course in the bundle
    if (o.courseId) {
      await db.insert(courseEnrollments).values({ userId: o.userId, courseId: o.courseId }).onConflictDoNothing();
    }
    if (o.bundleId) {
      const bundleRows = await db
        .select({ courseId: bundleCourses.courseId })
        .from(bundleCourses)
        .where(eq(bundleCourses.bundleId, o.bundleId));
      for (const b of bundleRows) {
        await db.insert(courseEnrollments).values({ userId: o.userId, courseId: b.courseId }).onConflictDoNothing();
      }
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
    eventBus.emit("order.fulfilled", { orderId, userId: o.userId, courseId: o.courseId });
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

  // ── A8: coupon management (mentor/admin) ────────────────────────────
  async createCoupon(user: { id: string }, input: { code: string; percentOff: number; maxUses?: number | null; courseId?: string | null; expiresAt?: string | null }) {
    const code = input.code?.trim().toUpperCase();
    if (!code || !/^[A-Z0-9_-]{3,50}$/.test(code)) throw new BadRequestError("code must be 3-50 chars of A-Z 0-9 _ -", "VALIDATION_ERROR");
    if (!Number.isInteger(input.percentOff) || input.percentOff < 1 || input.percentOff > 100) {
      throw new BadRequestError("percentOff must be an integer 1-100", "VALIDATION_ERROR");
    }
    if (input.maxUses !== null && input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
      throw new BadRequestError("maxUses must be a positive integer or null", "VALIDATION_ERROR");
    }
    const db = getDb();
    const [row] = await db
      .insert(coupons)
      .values({
        code,
        percentOff: input.percentOff,
        maxUses: input.maxUses ?? null,
        courseId: input.courseId ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: user.id
      })
      .returning();
    if (!row) throw new ConflictError("Failed to create coupon (code may already exist)");
    await audit({ action: "coupon.create", resourceType: "coupon", resourceId: row.id, after: { code, percentOff: input.percentOff } });
    return row;
  },

  /** List coupons (admin view). */
  async listCoupons(limit = 50) {
    const rows = await getDb().select().from(coupons).orderBy(desc(coupons.createdAt)).limit(limit);
    return rows;
  },

  // ── A8: bundle management (mentor/admin) ────────────────────────────
  async createBundle(user: { id: string }, input: { title: string; description?: string; priceCents: number; courseIds: string[] }) {
    const title = input.title?.trim();
    if (!title) throw new BadRequestError("Bundle title is required", "VALIDATION_ERROR");
    if (!Number.isInteger(input.priceCents) || input.priceCents <= 0) throw new BadRequestError("priceCents must be a positive integer", "VALIDATION_ERROR");
    if (!input.courseIds?.length) throw new BadRequestError("At least one course is required", "VALIDATION_ERROR");
    const db = getDb();
    const [row] = await db
      .insert(bundles)
      .values({ title, description: input.description ?? null, priceCents: input.priceCents, status: "draft", createdBy: user.id })
      .returning();
    if (!row) throw new ConflictError("Failed to create bundle");
    await db.insert(bundleCourses).values(input.courseIds.map((courseId, i) => ({ bundleId: row.id, courseId, sortOrder: i }))).onConflictDoNothing();
    await audit({ action: "bundle.create", resourceType: "bundle", resourceId: row.id, after: { courseCount: input.courseIds.length } });
    return row;
  },

  /** Update bundle fields and/or replace its courses. */
  async updateBundle(user: { id: string; roles: string[] }, id: string, input: { title?: string; description?: string; priceCents?: number; status?: string; courseIds?: string[] }) {
    const db = getDb();
    const existing = (await db.select().from(bundles).where(eq(bundles.id, id)).limit(1))[0];
    if (!existing) throw new NotFoundError("Bundle not found");
    if (!user.roles.includes("admin") && existing.createdBy !== user.id) throw new ForbiddenError("Only the bundle owner or admin can update");
    if (input.priceCents !== undefined && (!Number.isInteger(input.priceCents) || input.priceCents <= 0)) {
      throw new BadRequestError("priceCents must be a positive integer", "VALIDATION_ERROR");
    }
    const fields: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) fields.title = input.title;
    if (input.description !== undefined) fields.description = input.description ?? null;
    if (input.priceCents !== undefined) fields.priceCents = input.priceCents;
    if (input.status !== undefined) fields.status = input.status;
    await db.update(bundles).set(fields).where(eq(bundles.id, id));
    if (input.courseIds !== undefined) {
      await db.delete(bundleCourses).where(eq(bundleCourses.bundleId, id));
      if (input.courseIds.length) {
        await db.insert(bundleCourses).values(input.courseIds.map((courseId, i) => ({ bundleId: id, courseId, sortOrder: i }))).onConflictDoNothing();
      }
    }
    await audit({ action: "bundle.update", resourceType: "bundle", resourceId: id, before: { title: existing.title }, after: fields });
    return this.getBundle(id);
  },

  /** Bundle detail with ordered courses. */
  async getBundle(id: string) {
    const db = getDb();
    const bundle = (await db.select().from(bundles).where(eq(bundles.id, id)).limit(1))[0];
    if (!bundle) throw new NotFoundError("Bundle not found");
    const items = await db
      .select({ courseId: courses.id, title: courses.title, sortOrder: bundleCourses.sortOrder })
      .from(bundleCourses)
      .innerJoin(courses, eq(courses.id, bundleCourses.courseId))
      .where(eq(bundleCourses.bundleId, id))
      .orderBy(bundleCourses.sortOrder);
    return { ...bundle, courses: items };
  },

  /** Public list: published bundles with course counts. */
  async listBundles(limit = 50) {
    const db = getDb();
    const rows = await db
      .select({ id: bundles.id, title: bundles.title, description: bundles.description, priceCents: bundles.priceCents, createdAt: bundles.createdAt })
      .from(bundles)
      .where(eq(bundles.status, "published"))
      .orderBy(desc(bundles.createdAt))
      .limit(limit);
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await db.select({ bundleId: bundleCourses.bundleId, c: count() }).from(bundleCourses).where(inArray(bundleCourses.bundleId, ids)).groupBy(bundleCourses.bundleId)
      : [];
    const byId = new Map(counts.map((r) => [r.bundleId, r.c]));
    return rows.map((r) => ({ ...r, courseCount: byId.get(r.id) ?? 0 }));
  },
};