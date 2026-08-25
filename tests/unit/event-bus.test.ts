import { describe, it, expect, vi, afterEach } from "vitest";
import { eventBus } from "../../src/shared/events/bus.js";

// The bus is a module-level singleton with internal handler state — events
// are type-scoped so each test uses unique event names to avoid cross-talk.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("event bus", () => {
  it("delivers typed payloads to subscribers", async () => {
    const handler = vi.fn();
    const off = eventBus.on("course.published", handler);
    eventBus.emit("course.published", { courseId: "c1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith({ courseId: "c1" });
    off();
  });

  it("supports multiple subscribers per event", async () => {
    const a = vi.fn();
    const b = vi.fn();
    eventBus.on("course.deleted", a);
    eventBus.on("course.deleted", b);
    eventBus.emit("course.deleted", { courseId: "c2" });
    await new Promise((r) => setTimeout(r, 10));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes when the returned disposer is called", async () => {
    const handler = vi.fn();
    const off = eventBus.on("question.deleted", handler);
    off();
    eventBus.emit("question.deleted", { questionId: "q1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it("a throwing handler never breaks the emitter or other handlers", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    eventBus.on("order.fulfilled", bad);
    eventBus.on("order.fulfilled", good);
    expect(() => eventBus.emit("order.fulfilled", { orderId: "o1", userId: "u1" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(good).toHaveBeenCalled();
    void logSpy;
  });

  it("emitting with no subscribers is a no-op", () => {
    expect(() => eventBus.emit("leaderboard.changed", { packageId: "p1" })).not.toThrow();
  });

  it("async handlers are awaited fire-and-forget (never block emit)", async () => {
    let resolved = false;
    eventBus.on("user.password_reset", async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    });
    eventBus.emit("user.password_reset", { userId: "u1" });
    expect(resolved).toBe(false); // emit returns immediately
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(true);
  });
});
