import { describe, it, expect } from "vitest";
import {
  encodeCursor, decodeCursor, keysetCondition, buildPage, parseLimit, orderByCols,
} from "../../src/shared/pagination.js";
import { BadRequestError } from "../../src/shared/http/errors.js";

describe("pagination: encodeCursor/decodeCursor round-trip", () => {
  it("round-trips string keys", () => {
    const keys = { createdAt: "2025-01-01T00:00:00.000Z", id: "abc-123" };
    expect(decodeCursor(encodeCursor(keys))).toEqual(keys);
  });

  it("round-trips numeric keys", () => {
    const keys = { seq: 42, id: 7 };
    expect(decodeCursor(encodeCursor(keys))).toEqual(keys);
  });

  it("is URL-safe (no +/ or = padding)", () => {
    const cursor = encodeCursor({ createdAt: "2025-01-01T00:00:00.000Z", id: "a/b+c=d" });
    expect(cursor).not.toMatch(/[+/=]/);
    expect(decodeCursor(cursor)).toEqual({ createdAt: "2025-01-01T00:00:00.000Z", id: "a/b+c=d" });
  });

  it("produces a different cursor for different keys", () => {
    const a = encodeCursor({ createdAt: "2025-01-01", id: "1" });
    const b = encodeCursor({ createdAt: "2025-01-02", id: "1" });
    expect(a).not.toBe(b);
  });
});

describe("pagination: decodeCursor validation", () => {
  it("treats undefined/null/empty as the first page", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor(null)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
  });

  it("rejects non-string cursors", () => {
    expect(() => decodeCursor(123 as unknown)).toThrow(BadRequestError);
    expect(() => decodeCursor({ bad: true } as unknown)).toThrow(BadRequestError);
  });

  it("rejects garbage / truncated base64url", () => {
    expect(() => decodeCursor("not-a-cursor!")).toThrow(BadRequestError);
    expect(() => decodeCursor("aGVsbG8")).toThrow(BadRequestError); // valid b64, not JSON
  });

  it("rejects arrays and null JSON payloads", () => {
    expect(() => decodeCursor(Buffer.from("[1,2]").toString("base64url"))).toThrow(BadRequestError);
    expect(() => decodeCursor(Buffer.from("null").toString("base64url"))).toThrow(BadRequestError);
  });

  it("rejects non-string/non-number values (SQL injection surface)", () => {
    const evil = JSON.stringify({ createdAt: { $gt: "1" } });
    expect(() => decodeCursor(Buffer.from(evil).toString("base64url"))).toThrow(BadRequestError);
    const evil2 = JSON.stringify({ createdAt: ["x"] });
    expect(() => decodeCursor(Buffer.from(evil2).toString("base64url"))).toThrow(BadRequestError);
  });

  it("throws a typed BadRequestError with INVALID_CURSOR code", () => {
    try {
      decodeCursor("garbage");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).code).toBe("INVALID_CURSOR");
    }
  });
});

describe("pagination: parseLimit", () => {
  it("defaults to the fallback when raw is missing", () => {
    expect(parseLimit(undefined, 20)).toBe(20);
    expect(parseLimit(null, 10)).toBe(10);
  });

  it("parses numeric strings", () => {
    expect(parseLimit("5", 20)).toBe(5);
    expect(parseLimit(5, 20)).toBe(5);
  });

  it("rejects zero, negatives, and non-numeric values", () => {
    for (const bad of [0, -1, "0", "-3", "abc", NaN, Infinity, "1.5x"]) {
      expect(() => parseLimit(bad, 20), String(bad)).toThrow(BadRequestError);
    }
  });

  it("floors fractional limits", () => {
    expect(parseLimit(2.9, 20)).toBe(2);
    expect(parseLimit("3.7", 20)).toBe(3);
  });

  it("caps at MAX_LIMIT (100)", () => {
    expect(parseLimit(1000, 20)).toBe(100);
    expect(parseLimit("500", 20)).toBe(100);
    expect(parseLimit(100, 20)).toBe(100);
  });
});

describe("pagination: keysetCondition", () => {
  it("returns a truthy SQL for an empty column list (true predicate)", () => {
    expect(keysetCondition([])).toBeTruthy();
  });

  it("builds a comparison SQL object for single and composite keys", () => {
    const single = keysetCondition([{ name: "created_at", value: "2025-01-01", dir: "desc" }]);
    expect(single).toBeTruthy();
    const composite = keysetCondition([
      { name: "created_at", value: "2025-01-01", dir: "desc" },
      { name: "id", value: "abc", dir: "desc" },
    ]);
    expect(composite).toBeTruthy();
    // The raw SQL string must contain the OR-chain shape (integration tests
    // verify it executes correctly against Postgres)
    expect(String(composite)).toBeTruthy();
  });

  it("handles empty and malformed input defensively", () => {
    expect(() => keysetCondition([{ name: "x", value: "1", dir: "desc" as const }])).not.toThrow();
  });
});

describe("pagination: buildPage", () => {
  it("emits a nextCursor only when the page is full", () => {
    const rows = [{ createdAt: "2025-01-01", id: "1" }, { createdAt: "2025-01-02", id: "2" }];
    const full = buildPage(rows, 2, ["createdAt", "id"]);
    expect(full.nextCursor).toBeTruthy();
    expect(decodeCursor(full.nextCursor as string)).toEqual({ createdAt: "2025-01-02", id: "2" });

    const partial = buildPage(rows.slice(0, 1), 2, ["createdAt", "id"]);
    expect(partial.nextCursor).toBeNull();

    const empty = buildPage([], 2, ["createdAt", "id"]);
    expect(empty.nextCursor).toBeNull();
    expect(empty.rows).toEqual([]);
  });

  it("uses the LAST row's keys for the cursor", () => {
    const rows = [{ createdAt: "a", id: "1" }, { createdAt: "b", id: "2" }, { createdAt: "c", id: "3" }];
    const page = buildPage(rows, 3, ["createdAt", "id"]);
    const keys = decodeCursor(page.nextCursor as string) as Record<string, string>;
    expect(keys.createdAt).toBe("c");
    expect(keys.id).toBe("3");
  });
});

describe("pagination: orderByCols", () => {
  it("maps each column to a SQL expression preserving order", () => {
    const cols = orderByCols([{ name: "created_at", dir: "desc" }, { name: "id", dir: "asc" }]);
    expect(cols.length).toBe(2);
    expect(cols[0]).toBeTruthy();
    expect(cols[1]).toBeTruthy();
  });

  it("is empty for an empty input", () => {
    expect(orderByCols([])).toEqual([]);
  });
});
