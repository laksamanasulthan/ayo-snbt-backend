/**
 * Tiny zero-dependency CSV parser (RFC-4180-ish) for bulk question import.
 * Handles: quoted fields, escaped quotes (""), commas inside quotes,
 * CRLF/LF line endings. Returns rows as arrays of strings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const input = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // Last field/row without trailing newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Import row shape shared with the service (JSON import and CSV import).
 */
export interface ImportQuestionRow {
  text: string;
  category?: string;
  difficulty?: string;
  tags?: string[];
  options: { text: string; isCorrect: boolean }[];
  explanation?: string;
  /** A10: provenance { origin, year? } + review workflow status */
  source?: { origin: string; year?: number } | null;
  reviewStatus?: string | null;
}

export const CSV_COLUMNS = [
  "text", "category", "difficulty", "tags", "option1", "option2", "option3", "option4", "correct", "explanation", "source_origin", "source_year", "review_status"
] as const;

/**
 * Map parsed CSV rows to ImportQuestionRow[].
 * - First row is a header; it may be any of the CSV_COLUMNS names (order
 *   flexible). If the first row does not look like a header, it is treated
 *   as data in the canonical column order.
 * - options: option1..option4 (at least 2 must be filled; validated later)
 * - correct: 1-based, comma-separated ("1" or "1,3")
 * - tags: semicolon-separated
 */
export function csvToImportRows(rows: string[][]): ImportQuestionRow[] {
  if (rows.length === 0) return [];
  const first = (rows[0] as string[]).map((c) => c.trim().toLowerCase());
  const isHeader = first.some((c) => c === "text");
  const dataRows = isHeader ? rows.slice(1) : rows;
  const colIndex = (name: string): number => {
    if (!isHeader) return CSV_COLUMNS.indexOf(name as (typeof CSV_COLUMNS)[number]);
    return first.indexOf(name);
  };
  const out: ImportQuestionRow[] = [];
  for (const raw of dataRows) {
    const at = (name: string): string => {
      const i = colIndex(name);
      return i >= 0 ? (raw[i] ?? "").trim() : "";
    };
    const options: { text: string; isCorrect: boolean }[] = [];
    for (let n = 1; n <= 4; n++) {
      const optText = at("option" + n);
      if (optText) options.push({ text: optText, isCorrect: false });
    }
    const correctSpec = at("correct");
    const correctSet = new Set(correctSpec.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 1));
    options.forEach((o, i) => { o.isCorrect = correctSet.has(i + 1); });
    const tags = at("tags").split(";").map((t) => t.trim()).filter(Boolean);
    // A10: provenance + review status from optional columns
    const sourceOrigin = at("source_origin");
    const sourceYearRaw = at("source_year");
    const sourceYear = sourceYearRaw ? parseInt(sourceYearRaw, 10) : undefined;
    const reviewStatus = at("review_status");
    out.push({
      text: at("text"),
      category: at("category") || undefined,
      difficulty: at("difficulty") || undefined,
      tags: tags.length > 0 ? tags : undefined,
      options,
      explanation: at("explanation") || undefined,
      source: sourceOrigin ? { origin: sourceOrigin, ...(sourceYear ? { year: sourceYear } : {}) } : null,
      reviewStatus: reviewStatus || null
    });
  }
  return out;
}
