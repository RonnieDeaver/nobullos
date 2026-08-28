/* test-registration
{
  "name": "lint-react-hooks rules-of-hooks guard (Task #2798)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2798: the rules-of-hooks guard. Its first assertion runs the ESLint rules-of-hooks scan over the REAL client/src tree, so a page-crashing hook mistake (the Task #2791 ConversationHub class: hooks below a conditional early return) fails the routine gate. The managed Long validation workflow runs the reviewed routine-gate profile, including this lint and SMOKE_FILES coverage. DB-free, network-free (ESLint Node API + tmpdir fixtures). The client tree has grown to ~469 scanned files (~3min solo as of Task #4271, vs ~25s at 245 files when the old 120s budget was set), so the budget is 300s. Task #4531: both real-tree passes reuse the lint green-verdict cache when every input is byte-identical to the last green run (red verdicts never cached; LINT_VERDICT_CACHE=0 forces the scan), so steady-state full-set runs stop paying the ~80s rescan.",
  "timeoutMs": 300000,
  "tier": "medium",
  "tierReason": "The medium tier is intentional despite the latest short cached-harness measurement: this suite owns a real client-tree ESLint scan, has a 300-second timeout, and its uncached execution can materially exceed the small-tier ceiling."
}
test-registration */
/**
 * Task #2798 — Gate + regression test for the rules-of-hooks lint.
 *
 * The managed Long validation workflow runs the reviewed routine-gate profile; this test is
 * registered in tests/run-all.ts SMOKE_FILES and its FIRST assertion runs the lint over the
 * real client/src tree, so any page-crashing hook violation (the Task #2791
 * ConversationHub class: hooks below a conditional early return) fails the
 * routine validation run.
 *
 * Fixture cases then prove the lint itself works:
 *   2. A hook called after a conditional early return is flagged (the exact
 *      #2791 shape).
 *   3. A clean component (hooks above the early return) passes.
 *   4. A baselined violation is grandfathered (ok, counted).
 *   5. A stale baseline entry fails the lint.
 *   6. A fatal parse error fails and is NOT baselinable.
 *
 * Task #2806 — exhaustive-deps REPORT-ONLY pass:
 *   7. The real-tree pass runs and REPORTS new stale-dependency hits without
 *      failing this test (decision recorded in scripts/lint-react-hooks.ts:
 *      keep report-only until the seeded baseline burns down below ~20 and
 *      the new-hit signal proves quiet).
 *   8. A missing effect dependency is flagged by the pass.
 *   9. A complete dependency array passes.
 *  10. Baselined hits are grandfathered; stale entries and parse errors do
 *      NOT fail the pass (the hard gate owns parse errors).
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runExhaustiveDepsLint,
  runLint,
  runRealTreeHookLintsCached,
} from "../scripts/lint-react-hooks";

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

/** The exact Task #2791 bug shape: early return ABOVE a hook. */
const VIOLATING_COMPONENT = `import { useCallback } from "react";
export function Broken({ user }: { user: unknown }) {
  if (!user) return null;
  const onClick = useCallback(() => {}, []);
  return <button onClick={onClick}>x</button>;
}
`;

const CLEAN_COMPONENT = `import { useCallback } from "react";
export function Fine({ user }: { user: unknown }) {
  const onClick = useCallback(() => {}, []);
  if (!user) return null;
  return <button onClick={onClick}>x</button>;
}
`;

function fixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lint-react-hooks-"));
  mkdirSync(join(dir, "src"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function main(): Promise<void> {
  // Task #4531: both real-tree passes (rules-of-hooks hard gate, section 1 +
  // promoted exhaustive-deps gate, section 7) run through the green-verdict
  // cache — a byte-identical client tree reuses the recorded green verdict
  // instead of re-scanning ~470 files (~80s). Red verdicts are never cached
  // and fixtures below always execute. LINT_VERDICT_CACHE=0 forces the scan.
  const realTree = await runRealTreeHookLintsCached();

  // 1. THE GATE — the real client/src tree must be clean.
  {
    const res = realTree.hard;
    for (const v of res.offenders) {
      console.error(`    offender: ${v.file}:${v.line}:${v.column} ${v.message}`);
    }
    for (const s of res.staleBaselineEntries) {
      console.error(`    stale baseline entry: ${s}`);
    }
    assert(
      res.ok,
      `real client/src tree has no rules-of-hooks violations (${res.filesScanned} files scanned, ${res.baselinedCount} grandfathered)`,
    );
    assert(
      res.filesScanned > 100,
      `the scan actually covered the client tree (${res.filesScanned} files — a collapsed glob would silently pass)`,
    );
  }

  // 2. The #2791 shape (hook below an early return) is flagged.
  {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(join(dir, "src", "Broken.tsx"), VIOLATING_COMPONENT);
      const res = await runLint({ cwd: dir, patterns: ["src/**/*.tsx"] });
      assert(!res.ok, "a hook called after a conditional early return fails");
      assert(
        res.offenders.length === 1 &&
          res.offenders[0].file === "src/Broken.tsx" &&
          res.offenders[0].line === 4 &&
          /called conditionally|React Hook/i.test(res.offenders[0].message),
        "the offender is reported with file, line, and a rules-of-hooks message",
      );
    } finally {
      cleanup();
    }
  }

  // 3. Hooks above the early return pass.
  {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(join(dir, "src", "Fine.tsx"), CLEAN_COMPONENT);
      const res = await runLint({ cwd: dir, patterns: ["src/**/*.tsx"] });
      assert(
        res.ok && res.violations.length === 0 && res.filesScanned === 1,
        "a clean component (hooks above the early return) passes",
      );
    } finally {
      cleanup();
    }
  }

  // 4. A baselined violation is grandfathered.
  {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(join(dir, "src", "Broken.tsx"), VIOLATING_COMPONENT);
      writeFileSync(
        join(dir, "baseline.txt"),
        "src/Broken.tsx:4  # known debt, tracked\n",
      );
      const res = await runLint({
        cwd: dir,
        patterns: ["src/**/*.tsx"],
        baselinePath: "baseline.txt",
      });
      assert(
        res.ok && res.baselinedCount === 1 && res.offenders.length === 0,
        "a baselined violation is grandfathered, not build-failing",
      );
      assert(
        res.violations.length === 1 && res.violations[0].baselined,
        "the grandfathered hit is still surfaced in the report",
      );
    } finally {
      cleanup();
    }
  }

  // 5. A stale baseline entry (violation since fixed) fails the lint.
  {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(join(dir, "src", "Fine.tsx"), CLEAN_COMPONENT);
      writeFileSync(join(dir, "baseline.txt"), "src/Fine.tsx:4\n");
      const res = await runLint({
        cwd: dir,
        patterns: ["src/**/*.tsx"],
        baselinePath: "baseline.txt",
      });
      assert(
        !res.ok &&
          res.staleBaselineEntries.length === 1 &&
          res.staleBaselineEntries[0] === "src/Fine.tsx:4",
        "a stale baseline entry is reported and fails the lint",
      );
    } finally {
      cleanup();
    }
  }

  // 6. A fatal parse error fails and cannot be baselined away.
  {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(
        join(dir, "src", "Mangled.tsx"),
        "export function Mangled( {\n", // unparseable
      );
      writeFileSync(join(dir, "baseline.txt"), "src/Mangled.tsx:1\n");
      const res = await runLint({
        cwd: dir,
        patterns: ["src/**/*.tsx"],
        baselinePath: "baseline.txt",
      });
      assert(
        !res.ok &&
          res.offenders.some((v) => v.fatal && v.file === "src/Mangled.tsx"),
        "a fatal parse error fails the lint even with a baseline entry",
      );
    } finally {
      cleanup();
    }
  }

  // ---- Task #2806: exhaustive-deps report-only pass ----

  /** A stale-closure bug shape: effect reads `count` but omits it. */
  const MISSING_DEP_COMPONENT = `import { useEffect, useState } from "react";
export function Stale({ id }: { id: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    console.log(id, count);
  }, [id]);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`;

  const COMPLETE_DEPS_COMPONENT = `import { useEffect, useState } from "react";
export function Fresh({ id }: { id: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    console.log(id, count);
  }, [id, count]);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`;

  // 7. HARD GATE on the real tree: no NEW (non-baselined) exhaustive-deps
  // hits. Promoted from report-only per the PROMOTION DECISION recorded in
  // scripts/lint-react-hooks.ts (Task #2808): the seeded 54-entry baseline
  // was burned down to 13 real grandfathered hits, so line drift in the few
  // remaining files can no longer spray false "new" hits on unrelated edits.
  // Stale baseline entries still never fail this pass.
  {
    const res = realTree.deps;
    for (const v of res.offenders) {
      console.error(
        `    [exhaustive-deps NEW] ${v.file}:${v.line}:${v.column} ${v.message}`,
      );
    }
    console.log(
      `    exhaustive-deps report: ${res.offenders.length} NEW hit(s), ` +
        `${res.baselinedCount} grandfathered, ${res.staleBaselineEntries.length} stale baseline entr(ies) ` +
        `across ${res.filesScanned} files`,
    );
    assert(
      res.ok,
      `the real client/src tree has no NEW exhaustive-deps hits (fix the stale dependency or, with a justifying comment, add it to scripts/lint-react-hooks.exhaustive-deps.baseline.txt)`,
    );
    assert(
      res.filesScanned > 100,
      `the exhaustive-deps pass actually covered the client tree (${res.filesScanned} files)`,
    );
    // Baseline-consulted check: only meaningful while the seeded baseline
    // still has entries. Once the debt is fully burned down this check
    // retires itself instead of failing (per code-review note, Task #2806).
    const baselineFile = readFileSync(
      "scripts/lint-react-hooks.exhaustive-deps.baseline.txt",
      "utf8",
    );
    const baselineEntryCount = baselineFile
      .split("\n")
      .filter((l) => l.split("#")[0].trim()).length;
    if (baselineEntryCount > 0) {
      assert(
        res.baselinedCount + res.staleBaselineEntries.length > 0,
        `the seeded exhaustive-deps baseline is being consulted (${baselineEntryCount} entries on disk)`,
      );
    } else {
      console.log(
        "    exhaustive-deps baseline is empty (fully burned down)",
      );
    }
  }

  // 8. A missing effect dependency is flagged.
  {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(join(dir, "src", "Stale.tsx"), MISSING_DEP_COMPONENT);
      const res = await runExhaustiveDepsLint({
        cwd: dir,
        patterns: ["src/**/*.tsx"],
      });
      assert(
        !res.ok &&
          res.offenders.length === 1 &&
          res.offenders[0].file === "src/Stale.tsx" &&
          /missing dependenc/i.test(res.offenders[0].message) &&
          /count/.test(res.offenders[0].message),
        "an effect that omits a dependency it reads is flagged, naming the missing dep",
      );
    } finally {
      cleanup();
    }
  }

  // 9. A complete dependency array passes.
  {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(join(dir, "src", "Fresh.tsx"), COMPLETE_DEPS_COMPONENT);
      const res = await runExhaustiveDepsLint({
        cwd: dir,
        patterns: ["src/**/*.tsx"],
      });
      assert(
        res.ok && res.violations.length === 0 && res.filesScanned === 1,
        "an effect with a complete dependency array passes the exhaustive-deps pass",
      );
    } finally {
      cleanup();
    }
  }

  // 10. Baselined hit grandfathered; stale entries + parse errors don't fail.
  {
    const { dir, cleanup } = fixture();
    try {
      writeFileSync(join(dir, "src", "Stale.tsx"), MISSING_DEP_COMPONENT);
      writeFileSync(
        join(dir, "src", "Mangled.tsx"),
        "export function Mangled( {\n", // unparseable — hard gate's problem
      );
      writeFileSync(
        join(dir, "baseline.txt"),
        "src/Stale.tsx:6  # grandfathered at introduction\nsrc/Gone.tsx:9  # stale — file since fixed\n",
      );
      const res = await runExhaustiveDepsLint({
        cwd: dir,
        patterns: ["src/**/*.tsx"],
        baselinePath: "baseline.txt",
      });
      assert(
        res.ok && res.baselinedCount === 1 && res.offenders.length === 0,
        "a baselined exhaustive-deps hit is grandfathered, not a new offender",
      );
      assert(
        res.staleBaselineEntries.length === 1 &&
          res.staleBaselineEntries[0] === "src/Gone.tsx:9" &&
          res.ok,
        "a stale baseline entry is surfaced but does NOT fail the report-only pass",
      );
      assert(
        !res.violations.some((v) => v.fatal),
        "fatal parse errors are excluded from the report-only pass (the hard gate owns them)",
      );
    } finally {
      cleanup();
    }
  }

  console.log(`\n  passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
