/* test-registration
{
  "name": "Post-merge generated-artifact auto-refresh (Task #4115)",
  "regression": true,
  "smoke": true,
  "scanPaths": ["scripts/post-merge.sh", "scripts/post-merge-generated-artifact-refresh.ts", "scripts/post-merge-route-inventory-refresh.ts", "scripts/governanceInventoryLib.ts", "website/public", "website/generate.ts"],
  "smokeReason": "Task #4115: the Task #4111 route-inventory auto-refresh regenerates tests/route-inventory.json post-merge, which immediately stales the contract table generated FROM it (lint-contract-table-freshness went red twice on 2026-08-08 until manual regens); website/public's input-fingerprint stamp can likewise mismatch the merged union of inputs; Task #4189 added the four governance inventories (audits/governance/*) with the same parallel-merge staleness mode. This guard proves the generic decision core (stale -> regen -> re-lint -> commit ONLY the artifact paths), all six artifact specs, and the post-merge.sh ordering (AFTER the route-inventory refresh). Pure injected-deps unit test + source-scan wiring checks: no DB, no network, no git.",
  "tier": "small"
}
test-registration */
/**
 * Guard test for scripts/post-merge-generated-artifact-refresh.ts.
 *
 * Proves:
 *   1. Fresh artifact: no regen, no commit, exit 0.
 *   2. Stale artifact: regen runs, re-lint clean, commit runs, exit 0.
 *   3. Regen failure: exit 1, loud message, no commit attempted.
 *   4. Still-stale after regen: refreshed artifacts STILL committed, exit 1.
 *   5. Commit failure: exit 1 + loud message.
 *   6. Nothing-to-commit after a clean re-lint: exit 0.
 *   7. Artifact specs: exactly the contract-table + website-bundle + four
 *      governance-inventory artifacts, correct paths/regen commands,
 *      freshness checks imported from the real lint modules / the
 *      generators' own generate()+checkArtifact (no re-implemented checks).
 *   8. Wiring lockstep: post-merge.sh invokes the refresh script (non-fatal,
 *      loud-warn pattern) AFTER the route-inventory refresh, and the script
 *      commits with --only scoped to the artifact paths.
 */

import { readFileSync } from "node:fs";
import {
  refreshArtifactIfStale,
  ARTIFACTS,
  type ArtifactSpec,
  type RefreshDeps,
  type FreshnessLintResult,
} from "../scripts/post-merge-generated-artifact-refresh";

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

const SPEC: ArtifactSpec = {
  name: "fixture-artifact",
  paths: ["audits/fixture.md", "audits/fixture.json"],
  regenCommand: "node scripts/fixture-regen.mjs",
  commitMessage: "post-merge: fixture",
};

const FRESH: FreshnessLintResult = { ok: true, problems: [] };
const STALE: FreshnessLintResult = {
  ok: false,
  problems: ["audits/fixture.json is STALE — handler file:line drifted"],
};
const SOURCE_BUG: FreshnessLintResult = {
  ok: false,
  problems: ["duplicate live registration — a source bug regen cannot fix"],
};

interface Trace {
  logs: string[];
  regenCalls: number;
  commitCalls: number;
}

function makeDeps(
  lintResults: FreshnessLintResult[],
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
    const r = refreshArtifactIfStale(SPEC, deps);
    assert(r.outcome === "fresh" && r.exitCode === 0, "fresh artifact: outcome 'fresh', exit 0");
    assert(
      trace.regenCalls === 0 && trace.commitCalls === 0,
      "fresh artifact: neither regen nor commit invoked",
    );
  }

  // 2. Stale → regen → clean re-lint → commit → exit 0.
  {
    const { deps, trace } = makeDeps([STALE, FRESH], true, "committed");
    const r = refreshArtifactIfStale(SPEC, deps);
    assert(
      r.outcome === "refreshed-committed" && r.exitCode === 0,
      "stale: regen + commit path exits 0",
    );
    assert(trace.regenCalls === 1 && trace.commitCalls === 1, "stale: regen and commit each invoked once");
    assert(
      trace.logs.some((l) => l.includes(SPEC.regenCommand)),
      "stale: log names the artifact's regen command",
    );
    assert(
      r.problemsBefore.length === 1 && r.problemsAfter.length === 0,
      "stale: before/after problems recorded",
    );
  }

  // 3. Regen failure: exit 1, commit never attempted.
  {
    const { deps, trace } = makeDeps([STALE], false, "committed");
    const r = refreshArtifactIfStale(SPEC, deps);
    assert(r.outcome === "regen-failed" && r.exitCode === 1, "regen failure: exit 1");
    assert(trace.commitCalls === 0, "regen failure: commit not attempted");
    assert(trace.logs.some((l) => l.includes("regen FAILED")), "regen failure: loud message");
  }

  // 4. Still stale after regen: commit still happens, exit 1.
  {
    const { deps, trace } = makeDeps([STALE, SOURCE_BUG], true, "committed");
    const r = refreshArtifactIfStale(SPEC, deps);
    assert(
      r.outcome === "still-stale-after-regen" && r.exitCode === 1,
      "source bug after regen: exit 1",
    );
    assert(trace.commitCalls === 1, "source bug after regen: refreshed artifacts still committed");
    assert(
      trace.logs.some((l) => l.includes("STILL FAILING after regen")),
      "source bug after regen: loud source-fix message",
    );
    assert(
      r.problemsAfter.some((p) => p.includes("source bug")),
      "remaining problems surfaced in problemsAfter",
    );
  }

  // 5. Commit failure: exit 1 + loud message.
  {
    const { deps, trace } = makeDeps([STALE, FRESH], true, "failed");
    const r = refreshArtifactIfStale(SPEC, deps);
    assert(r.outcome === "commit-failed" && r.exitCode === 1, "commit failure: exit 1");
    assert(trace.logs.some((l) => l.includes("COMMIT FAILED")), "commit failure: loud message");
  }

  // 6. Nothing to commit after clean re-lint: exit 0.
  {
    const { deps } = makeDeps([STALE, FRESH], true, "nothing-to-commit");
    const r = refreshArtifactIfStale(SPEC, deps);
    assert(
      r.outcome === "refreshed-nothing-to-commit" && r.exitCode === 0,
      "nothing-to-commit after refresh: exit 0",
    );
  }

  // 7. Artifact specs.
  {
    assert(ARTIFACTS.length === 6, "exactly six artifact specs registered");
    const contract = ARTIFACTS.find((a) => a.name === "endpoint-contract-table");
    assert(
      !!contract &&
        contract.paths.length === 2 &&
        contract.paths.includes("audits/D-endpoint-contract-table.md") &&
        contract.paths.includes("audits/D-endpoint-contract-table.json") &&
        contract.regenCommand.includes("generate-endpoint-contract-table.mjs"),
      "contract-table spec covers both audits/D-endpoint-contract-table artifacts with the real generator",
    );
    const website = ARTIFACTS.find((a) => a.name === "website-bundle");
    assert(
      !!website &&
        website.paths.length === 1 &&
        website.paths[0] === "website/public" &&
        website.regenCommand.includes("website/generate.ts"),
      "website-bundle spec commits website/public via the real generator",
    );

    // Task #4189: the four governance inventories, each committing exactly
    // its own artifact path via the real generator command, freshness-checked
    // through the generators' own generate() + checkArtifact (the exact
    // functions behind their --check) — never a re-implemented comparison.
    const governance: Array<[string, string, string]> = [
      [
        "governance-data-ownership",
        "audits/governance/data-ownership.json",
        "generate-data-ownership-inventory.ts",
      ],
      [
        "governance-integration-reliability",
        "audits/governance/integration-reliability.json",
        "generate-integration-reliability-inventory.ts",
      ],
      [
        "governance-async-topology",
        "audits/governance/async-topology.json",
        "generate-async-topology-inventory.ts",
      ],
      [
        "governance-test-portfolio-baseline",
        "audits/governance/test-portfolio-baseline.json",
        "generate-test-portfolio-baseline.ts",
      ],
    ];
    for (const [name, path, generator] of governance) {
      const spec = ARTIFACTS.find((a) => a.name === name);
      assert(
        !!spec &&
          spec.paths.length === 1 &&
          spec.paths[0] === path &&
          spec.regenCommand.includes(generator),
        `${name} spec commits ONLY ${path} via the real generator`,
      );
    }

    const script = readFileSync("scripts/post-merge-generated-artifact-refresh.ts", "utf-8");
    assert(
      script.includes('from "./lint-contract-table-freshness"') &&
        script.includes('from "./lint-website-bundle-freshness"'),
      "refresh script imports the real lints' runLint (no re-implemented freshness checks)",
    );
    assert(
      script.includes('from "./governanceInventoryLib"') &&
        script.includes("checkArtifact(artifactPath, generate())"),
      "governance freshness reuses checkArtifact + each generator's generate() (the exact --check logic)",
    );
    assert(
      script.includes('"--only"') && script.includes("...spec.paths"),
      "git commit uses --only with the artifact paths (never sweeps other worktree changes)",
    );
  }

  // 8. Wiring lockstep.
  {
    const postMerge = readFileSync("scripts/post-merge.sh", "utf-8");
    assert(
      postMerge.includes("scripts/post-merge-generated-artifact-refresh.ts"),
      "post-merge.sh invokes the generated-artifact refresh script",
    );
    assert(
      /post-merge-generated-artifact-refresh\.ts \|\| \{/.test(postMerge),
      "post-merge.sh treats a refresh failure as a loud non-fatal warning",
    );
    const routeIdx = postMerge.indexOf("scripts/post-merge-route-inventory-refresh.ts");
    const artifactIdx = postMerge.indexOf("scripts/post-merge-generated-artifact-refresh.ts");
    assert(
      routeIdx !== -1 && artifactIdx !== -1 && artifactIdx > routeIdx,
      "generated-artifact refresh runs AFTER the route-inventory refresh (contract table is generated FROM the inventory)",
    );
  }

  console.log(`\npost-merge-generated-artifact-refresh guard: passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main();
