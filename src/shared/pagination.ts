import { asc, desc, sql, type SQL } from "drizzle-orm";
import { BadRequestError } from "./http/errors.js";

/**
 * Cursor-based (keyset) pagination primitives.
 * Opaque cursor: base64url(JSON) of the last row ordering keys.
 * Stable composite ordering: (createdAt, id) with id as the tie-breaker.
 */

export interface CursorKeys {
  [column: string]: string | number;
}

export interface PageResult<T> {
  rows: T[];
  nextCursor: string | null;
  limit: number;
}

const MAX_LIMIT = 100;

export function parseLimit(raw: unknown, fallback = 20): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n < 1) throw new BadRequestError("limit must be a positive integer", "INVALID_LIMIT");
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export function encodeCursor(keys: CursorKeys): string {
  return Buffer.from(JSON.stringify(keys)).toString("base64url");
}

/** Decode + validate a cursor; null/undefined/empty → undefined (first page). */
export function decodeCursor(cursor: unknown): CursorKeys | undefined {
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  if (typeof cursor !== "string") throw new BadRequestError("Invalid cursor", "INVALID_CURSOR");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad shape");
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "number") throw new Error("bad value");
    }
    return parsed as CursorKeys;
  } catch {
    throw new BadRequestError("Invalid cursor", "INVALID_CURSOR");
  }
}

export type OrderDir = "asc" | "desc";

const Q = "'";

/**
 * Keyset predicate: rows strictly after the cursor under (col1, col2, ...)
 * ordering with per-column direction. Generates the OR-chain:
 *   (c1 < v1) OR (c1 = v1 AND c2 < v2) OR (c1 = v1 AND c2 = v2 AND c3 < v3)
 */
export function keysetCondition(cols: { name: string; value: string | number; dir: OrderDir }[]): SQL<unknown> {
  if (cols.length === 0) return sql.raw("true");
  const cmp = (dir: OrderDir) => (dir === "desc" ? "<" : ">");
  const lit = (v: string | number) => (typeof v === "number" ? String(v) : Q + v + Q);
  const eqExpr = (c: { name: string; value: string | number }) => c.name + " = " + lit(c.value);
  const ors: string[] = [];
  for (let i = 0; i < cols.length; i++) {
    const cur = cols[i];
    if (!cur) continue;
    const parts: string[] = [];
    for (let j = 0; j < i; j++) {
      const prev = cols[j];
      if (prev) parts.push(eqExpr(prev));
    }
    parts.push(cur.name + " " + cmp(cur.dir) + " " + lit(cur.value));
    ors.push("(" + parts.join(" AND ") + ")");
  }
  return sql.raw("(" + ors.join(" OR ") + ")");
}

/**
 * Build the page result: rows plus an opaque nextCursor derived from the
 * last row keys (only when the page is full — more rows may exist).
 */
export function buildPage<T>(rows: T[], limit: number, keyColumns: string[]): PageResult<T> {
  const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
  const nextCursor = rows.length === limit && last ? encodeCursor(Object.fromEntries(keyColumns.map((c) => [c, last[c] as string | number]))) : null;
  return { rows, nextCursor, limit };
}

export function orderByCols(cols: { name: string; dir: OrderDir }[]) {
  return cols.map((c) => (c.dir === "desc" ? desc(sql.raw(c.name)) : asc(sql.raw(c.name))));
}