/**
 * Task #2379 — Guardrail against shared-DB global-switch contamination
 * between test suites.
 *
 * Background: the test runner (`tests/run-all.ts`) runs files serially in
 * separate child processes against the *shared* dev Postgres. Serial
 * execution does NOT isolate a global `system_settings` switch: a sibling
 * suite that flips an operator switch (e.g.
 * `front_analytics_refresh_enabled=false`) and restores it in a `finally`
 * can be SIGKILL'd on a per-test timeout *before* its `finally` runs.
 * SIGKILL skips the restore, so the non-default value is left durable in
 * the shared dev DB. A later suite that merely *depends on* that switch —
 * either by reading it directly or by listing it in its keys-to-restore
 * backup set — then silently picks up the leaked value and a gated code
 * path short-circuits (see Task #2366: `runCoverageRefreshTick` returned
 * "refresh disabled", pullCalls stayed 0, and the assertion failed).
 *
 * The fix is for every suite that *depends on* a high-risk global switch
 * to PIN it: back it up AND `setSystemSetting(key, desiredValue, ...)` so
 * the suite is deterministic regardless of leftover global state. See
 * `.agents/memory/test-global-setting-leak-from-sigkill.md`.
 *
 * This lint enforces that contract for a curated registry of high-risk
 * global switches (below). A test file is an OFFENDER when it *depends on*
 * a registered switch — i.e. it references the switch's exported constant
 * (or its raw key string) in non-import, non-comment code, which in
 * practice means either reading it via `getSystemSetting` or listing it in
 * a keys-to-restore backup array — but never PINS it via a
 * `setSystemSetting(<key>, ...)` call.
 *
 * Why a curated registry rather than "every *_enabled key": the generic
 * signal is too noisy — `SETTING_ENABLED` is re-exported by ~dozens of
 * alert modules with different key strings, and many suites that *back up*
 * a switch defensively actually inject the value via a config/param
 * override and never read the DB row (so a leak can't reach them). The
 * registry intentionally lists only switches that a steady-state consumer
 * reads from `system_settings` and that have demonstrably leaked across
 * suites. ADD A NEW ENTRY when you introduce another always-on
 * background-loop master switch that consumers read from the DB.
 *
 * Exit code:
 *   0 — no offenders.
 *   1 — at least one suite depends on a registered switch without pinning.
 */

import { readFileSync } from "node:fs";
import {
  isScannablePath,
  listTrackedFiles,
  walkDir,
} from "./lintFileDiscovery";

const SELF = "lint-test-shared-setting-pinning";

/**
 * A high-risk global `system_settings` switch. `key` is the raw row key;
 * `constants` lists the exported constant identifier(s) test files import
 * to reference it. Both forms are recognized so a suite cannot evade the
 * check by using the raw string instead of the constant (or vice-versa).
 */
export interface HighRiskSwitch {
  /** The `system_settings` row key. */
  key: string;
  /** Exported constant identifier(s) tests use to reference the key. */
  constants: string[];
  /** Human-readable note for the failure message. */
  why: string;
}

/**
 * Curated registry of high-risk global switches. These are always-on
 * background-loop master switches a steady-state consumer reads from
 * `system_settings` (NOT injected via param), so a value leaked by a
 * SIGKILL'd sibling silently breaks any suite that depends on them.
 */
export const HIGH_RISK_SWITCHES: ReadonlyArray<HighRiskSwitch> = [
  {
    key: "front_analytics_refresh_enabled",
    constants: ["SETTING_REFRESH_ENABLED"],
    why: "legacy emergency master for Front Analytics coverage refresh; runCoverageRefreshTick short-circuits when leaked 'false'",
  },
  {
    key: "front_analytics_measurement_refresh_enabled",
    constants: ["SETTING_MEASUREMENT_REFRESH_ENABLED"],
    why: "Stage-1 measurement-cadence master; the scheduler's due-check returns false unconditionally when leaked 'false'",
  },
];

interface Offender {
  file: string;
  switchKey: string;
  reason: string;
}

// The pin+restore contract lives in the `.test.ts(x)` suites themselves;
// fixtures + helper stubs are out of scope (the shared discovery module
// already skips fixtures/; helpers/ is skipped here).
function isPinScannable(file: string): boolean {
  const segments = file.split("/");
  const base = segments[segments.length - 1];
  if (base.includes(SELF)) return false;
  if (segments.slice(0, -1).includes("helpers")) return false;
  return base.endsWith(".test.ts") || base.endsWith(".test.tsx");
}

/**
 * Remove `import ... from "..."` / `import "..."` statements (so a switch
 * referenced *only* in an import isn't treated as a dependency) and then
 * blank out line + block comments (so commentary and assertion-string
 * substrings don't count as code references).
 */
export function stripImportsAndComments(src: string): string {
  let s = src;
  // Drop import statements (including multi-line `import { ... } from`).
  s = s.replace(/\bimport\s+type\b[\s\S]*?from\s*['"][^'"]+['"];?/g, " ");
  s = s.replace(/\bimport\b[\s\S]*?from\s*['"][^'"]+['"];?/g, " ");
  s = s.replace(/\bimport\s*['"][^'"]+['"];?/g, " ");
  // Blank block comments (preserve newlines for line reporting).
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // Blank line comments.
  s = s
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");
  return s;
}

/**
 * True when the file actually interacts with the `system_settings` store.
 * A suite that never calls get/set/deleteSystemSetting (e.g. a React
 * component test that only uses a switch key as a UI label) cannot be
 * broken by a value leaked into the shared DB, so it is out of scope.
 */
function touchesSettingsStore(code: string): boolean {
  return /\b(?:get|set|delete)SystemSetting\s*\(/.test(code);
}

function dependsOn(code: string, sw: HighRiskSwitch): boolean {
  // Reference via exported constant identifier (word-boundary), e.g.
  // `getSystemSetting(SETTING_REFRESH_ENABLED)` or membership in a
  // `keysToRestore` array.
  for (const c of sw.constants) {
    if (new RegExp(`\\b${c}\\b`).test(code)) return true;
  }
  // Reference via the raw key as a standalone quoted string, e.g.
  // `getSystemSetting("front_analytics_refresh_enabled")`. The closing
  // quote must immediately follow the key so a compound assertion string
  // like "front_analytics_refresh_enabled=false" does NOT match.
  const esc = sw.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(['"])${esc}\\1`).test(code)) return true;
  return false;
}

function isPinned(code: string, sw: HighRiskSwitch): boolean {
  // A pin is `setSystemSetting(<key>, <value>, ...)` — matches both the
  // bare `setSystemSetting(` and `storage.setSystemSetting(` forms.
  const tokens = [
    ...sw.constants,
    `['"]${sw.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
  ];
  for (const t of tokens) {
    if (new RegExp(`setSystemSetting\\(\\s*${t}\\s*,`).test(code)) return true;
  }
  return false;
}

export function runLint(root?: string): {
  ok: boolean;
  offenders: Offender[];
  scanned: number;
} {
  const files: string[] = [];
  if (root) {
    // Fixture mode: walk the given directory with the same predicate.
    walkDir(root, files, isPinScannable);
  } else {
    // Repo-wide scope (Task #2846): discover `.test.ts(x)` suites from
    // `git ls-files` instead of walking the fixed tests/ root, so a test
    // tree outside tests/ is in scope automatically.
    for (const f of listTrackedFiles()) {
      if (isScannablePath(f) && isPinScannable(f)) files.push(f);
    }
  }
  const offenders: Offender[] = [];

  for (const file of files) {
    const code = stripImportsAndComments(readFileSync(file, "utf8"));
    // Out of scope: suites that never touch the settings store cannot be
    // broken by a value leaked into the shared DB.
    if (!touchesSettingsStore(code)) continue;
    for (const sw of HIGH_RISK_SWITCHES) {
      if (dependsOn(code, sw) && !isPinned(code, sw)) {
        offenders.push({
          file,
          switchKey: sw.key,
          reason: `depends on global switch '${sw.key}' (${sw.why}) but never pins it — add setSystemSetting('${sw.key}', <desired>, "test") right after entering the settings-backup scope`,
        });
      }
    }
  }

  return { ok: offenders.length === 0, offenders, scanned: files.length };
}

export function cliMain(): number {
  const result = runLint();
  if (result.ok) {
    console.log(
      `[lint-test-shared-setting-pinning] OK — scanned ${result.scanned} test files, every suite depending on a high-risk global switch pins it.`,
    );
    return 0;
  }
  console.error(
    `[lint-test-shared-setting-pinning] FAILED — ${result.offenders.length} suite(s) depend on a high-risk global system_settings switch without pinning it:`,
  );
  for (const o of result.offenders) {
    console.error(`  ${o.file}`);
    console.error(`    > ${o.reason}`);
  }
  console.error(
    "\nWhy this matters: tests/run-all.ts runs files serially against the SHARED dev DB and SIGKILLs a child on timeout, skipping its `finally` restore. A leaked non-default switch value then silently breaks any suite that only reads it.",
  );
  console.error(
    "Fix: back up the switch AND pin it to the value this suite needs, e.g.\n  await setSystemSetting('front_analytics_refresh_enabled', 'true', 'test');\nSee .agents/memory/test-global-setting-leak-from-sigkill.md",
  );
  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-test-shared-setting-pinning.ts");

if (isMain) {
  process.exit(cliMain());
}
