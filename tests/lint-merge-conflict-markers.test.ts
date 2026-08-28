/* test-registration
{
  "name": "lint-merge-conflict-markers guard (Task #2812)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2812: leftover merge-conflict markers guard. A stray conflict-end (seven `>`) line left in THIS file by an upstream merge once crashed the whole test gate at parse time (Task #2804) — so no smoke tests ran and nothing flagged it. The managed Long validation workflow runs the reviewed routine-gate profile, including the lint through gate.ts LINT_CHECKS and this real-tree SMOKE_FILES assertion. Fast, DB-free, deterministic (filesystem scan + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Task #2812 — Guard test for scripts/lint-merge-conflict-markers.ts.
 *
 * Background: a stray conflict-end marker line (seven `>` then `ed353e1 (...)`) left in
 * tests/run-all.ts by an upstream merge crashed the entire validation run at
 * parse time — so NO smoke tests ran at all (Task #2804). The `.replit`
 * managed Long validation workflow runs the reviewed routine-gate profile; this SMOKE_FILES-gated test's
 * FIRST assertion also runs the lint against the real tree.
 *
 * Proves:
 *   1. The real source tree passes (no leftover conflict markers), and the
 *      default scan is sourced from `git ls-files` (Task #2835): tracked
 *      files with extensions the old allow-list never knew about — and
 *      extension-less tracked files — are in scope.
 *   2. A full conflict block (begin / separator / end marker lines) is flagged with
 *      file + line for each marker line.
 *   3. A stray, unpaired conflict-end `<sha> (...)` line — the exact Task #2804
 *      case — is flagged on its own.
 *   4. A standalone seven-equals underline (comment rule, no surrounding markers)
 *      is NOT flagged.
 *   5. Indented marker-like strings (heredoc/fixture content, not column 0)
 *      are NOT flagged.
 *   6. A file carrying the fixture pragma is skipped entirely.
 *   7. An allow-listed file path is skipped.
 *   8. A diff3 base marker (|||||||) is flagged.
 *   9. Root-file fixture scans stay non-recursive, while recursive roots
 *      catch nested files (migrations-style coverage).
 *  10. (Task #2835) Unknown-extension and extension-less files are in
 *      scope by default (denylist model): a marker in a Dockerfile-like
 *      file, a .toml, and special root files (.replit, .gitignore,
 *      replit.nix) are all flagged; binary/asset extensions and
 *      attached_assets/ paths are excluded.
 *
 * Marker strings in fixtures are built via .repeat() so this test file never
 * contains a literal column-0 marker itself.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BINARY_EXTENSIONS,
  isScannablePath,
  listTrackedFiles,
  runLint,
} from "../scripts/lint-merge-conflict-markers";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const LT7 = "<".repeat(7);
const GT7 = ">".repeat(7);
const EQ7 = "=".repeat(7);
const PIPE7 = "|".repeat(7);

function fixtureRoot(files: Record<string, string>): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lint-conflict-markers-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 1. Real source tree passes, and the default scope is git-ls-files-based.
{
  const res = runLint();
  if (!res.ok) {
    for (const o of res.offenders) {
      console.error(`    ${o.file}:${o.line} (${o.kind}) > ${o.text}`);
    }
  }
  assert(res.ok, "real source tree has no merge-conflict markers");
  assert(
    res.scannedFiles > 500,
    `scanned a substantial tree (${res.scannedFiles} files)`,
  );

  // Task #2835 — the default file list comes from git ls-files, so a
  // tracked file with an extension the old allow-list never contained is
  // in scope. Find one dynamically (the old SCAN_EXTENSIONS set, frozen
  // here as the legacy baseline).
  const LEGACY_ALLOWED = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".css",
    ".html",
    ".sql",
    ".sh",
    ".md",
    ".txt",
    ".yml",
    ".yaml",
  ]);
  const tracked = listTrackedFiles();
  const unknownExtTracked = tracked.find((f) => {
    if (!isScannablePath(f)) return false;
    const base = f.split("/").pop()!;
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
    return ext !== "" && !LEGACY_ALLOWED.has(ext);
  });
  assert(
    unknownExtTracked !== undefined,
    `a tracked unknown-extension file exists to prove scope (${unknownExtTracked ?? "none"})`,
  );
  if (unknownExtTracked) {
    const without = runLint({ allowFiles: [unknownExtTracked] });
    assert(
      res.scannedFiles === without.scannedFiles + 1,
      `tracked unknown-extension file is scanned by default (${unknownExtTracked})`,
    );
  }

  // Extension-less tracked files are in scope too (.gitignore is a
  // dotfile → treated as extension-less). (.gitattributes was the previous
  // fixture; it was removed with its only LFS rule in the Task #3790 cleanup.)
  assert(
    tracked.includes(".gitignore") &&
      runLint({ allowFiles: [".gitignore"] }).scannedFiles ===
        res.scannedFiles - 1,
    "extension-less tracked root file (.gitignore) is scanned by default",
  );

  // The real repo root's .replit is reachable by the default scan:
  // allow-listing it must strictly shrink the default scanned-file count.
  const withoutDotReplit = runLint({ allowFiles: [".replit"] });
  assert(
    res.scannedFiles === withoutDotReplit.scannedFiles + 1,
    `real .replit is scanned by default (${res.scannedFiles} vs ${withoutDotReplit.scannedFiles} when allow-listed)`,
  );

  // Denylist sanity: binary/asset paths and attached_assets/ are excluded.
  assert(
    !isScannablePath("attached_assets/whatever.txt"),
    "attached_assets/ paths are excluded",
  );
  assert(!isScannablePath("logo.png"), "binary extensions are excluded");
  assert(
    BINARY_EXTENSIONS.has(".png") && BINARY_EXTENSIONS.has(".pdf"),
    "denylist covers common binary formats",
  );
  assert(
    isScannablePath("Dockerfile") &&
      isScannablePath("config.toml") &&
      isScannablePath("scripts/deploy"),
    "unknown-extension and extension-less paths are scannable",
  );
}

// 2. A full conflict block is flagged, with file + line per marker.
{
  const { root, cleanup } = fixtureRoot({
    "conflicted.ts": [
      "const a = 1;",
      `${LT7} HEAD`,
      "const b = 2;",
      EQ7,
      "const b = 3;",
      `${GT7} ed353e1 (upstream change)`,
      "export {};",
    ].join("\n"),
  });
  try {
    const res = runLint({ roots: [root] });
    assert(!res.ok, "full conflict block trips the lint");
    assert(res.offenders.length === 3, "all three marker lines are flagged");
    const kinds = res.offenders.map((o) => o.kind).sort();
    assert(
      kinds.join(",") === "end,separator,start",
      "start, separator, and end markers each reported",
    );
    assert(
      res.offenders.every((o) => o.file.endsWith("conflicted.ts") && o.line > 0),
      "offenders carry file + line",
    );
    const sep = res.offenders.find((o) => o.kind === "separator");
    assert(sep?.line === 4, "separator flagged at its exact line");
  } finally {
    cleanup();
  }
}

// 3. The exact Task #2804 case: a stray unpaired conflict-end "sha (...)" line.
{
  const { root, cleanup } = fixtureRoot({
    "run-all-like.ts": [
      "const SMOKE = new Set<string>([",
      '  "tests/foo.test.ts",',
      "]);",
      `${GT7} ed353e1 (Task #2801: cover the booking panel)`,
      "export {};",
    ].join("\n"),
  });
  try {
    const res = runLint({ roots: [root] });
    assert(!res.ok, "stray unpaired end marker (the #2804 case) trips the lint");
    assert(
      res.offenders.length === 1 && res.offenders[0].kind === "end",
      "reported as a lone end marker",
    );
    assert(res.offenders[0].line === 4, "stray marker flagged at its exact line");
  } finally {
    cleanup();
  }
}

// 4. Standalone seven-equals underline (comment rule) is NOT flagged.
{
  const { root, cleanup } = fixtureRoot({
    "clean.ts": [
      "// Section header",
      "// " + EQ7,
      EQ7,
      "const x = 1;",
      "export {};",
    ].join("\n"),
  });
  try {
    const res = runLint({ roots: [root] });
    assert(res.ok, "standalone equals-underline (no surrounding markers) passes");
  } finally {
    cleanup();
  }
}

// 5. Indented marker-like strings (fixture/heredoc content) are NOT flagged.
{
  const { root, cleanup } = fixtureRoot({
    "indented.ts": [
      "const fixture = `",
      `  ${LT7} HEAD`,
      `  ${EQ7}`,
      `  ${GT7} abc1234`,
      "`;",
      "export {};",
    ].join("\n"),
  });
  try {
    const res = runLint({ roots: [root] });
    assert(res.ok, "indented (non-column-0) marker-like strings pass");
  } finally {
    cleanup();
  }
}

// 6. A file carrying the fixture pragma is skipped entirely.
{
  const pragma = "conflict-marker-" + "fixture-ok";
  const { root, cleanup } = fixtureRoot({
    "pragma-fixture.ts": [
      `// ${pragma}: this fixture intentionally contains column-0 markers`,
      `${LT7} HEAD`,
      EQ7,
      `${GT7} abc1234`,
    ].join("\n"),
  });
  try {
    const res = runLint({ roots: [root] });
    assert(res.ok, "pragma-carrying fixture file is skipped");
  } finally {
    cleanup();
  }
}

// 7. An allow-listed file path is skipped.
{
  const { root, cleanup } = fixtureRoot({
    "allowed.ts": `${LT7} HEAD\n${EQ7}\n${GT7} abc1234\n`,
  });
  try {
    const allowPath = join(root, "allowed.ts");
    const flagged = runLint({ roots: [root] });
    assert(!flagged.ok, "non-allow-listed marker file trips the lint");
    const res = runLint({ roots: [root], allowFiles: [allowPath] });
    assert(res.ok, "allow-listed file path is skipped");
  } finally {
    cleanup();
  }
}

// 8. A diff3 base marker (|||||||) is flagged.
{
  const { root, cleanup } = fixtureRoot({
    "diff3.ts": [
      `${LT7} HEAD`,
      "const a = 1;",
      `${PIPE7} merged common ancestor`,
      "const a = 0;",
      EQ7,
      "const a = 2;",
      `${GT7} theirs`,
    ].join("\n"),
  });
  try {
    const res = runLint({ roots: [root] });
    assert(!res.ok, "diff3 conflict block trips the lint");
    assert(
      res.offenders.some((o) => o.kind === "base"),
      "diff3 base marker (|||||||) is reported",
    );
  } finally {
    cleanup();
  }
}

// 9. rootFileDirs scans immediate files only — a marker in a top-level file
//    is flagged, but the same marker in a subdirectory is NOT picked up by
//    the non-recursive root-file scan.
{
  const { root, cleanup } = fixtureRoot({
    "replit-like.md": [
      "# Runbook",
      `${LT7} HEAD`,
      "ours",
      EQ7,
      "theirs",
      `${GT7} abc1234`,
    ].join("\n"),
  });
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(
      join(root, "sub", "nested.sql"),
      `${GT7} abc1234 (nested marker)\nSELECT 1;\n`,
    );

    const res = runLint({ rootFileDirs: [root] });
    assert(!res.ok, "marker in a top-level root file trips the lint");
    assert(
      res.offenders.every((o) => o.file.endsWith("replit-like.md")),
      "root-file scan is non-recursive (nested subdirectory file not scanned)",
    );

    // The same nested .sql file IS caught when its directory is a recursive
    // root — the migrations/ coverage path.
    const recursive = runLint({ roots: [join(root, "sub")] });
    assert(
      !recursive.ok &&
        recursive.offenders.some((o) => o.file.endsWith("nested.sql")),
      "a .sql file under a recursive root (migrations-style) is flagged",
    );
  } finally {
    cleanup();
  }
}

// 10. (Task #2835) Unknown-extension / extension-less files are IN scope;
//     binary extensions are excluded — the denylist model.
{
  const { root, cleanup } = fixtureRoot({
    ".replit": [
      "[deployment]",
      `${LT7} HEAD`,
      'build = ["sh", "-c", "npm run build"]',
      EQ7,
      'build = ["sh", "-c", "./scripts/predeploy.sh && npm run build"]',
      `${GT7} abc1234 (upstream deploy change)`,
    ].join("\n"),
    ".gitignore": `node_modules/\n${GT7} abc1234 (stray marker)\ndist/\n`,
    "replit.nix": `{ deps = [ ]; }\n${GT7} abc1234 (stray marker)\n`,
    Procfile: `${GT7} abc1234 (extension-less config)\nweb: node x\n`,
    Dockerfile: `FROM node:20\n${GT7} abc1234 (Dockerfile marker)\nRUN npm ci\n`,
    "config.toml": `[section]\n${GT7} abc1234 (new-extension marker)\n`,
    "asset.png": `${GT7} abc1234 (marker text inside a denylisted extension)\n`,
  });
  try {
    const res = runLint({ rootFileDirs: [root] });
    assert(!res.ok, "markers in unknown/extension-less files trip the lint");
    for (const inScope of [
      ".replit",
      ".gitignore",
      "replit.nix",
      "Procfile",
      "Dockerfile",
      "config.toml",
    ]) {
      assert(
        res.offenders.some((o) => o.file.endsWith(inScope)),
        `marker in ${inScope} is flagged`,
      );
    }
    assert(
      res.offenders.every((o) => !o.file.endsWith("asset.png")),
      "denylisted binary extension (.png) stays unscanned",
    );
  } finally {
    cleanup();
  }
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
