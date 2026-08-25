import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent?: string;
  actorId?: string;
}

/**
 * Per-request context (AsyncLocalStorage): requestId, client IP, user-agent
 * and — once authGuard runs — the authenticated actor id. Services read it
 * via getRequestContext() for audit trails and future tracing, without
 * threading parameters through every call.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStorage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | null {
  return requestContextStorage.getStore() ?? null;
}

/** Set the actor on the current context (called by authGuard on success). */
export function setContextActor(actorId: string): void {
  const store = requestContextStorage.getStore();
  if (store) store.actorId = actorId;
}
