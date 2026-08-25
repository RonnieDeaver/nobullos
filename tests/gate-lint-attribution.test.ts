/* test-registration
{
  "name": "Gate lint-inheritance rails: classification matrix, excusal arming, self-heal outcomes, registry lockstep (Task #4533)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4533 (planned as Task #4491 step 7): scripts/gateLintAttribution.ts decides whether a gate LINT red may be excused as inherited from the task's base tree — the one thing this machinery must never do is excuse a failure the task itself caused. Mostly pure fixture tests (injected deps, tmpdir fs, no DB, no network); one Task #4604 end-to-end case additionally exercises the REAL capture channels (gate worker thread + disposable git worktree + capture-CLI child) against a tmpdir git repo, proving identical inherited offenses classify inherited instead of being blamed on the task. A regression here silently converts the gate's lint phase into a rubber stamp — or back into manual innocence archaeology.",
  "scanPaths": [
    "scripts/gate.ts",
    "scripts/gateLintAttribution.ts",
    "scripts/predeploy.sh",
    "scripts/post-merge-route-inventory-refresh.ts",
    "scripts/post-merge-generated-artifact-refresh.ts",
    "tests/run-all.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4533 — Guard-test slate for the Task #4491 gate lint-failure rails
 * (scripts/gateLintAttribution.ts). Proves, against the PURE injectable seams:
 *
 *   1. Classification matrix: base-green / signature-mismatch / A-B error /
 *      timeout / budget-exhausted / missing base run / task-diff-intersect /
 *      lint-script-touch / harness-touch / classification error — ALL fall
 *      open to "yours"; only the identical-offense untouched-diff chain earns
 *      "inherited".
 *   2. Excusal arming: decideLintExcusals excuses ONLY inherited verdicts and
 *      ONLY when armed; the kill-switch env name is pinned; gate.ts is the
 *      sole runGateLintFailureRails call site (run-all/predeploy never call).
 *   3. Offense normalization: deliberately UNDER-normalizes (prefix strip,
 *      duration/timestamp neutralization, line endings) — different offense
 *      text yields different signatures; exit codes always split signatures.
 *   4. Self-heal outcome matrix (injected deps): pre-dirty skip, regen fail,
 *      out-of-spec writes reverted, non-converged reverted, commit failure,
 *      artifact-only happy paths, and a throwing dep degrading (never
 *      throwing out).
 *   5. GATE_SELF_HEAL_SPECS lockstep with the post-merge regen registries
 *      (scripts/post-merge-route-inventory-refresh.ts INVENTORY_PATHS and
 *      scripts/post-merge-generated-artifact-refresh.ts ARTIFACTS) and with
 *      LINT_CHECKS itself.
 *   6. Attribution-report §lints round-trip: gate writes the section
 *      (schemaVersion 4, preserving foreign keys); the suite-side writer
 *      (tests/redManifest.ts attributeRunFailures) carries a FRESH section
 *      forward and drops a stale one.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTRIBUTION_REPORT_LINTS_FRESH_MS,
  DEFAULT_AB_OVERALL_BUDGET_MS,
  DEFAULT_AB_PER_LINT_TIMEOUT_MS,
  GATE_HARNESS_PATHS,
  GATE_LINT_AB_BUDGET_ENV,
  GATE_LINT_EXCUSE_KILL_SWITCH_ENV,
  GATE_LINT_SELFHEAL_KILL_SWITCH_ENV,
  GATE_SELF_HEAL_SPECS,
  classifyLintFailure,
  decideLintExcusals,
  normalizeOffenseOutput,
  offenseSignature,
  parsePorcelainPaths,
  pathInSpec,
  runBaseTreeLints,
  selfHealFreshnessLint,
  writeLintSectionIntoAttributionReport,
  type BaseLintRun,
  type GateSelfHealSpec,
  type LintAttributionVerdict,
  type LintFailureForAttribution,
  type SelfHealDeps,
  type SelfHealStatusEntry,
} from "../scripts/gateLintAttribution";
import { LINT_CHECKS, runLintPhase } from "../scripts/gate";
import { attributeRunFailures } from "./redManifest";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const OFFENSE = "scripts/foo.ts:12 uses a bare array binding\nlint-fixture: 1 problem\n";

function failure(over?: Partial<LintFailureForAttribution>): LintFailureForAttribution {
  return {
    name: "lint-fixture",
    script: "scripts/lint-fixture.ts", // fs-scan-inputs-ignore -- fixture lint-script name, never read
    exitCode: 1,
    outputText: OFFENSE,
    ...over,
  };
}

function ranBase(over?: Partial<BaseLintRun>): BaseLintRun {
  return {
    name: "lint-fixture",
    status: "ran",
    exitCode: 1,
    output: OFFENSE,
    durationMs: 100,
    ...over,
  };
}

const identity = (raw: string) => normalizeOffenseOutput(raw, []);

function classify(over: {
  failure?: Partial<LintFailureForAttribution>;
  baseRun?: BaseLintRun | undefined;
  taskDiffFiles?: string[];
  harnessPaths?: readonly string[];
  normalize?: (raw: string) => string;
}): LintAttributionVerdict {
  return classifyLintFailure({
    failure: failure(over.failure),
    baseRun: "baseRun" in over ? over.baseRun : ranBase(),
    taskDiffFiles: over.taskDiffFiles ?? ["client/src/unrelated.tsx"], // fs-scan-inputs-ignore -- fixture task-diff filename, never read
    harnessPaths: over.harnessPaths,
    normalize: over.normalize ?? identity,
  });
}

// ---------------------------------------------------------------------------
// 1. Classification matrix — everything weaker than the full chain is "yours"
// ---------------------------------------------------------------------------

test("inherited happy path: identical offense at base + task diff touching nothing guarded", () => {
  const v = classify({});
  assert.equal(v.verdict, "inherited");
  assert.equal(v.excused, false, "classification NEVER excuses by itself — only decideLintExcusals may");
  assert.equal(v.baseSignature, v.headSignature, "identical offense set proven by signature equality");
  assert.ok(v.evidence.some((e) => e.includes("identical offense signature at base tree")));
  assert.ok(v.evidence.some((e) => e.includes("touches neither")));
});

test("base GREEN ⇒ yours: the offense is introduced by the task's tree", () => {
  const v = classify({ baseRun: ranBase({ exitCode: 0, output: "all clean\n" }) });
  assert.equal(v.verdict, "yours");
  assert.ok(v.evidence.some((e) => e.includes("GREEN at the base tree")));
});

test("signature mismatch ⇒ yours: the task tree changes the offense set", () => {
  // Same exit code, one extra offense line at head — a task that ADDS an
  // offense on top of an inherited one must own the whole red.
  const v = classify({
    failure: { outputText: `${OFFENSE}scripts/bar.ts:9 second offense added by the task\n` },
  });
  assert.equal(v.verdict, "yours");
  assert.ok(v.evidence.some((e) => e.includes("offense signature differs at base")));
  assert.notEqual(v.headSignature, v.baseSignature);
});

test("different exit code at base ⇒ yours (exit code is part of the signature)", () => {
  const v = classify({ baseRun: ranBase({ exitCode: 2 }) });
  assert.equal(v.verdict, "yours");
});

test("A/B spawn error / timeout / budget-exhausted / missing base run ⇒ ALL yours", () => {
  for (const status of ["spawn-error", "timeout", "budget-exhausted"] as const) {
    const v = classify({ baseRun: ranBase({ status, exitCode: null, output: "", detail: "boom" }) });
    assert.equal(v.verdict, "yours", `${status} must fall open to yours`);
    assert.equal(v.baseSignature, null, `${status}: no base signature is claimed`);
    assert.ok(v.evidence.some((e) => e.includes(status) && e.includes("fall-open")));
  }
  const missing = classify({ baseRun: undefined });
  assert.equal(missing.verdict, "yours", "no base run recorded (budget) must fall open to yours");
  assert.ok(missing.evidence.some((e) => e.includes("no A/B base run")));
});

test("task diff intersecting the offense output ⇒ yours even with an identical base offense", () => {
  const v = classify({ taskDiffFiles: ["scripts/foo.ts"] }); // fs-scan-inputs-ignore -- fixture offense text, never read
  assert.equal(v.verdict, "yours", "a task-touched file named in the offense is never excused");
  assert.ok(v.evidence.some((e) => e.includes("task-touched file(s) appear in the offense output")));
  assert.ok(v.evidence.some((e) => e.includes("scripts/foo.ts"))); // fs-scan-inputs-ignore -- fixture offense text assertion, never read
});

test("task diff touching the lint's OWN script ⇒ yours (identical offense notwithstanding)", () => {
  const v = classify({ taskDiffFiles: ["scripts/lint-fixture.ts"] }); // fs-scan-inputs-ignore -- fixture task-diff filename, never read
  assert.equal(v.verdict, "yours");
  assert.ok(v.evidence.some((e) => e.includes("never excused")));
});

test("task diff touching the gate harness ⇒ yours, for every default harness path", () => {
  assert.deepEqual(
    [...GATE_HARNESS_PATHS].sort(),
    ["scripts/gate-lint-ab-capture.mjs", "scripts/gate-lint-worker.mjs", "scripts/gate.ts", "scripts/gateLintAttribution.ts"].sort(), // fs-scan-inputs-ignore -- pinned harness path constants compared as strings, never read
    "the harness guard covers the gate entry, the worker, the A/B capture CLI, and this rails module itself",
  );
  for (const harnessFile of GATE_HARNESS_PATHS) {
    const v = classify({ taskDiffFiles: [harnessFile] });
    assert.equal(v.verdict, "yours", `${harnessFile} edits must force yours`);
  }
});

test("classification error (throwing normalize on the base output) ⇒ yours, never a throw out", () => {
  let calls = 0;
  const v = classify({
    normalize: (raw: string) => {
      // First call computes the head signature; throw on the base-side call
      // so the error happens mid-classification.
      // Call 1 = head signature (outside the try); call 2 = base-side
      // signature (inside); call 3 = the fall-open yours() rebuild.
      calls++;
      if (calls === 2) throw new Error("normalize exploded");
      return identity(raw);
    },
  });
  assert.equal(v.verdict, "yours");
  assert.ok(v.evidence.some((e) => e.includes("classification error") && e.includes("fall-open")));
});

// ---------------------------------------------------------------------------
// 2. Excusal arming
// ---------------------------------------------------------------------------

test("decideLintExcusals: armed excuses ONLY inherited; disarmed excuses NOTHING; 'yours' is never excusable", () => {
  const make = (): LintAttributionVerdict[] => [
    classify({}), // inherited
    classify({ baseRun: ranBase({ exitCode: 0, output: "clean\n" }) }), // yours
  ];

  const armed = make();
  const armedCounts = decideLintExcusals(armed, { armed: true });
  assert.deepEqual(armedCounts, { excusedCount: 1, blockingCount: 1 });
  assert.equal(armed[0].excused, true);
  assert.equal(armed[1].excused, false, "a 'yours' verdict is structurally inexcusable");

  const disarmed = make();
  const disarmedCounts = decideLintExcusals(disarmed, { armed: false });
  assert.deepEqual(disarmedCounts, { excusedCount: 0, blockingCount: 2 });
  assert.ok(disarmed.every((v) => v.excused === false), "disarmed (kill switch) excuses nothing");
});

test("kill-switch/budget env names are pinned (rows in the G-docs tables reference them verbatim)", () => {
  assert.equal(GATE_LINT_EXCUSE_KILL_SWITCH_ENV, "GATE_LINT_ATTRIBUTION_EXCUSE");
  assert.equal(GATE_LINT_SELFHEAL_KILL_SWITCH_ENV, "GATE_LINT_SELFHEAL");
  assert.equal(GATE_LINT_AB_BUDGET_ENV, "GATE_LINT_AB_BUDGET_MS");
  assert.ok(DEFAULT_AB_PER_LINT_TIMEOUT_MS <= DEFAULT_AB_OVERALL_BUDGET_MS, "per-lint cap fits inside the overall budget");
});

test("wiring pin (fs): gate.ts is the ONLY runGateLintFailureRails call site; publish/nightly and predeploy never consult the rails", () => {
  const gate = readFileSync("scripts/gate.ts", "utf8");
  assert.ok(gate.includes("runGateLintFailureRails({"), "gate.ts calls the rails on lint reds");
  const runAll = readFileSync("tests/run-all.ts", "utf8");
  assert.ok(
    !runAll.includes("runGateLintFailureRails"),
    "the nightly publish run's report-only lint phase must never consult the excusal rails",
  );
  const predeploy = readFileSync("scripts/predeploy.sh", "utf8");
  assert.ok(
    !predeploy.includes("gateLintAttribution") && !predeploy.includes("runGateLintFailureRails"),
    "predeploy runs lints bare — deploys are untouched by excusal by design",
  );
  // Both kill switches are read at call time inside the rails module (not
  // captured at import) so tests and operators can flip them live.
  const rails = readFileSync("scripts/gateLintAttribution.ts", "utf8");
  assert.ok(rails.includes(`env[GATE_LINT_EXCUSE_KILL_SWITCH_ENV] !== "0"`), "excusal arming reads the env at call time");
  assert.ok(rails.includes(`env[GATE_LINT_SELFHEAL_KILL_SWITCH_ENV] !== "0"`), "self-heal arming reads the env at call time");
});

// ---------------------------------------------------------------------------
// 3. Offense normalization + signatures
// ---------------------------------------------------------------------------

test("normalizeOffenseOutput: strips path prefixes, neutralizes durations/timestamps, normalizes line endings + trailing space", () => {
  const main = "/home/runner/workspace";
  const worktree = "/tmp/gate-lint-ab-123";
  const atMain = `${main}/scripts/foo.ts:12 offense (took 431ms at 2026-08-12T01:02:03.456Z)   \r\n`;
  const atWorktree = `${worktree}/scripts/foo.ts:12 offense (took 2.1s at 2026-08-11T23:59:59Z)\n`;
  const n1 = normalizeOffenseOutput(atMain, [main, worktree]);
  const n2 = normalizeOffenseOutput(atWorktree, [main, worktree]);
  assert.equal(n1, n2, "same repo-relative offense normalizes identically across trees");
  assert.ok(n1.includes("scripts/foo.ts:12"), "the offense location survives normalization"); // fs-scan-inputs-ignore -- fixture offense text, never read
  assert.ok(!n1.includes(main) && !n1.includes("<t>431"), "prefixes and raw durations are gone");

  // UNDER-normalization is the safety property: any real textual difference
  // (an extra offense, a different file) must survive and split signatures.
  const extra = normalizeOffenseOutput(`${atMain}scripts/bar.ts:9 second offense\n`, [main, worktree]);
  assert.notEqual(n1, extra, "a real extra offense is never normalized away");
});

test("offenseSignature: exit code and normalized output both split signatures", () => {
  const a = offenseSignature(1, "x\n");
  assert.equal(a, offenseSignature(1, "x\n"), "deterministic");
  assert.notEqual(a, offenseSignature(2, "x\n"), "exit code is part of the signature");
  assert.notEqual(a, offenseSignature(1, "y\n"), "output is part of the signature");
  assert.match(a, /^exit=1:sha256=[0-9a-f]{16}$/);
});

test("parsePorcelainPaths: plain entries, renames (both sides), quoted paths", () => {
  const out = parsePorcelainPaths(
    [" M scripts/a.ts", "?? tests/new.test.ts", 'R  "old name.ts" -> "new name.ts"', ""].join("\n"),
  );
  assert.ok(out.includes("scripts/a.ts")); // fs-scan-inputs-ignore -- fixture porcelain output, never read
  assert.ok(out.includes("tests/new.test.ts"));
  assert.ok(out.includes("old name.ts") && out.includes("new name.ts"), "renames contribute both sides");
});

// ---------------------------------------------------------------------------
// 4. Self-heal outcome matrix (injected deps — the pure decision core)
// ---------------------------------------------------------------------------

const SPEC: GateSelfHealSpec = {
  lintName: "lint-fixture-freshness",
  artifactPaths: ["tests/fixture-artifact.json", "generated/dir"],
  regenArgv: ["node", "scripts/regen-fixture.mjs"], // fs-scan-inputs-ignore -- fixture generator argv, never executed or read
  commitMessage: "gate: fixture regen",
};

interface HealTrace {
  regenCalled: boolean;
  relintCalled: boolean;
  commitCalled: boolean;
  reverted: SelfHealStatusEntry[][];
  logs: string[];
}

function healDeps(over: {
  statusSeq?: SelfHealStatusEntry[][];
  regen?: boolean | (() => boolean);
  relint?: boolean;
  commit?: "committed" | "nothing-to-commit" | "failed";
}): { deps: SelfHealDeps; trace: HealTrace } {
  const trace: HealTrace = { regenCalled: false, relintCalled: false, commitCalled: false, reverted: [], logs: [] };
  const statusSeq = over.statusSeq ?? [[], []];
  let statusCall = 0;
  const deps: SelfHealDeps = {
    status: () => statusSeq[Math.min(statusCall++, statusSeq.length - 1)],
    regen: () => {
      trace.regenCalled = true;
      return typeof over.regen === "function" ? over.regen() : (over.regen ?? true);
    },
    relint: () => {
      trace.relintCalled = true;
      return over.relint ?? true;
    },
    revert: (entries) => {
      trace.reverted.push(entries);
    },
    commit: () => {
      trace.commitCalled = true;
      return over.commit ?? "committed";
    },
    log: (line) => trace.logs.push(line),
  };
  return { deps, trace };
}

test("self-heal: artifact path dirty BEFORE regen ⇒ skipped-pre-dirty, generator never runs (task work in flight is sacred)", () => {
  const { deps, trace } = healDeps({
    statusSeq: [[{ path: "tests/fixture-artifact.json", untracked: false }]],
  });
  const res = selfHealFreshnessLint(SPEC, deps);
  assert.equal(res.outcome, "skipped-pre-dirty");
  assert.ok(res.detail.includes("tests/fixture-artifact.json"));
  assert.equal(trace.regenCalled, false, "regen must NOT run over possibly-in-flight task edits");
  assert.equal(trace.commitCalled, false);
});

test("self-heal: unrelated pre-dirty files do NOT block healing", () => {
  const dirty: SelfHealStatusEntry = { path: "server/routes.ts", untracked: false }; // fs-scan-inputs-ignore -- fixture dirty-worktree path, never read
  const { deps, trace } = healDeps({
    statusSeq: [[dirty], [dirty, { path: "tests/fixture-artifact.json", untracked: false }]],
  });
  const res = selfHealFreshnessLint(SPEC, deps);
  assert.equal(res.outcome, "healed-committed");
  assert.equal(trace.reverted.length, 0);
});

test("self-heal: regen failure ⇒ regen-failed, nothing committed", () => {
  const { deps, trace } = healDeps({ regen: false });
  const res = selfHealFreshnessLint(SPEC, deps);
  assert.equal(res.outcome, "regen-failed");
  assert.equal(trace.commitCalled, false);
  assert.equal(trace.relintCalled, false);
});

test("self-heal: regen writing OUTSIDE the registered artifact paths ⇒ ALL its writes reverted, never committed", () => {
  const inSpec: SelfHealStatusEntry = { path: "generated/dir/output.json", untracked: true };
  const outside: SelfHealStatusEntry = { path: "server/storage.ts", untracked: false }; // fs-scan-inputs-ignore -- fixture out-of-spec write path, never read
  const { deps, trace } = healDeps({ statusSeq: [[], [inSpec, outside]] });
  const res = selfHealFreshnessLint(SPEC, deps);
  assert.equal(res.outcome, "out-of-spec-writes");
  assert.ok(res.detail.includes("server/storage.ts"), "the surprising path is named"); // fs-scan-inputs-ignore -- fixture out-of-spec write path, never read
  assert.equal(trace.commitCalled, false, "a generator that surprises us never auto-commits");
  assert.deepEqual(trace.reverted, [[inSpec, outside]], "the ENTIRE regen write set is reverted, tree left as found");
});

test("self-heal: lint still red after regen ⇒ not-converged, regen writes reverted, never committed", () => {
  const written: SelfHealStatusEntry = { path: "tests/fixture-artifact.json", untracked: false };
  const { deps, trace } = healDeps({ statusSeq: [[], [written]], relint: false });
  const res = selfHealFreshnessLint(SPEC, deps);
  assert.equal(res.outcome, "not-converged");
  assert.equal(trace.commitCalled, false);
  assert.deepEqual(trace.reverted, [[written]]);
});

test("self-heal: converged green ⇒ artifact-only commit (committed / nothing-to-commit / commit-failed)", () => {
  const written: SelfHealStatusEntry = { path: "tests/fixture-artifact.json", untracked: false };
  const committed = selfHealFreshnessLint(SPEC, healDeps({ statusSeq: [[], [written]] }).deps);
  assert.equal(committed.outcome, "healed-committed");
  assert.ok(committed.detail.includes("artifact-only"));

  const nothing = selfHealFreshnessLint(SPEC, healDeps({ statusSeq: [[], [written]], commit: "nothing-to-commit" }).deps);
  assert.equal(nothing.outcome, "healed-nothing-to-commit");

  const failed = selfHealFreshnessLint(SPEC, healDeps({ statusSeq: [[], [written]], commit: "failed" }).deps);
  assert.equal(failed.outcome, "commit-failed");
});

test("self-heal: a throwing dep degrades to regen-failed — never throws out into the gate", () => {
  const { deps } = healDeps({
    regen: () => {
      throw new Error("dep exploded");
    },
  });
  const res = selfHealFreshnessLint(SPEC, deps);
  assert.equal(res.outcome, "regen-failed");
  assert.ok(res.detail.includes("dep exploded"));
});

test("pathInSpec: exact match, directory-prefix match, no substring false positives", () => {
  assert.equal(pathInSpec("tests/fixture-artifact.json", SPEC), true);
  assert.equal(pathInSpec("generated/dir/nested/file.js", SPEC), true);
  assert.equal(pathInSpec("generated/dir", SPEC), true);
  assert.equal(pathInSpec("generated/dir-other/file.js", SPEC), false, "prefix must respect the / boundary");
  assert.equal(pathInSpec("tests/fixture-artifact.json.bak", SPEC), false, "no bare-substring matches");
});

// ---------------------------------------------------------------------------
// 5. GATE_SELF_HEAL_SPECS lockstep with the post-merge regen registries
// ---------------------------------------------------------------------------

test("every GATE_SELF_HEAL_SPECS lint exists in LINT_CHECKS with a remedy naming its generator", () => {
  const byName = new Map(LINT_CHECKS.map((c) => [c.name, c]));
  assert.equal(GATE_SELF_HEAL_SPECS.length, 3, "route inventory, contract table, website bundle");
  for (const spec of GATE_SELF_HEAL_SPECS) {
    const check = byName.get(spec.lintName);
    assert.ok(check, `${spec.lintName} is a registered gate lint`);
    const generator = spec.regenArgv.slice(spec.regenArgv[0] === "npx" ? 2 : 1).join(" ");
    assert.ok(
      check!.remedy?.includes(generator),
      `${spec.lintName} remedy names its registered generator (${generator})`,
    );
  }
  // Execution order is a contract: the contract table is generated FROM the
  // route inventory, so the inventory must heal first.
  assert.equal(GATE_SELF_HEAL_SPECS[0].lintName, "lint-route-inventory-freshness");
  assert.equal(GATE_SELF_HEAL_SPECS[1].lintName, "lint-contract-table-freshness");
});

test("lockstep: route-inventory spec mirrors scripts/post-merge-route-inventory-refresh.ts INVENTORY_PATHS + regen command", async () => {
  const { INVENTORY_PATHS } = await import("../scripts/post-merge-route-inventory-refresh");
  const spec = GATE_SELF_HEAL_SPECS.find((s) => s.lintName === "lint-route-inventory-freshness")!;
  assert.deepEqual([...spec.artifactPaths].sort(), [...INVENTORY_PATHS].sort(), "artifact paths identical to the post-merge registry");
  const postMerge = readFileSync("scripts/post-merge-route-inventory-refresh.ts", "utf8");
  assert.ok(
    postMerge.includes("scripts/regen-route-inventory.mjs"), // fs-scan-inputs-ignore -- pinned regen argv compared as strings, never read
    "post-merge refresh runs the same registered generator",
  );
  assert.deepEqual(
    [...spec.regenArgv],
    ["npx", "tsx", "scripts/regen-route-inventory.mjs"], // fs-scan-inputs-ignore -- pinned regen argv compared as strings, never read
    "gate self-heal runs the identical generator command",
  );
});

test("lockstep: contract-table + website-bundle specs mirror scripts/post-merge-generated-artifact-refresh.ts ARTIFACTS", () => {
  // Text pin instead of an import: the post-merge module pulls the four
  // governance generators (repo-scanning modules) into scope; this suite
  // stays lean the same way gate.ts does (see the GATE_SELF_HEAL_SPECS doc).
  const src = readFileSync("scripts/post-merge-generated-artifact-refresh.ts", "utf8");
  for (const lintName of ["lint-contract-table-freshness", "lint-website-bundle-freshness"]) {
    const spec = GATE_SELF_HEAL_SPECS.find((s) => s.lintName === lintName)!;
    for (const p of spec.artifactPaths) {
      assert.ok(src.includes(`"${p}"`), `${lintName}: artifact path ${p} present in the post-merge ARTIFACTS registry`);
    }
    const argvLiteral = spec.regenArgv.map((a) => `"${a}"`).join(", ");
    assert.ok(src.includes(argvLiteral), `${lintName}: regenArgv [${argvLiteral}] identical in the post-merge registry`);
  }
});

// ---------------------------------------------------------------------------
// 6. Attribution-report §lints round-trip
// ---------------------------------------------------------------------------

function lintSection(generatedAt: string) {
  return {
    sectionVersion: 1 as const,
    generatedAt,
    base: { commit: "abc123def", subject: "some upstream merge", resolution: "merge-second-parent" },
    excusalArmed: true,
    selfHeal: [],
    verdicts: [
      {
        name: "lint-fixture",
        script: "scripts/lint-fixture.ts", // fs-scan-inputs-ignore -- fixture lint-script name in the report section, never read
        verdict: "inherited" as const,
        excused: true,
        headSignature: "exit=1:sha256=0011223344556677",
        baseSignature: "exit=1:sha256=0011223344556677",
        evidence: ["identical offense signature at base tree"],
      },
    ],
    excusedCount: 1,
    blockingCount: 0,
  };
}

test("writeLintSectionIntoAttributionReport: merges into an existing report (foreign keys preserved), stamps schemaVersion 4, survives corrupt files, reports unwritable destinations", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-lint-report-"));
  try {
    const reportPath = join(root, "attribution-report.json");
    writeFileSync(reportPath, JSON.stringify({ schemaVersion: 4, failures: [{ file: "tests/x.test.ts" }], excusedCount: 2 }));
    assert.equal(writeLintSectionIntoAttributionReport(lintSection("2026-08-12T00:00:00.000Z"), reportPath), true);
    const merged = JSON.parse(readFileSync(reportPath, "utf8")); // fs-scan-inputs-ignore -- tmpdir fixture report written by this test
    assert.equal(merged.schemaVersion, 4);
    assert.deepEqual(merged.failures, [{ file: "tests/x.test.ts" }], "the suite-side section is untouched");
    assert.equal(merged.excusedCount, 2, "suite-side counts are untouched");
    assert.equal(merged.lints.verdicts[0].name, "lint-fixture");
    assert.equal(merged.lints.verdicts[0].verdict, "inherited");

    // Corrupt existing file → fresh object, still writes.
    writeFileSync(reportPath, "{corrupt");
    assert.equal(writeLintSectionIntoAttributionReport(lintSection("2026-08-12T01:00:00.000Z"), reportPath), true);
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).lints.generatedAt, "2026-08-12T01:00:00.000Z"); // fs-scan-inputs-ignore -- tmpdir fixture report written by this test

    // Unwritable destination → false, never a throw.
    const fileAsDir = join(root, "occupied");
    writeFileSync(fileAsDir, "file");
    assert.equal(writeLintSectionIntoAttributionReport(lintSection("x"), join(fileAsDir, "r.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("round-trip: the suite-side report writer carries a FRESH gate-written §lints forward and drops a STALE one", () => {
  const NOW = new Date("2026-08-12T06:00:00.000Z");
  const root = mkdtempSync(join(tmpdir(), "gate-lint-carry-"));
  try {
    const reportPath = join(root, "attribution-report.json");
    const runSuiteWriter = () =>
      attributeRunFailures({
        repoRoot: root,
        mode: "smoke",
        failures: [],
        fingerprints: null,
        excusalArmed: true,
        manifestPath: join(root, "no-manifest.json"),
        reportPath,
        now: NOW,
      });

    // Fresh (1h old, inside ATTRIBUTION_REPORT_LINTS_FRESH_MS) → carried.
    const freshAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    assert.ok(60 * 60 * 1000 < ATTRIBUTION_REPORT_LINTS_FRESH_MS, "fixture sits inside the freshness window");
    writeLintSectionIntoAttributionReport(lintSection(freshAt), reportPath);
    runSuiteWriter();
    const carried = JSON.parse(readFileSync(reportPath, "utf8")); // fs-scan-inputs-ignore -- tmpdir fixture report written by this test
    assert.equal(carried.lints?.generatedAt, freshAt, "fresh gate lint section is carried forward");
    assert.equal(carried.schemaVersion, 4);

    // Stale (older than the window) → dropped (stale sections mislead humans).
    const staleAt = new Date(NOW.getTime() - ATTRIBUTION_REPORT_LINTS_FRESH_MS - 60_000).toISOString();
    writeLintSectionIntoAttributionReport(lintSection(staleAt), reportPath);
    runSuiteWriter();
    const dropped = JSON.parse(readFileSync(reportPath, "utf8")); // fs-scan-inputs-ignore -- tmpdir fixture report written by this test
    assert.equal(dropped.lints, undefined, "stale gate lint section is NOT carried forward");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Task #4604 — REAL capture channels end to end: head via the gate's
//    worker thread, base via the disposable-worktree capture CLI. Before the
//    fix, the base side compared a raw `npx tsx` subprocess's regrouped
//    stdout+stderr (plus npm/tsx boot noise) against the worker's ordered
//    console capture, so byte-identical inherited offenses hashed
//    differently and were blamed on the task.
// ---------------------------------------------------------------------------

// The fixture lint interleaves stdout/stderr (stream regrouping would split
// signatures under the old channel), prints an absolute import.meta-derived
// path (different at head vs the A/B worktree — exercises prefix stripping),
// and a varying duration (exercises <t> neutralization).
const AB_FIXTURE_LINT_SRC = `import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function cliMain(): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(root + "/scripts/foo.ts:3 bare array binding (took " + ((Date.now() % 997) + 1) + "ms)");
  console.error("1 problem found");
  console.log("scan complete");
  return 1;
}
`;

test("REAL gate-path A/B (Task #4604): identical offense at base classifies inherited across the two capture channels", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gate-lint-ab-e2e-"));
  try {
    const gitIn = (args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", ...args], {
        cwd: repo,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    };
    mkdirSync(join(repo, "scripts"), { recursive: true });
    // Match the real repo's module system — without "type": "module" tsx
    // loads the .ts fixture through require(esm) and the import fails.
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "ab-fixture", type: "module" }));
    const scriptRel = "scripts/lint-ab-fixture.ts"; // fs-scan-inputs-ignore -- tmpdir fixture lint written by this test
    writeFileSync(join(repo, scriptRel), AB_FIXTURE_LINT_SRC);
    gitIn(["init", "-q"]);
    gitIn(["add", "-A"]);
    gitIn(["commit", "-q", "-m", "base"]);

    // HEAD side: the gate's actual worker-thread capture (runLintPhase),
    // output composed exactly as scripts/gate.ts composes it for the rails.
    const phase = await runLintPhase([{ name: "lint-ab-fixture", script: join(repo, scriptRel) }], {
      concurrency: 1,
      sink: { out: () => {}, err: () => {} },
    });
    const head = phase.results[0];
    assert.equal(head.exitCode, 1, "fixture lint reports an offense at head");
    const outputText = head.output.map((o) => o.text).join("\n");

    // BASE side: the actual disposable-worktree A/B runner (capture CLI child).
    const ab = runBaseTreeLints({
      baseCommit: "HEAD",
      lints: [{ name: "lint-ab-fixture", script: scriptRel }],
      repoRoot: repo,
    });
    assert.equal(ab.worktreeError, null, "A/B worktree prepared");
    const baseRun = ab.runs[0];
    assert.equal(baseRun.status, "ran", `base run ran (detail: ${baseRun.detail ?? "-"})`);
    assert.equal(baseRun.exitCode, 1, "base exit code comes from cliMain, not runner noise");

    const strip = [ab.worktreeDir ?? "", repo].filter(Boolean);
    const normalize = (raw: string) => normalizeOffenseOutput(raw, strip);
    const v = classifyLintFailure({
      failure: { name: "lint-ab-fixture", script: scriptRel, exitCode: head.exitCode, outputText },
      baseRun,
      taskDiffFiles: [],
      normalize,
    });
    assert.equal(
      v.verdict,
      "inherited",
      `identical offense captured through the REAL head/base channels must classify inherited — evidence: ${v.evidence.join(" | ")}`,
    );
    assert.equal(v.baseSignature, v.headSignature, "signatures are byte-comparable across channels");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} gate-lint-attribution tests passed`);
process.exit(failed > 0 ? 1 : 0);
