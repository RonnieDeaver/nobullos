/* test-registration
{
  "name": "Server runtime import-cycle gate (Task #3951)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the whole-repository runtime import-cycle lint (scripts/lint-server-import-cycles.ts): positive fixture proves a synthetic static cycle is detected with its complete closed path reported, negative fixtures prove acyclic input and the sanctioned dynamic-import cycle-break boundary pass, an unresolvable-import fixture proves the trace fails loudly instead of passing blind, and the real server graph is asserted acyclic. Pure esbuild source tracing over committed fixtures, no DB. lint-*-named so it stays in the always-run core (the lint reads sources via esbuild, invisible to import tracing).",
  "tier": "small"
}
test-registration */
/**
 * Task #3951 — guard test for the runtime import-cycle gate.
 *
 * The lint traces the static runtime import graph of server/ + shared/ with
 * the repository-native esbuild frontier-BFS tracer and fails on ANY cycle,
 * printing the complete cycle path. There is deliberately NO allow-list —
 * the enforced baseline is zero cycles. This test drives the pure engine
 * (findImportCycles / findCyclesInGraph / runLint) against committed
 * fixture trees under tests/fixtures/import-cycles/:
 *
 *   1. cyclic/         a → b → c → a static cycle: detected, full closed
 *                      path reported, and the CLI message names every module.
 *   2. self-loop/      a module statically importing itself: detected.
 *   3. acyclic/        a → b → c chain: passes with zero cycles.
 *   4. dynamic-break/  d1 → d2 static, d2 → d1 only via literal dynamic
 *                      import(): passes — deferred lazy imports are the
 *                      sanctioned cycle-break boundary (apiPoolPressureTuning,
 *                      mcu/worker, semrushApi all rely on it).
 *   5. missing-import/ an unresolvable relative import: the trace FAILS
 *                      (ok=false with an error) — the gate must never pass
 *                      vacuously on an incomplete graph.
 *   6. The real repository graph (server/ + shared/) is acyclic — the same
 *      assertion the gate enforces, run through the public runLint().
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  findImportCycles,
  findCyclesInGraph,
  runLint,
  DEFAULT_ENTRY_DIRS,
} from "../scripts/lint-server-import-cycles";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIX = resolve(ROOT, "tests/fixtures/import-cycles");

let failed = 0;
function check(cond: boolean, okMsg: string, failMsg: string): void {
  if (cond) {
    console.log(`  ok  ${okMsg}`);
  } else {
    console.error(`  FAIL ${failMsg}`);
    failed++;
  }
}

async function main(): Promise<void> {
  console.log("\n=== Server runtime import-cycle gate guard (Task #3951) ===");

  // ── 1. Positive fixture: static 3-node cycle detected with full path ──
  {
    const r = await findImportCycles(resolve(FIX, "cyclic"), ["."]);
    check(r.error === null, "cyclic fixture traces cleanly", `cyclic fixture trace error: ${r.error}`);
    check(!r.ok && r.cycles.length === 1, "exactly one cycle detected in cyclic fixture", `expected 1 cycle, got ${r.cycles.length} (ok=${r.ok})`);
    const cycle = r.cycles[0] ?? [];
    check(
      cycle.length === 4 && cycle[0] === cycle[cycle.length - 1],
      "cycle path is closed (first module repeated at the end)",
      `cycle path not closed: ${cycle.join(" → ")}`,
    );
    for (const member of ["a.ts", "b.ts", "c.ts"]) {
      check(
        cycle.some((p) => p.endsWith(member)),
        `cycle path names ${member}`,
        `cycle path is missing ${member}: ${cycle.join(" → ")}`,
      );
    }
    const lint = await runLint(resolve(FIX, "cyclic"), ["."]);
    check(!lint.ok, "runLint fails on the cyclic fixture", "runLint passed a cyclic graph");
    check(
      ["a.ts", "b.ts", "c.ts"].every((m) => lint.message.includes(m)),
      "failure message names every module in the cycle",
      `failure message incomplete: ${lint.message}`,
    );
    check(
      lint.message.includes("NO allow-list") && lint.message.includes("Break the cycle"),
      "failure message states the zero-cycle no-allow-list baseline",
      "failure message should direct to breaking the cycle, never allow-listing it",
    );
  }

  // ── 2. Self-loop detected ──
  {
    const r = await findImportCycles(resolve(FIX, "self-loop"), ["."]);
    check(
      !r.ok && r.cycles.length === 1 && r.cycles[0][0] === r.cycles[0][1],
      "static self-import is detected as a cycle",
      `self-loop not detected: ok=${r.ok} cycles=${JSON.stringify(r.cycles)}`,
    );
  }

  // ── 3. Negative fixture: acyclic chain passes ──
  {
    const r = await findImportCycles(resolve(FIX, "acyclic"), ["."]);
    check(
      r.ok && r.cycles.length === 0 && r.error === null,
      "acyclic fixture passes with zero cycles",
      `acyclic fixture failed: ok=${r.ok} cycles=${r.cycles.length} error=${r.error}`,
    );
    check(r.fileCount === 3 && r.edgeCount === 2, "acyclic fixture traced 3 files / 2 edges (trace is not vacuous)", `unexpected trace shape: ${r.fileCount} files / ${r.edgeCount} edges`);
    const lint = await runLint(resolve(FIX, "acyclic"), ["."]);
    check(lint.ok && lint.message.includes("zero runtime import cycles"), "runLint passes the acyclic fixture", `runLint failed acyclic fixture: ${lint.message}`);
  }

  // ── 4. Dynamic-import back-edge is the sanctioned break boundary ──
  {
    const r = await findImportCycles(resolve(FIX, "dynamic-break"), ["."]);
    check(
      r.ok && r.cycles.length === 0,
      "literal dynamic import() back-edge does NOT count as a cycle (sanctioned lazy boundary)",
      `dynamic-break fixture flagged: ${JSON.stringify(r.cycles)}`,
    );
    check(
      r.fileCount === 2 && r.edgeCount === 1,
      "dynamic target still traversed (2 files) with only the static edge recorded (1 edge)",
      `unexpected dynamic-break trace shape: ${r.fileCount} files / ${r.edgeCount} edges`,
    );
  }

  // ── 5. Unresolvable import: fail loudly, never pass blind ──
  {
    const r = await findImportCycles(resolve(FIX, "missing-import"), ["."]);
    check(
      !r.ok && r.error !== null && r.error.includes("nope"),
      "unresolvable relative import fails the trace (no vacuous pass)",
      `missing-import fixture did not fail loudly: ok=${r.ok} error=${r.error}`,
    );
    const lint = await runLint(resolve(FIX, "missing-import"), ["."]);
    check(
      !lint.ok && lint.message.includes("TRACE FAILED"),
      "runLint reports the trace failure as a violation",
      `runLint hid a trace failure: ${lint.message}`,
    );
  }

  // ── 6. Pure graph engine sanity (deterministic SCC/path extraction) ──
  {
    const edges = new Map<string, Set<string>>([
      ["x", new Set(["y"])],
      ["y", new Set(["z"])],
      ["z", new Set(["x"])],
      ["p", new Set(["q"])],
      ["q", new Set(["p"])],
      ["lone", new Set(["x"])],
    ]);
    const cycles = findCyclesInGraph(edges);
    check(cycles.length === 2, "graph engine finds both independent cycles", `expected 2 cycles, got ${cycles.length}`);
    check(
      cycles.every((c) => c[0] === c[c.length - 1] && c.length >= 3),
      "every reported cycle path is closed",
      `unclosed cycle path: ${JSON.stringify(cycles)}`,
    );
    const again = findCyclesInGraph(edges);
    check(
      JSON.stringify(cycles) === JSON.stringify(again),
      "cycle report is deterministic across runs",
      "cycle report order/content varies between identical runs",
    );
  }

  // ── 7. The real server graph is acyclic (the enforced baseline) ──
  {
    const lint = await runLint(ROOT, DEFAULT_ENTRY_DIRS);
    check(
      lint.ok,
      `real repository graph is acyclic: ${lint.message}`,
      `the real server graph has a runtime import cycle — the gate enforces zero:\n${lint.message}`,
    );
  }
}

main()
  .then(async () => {
    // Stop the esbuild service child so the process drains naturally.
    try {
      const esb = await import("esbuild");
      await esb.stop();
    } catch {
      /* nothing to stop */
    }
    if (failed > 0) {
      console.error(`\n${failed} import-cycle gate check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll server import-cycle gate checks passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ lint-server-import-cycles guard crashed:", err);
    process.exit(1);
  });
