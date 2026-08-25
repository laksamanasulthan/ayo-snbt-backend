import { getLogger } from "../logger.js";

const log = getLogger();

/** The domain events emitted by the slices — add new events here. */
export interface DomainEventMap {
  "course.published": { courseId: string };
  "course.deleted": { courseId: string };
  "course.restored": { courseId: string };
  "question.updated": { questionId: string };
  "question.created": { questionId: string };
  "question.deleted": { questionId: string };
  "simulation_package.updated": { packageId: string };
  "simulation_package.deleted": { packageId: string };
  "order.fulfilled": { orderId: string; userId: string; courseId?: string | null };
  "user.password_reset": { userId: string };
  "leaderboard.changed": { packageId: string };
  "simulation.graded": { sessionId: string; packageId: string; userId: string };
  "user.registered": { userId: string };
  "user.email_verified": { userId: string };
  "simulation.started": { sessionId: string; userId: string; type: string };
  "results.viewed": { sessionId: string; userId: string };
}

export type DomainEventName = keyof DomainEventMap;

type Handler<T> = (payload: T) => void | Promise<void>;

/**
 * Lightweight typed in-process event bus. Slices emit domain events;
 * cross-cutting concerns (cache invalidation, notifications, audit)
 * subscribe. Handlers run async fire-and-forget — a failing handler is
 * logged and never breaks the emitter.
 */
export const eventBus = {
  on<K extends DomainEventName>(name: K, handler: Handler<DomainEventMap[K]>): () => void {
    const listeners = handlers.get(name) ?? [];
    listeners.push(handler as Handler<DomainEventMap[DomainEventName]>);
    handlers.set(name, listeners);
    return () => {
      const list = handlers.get(name);
      if (!list) return;
      handlers.set(name, list.filter((h) => h !== handler));
    };
  },

  emit<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): void {
    const listeners = handlers.get(name);
    if (!listeners || listeners.length === 0) return;
    for (const handler of listeners) {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err) => log.error({ err, event: name }, "event handler failed"));
    }
  }
};

const handlers = new Map<DomainEventName, Handler<DomainEventMap[DomainEventName]>[]>();
