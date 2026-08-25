/**
 * Drift guard: no decimal-capable report-editor field may parse its input
 * with parseInt (Task #2757).
 *
 * Background
 * ----------
 * Two separate bug reports (Ad Spend, then Avg Time to Human Answer) came from
 * the same bug class: a controlled number input in the report editor parsed
 * the typed value with `parseInt(e.target.value)`, silently stripping decimals
 * as the user typed. Both were fixed by switching to the shared `safeNumber()`
 * helper in ReportForm.tsx, but nothing prevented a future field from
 * reintroducing the pattern on another decimal-capable field.
 *
 * What this lint asserts
 * ----------------------
 * In every scanned report-editor file, any assignment of the form
 * `<fieldName>: parseInt(...)` (or `Number.parseInt`) where <fieldName> is
 * decimal-capable is flagged. Decimal capability is inferred from the field
 * name's camelCase segments: names containing a money / rate / time / average
 * token (spend, rate, value, cost, price, amount, revenue, density, avg,
 * average, time, seconds, minutes, hours, duration, age, percent, ratio, roi,
 * roas, cpl, cpc, cpa, ...) are decimal-capable. This mirrors the schema:
 * `avgTimeToAnswer` / `missedCallRate` are `real` columns in
 * shared/models/reports.ts, and the jsonb dollar fields (adSpend,
 * averageCaseValue) carry cents.
 *
 * Integer-count fields (uniqueLeads, registrants, totalReviews, monthlyTarget,
 * leadQuality buckets, etc.) contain none of these tokens and remain free to
 * use parseInt.
 *
 * Task #2762 extension: the same bug class can also route through the shared
 * safeNumber() helper via `allowDecimal: false`, which floors the value as the
 * user types. Any assignment `<fieldName>: safeNumber(..., { ...allowDecimal:
 * false... })` on a decimal-capable field is flagged too (averageCaseValue and
 * noShowRate were fixed this way — dollar amounts carry cents, and no-show
 * rates like 12.5% are meaningful).
 *
 * If a genuinely-integer field name happens to contain a decimal token, add it
 * to INTEGER_FIELD_EXCEPTIONS with a comment explaining why it is an integer.
 *
 * Exit code: 0 — clean; 1 — a decimal-capable field uses parseInt or
 * safeNumber with allowDecimal: false.
 *
 * Emergency escape hatch: LINT_REPORT_DECIMAL_PARSEINT_SKIP=1.
 */
import { readFileSync, existsSync } from "node:fs";

/** Report-editor files whose numeric onChange handlers are guarded. */
// Scope intentionally fixed (Task #2846): this guard targets specific
// report-editor files by design; a missing target fails loudly (see below).
const TARGET_FILES = ["client/src/pages/ReportForm.tsx"];

/**
 * camelCase segments that mark a field as decimal-capable. Matched against
 * whole segments (so "messages" does NOT match "age", "score" is not here —
 * scores in this editor are integers).
 */
const DECIMAL_TOKENS = new Set([
  "spend",
  "rate",
  "value",
  "cost",
  "price",
  "amount",
  "revenue",
  "dollars",
  "density",
  "avg",
  "average",
  "mean",
  "time",
  "seconds",
  "secs",
  "minutes",
  "hours",
  "duration",
  "age",
  "pct",
  "percent",
  "percentage",
  "ratio",
  "roi",
  "roas",
  "cpl",
  "cpc",
  "cpa",
]);

/**
 * Field names that contain a decimal token but are deliberately integers.
 * Each entry must carry a comment explaining why parseInt is correct for it.
 * (Currently empty — every token-matching field in the editor is decimal.)
 */
const INTEGER_FIELD_EXCEPTIONS: ReadonlySet<string> = new Set([]);

/** `<field>: parseInt(` / `<field>: Number.parseInt(` assignments. */
const ASSIGNMENT_RE =
  /([A-Za-z_$][\w$]*)\s*:\s*(?:Number\s*\.\s*)?parseInt\s*\(/g;

/**
 * `<field>: safeNumber(..., { ...allowDecimal: false... })` assignments —
 * the safeNumber-routed variant of the same decimal-stripping bug (Task #2762).
 * Single-line match: these onChange handlers are written on one line.
 */
const SAFE_NUMBER_NO_DECIMAL_RE =
  /([A-Za-z_$][\w$]*)\s*:\s*safeNumber\s*\([^)]*allowDecimal\s*:\s*false/g;

/** Split a camelCase / snake_case identifier into lowercase segments. */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$-]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

export function isDecimalCapableFieldName(name: string): boolean {
  if (INTEGER_FIELD_EXCEPTIONS.has(name)) return false;
  return splitIdentifier(name).some((seg) => DECIMAL_TOKENS.has(seg));
}

interface Violation {
  file: string;
  line: number;
  field: string;
  kind: "parseInt" | "allowDecimalFalse";
}

interface LintResult {
  ok: boolean;
  errors: string[];
  violations: Violation[];
  filesScanned: number;
  parseIntAssignments: number;
}

export interface LintOptions {
  /** Files to scan (defaults to TARGET_FILES). For fixture testing. */
  targetFiles?: string[];
}

export function runLint(opts: LintOptions = {}): LintResult {
  const targetFiles = opts.targetFiles ?? TARGET_FILES;
  const errors: string[] = [];
  const violations: Violation[] = [];
  let filesScanned = 0;
  let parseIntAssignments = 0;

  for (const file of targetFiles) {
    if (!existsSync(file)) {
      errors.push(
        `${file}: guarded report-editor file not found — if it moved, update TARGET_FILES in this lint.`,
      );
      continue;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      errors.push(`could not read ${file}: ${(err as Error).message}`);
      continue;
    }
    filesScanned += 1;

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      ASSIGNMENT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ASSIGNMENT_RE.exec(lines[i])) !== null) {
        parseIntAssignments += 1;
        const field = m[1];
        if (isDecimalCapableFieldName(field)) {
          violations.push({ file, line: i + 1, field, kind: "parseInt" });
        }
      }
      SAFE_NUMBER_NO_DECIMAL_RE.lastIndex = 0;
      while ((m = SAFE_NUMBER_NO_DECIMAL_RE.exec(lines[i])) !== null) {
        const field = m[1];
        if (isDecimalCapableFieldName(field)) {
          violations.push({ file, line: i + 1, field, kind: "allowDecimalFalse" });
        }
      }
    }
  }

  for (const v of violations) {
    if (v.kind === "parseInt") {
      errors.push(
        `${v.file}:${v.line}: decimal-capable field "${v.field}" is parsed with parseInt — ` +
          `this silently strips decimals as the user types (the Ad Spend / Avg Time to Human ` +
          `Answer bug class). Use the shared safeNumber(e.target.value) helper instead. If ` +
          `"${v.field}" is genuinely an integer count, add it to INTEGER_FIELD_EXCEPTIONS in ` +
          `scripts/lint-report-editor-decimal-parseint.ts with a justifying comment.`,
      );
    } else {
      errors.push(
        `${v.file}:${v.line}: decimal-capable field "${v.field}" uses safeNumber with ` +
          `allowDecimal: false — this floors the value as the user types (the same bug class ` +
          `as parseInt, routed through the shared helper; the averageCaseValue / noShowRate ` +
          `case). Drop allowDecimal: false, or if "${v.field}" is genuinely an integer count, ` +
          `add it to INTEGER_FIELD_EXCEPTIONS in scripts/lint-report-editor-decimal-parseint.ts ` +
          `with a justifying comment.`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    violations,
    filesScanned,
    parseIntAssignments,
  };
}

function main(): void {
  if (process.env.LINT_REPORT_DECIMAL_PARSEINT_SKIP === "1") {
    console.log(
      "lint-report-editor-decimal-parseint: SKIPPED (LINT_REPORT_DECIMAL_PARSEINT_SKIP=1)",
    );
    process.exit(0);
  }

  const result = runLint();

  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-report-editor-decimal-parseint: a decimal-capable report-editor field uses parseInt or safeNumber with allowDecimal: false",
    );
    console.error("");
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
    console.error("");
    console.error(
      "  Emergency override (with a fix landing in the same change): LINT_REPORT_DECIMAL_PARSEINT_SKIP=1.",
    );
    console.error("");
    process.exit(1);
  }

  console.log(
    `lint-report-editor-decimal-parseint: OK (${result.filesScanned} file(s) scanned, ` +
      `${result.parseIntAssignments} parseInt assignment(s) checked — all on integer-count fields)`,
  );
  process.exit(0);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-report-editor-decimal-parseint.ts");

if (isMain) {
  main();
}
