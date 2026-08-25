// ── Barrel: re-exports every table for the 18 importers and drizzle-kit ──
// Drizzle follows re-exports, so this file stays the schema entry point in
// drizzle.config.ts. New tables go into the appropriate slice file and are
// re-exported here.

export { users, userIdentities, roles, permissions, rolePermissions, userRoles } from "./users.js";
export { refreshTokens, emailVerifications, passwordResets } from "./auth.js";
export { outboxJobs } from "./outbox.js";
export { courses, lessons, courseEnrollments, lessonProgress } from "./courses.js";
export { videos } from "./videos.js";
export { questions, questionOptions } from "./questions.js";
export { tags, questionTags } from "./tags.js";
export { questionReplies, replyUpvotes } from "./qa.js";
export { learningPaths, pathCourses, pathEnrollments } from "./paths.js";
export { follows } from "./follows.js";
export { coupons, bundles, bundleCourses } from "./coupons.js";
export { analyticsEvents } from "./analytics.js";
export { dailyChallenges } from "./challenges.js";
export { questionNotes } from "./notes.js";
export { certificates } from "./certificates.js";
export { wishlist } from "./wishlist.js";
export { pointsEvents, badges, userBadges } from "./gamification.js";
export { simulationPackages, simulationSessions, simulationAnswers } from "./simulations.js";
export { orders, paymentEvents } from "./payments.js";
export { notifications } from "./notifications.js";
export { auditLogs } from "./audit.js";
