/**
 * Drift guard: lock the heatmap keyword canonical rule to ONE shared
 * definition (Task #2540).
 *
 * Background
 * ----------
 * The canonical-keyword rule — trim leading/trailing whitespace, collapse
 * runs of internal whitespace to a single ASCII space, lowercase — is
 * written in three independent places that have to be kept identical BY
 * HAND:
 *
 *   1. The TypeScript `normalizeKeyword` in `shared/keywordNormalization.ts`
 *      (the application write/read/cleanup/coverage source of truth).
 *   2. The SQL expression `CANONICAL_EXPR` in
 *      `server/services/legacyKeywordSpellingCleanup.ts`
 *      (`lower(regexp_replace(btrim(keyword_name), '\s+', ' ', 'g'))`),
 *      shared by the CLI and the `cleanup_legacy_keyword_spellings`
 *      prod-action.
 *   3. The CHECK constraint
 *      `heatmap_snapshots_keyword_name_canonical_chk` — written twice, once
 *      in `migrations/0061_heatmap_keyword_canonical_check.sql` (the UPDATE
 *      and the ALTER ... ADD CONSTRAINT) and once in the Drizzle model
 *      `shared/models/heatmap.ts`.
 *
 * If anyone edits one and forgets the others, rows silently diverge from
 * the constraint (a write the app considers canonical can fail the CHECK,
 * or a non-canonical row can slip past it). There was no automated check
 * that would catch the divergence at PR time.
 *
 * What this lint asserts
 * ----------------------
 *   A. Every executable SQL occurrence of the canonical expression — in the
 *      cleanup core, in migration 0061, and in the Drizzle model — is
 *      byte-identical after normalizing away the only legitimate
 *      differences (the column reference token and TS template-literal
 *      backslash escaping). They must all equal the single reference
 *      expression below.
 *   B. The TypeScript `normalizeKeyword` still implements exactly the
 *      documented rule (trim + collapse-internal-whitespace + lowercase),
 *      verified behaviorally against a probe battery. If someone changes
 *      the TS rule, the probes fail here and remind them the SQL must move
 *      in lockstep (and vice versa — changing the SQL away from the
 *      reference fails part A).
 *
 * The human-readable description string in `prodActionsRegistry.ts` and the
 * reconstructed expression in `tests/keyword-pill-dedupe.test.ts` are NOT
 * sources of truth and are intentionally out of scope.
 *
 * Exit code:
 *   0 — all three SQL expressions match the reference AND normalizeKeyword
 *       behaves canonically.
 *   1 — drift detected; the message names the offending file/expression.
 *
 * Emergency escape hatch:
 *   Set LINT_KEYWORD_CANONICAL_SKIP=1 to skip the check entirely. Use only
 *   when you are intentionally changing the canonical rule in every place
 *   in the same change and updating this reference accordingly.
 */
import { readFileSync } from "node:fs";

import { normalizeKeyword } from "../shared/keywordNormalization";

/** Column-reference placeholder used when normalizing SQL occurrences. */
const KW = "keyword_name";

/**
 * The single canonical reference expression, in plain SQL form. Every
 * executable occurrence must normalize to exactly this string.
 */
const REFERENCE_SQL = `lower(regexp_replace(btrim(${KW}), '\\s+', ' ', 'g'))`;

/** Files that contain executable canonical SQL expressions. */
// Scope intentionally fixed (Task #2846): this is a lockstep check over a
// known, enumerated set of SQL-bearing files, not a repo-wide scan.
const SQL_SOURCE_FILES = [
  "server/services/legacyKeywordSpellingCleanup.ts",
  "migrations/0061_heatmap_keyword_canonical_check.sql",
  "shared/models/heatmap.ts",
];

/**
 * Matches `lower(regexp_replace(btrim(<col>), '<search>', '<repl>', 'g'))`
 * across TS template literals and raw .sql files. `<col>` may be
 * `keyword_name` or the Drizzle `${table.keywordName}` interpolation.
 */
const CANONICAL_RE =
  /lower\s*\(\s*regexp_replace\s*\(\s*btrim\s*\(\s*[^)]*?\s*\)\s*,\s*'(?:[^'\\]|\\.)*'\s*,\s*'[^']*'\s*,\s*'g'\s*\)\s*\)/g;

/**
 * Normalize an extracted SQL occurrence so the only legitimate differences
 * (column-reference token, TS `\\` escaping, incidental whitespace) collapse
 * away, leaving a form directly comparable to REFERENCE_SQL.
 */
function normalizeSqlExpr(raw: string): string {
  return raw
    .replace(/\$\{[^}]*\}/g, KW) // Drizzle `${table.keywordName}` -> keyword_name
    .replace(/\\\\/g, "\\") // interpret TS template-literal `\\` as a single `\`
    .replace(/\s+/g, " ") // collapse incidental whitespace
    .trim()
    .toLowerCase();
}

const NORMALIZED_REFERENCE = normalizeSqlExpr(REFERENCE_SQL);

/**
 * Behavioral probe battery for `normalizeKeyword`. Each pair is
 * [input, expected canonical output] under the documented rule.
 */
const NORMALIZE_PROBES: ReadonlyArray<readonly [string, string]> = [
  ["Plumber", "plumber"],
  ["  plumber  ", "plumber"],
  ["IMMIGRATION ATTORNEY", "immigration attorney"],
  ["immigration  attorney", "immigration attorney"],
  ["plumber near   me", "plumber near me"],
  ["\tImmigration\tAttorney\t", "immigration attorney"],
  ["car   accident\n\nlawyer", "car accident lawyer"],
  ["already canonical", "already canonical"],
  ["", ""],
];

interface LintResult {
  ok: boolean;
  errors: string[];
  sqlOccurrences: number;
}

export function runLint(): LintResult {
  const errors: string[] = [];
  let sqlOccurrences = 0;

  // --- Part A: every executable SQL expression matches the reference. ---
  for (const file of SQL_SOURCE_FILES) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      errors.push(`could not read ${file}: ${(err as Error).message}`);
      continue;
    }

    const matches = text.match(CANONICAL_RE) ?? [];
    if (matches.length === 0) {
      errors.push(
        `${file}: expected at least one canonical SQL expression ` +
          `(lower(regexp_replace(btrim(...), '\\s+', ' ', 'g'))) but found none — ` +
          `was the expression renamed, reformatted, or removed?`,
      );
      continue;
    }

    for (const occurrence of matches) {
      sqlOccurrences += 1;
      const normalized = normalizeSqlExpr(occurrence);
      if (normalized !== NORMALIZED_REFERENCE) {
        errors.push(
          `${file}: canonical SQL expression drifted from the shared rule.\n` +
            `    found:    ${normalized}\n` +
            `    expected: ${NORMALIZED_REFERENCE}`,
        );
      }
    }
  }

  // --- Part B: normalizeKeyword still implements the canonical rule. ---
  for (const [input, expected] of NORMALIZE_PROBES) {
    const actual = normalizeKeyword(input);
    if (actual !== expected) {
      errors.push(
        `shared/keywordNormalization.ts: normalizeKeyword(${JSON.stringify(
          input,
        )}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(
          expected,
        )} — the TS canonical rule drifted from trim + collapse-whitespace + lowercase.`,
      );
    }
  }
  for (const empty of [null, undefined]) {
    const actual = normalizeKeyword(empty);
    if (actual !== "") {
      errors.push(
        `shared/keywordNormalization.ts: normalizeKeyword(${String(
          empty,
        )}) returned ${JSON.stringify(actual)}, expected "".`,
      );
    }
  }

  return { ok: errors.length === 0, errors, sqlOccurrences };
}

export function cliMain(): number {
  if (process.env.LINT_KEYWORD_CANONICAL_SKIP === "1") {
    console.log(
      "lint-keyword-canonical-lockstep: SKIPPED (LINT_KEYWORD_CANONICAL_SKIP=1)",
    );
    return 0;
  }

  const result = runLint();

  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-keyword-canonical-lockstep: the heatmap keyword canonical rule has drifted",
    );
    console.error("");
    console.error(
      "  The canonical rule (trim, collapse internal whitespace, lowercase) must be",
    );
    console.error(
      "  identical in normalizeKeyword (shared/keywordNormalization.ts), the cleanup",
    );
    console.error(
      "  core's SQL (server/services/legacyKeywordSpellingCleanup.ts), and the CHECK",
    );
    console.error(
      "  constraint (migrations/0061 + shared/models/heatmap.ts). One drifted:",
    );
    console.error("");
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
    console.error("");
    console.error(
      "  Fix every place in lockstep (and update REFERENCE_SQL / the probes in this",
    );
    console.error(
      "  lint if you are intentionally changing the canonical rule). Emergency",
    );
    console.error("  override: LINT_KEYWORD_CANONICAL_SKIP=1.");
    console.error("");
    return 1;
  }

  console.log(
    `lint-keyword-canonical-lockstep: OK (${result.sqlOccurrences} SQL occurrences across ${SQL_SOURCE_FILES.length} files match the reference, ${NORMALIZE_PROBES.length + 2} normalizeKeyword probes pass)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-keyword-canonical-lockstep.ts") ?? false);

if (isMain) {
  process.exit(cliMain());
}
