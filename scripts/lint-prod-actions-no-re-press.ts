/**
 * Task #1969 — Lint guard for the one-and-done prod-action policy.
 *
 * Every action in `server/services/prodActionsRegistry.ts` must be
 * one-and-done: either finish its entire effect in a single press, or
 * return immediately while a background drain (via
 * `prodActionBackgroundDrain.ts`) completes the rest. The operator
 * must never be the loop.
 *
 * This lint enforces that by failing CI if a new prod-action's
 * description, change, or detail strings instruct the operator to
 * "re-press", "press again", or "press until …". Code comments are
 * exempt — they may legitimately discuss the historical pattern when
 * documenting the conversion.
 *
 * Exit code:
 *   0 — no offenders.
 *   1 — at least one user-facing string contains forbidden language.
 */
import { readFileSync, readdirSync } from "node:fs";

// Scope (Task #2846, extended by F7/Task #4154): actions were registered in
// the single monolithic registry file; F7 split them into domain modules
// under server/services/prodActions/. The scan set is the composition root
// plus every module in that directory — enumerated from disk so a new domain
// module is covered automatically, with no glob and no recursion.
const ROOT_FILE = "server/services/prodActionsRegistry.ts";
const DOMAIN_DIR = "server/services/prodActions";
const FILES: string[] = [
  ROOT_FILE,
  ...readdirSync(DOMAIN_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => `${DOMAIN_DIR}/${f}`),
];
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\bre-?press(?:ing|es|ed)?\b/i, name: "re-press" },
  { pattern: /\bpress again\b/i, name: "press again" },
  { pattern: /\bpress until\b/i, name: "press until" },
  { pattern: /\bkeep(?:s)? pressing\b/i, name: "keep pressing" },
];

interface Violation {
  line: number;
  matched: string;
  text: string;
}

interface FileViolation extends Violation {
  file: string;
}

export function cliMain(): number {
  const violations: FileViolation[] = [];
  for (const file of FILES) {
    for (const v of scanFile(file)) {
      violations.push({ ...v, file });
    }
  }

  if (violations.length > 0) {
    console.error(
      `[lint-prod-actions-no-re-press] ${violations.length} violation(s):`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} matched "${v.matched}" — ${v.text}`);
    }
    console.error(
      "\nProd actions must be one-and-done (Task #1969). Replace per-press" +
        " loops with a background drain via" +
        " `server/services/prodActionBackgroundDrain.ts`, then remove the" +
        ' "re-press" / "press again" / "press until" phrasing from the' +
        " description, change, and detail strings.",
    );
    return 1;
  }

  console.log(
    `[lint-prod-actions-no-re-press] OK — no multi-press language in ${FILES.length} registry file(s).`,
  );
  return 0;
}

function scanFile(file: string): Violation[] {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  const violations: Violation[] = [];

  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let scan = raw;

    // Strip block comments — they're commentary, not operator-facing strings.
    if (inBlockComment) {
      const end = scan.indexOf("*/");
      if (end === -1) continue;
      scan = scan.slice(end + 2);
      inBlockComment = false;
    }
    while (true) {
      const start = scan.indexOf("/*");
      if (start === -1) break;
      const end = scan.indexOf("*/", start + 2);
      if (end === -1) {
        scan = scan.slice(0, start);
        inBlockComment = true;
        break;
      }
      scan = scan.slice(0, start) + scan.slice(end + 2);
    }

    // Strip trailing line comments.
    const trimmed = scan.trimStart();
    if (trimmed.startsWith("//")) continue;
    const lineCommentIdx = scan.indexOf("//");
    if (lineCommentIdx !== -1) {
      // Heuristic: only strip when "//" is preceded by whitespace or start,
      // to avoid clobbering a URL inside a string. Good enough for this
      // registry file.
      const before = scan[lineCommentIdx - 1];
      if (before === undefined || /\s/.test(before)) {
        scan = scan.slice(0, lineCommentIdx);
      }
    }

    for (const { pattern, name } of FORBIDDEN) {
      const m = scan.match(pattern);
      if (m) {
        violations.push({ line: i + 1, matched: m[0], text: raw.trim() });
        // Only record the first match per (line, name) to keep output compact.
        break;
      }
      void name;
    }
  }

  return violations;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-prod-actions-no-re-press.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
