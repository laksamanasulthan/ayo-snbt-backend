import { isNull } from "drizzle-orm";
import type { AnyPgColumn, PgColumn } from "drizzle-orm/pg-core";

/**
 * Standard soft-delete filter: every query on a soft-deletable table MUST
 * include this condition (enforced by convention via the repository layer).
 */
export function notDeleted(column: AnyPgColumn) {
  return isNull(column as PgColumn);
}
