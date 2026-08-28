/* test-registration
{
  "name": "Gate single-process lint phase: pool, capture, failure semantics, cliMain contract (Task #3789)",
  "smoke": true,
  "smokeReason": "Guards the gate's own lint-phase machinery (worker pool bounds, output capture, exit semantics, and the per-script cliMain contract). DB-free and fast; a regression here silently degrades every gate run's lint coverage.",
  "regression": true,
  "tier": "small"
}
test-registration */
// fs-scan-fixture-only -- reads gate event logs from a mkdtemp run dir only
/**
 * Task #3789 — the gate runs its 22 lint checks inside one process via a
 * bounded worker-thread pool (scripts/gate.ts runLintPhase +
 * scripts/gate-lint-worker.mjs) instead of 22 serial `npx tsx` spawns.
 *
 * This test drives the machinery with purpose-built fixtures
 * (tests/helpers/gate-lint-fixtures/) and then checks the real LINT_CHECKS
 * contract: every registered script must exist and export cliMain(), because
 * a script that runs its CLI at import time (the old shape) would report a
 * confusing worker-exit failure on every gate run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LINT_CHECKS, runLintPhase, type LintPhaseSink } from "../scripts/gate.ts";

let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const FIX = "tests/helpers/gate-lint-fixtures";

async function main(): Promise<void> {
  console.log("1) pool + output capture + failure semantics + deterministic order");
  {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const sink: LintPhaseSink = {
      out: (t) => outLines.push(t),
      err: (t) => errLines.push(t),
    };
    const { results } = await runLintPhase(
      [
        { name: "fixture-ok", script: `${FIX}/fixture-ok.ts` },
        { name: "fixture-fail", script: `${FIX}/fixture-fail.ts` },
        { name: "fixture-no-climain", script: `${FIX}/fixture-no-climain.ts` },
        { name: "fixture-exits-on-import", script: `${FIX}/fixture-exits-on-import.ts` },
      ],
      { concurrency: 2, sink },
    );
    ok(results.length === 4, "four results, one per check, none dropped");
    ok(
      results[0]?.name === "fixture-ok" && results[0]?.passed === true && results[0]?.exitCode === 0,
      "passing check reports passed / exit 0",
    );
    ok(
      results[0]?.output.some((l) => l.stream === "stdout" && l.text.includes("fixture-ok: OK")),
      "stdout from cliMain is captured per-check",
    );
    ok(results[1]?.passed === false && results[1]?.exitCode === 1, "failing check reports failed / exit 1");
    ok(
      results[1]?.output.some((l) => l.stream === "stderr" && l.text.includes("failing on purpose")),
      "stderr from cliMain is captured per-check",
    );
    ok(
      results[2]?.passed === false && results[2]?.exitCode === 97,
      "missing cliMain export fails with the dedicated contract code (97)",
    );
    ok(
      results[2]?.output.some((l) => l.text.includes("cliMain")),
      "missing-export failure explains the cliMain contract",
    );
    ok(
      results[3]?.passed === false && results[3]?.exitCode === 3,
      "process.exit at import time surfaces the module's exit code as a failure",
    );
    ok(
      results[3]?.output.some((l) => l.text.includes("import time")),
      "import-time-exit failure carries the diagnostic hint",
    );
    const joined = outLines.join("\n");
    const order = [
      joined.indexOf("--- [fixture-ok]"),
      joined.indexOf("--- [fixture-fail]"),
      joined.indexOf("--- [fixture-no-climain]"),
      joined.indexOf("--- [fixture-exits-on-import]"),
    ];
    ok(
      order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3],
      "per-check blocks flush in canonical order despite concurrent execution",
    );
    ok(
      errLines.some((t) => t.includes("failing on purpose")),
      "stderr lines are routed to the error sink",
    );
  }

  console.log("\n2) concurrency is bounded AND actually concurrent");
  {
    const dir = mkdtempSync(join(tmpdir(), "gate-lint-fixture-"));
    const logPath = join(dir, "overlap.log");
    process.env.GATE_FIXTURE_LOG = logPath;
    const sink: LintPhaseSink = { out: () => {}, err: () => {} };
    try {
      const { results, wallMs } = await runLintPhase(
        [
          { name: "slow-1", script: `${FIX}/fixture-slow.ts` },
          { name: "slow-2", script: `${FIX}/fixture-slow.ts` },
          { name: "slow-3", script: `${FIX}/fixture-slow.ts` },
          { name: "slow-4", script: `${FIX}/fixture-slow.ts` },
        ],
        { concurrency: 2, sink },
      );
      ok(results.every((r) => r.passed), "all slow fixtures pass");
      const events = readFileSync(logPath, "utf8") // fs-scan-inputs-ignore -- tmp-dir event log written by this run's fixture scripts
        .trim()
        .split("\n")
        .map((l) => {
          const [kind, ts] = l.split(" ");
          return { kind, ts: Number(ts) };
        })
        // Sort by timestamp; on ties, count an End before a Start so
        // back-to-back scheduling is not misread as extra overlap.
        .sort((a, b) => a.ts - b.ts || (a.kind === "E" ? -1 : 1));
      let current = 0;
      let maxOverlap = 0;
      for (const e of events) {
        current += e.kind === "S" ? 1 : -1;
        maxOverlap = Math.max(maxOverlap, current);
      }
      ok(maxOverlap <= 2, `pool bound respected (max overlap ${maxOverlap} ≤ 2)`);
      ok(maxOverlap === 2, `checks actually run concurrently (max overlap ${maxOverlap} = 2)`);
      console.log(`  (info) 4×1.5s sleeps at concurrency 2 → wall ${wallMs}ms`);
    } finally {
      delete process.env.GATE_FIXTURE_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\n3) exclusive checks never overlap other lint workers");
  {
    const dir = mkdtempSync(join(tmpdir(), "gate-lint-exclusive-fixture-"));
    const logPath = join(dir, "overlap.log");
    process.env.GATE_FIXTURE_LOG = logPath;
    process.env.GATE_FIXTURE_DELAY_MS = "100";
    const sink: LintPhaseSink = { out: () => {}, err: () => {} };
    try {
      const { results } = await runLintPhase(
        [
          { name: "before", script: `${FIX}/fixture-slow.ts` },
          { name: "exclusive", script: `${FIX}/fixture-slow.ts`, exclusive: true },
          { name: "after", script: `${FIX}/fixture-slow.ts` },
        ],
        { concurrency: 3, sink },
      );
      ok(results.every((r) => r.passed), "exclusive-lane fixtures all pass");
      const events = readFileSync(logPath, "utf8") // fs-scan-inputs-ignore -- tmp-dir event log written by this run's fixture scripts
        .trim()
        .split("\n")
        .map((line) => {
          const [kind, ts] = line.split(" ");
          return { kind, ts: Number(ts) };
        })
        .sort((a, b) => a.ts - b.ts || (a.kind === "E" ? -1 : 1));
      let active = 0;
      let maxOverlap = 0;
      for (const event of events) {
        active += event.kind === "S" ? 1 : -1;
        maxOverlap = Math.max(maxOverlap, active);
      }
      ok(maxOverlap === 1, `exclusive check ran alone (max overlap ${maxOverlap} = 1)`);
    } finally {
      delete process.env.GATE_FIXTURE_LOG;
      delete process.env.GATE_FIXTURE_DELAY_MS;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\n4) every real LINT_CHECKS entry honors the cliMain contract");
  {
    ok(LINT_CHECKS.length >= 22, `LINT_CHECKS lists the full check set (${LINT_CHECKS.length} entries)`);
    ok(
      new Set(LINT_CHECKS.map((c) => c.name)).size === LINT_CHECKS.length,
      "check names are unique",
    );
    for (const check of LINT_CHECKS) {
      ok(existsSync(check.script), `${check.script} exists`);
    }
    const bundleCheck = LINT_CHECKS.find((check) => check.name === "lint-bundle-budget");
    ok(
      bundleCheck?.exclusive === true,
      "lint-bundle-budget uses the exclusive lane so cold builds avoid lint-pool contention",
    );
    // Task #4533 — remedy strings must stay brace-free: the
    // lint-gate-workflow-drift parser extracts LINT_CHECKS entries from
    // scripts/gate.ts by brace-matching the object literals, so a `{` or `}`
    // inside a remedy string would silently corrupt its parse of every
    // subsequent entry.
    for (const check of LINT_CHECKS) {
      if (check.remedy === undefined) continue;
      ok(
        !check.remedy.includes("{") && !check.remedy.includes("}"),
        `${check.name} remedy is brace-free (lint-gate-workflow-drift parser constraint)`,
      );
    }
    for (const check of LINT_CHECKS) {
      // A module that runs its CLI at import time would call process.exit
      // here and kill this test — which is exactly the loud failure we want.
      const mod = (await import(pathToFileURL(resolve(check.script)).href)) as {
        cliMain?: unknown;
      };
      ok(typeof mod.cliMain === "function", `${check.name} exports cliMain()`);
    }
  }

  if (failed === 0) {
    console.log("\ngate-lint-phase: all assertions passed");
    process.exit(0);
  }
  console.error(`\ngate-lint-phase: ${failed} assertion(s) FAILED`);
  process.exit(1);
}

main().catch((err) => {
  console.error("gate-lint-phase: crashed:", err);
  process.exit(1);
});
