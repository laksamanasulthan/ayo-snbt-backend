import { getDb } from "../db/client.js";
import { auditLogs } from "../db/schema/index.js";
import { getRequestContext } from "../context/request-context.js";
import { getLogger } from "../logger.js";

const log = getLogger();

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

/**
 * Append an audit entry. Context (actorId, requestId, ip, userAgent) is
 * read automatically from the request AsyncLocalStorage — callers only
 * supply the action + resource + optional before/after diff.
 */
export async function audit(input: AuditInput): Promise<void> {
  const ctx = getRequestContext();
  try {
    await getDb().insert(auditLogs).values({
      actorId: ctx?.actorId,
      requestId: ctx?.requestId,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: (input.before ?? null) as unknown,
      after: (input.after ?? null) as unknown,
      metadata: (input.metadata ?? null) as unknown
    });
  } catch (err) {
    // Audit must never break the main flow
    log.error({ err, action: input.action }, "audit write failed");
  }
}