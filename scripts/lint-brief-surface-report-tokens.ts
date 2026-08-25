/**
 * Brief-surface report-token guard.
 *
 * Background
 * ----------
 * The NoBull Brief (CeoPulseVisual, CeoPulseLetter, PublicCeoPulse) uses its
 * own dedicated `brief-*` token palette (#8B2E31 crimson, #C4A35A gold, etc.)
 * which is visually distinct from the `report-*` palette (#8A292F, #D5AC5C).
 * A 2026-08-17 hex→token sweep accidentally substituted `report-crimson`,
 * `report-gold`, and `report-ink*` tokens into the brief-surface files, and
 * no automated check caught it.
 *
 * What this lint asserts
 * ----------------------
 *   The three declared brief-surface files must NOT use Tailwind utility
 *   classes with the `report-*` token family for text, background, or border
 *   color (i.e. any class matching `text-report-*`, `bg-report-*`, or
 *   `border-report-*`).
 *
 * Suppress marker
 * ---------------
 *   Add the following comment on the line immediately BEFORE the line that
 *   carries the class to allow a deliberate use (e.g. a fixed paper-background
 *   token that is not a brand color):
 *
 *     // lint-brief-surface-report-tokens: suppress -- reason
 *
 *   Use a JavaScript `//` line comment — NOT a JSX expression comment
 *   (JSX expression comments break the single-root-return constraint in JSX files).
 *
 * Exit codes
 *   0 — all brief-surface files are free of unsuppressed `report-*` color
 *       tokens.
 *   1 — at least one violation found; offending file/line/class printed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Declared brief-surface files — the scope of this guard. */
export const BRIEF_SURFACE_FILES: readonly string[] = [
  "client/src/components/CeoPulseVisual.tsx",
  "client/src/pages/CeoPulseLetter.tsx",
  "client/src/pages/PublicCeoPulse.tsx",
];

/**
 * Tailwind utility prefixes that must not appear with a `report-*` token on
 * the brief surface.
 */
const FLAGGED_PREFIXES = ["text-report-", "bg-report-", "border-report-"];

/** Sentinel string that suppresses a single following line. */
const SUPPRESS_MARKER = "lint-brief-surface-report-tokens: suppress";

export interface Violation {
  file: string;
  line: number; // 1-based
  classes: string[];
}

export interface LintResult {
  ok: boolean;
  violations: Violation[];
  filesScanned: number;
}

/**
 * Run the lint against the declared set of brief-surface files.
 *
 * `overrideFiles` is used by guard tests to substitute fixture paths.
 */
export function runLint(
  overrideFiles?: readonly string[],
): LintResult {
  // When overrideFiles is provided (guard tests) each entry is an absolute
  // path to a fixture file.  When absent, resolve the declared brief-surface
  // paths from the workspace root.
  const files: readonly string[] = overrideFiles
    ? overrideFiles
    : BRIEF_SURFACE_FILES.map((rel) => resolve(ROOT, rel));

  const violations: Violation[] = [];
  let filesScanned = 0;

  for (const filePath of files) {
    let src: string;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      // File does not exist — treat as a missing brief-surface file and warn.
      violations.push({ file: filePath, line: 0, classes: ["<FILE NOT FOUND>"] });
      continue;
    }
    filesScanned++;

    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Only a JS `//` line comment on the IMMEDIATELY PRECEDING line may
      // suppress a violation. JSX `{/* */}` expression comments are NOT
      // accepted — they are invalid at single-root return positions and
      // would break TSX compilation if placed there. A standalone `//`
      // suppress line itself has no report-* classes, so it produces no
      // violation naturally.
      const prevLine = i > 0 ? lines[i - 1] : "";
      const prevTrimmed = prevLine.trimStart();
      if (
        prevTrimmed.startsWith("//") &&
        prevLine.includes(SUPPRESS_MARKER)
      ) {
        continue;
      }

      // Collect every flagged class token on this line.
      const flagged: string[] = [];
      for (const prefix of FLAGGED_PREFIXES) {
        // Match `prefix` (possibly with a Tailwind variant modifier such as
        // "hover:", "md:", "dark:" before it, and/or Tailwind's important
        // modifier `!` immediately before the prefix) followed by a
        // non-whitespace run, bounded by a class-boundary character (space,
        // ", ', `, {, :, or start-of-content). The `:` boundary captures
        // `hover:text-report-*` and `hover:!text-report-*` where the prefix
        // is directly preceded by the variant colon.
        const escapedPrefix = prefix.replace(/-/g, "\\-");
        const re = new RegExp(
          `(?:^|[\\s"'\`{:])(?:[a-zA-Z0-9_-]+:)*!?${escapedPrefix}[^\\s"'\`{}]+`,
          "g",
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          // Strip leading boundary character(s) — space, quote, backtick, {, :.
          const cls = m[0].trimStart().replace(/^[\s"'`{:]+/, "").trim();
          flagged.push(cls);
        }
      }

      if (flagged.length > 0) {
        violations.push({ file: filePath, line: i + 1, classes: flagged });
      }
    }
  }

  return { ok: violations.length === 0, violations, filesScanned };
}

export function cliMain(): number {
  const result = runLint();

  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-brief-surface-report-tokens: report-* color token(s) found on brief-surface files",
    );
    console.error("");
    console.error(
      "  The NoBull Brief uses `brief-*` tokens (#8B2E31 crimson, #C4A35A gold).",
    );
    console.error(
      "  The `report-*` palette is distinct (#8A292F, #D5AC5C) — substituting it",
    );
    console.error(
      "  silently recolors the brief surface. Replace with the matching `brief-*` token.",
    );
    console.error("");
    console.error("  Violations:");
    for (const v of result.violations) {
      const loc = v.line > 0 ? `:${v.line}` : "";
      console.error(`    ${v.file}${loc} — ${v.classes.join(", ")}`);
    }
    console.error("");
    console.error(
      "  If a report-* token is DELIBERATELY used (e.g. report-paper-bright for",
    );
    console.error(
      "  the pinned light paper background), add a JS line comment suppress",
    );
    console.error("  marker on the line IMMEDIATELY BEFORE the violation:");
    console.error(
      "    // lint-brief-surface-report-tokens: suppress -- reason",
    );
    console.error(
      "  (Use a JS `//` comment, NOT a JSX `{/* */}` expression — JSX",
    );
    console.error(
      "  comments as siblings break the single-root-return constraint.)",
    );
    console.error("");
    return 1;
  }

  console.log(
    `lint-brief-surface-report-tokens: OK (${result.filesScanned} brief-surface file(s) scanned, 0 violations)`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-brief-surface-report-tokens.ts");

if (isMain) {
  process.exit(cliMain());
}
