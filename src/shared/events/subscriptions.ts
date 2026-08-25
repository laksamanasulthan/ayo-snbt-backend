import { eventBus } from "./bus.js";
import { bumpCacheVersion } from "../cache/version.js";
import { getDb } from "../db/client.js";
import { eq, isNull } from "drizzle-orm";
import { users, courses, notifications } from "../db/schema/index.js";
import { notificationsService } from "../../modules/notifications/service.js";
import { analyticsService } from "../../modules/analytics/service.js";
import { gamificationService } from "../../modules/gamification/service.js";
import { QueueName, enqueue } from "../queue/queues.js";
import { getLogger } from "../logger.js";

const log = getLogger();

/**
 * Wire domain events to cross-cutting concerns: cache invalidation,
 * in-app notifications (M5), and the reserved email-notification queue.
 * Slices only emit — this module decides what happens next.
 */
export function subscribeEvents(): void {
  eventBus.on("course.published", ({ courseId }) => { void bumpCacheVersion("courses"); void courseId; });
  eventBus.on("course.deleted", () => { void bumpCacheVersion("courses"); });
  eventBus.on("course.restored", () => { void bumpCacheVersion("courses"); });
  eventBus.on("question.updated", () => { void bumpCacheVersion("questions"); });
  eventBus.on("question.deleted", () => { void bumpCacheVersion("questions"); });
  eventBus.on("simulation_package.updated", () => { void bumpCacheVersion("simulation_packages"); });
  eventBus.on("simulation_package.deleted", () => { void bumpCacheVersion("simulation_packages"); });
  eventBus.on("leaderboard.changed", ({ packageId }) => { void bumpCacheVersion("leaderboard:" + packageId); });
  // A freshly graded session changes the leaderboard ranking — invalidate
  eventBus.on("simulation.graded", ({ packageId }) => { void bumpCacheVersion("leaderboard:" + packageId); });

  // ── M5: in-app notifications ─────────────────────────────────────────
  // Result ready → tell the student
  eventBus.on("simulation.graded", ({ sessionId, packageId, userId }) => {
    void notificationsService.create({
      userId,
      type: "simulation.graded",
      title: "Hasil tryout siap",
      body: "Skor dan pembahasan tryout kamu sudah tersedia.",
      payload: { sessionId, packageId }
    }).catch((err) => log.error({ err }, "notify simulation.graded failed"));
  });

  // New course published → fan-out to every active user
  eventBus.on("course.published", ({ courseId }) => {
    void notifyCoursePublished(courseId).catch((err) => log.error({ err, courseId }, "notify course.published failed"));
  });

  // Order fulfilled → tell the buyer + schedule the email receipt
  eventBus.on("order.fulfilled", ({ orderId, userId, courseId }) => {
    void notificationsService.create({
      userId,
      type: "order.fulfilled",
      title: "Pembayaran berhasil",
      body: "Kursus kamu sudah aktif. Selamat belajar!",
      payload: { orderId, courseId }
    }).catch((err) => log.error({ err }, "notify order.fulfilled failed"));
    // Email subset via the reserved notification queue (worker not wired yet)
    void enqueue(QueueName.Notification, { type: "order.receipt", orderId, userId, courseId });
  });

  // ── A9: product analytics events ────────────────────────────────────
  eventBus.on("user.registered", ({ userId }) => {
    void analyticsService.record(userId, "user.registered").catch(() => undefined);
  });
  eventBus.on("user.email_verified", ({ userId }) => {
    void analyticsService.record(userId, "user.email_verified").catch(() => undefined);
  });
  eventBus.on("simulation.started", ({ userId, type }) => {
    void analyticsService.record(userId, "simulation.started", { type }).catch(() => undefined);
  });
  eventBus.on("results.viewed", ({ userId }) => {
    void analyticsService.record(userId, "results.viewed").catch(() => undefined);
  });
  eventBus.on("order.fulfilled", ({ userId }) => {
    void analyticsService.record(userId, "order.paid").catch(() => undefined);
  });

  // ── N9: gamification points ─────────────────────────────────────────
  const award = (event: string) => (payload: { userId: string }) => {
    void gamificationService.award(payload.userId, event).catch(() => undefined);
  };
  eventBus.on("user.registered", award("user.registered"));
  eventBus.on("user.email_verified", award("user.email_verified"));
  eventBus.on("simulation.started", award("simulation.started"));
  eventBus.on("simulation.graded", award("simulation.graded"));
  eventBus.on("results.viewed", award("results.viewed"));
  eventBus.on("order.fulfilled", award("order.paid"));
}

async function notifyCoursePublished(courseId: string): Promise<void> {
  const db = getDb();
  const course = (await db.select({ title: courses.title }).from(courses).where(eq(courses.id, courseId)).limit(1))[0];
  const title = course?.title ?? "Kursus baru";
  // Fan-out: insert one row per active user in batches (fine at this scale;
  // a per-user notification feed table or queue fan-out is the scale-up path)
  const userIds = await db.select({ id: users.id }).from(users).where(isNull(users.deletedAt)).limit(10_000);
  for (let i = 0; i < userIds.length; i += 500) {
    const batch = userIds.slice(i, i + 500);
    await db.insert(notifications).values(
      batch.map((u) => ({
        userId: u.id,
        type: "course.published",
        title: `Kursus baru: ${title}`,
        body: "Kursus baru sudah terbit — cek sekarang!",
        payload: { courseId }
      }))
    );
  }
}
