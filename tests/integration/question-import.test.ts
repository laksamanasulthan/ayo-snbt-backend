import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "../../src/shared/db/client.js";
import {
  truncateDb, buildTestApp, authHeaders, loginAs,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof import("./helpers.js").buildTestApp>>;
let app: TestApp;
let mentorToken: string;
let studentToken: string;


const jsonHeaders = (token: string) => ({ ...authHeaders(token), "content-type": "application/json" });

describe("M7 — Bulk question import", () => {
  beforeAll(async () => {
    await truncateDb();
    app = await buildTestApp();
    mentorToken = await loginAs("im-mentor@t.id", "Import Mentor", "mentor");
    studentToken = await loginAs("im-student@t.id", "Import Student", "student");
  });

  afterAll(async () => {
    await app.close();
    await getPool().end();
  });

  function importPayload(prefix: string, count = 1, opts: Partial<Record<string, unknown>> = {}) {
    return {
      dryRun: opts.dryRun,
      questions: Array.from({ length: count }, (_, i) => ({
        text: prefix + " Q" + i + " " + Date.now(),
        category: "TPS",
        difficulty: "easy",
        explanation: "Exp",
        tags: ["aljabar"],
        options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }]
      }))
    };
  }

  it("rejects students (no QUESTION_MANAGE)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(studentToken),
      payload: { questions: [] }
    });
    expect(res.statusCode).toBe(403);
  });

  it("imports valid JSON rows with options and tags", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(mentorToken),
      payload: importPayload("imp-json")
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.dryRun).toBe(false);
    expect(data.imported).toBe(1);
    expect(data.failed).toEqual([]);
    // Verify in DB: question + options + tag link
    const row = (await getPool().query("SELECT id, content_hash FROM questions WHERE text LIKE 'imp-json Q0 %'")).rows[0];
    expect(row?.content_hash).toBeTruthy();
    const opts = await getPool().query("SELECT count(*)::int AS c FROM question_options WHERE question_id = $1", [row?.id]);
    expect(opts.rows[0]?.c).toBe(2);
    const tagLink = await getPool().query(
      "SELECT count(*)::int AS c FROM question_tags qt JOIN tags t ON t.id = qt.tag_id WHERE qt.question_id = $1 AND t.name = 'aljabar'",
      [row?.id]
    );
    expect(tagLink.rows[0]?.c).toBe(1);
  });

  it("reports row-level validation failures without aborting good rows", async () => {
    const now = Date.now();
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(mentorToken),
      payload: {
        questions: [
          { text: "good-" + now, category: "TPS", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] },
          { text: "   ", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] }, // missing text
          { text: "few-options-" + now, options: [{ text: "only" }] }, // <2 options
          { text: "no-correct-" + now, options: [{ text: "A", isCorrect: false }, { text: "B", isCorrect: false }] }, // no correct
          { text: "bad-diff-" + now, difficulty: "insane", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] } // bad difficulty
        ]
      }
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.imported).toBe(1);
    expect(data.failed.length).toBe(4);
    const errTexts = data.failed.map((f: { errors: string[] }) => f.errors.join(" | "));
    expect(errTexts.some((e: string) => e.includes("text is required"))).toBe(true);
    expect(errTexts.some((e: string) => e.includes("at least 2 options"))).toBe(true);
    expect(errTexts.some((e: string) => e.includes("correct option"))).toBe(true);
    expect(errTexts.some((e: string) => e.includes("easy|medium|hard"))).toBe(true);
  });

  it("dryRun validates without writing anything", async () => {
    const before = (await getPool().query("SELECT count(*)::int AS c FROM questions")).rows[0]?.c;
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(mentorToken),
      payload: importPayload("imp-dry", 2, { dryRun: true })
    });
    const data = res.json().data;
    expect(data.dryRun).toBe(true);
    expect(data.wouldImport).toBe(2);
    expect(data.imported).toBe(0);
    const after = (await getPool().query("SELECT count(*)::int AS c FROM questions")).rows[0]?.c;
    expect(after).toBe(before);
  });

  it("is idempotent: re-importing the same rows skips duplicates", async () => {
    const payload = importPayload("imp-dup");
    const r1 = await app.inject({ method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(mentorToken), payload });
    expect(r1.json().data.imported).toBe(1);
    const r2 = await app.inject({ method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(mentorToken), payload });
    const d2 = r2.json().data;
    expect(d2.imported).toBe(0);
    expect(d2.skipped.length).toBe(1);
    expect(d2.skipped[0]?.reason).toContain("duplicate");
    const count = (await getPool().query("SELECT count(*)::int AS c FROM questions WHERE text LIKE 'imp-dup Q0 %'")).rows[0]?.c;
    expect(count).toBe(1);
  });

  it("imports a CSV payload with header, quoted commas and multiple correct answers", async () => {
    const text = "Berapa, 5+5?";
    const Q = String.fromCharCode(34); // double quote, keeps CSV source readable
    const csv =
      "text,category,difficulty,tags,option1,option2,option3,option4,correct,explanation\n" +
      Q + text + Q + ",TPS,medium,aljabar;bilangan," + Q + "10, bukan 9" + Q + ",9,11,12," + Q + "1,2" + Q + ",Ibukota?\n" +
      "Tanpa tag,TPS,easy,,A,B,,,2,exp2\n";
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import",
      headers: { ...authHeaders(mentorToken), "content-type": "text/plain" },
      payload: csv
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.imported).toBe(2);
    expect(data.failed).toEqual([]);
    // Quoted field preserved; both correct options marked
    const row = (await getPool().query("SELECT id FROM questions WHERE text = $1", [text])).rows[0];
    expect(row).toBeTruthy();
    const corrects = await getPool().query("SELECT count(*)::int AS c FROM question_options WHERE question_id = $1 AND is_correct = true", [row?.id]);
    expect(corrects.rows[0]?.c).toBe(2);
  });

  it("imports CSV without a header (positional)", async () => {
    const csv = "Positional,PK,easy,geometri,A,B,,,1,pos-exp\n";
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import",
      headers: { ...authHeaders(mentorToken), "content-type": "text/plain" },
      payload: csv
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.imported).toBe(1);
  });

  it("re-imports after a soft delete (partial unique index)", async () => {
    const payload = importPayload("imp-resurrect");
    const r1 = await app.inject({ method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(mentorToken), payload });
    const qid = (await getPool().query("SELECT id FROM questions WHERE text LIKE 'imp-resurrect Q0 %'")).rows[0]?.id;
    expect(r1.json().data.imported).toBe(1);
    // Soft delete it
    await app.inject({ method: "DELETE", url: `/api/v1/questions/${qid}`, headers: authHeaders(mentorToken) });
    // Re-import → should succeed (deleted row no longer blocks the hash)
    const r2 = await app.inject({ method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(mentorToken), payload });
    expect(r2.json().data.imported).toBe(1);
    const count = (await getPool().query("SELECT count(*)::int AS c FROM questions WHERE text LIKE 'imp-resurrect Q0 %' AND deleted_at IS NULL")).rows[0]?.c;
    expect(count).toBe(1);
  });

  it("rejects imports above the row cap", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/questions/import", headers: jsonHeaders(mentorToken),
      payload: { questions: Array.from({ length: 2001 }, (_, i) => ({ text: "bulk-" + i + "-" + Date.now(), options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] })) }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("IMPORT_TOO_LARGE");
  });
});
