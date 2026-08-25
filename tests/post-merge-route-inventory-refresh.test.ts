/* test-registration
{
  "name": "Post-merge route-inventory auto-refresh (Task #4111)",
  "regression": true,
  "smoke": true,
  "scanPaths": ["scripts/post-merge.sh", "scripts/post-merge-route-inventory-refresh.ts"],
  "smokeReason": "Task #4111: two independently-green tasks merged with line-number-only drift in tests/route-inventory.json and turned 3 consecutive nightly runs red until a manual regen. This guard proves the post-merge auto-refresh decision core (stale -> regen -> re-lint -> commit ONLY the inventory artifacts) and its post-merge.sh wiring; a regression here silently re-opens the every-nightly-red failure mode. Pure injected-deps unit test + source-scan wiring checks: no DB, no network, no git.",
  "tier": "small"
}
test-registration */
/**
 * Guard test for scripts/post-merge-route-inventory-refresh.ts.
 *
 * Proves:
 *   1. Fresh inventory: no regen, no commit, exit 0.
 *   2. Stale inventory: regen runs, re-lint clean, commit runs, exit 0.
 *   3. Regen failure: exit 1, loud message, no commit attempted.
 *   4. Still-stale after regen (e.g. duplicate live registrations): the
 *      refreshed artifacts are STILL committed (they are accurate) but
 *      exit 1 so post-merge.sh warns loudly at merge time.
 *   5. Commit failure: exit 1 + loud message.
 *   6. Nothing-to-commit after a clean re-lint: exit 0.
 *   7. Wiring lockstep: post-merge.sh invokes the refresh script (non-fatal,
 *      loud-warn pattern) and the script stages ONLY the two inventory paths.
 */

import { readFileSync } from "node:fs";
import {
  refreshRouteInventoryIfStale,
  INVENTORY_PATHS,
  AUTO_COMMIT_MESSAGE,
  type RefreshDeps,
} from "../scripts/post-merge-route-inventory-refresh";
import type { RouteInventoryLintResult } from "../scripts/lint-route-inventory-freshness";

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

const FRESH: RouteInventoryLintResult = { ok: true, freshCount: 1000, committedCount: 1000, problems: [] };
const STALE: RouteInventoryLintResult = {
  ok: false,
  freshCount: 1000,
  committedCount: 1000,
  problems: ["tests/route-inventory.json is STALE — same route set, but entry details drifted (line numbers, …)"],
};
const DUP: RouteInventoryLintResult = {
  ok: false,
  freshCount: 1000,
  committedCount: 1000,
  problems: ["duplicate live registration for GET /api/x: a.ts:1 wins at dispatch; b.ts:2 is dead code"],
};

interface Trace {
  logs: string[];
  regenCalls: number;
  commitCalls: number;
}

function makeDeps(
  lintResults: RouteInventoryLintResult[],
  regenOk: boolean,
  commitOutcome: "committed" | "nothing-to-commit" | "failed",
): { deps: RefreshDeps; trace: Trace } {
  const trace: Trace = { logs: [], regenCalls: 0, commitCalls: 0 };
  let lintIdx = 0;
  const deps: RefreshDeps = {
    lint: () => lintResults[Math.min(lintIdx++, lintResults.length - 1)],
    regen: () => {
      trace.regenCalls++;
      return regenOk;
    },
    commit: () => {
      trace.commitCalls++;
      return commitOutcome;
    },
    log: (l) => trace.logs.push(l),
  };
  return { deps, trace };
}

function main(): void {
  // 1. Fresh: nothing to do.
  {
    const { deps, trace } = makeDeps([FRESH], true, "committed");
    const r = refreshRouteInventoryIfStale(deps);
    assert(r.outcome === "fresh" && r.exitCode === 0, "fresh inventory: outcome 'fresh', exit 0");
    assert(trace.regenCalls === 0 && trace.commitCalls === 0, "fresh inventory: neither regen nor commit invoked");
  }

  // 2. Stale → regen → clean re-lint → commit → exit 0.
  {
    const { deps, trace } = makeDeps([STALE, FRESH], true, "committed");
    const r = refreshRouteInventoryIfStale(deps);
    assert(r.outcome === "refreshed-committed" && r.exitCode === 0, "stale: regen + commit path exits 0");
    assert(trace.regenCalls === 1 && trace.commitCalls === 1, "stale: regen and commit each invoked once");
    assert(
      trace.logs.some((l) => l.includes("regen-route-inventory.mjs")),
      "stale: log names the regen script",
    );
    assert(r.problemsBefore.length === 1 && r.problemsAfter.length === 0, "stale: before/after problems recorded");
  }

  // 3. Regen failure: exit 1, commit never attempted.
  {
    const { deps, trace } = makeDeps([STALE], false, "committed");
    const r = refreshRouteInventoryIfStale(deps);
    assert(r.outcome === "regen-failed" && r.exitCode === 1, "regen failure: exit 1");
    assert(trace.commitCalls === 0, "regen failure: commit not attempted");
    assert(trace.logs.some((l) => l.includes("regen FAILED")), "regen failure: loud message");
  }

  // 4. Still stale after regen (duplicates): commit still happens, exit 1.
  {
    const { deps, trace } = makeDeps([STALE, DUP], true, "committed");
    const r = refreshRouteInventoryIfStale(deps);
    assert(r.outcome === "still-stale-after-regen" && r.exitCode === 1, "duplicates after regen: exit 1");
    assert(trace.commitCalls === 1, "duplicates after regen: refreshed artifacts still committed");
    assert(
      trace.logs.some((l) => l.includes("STILL FAILING after regen")),
      "duplicates after regen: loud source-fix message",
    );
    assert(r.problemsAfter.some((p) => p.includes("duplicate live registration")), "duplicates surfaced in problemsAfter");
  }

  // 5. Commit failure: exit 1 + loud message.
  {
    const { deps } = makeDeps([STALE, FRESH], true, "failed");
    const r = refreshRouteInventoryIfStale(deps);
    assert(r.outcome === "commit-failed" && r.exitCode === 1, "commit failure: exit 1");
  }

  // 6. Nothing to commit after clean re-lint: exit 0.
  {
    const { deps } = makeDeps([STALE, FRESH], true, "nothing-to-commit");
    const r = refreshRouteInventoryIfStale(deps);
    assert(r.outcome === "refreshed-nothing-to-commit" && r.exitCode === 0, "nothing-to-commit after refresh: exit 0");
  }

  // 7. Wiring lockstep.
  {
    const postMerge = readFileSync("scripts/post-merge.sh", "utf-8");
    assert(
      postMerge.includes("scripts/post-merge-route-inventory-refresh.ts"),
      "post-merge.sh invokes the route-inventory refresh script",
    );
    assert(
      /post-merge-route-inventory-refresh\.ts \|\| \{/.test(postMerge),
      "post-merge.sh treats a refresh failure as a loud non-fatal warning",
    );

    const script = readFileSync("scripts/post-merge-route-inventory-refresh.ts", "utf-8");
    assert(
      script.includes('from "./lint-route-inventory-freshness"') && script.includes("runLint()"),
      "refresh script imports the real lint's runLint (no re-implemented freshness check)",
    );
    assert(
      INVENTORY_PATHS.length === 2 &&
        INVENTORY_PATHS.includes("tests/route-inventory.json") &&
        INVENTORY_PATHS.includes("tests/route-inventory-report.md"),
      "auto-commit stages exactly the two inventory artifacts",
    );
    // The real commit path must scope BOTH the add and the commit to those paths.
    assert(
      script.includes('"--only"') && script.includes("...INVENTORY_PATHS"),
      "git commit uses --only with the inventory paths (never sweeps other worktree changes)",
    );
    assert(AUTO_COMMIT_MESSAGE.includes("route inventory"), "auto-commit message names the route inventory");
  }

  console.log(`\npost-merge-route-inventory-refresh guard: passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main();
