/**
 * Task #2616 (reworked by Task #3786) — Guard against tests that silently
 * never run in the routine gated check.
 *
 * Background: the merge/completion gate runs `TEST_SMOKE=1 npm test`, which
 * selects ONLY the tests whose registration declares `"smoke": true`. The
 * `"regression": true` flag does NOT put a test in that gate — it only
 * matters for the separate `--regression` sweep and the full no-flag run,
 * NEITHER of which blocks a change. So a test can be regression-flagged and
 * still be invisible to the check that actually gates every merge.
 *
 * This is a documented, recurring rot: Front console tabs (#2523), Front
 * coverage surface (#2554), ClientDetail tab deep-link (#2577), the
 * user-restore admin tests (#2599), and the two heatmap color tests (#2601)
 * each broke undetected this way and were repaired one-off. This lint is the
 * standing guard.
 *
 * The convention it enforces (SEMANTIC gate decision)
 * ---------------------------------------------------
 * Registration lives in each test file's own `/* test-registration` block
 * since Task #3786 (see tests/testRegistry.ts) — there is no SMOKE_FILES set
 * or shared baseline file to edit anymore. Every regression-flagged test
 * must record an EXPLICIT decision in its own block, exactly one of:
 *
 *   1. `"smoke": true` + `"smokeReason"` — it runs in the routine gate (the
 *      goal for any fast, deterministic bug-class guard: DB-free
 *      pure-function tests or stubbed jsdom renders).
 *
 *   2. `"sweepOnlyReason"` — the recorded choice NOT to gate it (too slow,
 *      DB-heavy, or contention-sensitive). It still runs in the full suite
 *      and the nightly `--regression` sweep.
 *
 * The pre-#3786 grandfather baseline
 * (scripts/lint-smoke-gate-regression.baseline.txt) was folded into those
 * per-test `sweepOnlyReason` fields by the conversion and deleted; its
 * recorded reasons were preserved verbatim where they existed.
 *
 * The lint FAILS when a registration's gate decision is missing or
 * contradictory (see validateGateDecision in tests/testRegistry.ts):
 *   - regression without smoke and without sweepOnlyReason (the silent gap),
 *   - smoke without a smokeReason,
 *   - smoke combined with sweepOnlyReason (contradiction),
 *   - smokeReason / sweepOnlyReason on a test where they mean nothing.
 * Files whose block is structurally broken are reported here too (they have
 * no readable decision); scripts/lint-test-registration.ts is the focused
 * guard for that class.
 *
 * See `.agents/memory/smoke-gate-vs-regression-flag.md`.
 *
 * Exit codes:
 *   0 — every regression test records an explicit, consistent gate decision.
 *   1 — at least one missing/contradictory decision (or unparseable block).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTestRegistry,
  validateGateDecision,
} from "../tests/testRegistry";
import { validateTierPolicy } from "../tests/sizeTiers";

/**
 * Task #3841 — the migrated-boilerplate ratchet.
 *
 * The #3786 conversion stamped this verbatim no-reason boilerplate into every
 * sweep-only registration that the deleted baseline file had no reason for.
 * That satisfies the "explicit decision" rule formally but records nothing —
 * so a NEW suite could copy-paste it and evade ever making a real decision.
 * The grandfathered list freezes the boilerplate to the files that carried it
 * at the #3841 audit; it only ever shrinks:
 *   - a file using the boilerplate that is NOT in the list fails (write a
 *     substantive sweepOnlyReason or gate the suite with smoke+smokeReason);
 *   - a list entry whose file no longer uses the boilerplate (upgraded,
 *     gated, or deleted) is stale and fails until the line is removed.
 */
export const MIGRATED_BOILERPLATE_PREFIX =
  "Sweep-only decision migrated from the pre-#3786 grandfather baseline";
export const DEFAULT_GRANDFATHERED_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "lint-smoke-gate-regression.grandfathered.txt",
);
/**
 * The IMMUTABLE initial snapshot (Task #3841). The live grandfathered.txt is
 * the editable, shrink-only working list; this frozen file is its ceiling.
 * Its SHA-256 is pinned below, so editing the frozen file fails the lint,
 * and every live entry must be a member of the frozen set — additions fail,
 * removals remain permitted. (The frozen-snapshot ratchet pattern: derive
 * allowances from ONE hash-pinned artifact, never a hand-editable list.)
 */
export const DEFAULT_FROZEN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "lint-smoke-gate-regression.grandfathered.frozen.txt",
);
export const FROZEN_SNAPSHOT_SHA256 =
  "239fb68b2bf4e9adcfe2149cb5f1df7148b4fdc085df8f2d8f3f80efcc57af3e";

export function loadGrandfathered(path: string): Set<string> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out; // missing list = nothing grandfathered (fixtures)
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    out.add(t);
  }
  return out;
}

export interface LintOptions {
  /** Roots to scan (default: tests/ and client/src/). */
  rootDirs?: string[];
  /** Repo root the rootDirs are relative to (default: cwd). */
  repoRoot?: string;
  /** Grandfathered-boilerplate list path (default: alongside this script). */
  grandfatheredPath?: string;
  /** Frozen initial-snapshot path (default: alongside this script). */
  frozenPath?: string;
  /** Expected SHA-256 of the frozen snapshot (default: the pinned constant). */
  frozenSha256?: string;
  /** Published per-suite duration artifact used for tier ceilings. */
  greenBaselinePath?: string;
}

export interface Offender {
  file: string;
  message: string;
}

export interface LintResult {
  ok: boolean;
  /** Total `"regression": true` tests seen. */
  regressionCount: number;
  /** Regression tests gated via `"smoke": true` (run in the routine gate). */
  gatedCount: number;
  /** Regression tests with a recorded `"sweepOnlyReason"` decision. */
  sweepOnlyCount: number;
  /** Sweep-only tests still carrying the migrated no-reason boilerplate (grandfathered). */
  boilerplateCount: number;
  /** Suites with a declared size tier. */
  tieredCount: number;
  /** Tests whose gate decision is missing, contradictory, or unreadable. */
  offenders: Offender[];
}

interface GreenBaselineRecord {
  durationMs?: unknown;
}

function loadDurations(path: string): Map<string, number> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      records?: Record<string, GreenBaselineRecord>;
    };
    const out = new Map<string, number>();
    for (const [file, record] of Object.entries(raw.records ?? {})) {
      if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs)) {
        out.set(file, record.durationMs);
      }
    }
    return out;
  } catch {
    return new Map(); // bootstrap/fixture tree: absence means unmeasured, never invented.
  }
}

export function runLint(options: LintOptions = {}): LintResult {
  const registry = buildTestRegistry({
    repoRoot: options.repoRoot,
    rootDirs: options.rootDirs,
  });
  const repoRoot = options.repoRoot ?? process.cwd();
  const durations = loadDurations(
    options.greenBaselinePath ?? resolve(repoRoot, "tests/green-baseline.json"),
  );

  const offenders: Offender[] = [];
  // A structurally broken block has no readable gate decision — surface it
  // here as well so this lint is sound standalone (lint-test-registration
  // is the focused structural guard with the format help text).
  for (const p of registry.problems) {
    offenders.push({ file: p.file, message: `unreadable registration: ${p.message}` });
  }

  const grandfathered = loadGrandfathered(
    options.grandfatheredPath ?? DEFAULT_GRANDFATHERED_PATH,
  );

  // Frozen-snapshot ceiling: verify the snapshot is untampered, then require
  // the live list to be a subset — additions fail, removals are permitted.
  const frozenPath = options.frozenPath ?? DEFAULT_FROZEN_PATH;
  const expectedSha = options.frozenSha256 ?? FROZEN_SNAPSHOT_SHA256;
  let frozen: Set<string> | null = null;
  try {
    const rawFrozen = readFileSync(frozenPath, "utf8");
    const actualSha = createHash("sha256").update(rawFrozen).digest("hex");
    if (actualSha !== expectedSha) {
      offenders.push({
        file: "scripts/lint-smoke-gate-regression.grandfathered.frozen.txt",
        message:
          `frozen snapshot hash mismatch (expected ${expectedSha}, got ${actualSha}) — this ` +
          `file is the IMMUTABLE Task #3841 baseline and must never be edited; revert it`,
      });
    } else {
      frozen = new Set(
        rawFrozen
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("#")),
      );
    }
  } catch {
    offenders.push({
      file: "scripts/lint-smoke-gate-regression.grandfathered.frozen.txt",
      message: "frozen snapshot missing — restore it from git history; it must never be deleted",
    });
  }
  if (frozen) {
    for (const file of grandfathered) {
      if (!frozen.has(file)) {
        offenders.push({
          file,
          message:
            `added to scripts/lint-smoke-gate-regression.grandfathered.txt but absent from the ` +
            `frozen Task #3841 snapshot — the grandfathered list is shrink-only; write a ` +
            `substantive "sweepOnlyReason" (or gate with "smoke" + "smokeReason") instead`,
        });
      }
    }
  }

  let regressionCount = 0;
  let gatedCount = 0;
  let sweepOnlyCount = 0;
  let boilerplateCount = 0;
  let tieredCount = 0;
  const boilerplateFiles = new Set<string>();
  for (const [file, reg] of registry.registrations) {
    const errors = validateGateDecision(reg);
    for (const message of errors) offenders.push({ file, message });
    let source = "";
    try {
      source = readFileSync(resolve(repoRoot, file), "utf8");
    } catch {
      // Registry already records unreadable files. Avoid a duplicate noise row.
    }
    for (
      const message of validateTierPolicy({
        file,
        source,
        durationMs: durations.get(file) ?? null,
        registration: reg,
      })
    ) {
      offenders.push({ file, message });
    }
    if (reg.tier) tieredCount++;
    if (reg.regression === true) {
      regressionCount++;
      if (reg.smoke === true) gatedCount++;
      else if (reg.sweepOnlyReason) sweepOnlyCount++;
    }
    // Task #3841 ratchet: the migrated no-reason boilerplate is frozen to the
    // grandfathered list — new sweep-only decisions must state a real reason.
    if (
      reg.regression === true &&
      reg.smoke !== true &&
      (reg.sweepOnlyReason ?? "").startsWith(MIGRATED_BOILERPLATE_PREFIX)
    ) {
      boilerplateFiles.add(file);
      if (grandfathered.has(file)) {
        boilerplateCount++;
      } else {
        offenders.push({
          file,
          message:
            `"sweepOnlyReason" is the migrated no-reason boilerplate, which is frozen to the ` +
            `Task #3841 grandfathered list — write a substantive reason (why this suite should ` +
            `NOT gate: slow / DB-heavy / covered elsewhere) or gate it with "smoke" + "smokeReason"`,
        });
      }
    }
  }
  // Stale grandfathered entries fail so the list only ever shrinks.
  for (const file of grandfathered) {
    if (!boilerplateFiles.has(file)) {
      offenders.push({
        file,
        message:
          `stale entry in scripts/lint-smoke-gate-regression.grandfathered.txt — the file no ` +
          `longer carries the migrated boilerplate (upgraded, gated, or deleted); delete the line`,
      });
    }
  }
  offenders.sort((a, b) => a.file.localeCompare(b.file));

  return {
    ok: offenders.length === 0,
    regressionCount,
    gatedCount,
    sweepOnlyCount,
    boilerplateCount,
    tieredCount,
    offenders,
  };
}

export function cliMain(): number {
  const result = runLint();

  if (result.ok) {
    console.log(
      `lint-smoke-gate-regression: OK (${result.regressionCount} regression test(s): ` +
        `${result.gatedCount} gated via "smoke": true, ${result.sweepOnlyCount} recorded sweep-only, ` +
        `of which ${result.boilerplateCount} grandfathered no-reason boilerplate; ` +
        `${result.tieredCount} size-tiered).`,
    );
    return 0;
  }

  console.error("");
  console.error(
    "✗ lint-smoke-gate-regression: test(s) without an explicit, consistent gate decision",
  );
  console.error("");
  console.error(
    "  The merge/completion gate runs `TEST_SMOKE=1 npm test`, which runs ONLY",
  );
  console.error(
    '  tests whose registration block declares `"smoke": true`. A test marked',
  );
  console.error(
    '  `"regression": true` without it never runs in that gate — it silently',
  );
  console.error(
    "  rots until it breaks undetected (the #2523 / #2554 / #2577 / #2599 /",
  );
  console.error("  #2601 failure mode).");
  console.error("");
  console.error(
    "  Record the decision in the file's own `/* test-registration` block:",
  );
  console.error("");
  console.error(
    '    A) Gate it (preferred for fast, deterministic bug-class guards):',
  );
  console.error(
    '       add `"smoke": true` plus a `"smokeReason"` saying why it earns',
  );
  console.error("       a routine-gate slot.");
  console.error("");
  console.error(
    "    B) If it genuinely should NOT gate (slow / DB-heavy / contention-",
  );
  console.error(
    '       sensitive), add a `"sweepOnlyReason"` recording that choice; it',
  );
  console.error(
    "       still runs in the full suite and the nightly --regression sweep.",
  );
  console.error("");
  console.error("  See .agents/memory/smoke-gate-vs-regression-flag.md.");
  console.error("");
  console.error("  Offending registration(s):");
  for (const o of result.offenders) console.error(`    - ${o.file}: ${o.message}`);
  console.error("");
  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-smoke-gate-regression.ts");

if (isMain) {
  process.exit(cliMain());
}
