/**
 * Task #2812 — Guard against leftover merge-conflict markers silently
 * disabling the whole test gate.
 *
 * Background: during Task #2804, tests/run-all.ts contained a stray
 * `>>>>>>> ed353e1 (...)` merge-conflict marker left behind by an upstream
 * merge. It crashed the entire validation run at PARSE
 * time — so NO smoke tests ran at all — and nothing flagged the cause
 * besides the workflow's own stack trace. The same failure mode can recur
 * on any future merge, in any source file.
 *
 * Scope (Task #2835): the default scan sources its file list from
 * `git ls-files` — every tracked file is in scope regardless of extension
 * or name — minus a small binary/asset DENYLIST (images, fonts, archives,
 * media, office docs, attached_assets/). Earlier revisions (#2812/#2815/
 * #2825) used directory walks plus hand-maintained extension and
 * special-filename ALLOW-lists, which meant any new extension or
 * extension-less tracked file (a Dockerfile, a new .toml, a shell script
 * without .sh) silently fell outside the scan.
 *
 * Flagged marker lines:
 *
 *   - `<<<<<<< ` at the start of a line (conflict start)
 *   - `>>>>>>> ` at the start of a line (conflict end — flagged even when
 *     stray/unpaired, which is exactly the Task #2804 case)
 *   - `|||||||` at the start of a line (diff3 base marker)
 *   - `=======` alone on a line, but ONLY between an unclosed `<<<<<<<`
 *     and its `>>>>>>>` — a standalone `=======` (a common comment
 *     underline) is NOT flagged.
 *
 * False-positive controls:
 *   - Markers must be at column 0 (git writes them there); indented
 *     marker-like strings in heredocs / test fixtures are ignored.
 *   - Files whose basename contains "lint-merge-conflict-markers" (this
 *     script + its test, which construct marker strings for fixtures) are
 *     skipped.
 *   - A file containing the pragma string
 *     `conflict-marker-` + `fixture-ok` (written split here so this file
 *     doesn't self-allow by accident elsewhere) is skipped entirely —
 *     use it for fixtures that legitimately contain column-0 markers.
 *   - `runLint` accepts an `allowFiles` list for path-level exemptions.
 *   - Files whose content contains a NUL byte are treated as binary and
 *     skipped (belt-and-suspenders for binaries the denylist misses).
 *
 * Fixture testing: `runLint` keeps its `roots` / `rootFileDirs` options —
 * when either is provided, files come from walking those directories
 * (recursive / non-recursive respectively) instead of `git ls-files`, with
 * the SAME denylist applied. An explicit `files` list is also accepted.
 *
 * Gating: the `.replit` `Validate` workflow runs `npm run gate`, including
 * this lint through scripts/gate.ts LINT_CHECKS. It is also enforced by
 * tests/lint-merge-conflict-markers.test.ts, whose FIRST assertion runs
 * runLint() against the real tree and which is registered in SMOKE_FILES
 * (see .agents/memory/lint-workflow-limit-smoke-gate.md).
 *
 * Exit codes (CLI mode):
 *   0 — no conflict markers found.
 *   1 — at least one offender (file + line printed).
 */

import { readFileSync } from "node:fs";
import {
  BINARY_EXTENSIONS,
  SKIP_PATH_SEGMENTS,
  collectTopLevelFiles,
  isScannablePath as isScannableTrackedPath,
  listTrackedFiles,
  walkDir,
} from "./lintFileDiscovery";

// The denylist + git-ls-files discovery now lives in the shared module
// scripts/lintFileDiscovery.ts (Task #2846) so every repo-wide lint uses
// the same model. Re-exported here for this lint's test + back-compat.
export { BINARY_EXTENSIONS, SKIP_PATH_SEGMENTS, listTrackedFiles };

const SELF = "lint-merge-conflict-markers";

// Opt-out pragma for fixture files that legitimately contain column-0
// markers. Written split so this file's own mention doesn't count as the
// pragma appearing in scanned copies of this comment block elsewhere.
const FIXTURE_PRAGMA = "conflict-marker-" + "fixture-ok";

const START_RX = /^<{7}(?: |$)/;
const END_RX = /^>{7}(?: |$)/;
const BASE_RX = /^\|{7}(?: |$)/;
const SEPARATOR_RX = /^={7}$/;

export interface Offender {
  file: string;
  line: number;
  text: string;
  kind: "start" | "separator" | "base" | "end";
}

export interface LintResult {
  ok: boolean;
  offenders: Offender[];
  scannedFiles: number;
}

// Scannability predicate for BOTH the git-ls-files default mode and the
// fixture directory-walk mode: the shared denylist (path segments + binary
// extensions) plus this lint's own files (script + test construct marker
// strings for fixtures).
export function isScannablePath(file: string): boolean {
  const segments = file.split("/");
  const base = segments[segments.length - 1];
  if (base.includes(SELF)) return false;
  return isScannableTrackedPath(file);
}

export function scanFileText(file: string, text: string): Offender[] {
  if (text.includes(FIXTURE_PRAGMA)) return [];
  const offenders: Offender[] = [];
  const lines = text.split("\n");
  // `=======` is only a conflict separator when we are inside an unclosed
  // `<<<<<<<` block; a standalone one is a common comment underline.
  let insideConflict = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (START_RX.test(line)) {
      offenders.push({ file, line: i + 1, text: line.trim(), kind: "start" });
      insideConflict = true;
    } else if (END_RX.test(line)) {
      offenders.push({ file, line: i + 1, text: line.trim(), kind: "end" });
      insideConflict = false;
    } else if (BASE_RX.test(line)) {
      offenders.push({ file, line: i + 1, text: line.trim(), kind: "base" });
    } else if (insideConflict && SEPARATOR_RX.test(line)) {
      offenders.push({
        file,
        line: i + 1,
        text: line.trim(),
        kind: "separator",
      });
    }
  }
  return offenders;
}

export function runLint(options?: {
  /** Fixture mode: recursively walk these directories instead of git ls-files. */
  roots?: string[];
  /** Fixture mode: scan the immediate (non-recursive) files of these dirs. */
  rootFileDirs?: string[];
  /** Explicit file list (bypasses discovery; denylist still applies). */
  files?: string[];
  /** Path-level exemptions. */
  allowFiles?: string[];
}): LintResult {
  const allow = new Set(options?.allowFiles ?? []);
  const files: string[] = [];

  if (options?.files) {
    for (const f of options.files) {
      if (isScannablePath(f)) files.push(f);
    }
  } else if (options?.roots || options?.rootFileDirs) {
    for (const root of options.roots ?? []) {
      walkDir(root, files, isScannablePath);
    }
    for (const dir of options.rootFileDirs ?? []) {
      collectTopLevelFiles(dir, files, isScannablePath);
    }
  } else {
    for (const f of listTrackedFiles()) {
      if (isScannablePath(f)) files.push(f);
    }
  }

  const offenders: Offender[] = [];
  let scannedFiles = 0;
  for (const file of files) {
    if (allow.has(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Binary sniff: NUL byte means this isn't text we can meaningfully
    // scan (covers binaries the extension denylist doesn't list).
    if (text.includes("\0")) continue;
    scannedFiles++;
    offenders.push(...scanFileText(file, text));
  }

  return { ok: offenders.length === 0, offenders, scannedFiles };
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith(`${SELF}.ts`);

if (isMain) {
  const result = runLint();
  if (result.ok) {
    console.log(
      `[${SELF}] OK — scanned ${result.scannedFiles} files, no merge-conflict markers found.`,
    );
    process.exit(0);
  }
  console.error(
    `[${SELF}] FAILED — ${result.offenders.length} merge-conflict marker line(s) found:`,
  );
  for (const o of result.offenders) {
    console.error(`  ${o.file}:${o.line}  (${o.kind})`);
    console.error(`    > ${o.text}`);
  }
  console.error(
    "\nThese are leftover git merge-conflict markers. Resolve the conflict",
  );
  console.error(
    "and delete the marker lines — one of these crashed the entire test",
  );
  console.error("gate at parse time in Task #2804.");
  process.exit(1);
}
