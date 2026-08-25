import { eventBus } from "./bus.js";
import { bumpCacheVersion } from "../cache/version.js";

/**
 * Wire domain events to cache invalidation. Slices only emit; this
 * cross-cutting concern decides what to invalidate.
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
}
