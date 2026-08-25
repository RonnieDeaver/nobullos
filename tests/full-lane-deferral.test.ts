/* test-registration
{
  "name": "Full-lane deferral + wall-breach alerting rails (Task #5030)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5030 (L3-approved gate policy revision): pins the blocking-gate vs post-merge rebalance. (1) Rotation-day deferral: suites whose ONLY reason to execute is rotated green evidence are deferred to the post-merge/nightly lane — planFullLaneDeferral keeps every rail executing (related-selected, always-run core, blast-radius expansion, quarantine re-adds, smoke-only suites the nightly lane would never run, extraNodeArgs suites), defers ONLY decisions positively classified stale-rotation/stale-expired — no-record, last-failed, uncomputable/poisoned, and run-level fall-open decisions always execute (fail closed, proven end-to-end through planIncrementalRun with a real fixture repo), records an honest deferred-not-verified record, and the executed/skipped summary line discloses the third disposition. (2) Wall-breach alerting: the aggregate wall budget NEVER fails a run — breaches append to the JSONL ledger (append/read round-trip, trim, corrupt-line tolerance) and the sweep scheduler auto-files ONE re-baseline/triage item per stale-budget episode (filed-once dedupe, stamp-on-zero-filed, retry-on-error). (3) Culprit naming: resolveMergeWindow walks fromCommit..toCommit bounded (honest nulls), publishRedManifest stamps culprit only from an exactly-one-commit window and carries it across wholesale publishes, and the nightly notification + per-file feedback text name the window. Source pins hold run-all/gate/scheduler/regen wiring. DB-free (injected fileFn), network-free; fs confined to tmpdirs + the pinned sources (scanPaths).",
  "scanPaths": [
    "tests/run-all.ts",
    "scripts/gate.ts",
    "server/services/regressionSweepScheduler.ts",
    "scripts/regen-gate-duration-budget.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #5030 — Guard tests for the blocking-gate vs post-merge rebalance:
 *
 *   1. planFullLaneDeferral: defer ⟺ must-execute with NO keep-executing
 *      rail AND a positively-stale execute reason (stale-rotation /
 *      stale-expired). No-record, last-failed, uncomputable/poisoned, and
 *      run-level fall-open decisions always execute (fail closed) — proven
 *      at the planner AND end-to-end through planIncrementalRun on a real
 *      fixture repo (crafted green store + stalled-tracer fall-open), wired
 *      through the same deferralCandidatesFromPlan helper run-all uses.
 *      First-match tallies; sorted output; green-skip stays a distinct
 *      (stronger) disposition.
 *   2. The executed/skipped summary line discloses deferral as a third
 *      disposition ("NOT verified this run").
 *   3. This suite itself is in the always-run core (DEFAULT_CORE_RULES) —
 *      the deferral machinery can never defer its own guard.
 *   4. writeFullLaneDeferralRecord round-trips and never throws.
 *   5. Breach ledger: append/read round-trip, corrupt-line tolerance,
 *      trim to the newest DURATION_BREACH_EVENTS_MAX.
 *   6. buildDurationBreachReport: ONE failed result per stale-budget episode
 *      (dedupe key duration-budget:<budget generatedAt>).
 *   7. runDurationBudgetBreachCheck: files once per episode, stamps state
 *      even when filed=0, leaves state unstamped after fileFn errors (next
 *      6h tick retries).
 *   8. resolveMergeWindow: bounded git-log walk (real tmp repo), newest
 *      first, task-ref parsing, truncation cap, honest nulls (missing/equal/
 *      unresolvable endpoints, empty range).
 *   9. publishRedManifest: culprit stamped ONLY from an exactly-one-commit
 *      complete window; carried while the same breakage persists; multi-
 *      commit/truncated windows never guess.
 *  10. Culprit window annotations ride into the per-file feedback text and
 *      the nightly sweep notification.
 *  11-14. Source pins: run-all deferral wiring (kill switch, publish-arm and
 *      file-args exclusions, record write, wall-eval deferredCount, breach
 *      append), gate lint-wall alert wiring (non-blocking; invalid artifact
 *      still hard-fails), scheduler watchdog wiring, regen refusal on
 *      deferral-narrowed measurements.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DURATION_BREACH_EVENTS_MAX,
  appendDurationBudgetBreachEvent,
  readDurationBudgetBreachEvents,
  type DurationBudgetBreachEvent,
  type SweepReport,
} from "../server/services/regressionSweep";
import {
  DURATION_BREACH_FEEDBACK_USER_ID,
  buildDurationBreachReport,
  buildSweepNotification,
  readDurationBreachFiledKeys,
  runDurationBudgetBreachCheck,
} from "../server/services/regressionSweepScheduler";
import {
  buildSweepFeedbackText,
  type SweepFeedbackSummary,
} from "../server/services/regressionSweepFeedback";
import {
  deferralCandidatesFromPlan,
  emptyGreenStore,
  formatExecutedSkippedLine,
  planFullLaneDeferral,
  planIncrementalRun,
  writeFullLaneDeferralRecord,
  type FullLaneDeferralCandidate,
  type FullLaneDeferralRecord,
  type GreenRecord,
} from "./suiteFingerprint";
import { DEFAULT_CORE_RULES } from "./relatedSmokeSelection";
import {
  loadRedManifest,
  publishRedManifest,
  resolveMergeWindow,
  type MergeWindow,
} from "./redManifest";

// ---------------------------------------------------------------------------
// Mini test runner (post-merge-canary.test.ts pattern)
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "full-lane-deferral-"));
}

function cand(
  file: string,
  over: Partial<FullLaneDeferralCandidate> = {},
): FullLaneDeferralCandidate {
  return {
    file,
    mustExecute: true,
    relatedSelected: false,
    core: false,
    expansionAdded: false,
    quarantineReAdded: false,
    regression: true,
    hasExtraNodeArgs: false,
    // Default = the deferrable classification; tests opting into other kinds
    // prove the reason gate keeps them executing.
    executeReasonKind: "stale-rotation",
    ...over,
  };
}

function ev(over: Partial<DurationBudgetBreachEvent> = {}): DurationBudgetBreachEvent {
  return {
    observedAt: "2026-08-19T01:00:00.000Z",
    source: "run-all-wall",
    wallMs: 1_500_000,
    budgetMs: 1_230_000,
    budgetGeneratedAt: "2026-08-01T00:00:00.000Z",
    mode: "smoke",
    suiteCount: 700,
    ...over,
  };
}

function sweepReportFixture(over: Partial<SweepReport> = {}): SweepReport {
  return {
    startedAt: "2026-08-19T03:30:00.000Z",
    finishedAt: "2026-08-19T03:55:00.000Z",
    mode: "smoke",
    total: 1,
    passed: 0,
    hardFailed: 1,
    quarantinedFailed: 0,
    flaky: 0,
    results: [
      {
        name: "suite x",
        file: "tests/x.test.ts",
        outcome: "failed",
        quarantined: false,
        attempts: 2,
        elapsedMs: 30_000,
        failureReason: "exit 1",
      },
    ],
    hardFailedNames: ["suite x"],
    quarantinedFailedNames: [],
    flakyNames: [],
    ...over,
  };
}

const SINGLE_WINDOW: MergeWindow = {
  fromCommit: "a".repeat(40),
  toCommit: "b".repeat(40),
  commits: [
    {
      commit: "b".repeat(40),
      task: "#4444",
      subject: "Merge task #4444: change pool cap",
      committedAt: "2026-08-18T12:00:00.000Z",
    },
  ],
  truncated: false,
};

// ---------------------------------------------------------------------------
// 1-4. Deferral planner + record + disclosure
// ---------------------------------------------------------------------------

test("planFullLaneDeferral: defer only positively-stale rail-less must-execute suites; first-match tallies; sorted; green-skip distinct", () => {
  const plan = planFullLaneDeferral([
    // Green-skipped (stronger evidence-backed disposition) — even though it
    // is related-selected, the green skip wins and no rail is tallied.
    cand("tests/green.test.ts", { mustExecute: false, relatedSelected: true }),
    // Rails, one each. The first (related + core) counts under
    // relatedSelected ONLY — first matching rail in keptExecuting order.
    cand("tests/related-and-core.test.ts", { relatedSelected: true, core: true }),
    cand("tests/core.test.ts", { core: true }),
    cand("tests/expansion.test.ts", { expansionAdded: true }),
    cand("tests/quarantine.test.ts", { quarantineReAdded: true }),
    cand("tests/smoke-only.test.ts", { regression: false }),
    cand("tests/extra-node-args.test.ts", { hasExtraNodeArgs: true }),
    // Reason gate (Task #5030 review): rail-less but NOT positively-stale —
    // kept executing, never deferred (new/unverified, known-broken,
    // uncomputable, and fall-open suites must run in the blocking gate).
    cand("tests/never-recorded.test.ts", { executeReasonKind: "no-record" }),
    cand("tests/red-last-run.test.ts", { executeReasonKind: "last-failed" }),
    cand("tests/poisoned-closure.test.ts", { executeReasonKind: "unskippable" }),
    cand("tests/unfingerprintable.test.ts", { executeReasonKind: "no-fingerprint" }),
    cand("tests/run-level-fall-open.test.ts", { executeReasonKind: "run-level" }),
    cand("tests/kindless.test.ts", { executeReasonKind: null }),
    // Rail-less positively-stale regression suites → deferred (unsorted
    // input; expiry defers exactly like rotation).
    cand("tests/zz-plain.test.ts"),
    cand("tests/expired-green.test.ts", { executeReasonKind: "stale-expired" }),
    cand("tests/aa-plain.test.ts"),
  ]);
  assert.deepEqual(
    plan.deferredFiles,
    ["tests/aa-plain.test.ts", "tests/expired-green.test.ts", "tests/zz-plain.test.ts"],
    "deferred = rail-less positively-stale must-execute, sorted",
  );
  assert.deepEqual(plan.keptExecuting, {
    relatedSelected: 1,
    core: 1,
    expansionAdded: 1,
    quarantineReAdded: 1,
    smokeOnly: 1,
    extraNodeArgs: 1,
    noRecord: 1,
    lastFailed: 1,
    notDeferrable: 4,
  });
  assert.equal(plan.greenSkipped, 1);

  const empty = planFullLaneDeferral([]);
  assert.deepEqual(empty.deferredFiles, []);
  assert.equal(empty.greenSkipped, 0);
});

test("end-to-end reason gate: real planIncrementalRun decisions — only rotated/expired greens defer; no-record/failed/poisoned/fall-open execute", async () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    const files = {
      rot: "tests/rot.test.ts",
      newborn: "tests/newborn.test.ts",
      redlast: "tests/redlast.test.ts",
      aged: "tests/aged.test.ts",
      poisoned: "tests/poisoned.test.ts",
      fresh: "tests/fresh.test.ts",
    } as const;
    writeFileSync(join(root, files.rot), "export const rot = 1;\n");
    writeFileSync(join(root, files.newborn), "export const newborn = 1;\n");
    writeFileSync(join(root, files.redlast), "export const redlast = 1;\n");
    writeFileSync(join(root, files.aged), "export const aged = 1;\n");
    // Unresolvable relative import → build-error-poisoned closure → the
    // suite is "unskippable" (fingerprint uncomputable).
    writeFileSync(join(root, files.poisoned), 'import "./does-not-exist";\nexport const poisoned = 1;\n');
    writeFileSync(join(root, files.fresh), "export const fresh = 1;\n");
    const suites = Object.values(files).map((file) => ({ file, regression: true }));
    const now = new Date();

    // Pass 1 — learn each suite's REAL fingerprint (empty store, everything
    // executes; the real tracer runs against the fixture repo).
    const probe = await planIncrementalRun({
      suites,
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath: join(root, "probe-store.json"),
      env: {} as NodeJS.ProcessEnv,
      now,
      coreRules: [],
    });
    assert.equal(probe.skippingDisabledReason, null, "probe run has no run-level execute reason");
    const fp = (file: string): string => {
      const v = probe.fingerprints.get(file);
      assert.ok(v, `probe computed a fingerprint for ${file}`);
      return v as string;
    };

    // Pass 2 — craft one green-store record per classification.
    const storePath = join(root, "store.json");
    const store = emptyGreenStore();
    const rec = (fingerprint: string, over: Partial<GreenRecord> = {}): GreenRecord => ({
      fingerprint,
      verdict: "green",
      flaky: false,
      durationMs: 10,
      recordedAt: now.toISOString(),
      mode: "smoke",
      ...over,
    });
    // Fresh green whose fingerprint no longer matches → stale-rotation.
    store.records[files.rot] = rec("rotated-away-fingerprint");
    // files.newborn: no record at all → no-record.
    // Matching fingerprint but the last outcome FAILED → last-failed.
    store.records[files.redlast] = rec(fp(files.redlast), { verdict: "failed" });
    // Matching green past the 7d max age (clock-derived offset) → stale-expired.
    store.records[files.aged] = rec(fp(files.aged), {
      recordedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // files.poisoned: unskippable wins regardless of any record.
    // Fresh matching green → green-skip (no execute kind at all).
    store.records[files.fresh] = rec(fp(files.fresh));
    writeFileSync(storePath, JSON.stringify(store));

    const plan = await planIncrementalRun({
      suites,
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {} as NodeJS.ProcessEnv,
      now,
      coreRules: [],
    });
    assert.equal(plan.skippingDisabledReason, null, "classification run has no run-level execute reason");
    const kind = new Map(plan.decisions.map((d) => [d.file, d.executeReasonKind]));
    assert.equal(kind.get(files.rot), "stale-rotation");
    assert.equal(kind.get(files.newborn), "no-record");
    assert.equal(kind.get(files.redlast), "last-failed");
    assert.equal(kind.get(files.aged), "stale-expired");
    assert.equal(kind.get(files.poisoned), "unskippable", "build-error-poisoned closure classifies unskippable");
    assert.equal(kind.get(files.fresh), null, "a green-skip decision carries no execute kind");

    // The REAL run-all wiring: plan decisions → shared candidate helper →
    // deferral planner. Only the two positively-stale suites defer.
    const wire = (p: typeof plan) =>
      planFullLaneDeferral(
        deferralCandidatesFromPlan({
          plan: p,
          suites,
          relatedFiles: new Set<string>(),
          expansionAddedFiles: new Set<string>(),
          quarantineReAddedFiles: new Set<string>(),
          coreRules: [],
        }),
      );
    const dPlan = wire(plan);
    assert.deepEqual(dPlan.deferredFiles, [files.aged, files.rot], "ONLY the rotated + expired greens defer (sorted)");
    assert.deepEqual(dPlan.keptExecuting, {
      relatedSelected: 0,
      core: 0,
      expansionAdded: 0,
      quarantineReAdded: 0,
      smokeOnly: 0,
      extraNodeArgs: 0,
      noRecord: 1, // newborn — never verified anywhere: must run here
      lastFailed: 1, // redlast — known-broken: must run here
      notDeferrable: 1, // poisoned — uncomputable closure: must run here
    });
    assert.equal(dPlan.greenSkipped, 1, "the fresh green stays a green-skip, never a deferral");

    // Wholesale fingerprint failure (stalled tracer) → run-level execute
    // reason on EVERY decision. Nothing is deferrable even at the planner —
    // and run-all additionally disengages on plan.skippingDisabledReason.
    const fallOpen = await planIncrementalRun({
      suites,
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {} as NodeJS.ProcessEnv,
      now,
      coreRules: [],
      traceTimeoutMs: 150,
      traceFn: (() => new Promise<never>(() => {})) as never,
    });
    assert.ok(fallOpen.skippingDisabledReason, "wholesale trace failure sets the run-level execute reason");
    assert.ok(
      fallOpen.decisions.every((d) => d.executeReasonKind === "run-level"),
      "every decision classifies run-level under the fall-open",
    );
    const dFallOpen = wire(fallOpen);
    assert.deepEqual(dFallOpen.deferredFiles, [], "a fall-open run defers NOTHING");
    assert.equal(dFallOpen.keptExecuting.notDeferrable, suites.length, "every suite kept executing as not-deferrable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executed/skipped summary line discloses deferral as a third disposition", () => {
  assert.equal(
    formatExecutedSkippedLine(5, 2),
    "executed 5, skipped 2 (green on identical inputs)",
  );
  assert.equal(
    formatExecutedSkippedLine(5, 2, 0),
    "executed 5, skipped 2 (green on identical inputs)",
    "deferred 0 renders identically — no phantom disposition",
  );
  assert.equal(
    formatExecutedSkippedLine(5, 2, 3),
    "executed 5, skipped 2 (green on identical inputs), deferred 3 (rotation-day full-universe debt → post-merge/nightly lane; NOT verified this run)",
  );
});

test("this guard suite is in the always-run core — the deferral machinery can never defer its own guard", () => {
  assert.ok(
    DEFAULT_CORE_RULES.some(
      (r) => r.kind === "exact" && r.value === "tests/full-lane-deferral.test.ts",
    ),
    "DEFAULT_CORE_RULES pins tests/full-lane-deferral.test.ts",
  );
});

test("writeFullLaneDeferralRecord: round-trips the honest record and never throws", () => {
  const root = tmpRoot();
  try {
    const record: FullLaneDeferralRecord = {
      generatedAt: "2026-08-19T02:00:00.000Z",
      reason: "green evidence rotated (fingerprint rotation day)",
      selectionManifestGeneratedAt: "2026-08-19T01:59:00.000Z",
      deferredFiles: ["tests/a.test.ts", "tests/b.test.ts"],
      keptExecuting: {
        relatedSelected: 3,
        core: 12,
        expansionAdded: 1,
        quarantineReAdded: 0,
        smokeOnly: 40,
        extraNodeArgs: 5,
        noRecord: 2,
        lastFailed: 1,
        notDeferrable: 4,
      },
      greenSkipped: 100,
    };
    const path = join(root, "runs", "full-lane-deferred.json");
    writeFullLaneDeferralRecord(record, path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), record, "record round-trips");

    // Unwritable destination (a file occupies the parent path) → logs, no throw.
    const occupied = join(root, "occupied");
    writeFileSync(occupied, "i am a file");
    writeFullLaneDeferralRecord(record, join(occupied, "nested.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5-7. Breach ledger + scheduler auto-file
// ---------------------------------------------------------------------------

test("breach ledger: append/read round-trip, corrupt lines skipped, trimmed to the newest MAX", () => {
  const root = tmpRoot();
  try {
    const ledger = join(root, "runs", "breach-events.jsonl");
    const a = ev({ observedAt: "2026-08-19T01:00:00.000Z" });
    const b = ev({ observedAt: "2026-08-19T02:00:00.000Z", source: "gate-lint-wall", mode: "lint", suiteCount: 0 });
    appendDurationBudgetBreachEvent(a, ledger);
    appendDurationBudgetBreachEvent(b, ledger);
    assert.deepEqual(readDurationBudgetBreachEvents(ledger), [a, b], "round-trip, newest last");

    // A torn/corrupt line is skipped, valid neighbors survive.
    writeFileSync(ledger, `${JSON.stringify(a)}\n{"torn\n`, "utf8");
    appendDurationBudgetBreachEvent(b, ledger);
    assert.deepEqual(readDurationBudgetBreachEvents(ledger), [a, b], "corrupt line tolerated");

    // Foreign-shaped JSON lines are skipped too.
    writeFileSync(ledger, `${JSON.stringify({ hello: "world" })}\n${JSON.stringify(a)}\n`, "utf8");
    assert.deepEqual(readDurationBudgetBreachEvents(ledger), [a], "foreign shapes skipped");

    // Missing file ⇒ [].
    assert.deepEqual(readDurationBudgetBreachEvents(join(root, "absent.jsonl")), []);

    // Trim: append MAX+5 → newest MAX retained.
    rmSync(ledger, { force: true });
    for (let i = 0; i < DURATION_BREACH_EVENTS_MAX + 5; i++) {
      appendDurationBudgetBreachEvent(ev({ wallMs: 1_000_000 + i }), ledger);
    }
    const kept = readDurationBudgetBreachEvents(ledger);
    assert.equal(kept.length, DURATION_BREACH_EVENTS_MAX, "ledger trimmed to MAX");
    assert.equal(kept[0].wallMs, 1_000_005, "oldest entries dropped (newest MAX kept)");
    assert.equal(kept[kept.length - 1].wallMs, 1_000_000 + DURATION_BREACH_EVENTS_MAX + 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildDurationBreachReport: ONE failed result per stale-budget episode, keyed duration-budget:<stamp>", () => {
  const stampA = "2026-08-01T00:00:00.000Z";
  const stampB = "2026-08-15T00:00:00.000Z";
  const episodes = new Map<string, DurationBudgetBreachEvent[]>([
    [
      stampA,
      [
        ev({ budgetGeneratedAt: stampA, wallMs: 1_404_000, observedAt: "2026-08-18T01:00:00.000Z" }),
        ev({ budgetGeneratedAt: stampA, wallMs: 1_500_000, observedAt: "2026-08-18T02:00:00.000Z", source: "gate-lint-wall" }),
      ],
    ],
    [stampB, [ev({ budgetGeneratedAt: stampB, observedAt: "2026-08-19T01:00:00.000Z" })]],
  ]);
  const report = buildDurationBreachReport(episodes);
  assert.equal(report.results.length, 2, "one result per episode, never per breach event");
  assert.equal(report.hardFailed, 2);
  assert.equal(report.total, 2);
  const first = report.results[0];
  assert.equal(first.file, `duration-budget:${stampA}`, "dedupe key = duration-budget:<budget generatedAt>");
  assert.equal(first.outcome, "failed");
  assert.ok(first.name.includes("worst 1500s"), `name cites the worst observed wall (got: ${first.name})`);
  assert.ok(first.name.includes("2 breach event(s)"), "name cites the episode's breach count");
  assert.ok(first.name.includes("gate-lint-wall") && first.name.includes("run-all-wall"), "name cites the sources");
  assert.ok(first.name.includes("Green runs were NOT failed"), "name states the non-blocking policy");
  assert.equal(report.results[1].file, `duration-budget:${stampB}`);
  assert.equal(report.startedAt, "2026-08-18T01:00:00.000Z", "report spans the observed breaches");
  assert.equal(report.finishedAt, "2026-08-19T01:00:00.000Z");
});

test("runDurationBudgetBreachCheck: files once per episode, stamps on filed=0, retries after errors", async () => {
  const root = tmpRoot();
  try {
    const eventsPath = join(root, "events.jsonl");
    const statePath = join(root, "state.json");
    const calls: Array<{ report: SweepReport; submitterId: string; autoResolve: boolean }> = [];
    const fileFn = async (
      report: SweepReport,
      opts: { submitterId: string; submitterName: string; autoResolve?: boolean },
    ): Promise<SweepFeedbackSummary> => {
      calls.push({ report, submitterId: opts.submitterId, autoResolve: opts.autoResolve === true });
      return { filed: report.results.length, resolved: 0 };
    };

    // No ledger yet → no filing attempt.
    await runDurationBudgetBreachCheck({ eventsPath, statePath, fileFn });
    assert.equal(calls.length, 0, "no events ⇒ no filing");

    const stampA = "2026-08-01T00:00:00.000Z";
    const stampB = "2026-08-15T00:00:00.000Z";
    appendDurationBudgetBreachEvent(ev({ budgetGeneratedAt: stampA }), eventsPath);
    appendDurationBudgetBreachEvent(ev({ budgetGeneratedAt: stampA, wallMs: 1_600_000 }), eventsPath);
    appendDurationBudgetBreachEvent(ev({ budgetGeneratedAt: stampB }), eventsPath);

    await runDurationBudgetBreachCheck({ eventsPath, statePath, fileFn });
    assert.equal(calls.length, 1, "one filing batch");
    assert.equal(calls[0].report.results.length, 2, "both episodes in the batch");
    assert.equal(calls[0].submitterId, DURATION_BREACH_FEEDBACK_USER_ID);
    assert.equal(calls[0].autoResolve, false, "breach items never auto-resolve (absence proves nothing)");
    assert.deepEqual(
      readDurationBreachFiledKeys(statePath).sort(),
      [stampA, stampB],
      "state stamped with both episode keys",
    );

    // Second tick with the same ledger → dedupe, no new filing.
    await runDurationBudgetBreachCheck({ eventsPath, statePath, fileFn });
    assert.equal(calls.length, 1, "already-filed episodes never re-file");

    // filed=0 (DB-side dedupe hit) still stamps: the signal exists in the DB.
    const stampC = "2026-08-16T00:00:00.000Z";
    appendDurationBudgetBreachEvent(ev({ budgetGeneratedAt: stampC }), eventsPath);
    const zeroFiled = async (): Promise<SweepFeedbackSummary> => ({ filed: 0, resolved: 0 });
    await runDurationBudgetBreachCheck({ eventsPath, statePath, fileFn: zeroFiled });
    assert.ok(readDurationBreachFiledKeys(statePath).includes(stampC), "filed=0 still stamps the episode");

    // fileFn error → state unstamped → the next tick retries.
    const stampD = "2026-08-17T00:00:00.000Z";
    appendDurationBudgetBreachEvent(ev({ budgetGeneratedAt: stampD }), eventsPath);
    const boom = async (): Promise<SweepFeedbackSummary> => {
      throw new Error("db down");
    };
    await runDurationBudgetBreachCheck({ eventsPath, statePath, fileFn: boom });
    assert.ok(!readDurationBreachFiledKeys(statePath).includes(stampD), "error leaves the episode unstamped");
    await runDurationBudgetBreachCheck({ eventsPath, statePath, fileFn });
    assert.equal(calls.length, 2, "next tick retries the unstamped episode");
    assert.equal(calls[1].report.results.length, 1);
    assert.equal(calls[1].report.results[0].file, `duration-budget:${stampD}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8-9. Merge-window resolution + culprit stamping
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

test("resolveMergeWindow: bounded walk, newest first, task parsing, truncation, honest nulls", () => {
  const root = tmpRoot();
  try {
    git(root, ["init", "-q"]);
    git(root, ["commit", "--allow-empty", "-q", "-m", "genesis"]);
    const c1 = git(root, ["rev-parse", "HEAD"]);
    git(root, ["commit", "--allow-empty", "-q", "-m", "Merge task #4801: fix pool"]);
    const c2 = git(root, ["rev-parse", "HEAD"]);
    git(root, ["commit", "--allow-empty", "-q", "-m", "chore: bump dep"]);
    const c3 = git(root, ["rev-parse", "HEAD"]);

    const win = resolveMergeWindow({ fromCommit: c1, toCommit: c3, repoRoot: root });
    assert.ok(win, "resolvable window");
    assert.equal(win!.truncated, false);
    assert.deepEqual(
      win!.commits.map((c) => c.commit),
      [c3, c2],
      "newest first, fromCommit exclusive",
    );
    assert.equal(win!.commits[0].task, null);
    assert.equal(win!.commits[0].subject, "chore: bump dep");
    assert.equal(win!.commits[1].task, "#4801", "task ref parsed from the subject");
    assert.ok(!Number.isNaN(Date.parse(win!.commits[1].committedAt)), "committedAt is a parseable stamp");

    const single = resolveMergeWindow({ fromCommit: c2, toCommit: c3, repoRoot: root });
    assert.equal(single!.commits.length, 1, "single-commit window");
    assert.equal(single!.commits[0].commit, c3);

    const capped = resolveMergeWindow({ fromCommit: c1, toCommit: c3, repoRoot: root, maxCommits: 1 });
    assert.ok(capped, "capped walk still resolves");
    assert.equal(capped!.truncated, true, "cap hit ⇒ truncated (a prefix, not the whole range)");
    assert.deepEqual(capped!.commits.map((c) => c.commit), [c3]);

    // Honest nulls — every unresolvable shape declines to name a window.
    assert.equal(resolveMergeWindow({ fromCommit: null, toCommit: c3, repoRoot: root }), null, "null from");
    assert.equal(resolveMergeWindow({ fromCommit: "unknown", toCommit: c3, repoRoot: root }), null, "non-hex from");
    assert.equal(resolveMergeWindow({ fromCommit: "", toCommit: c3, repoRoot: root }), null, "empty from");
    assert.equal(resolveMergeWindow({ fromCommit: c3, toCommit: c3, repoRoot: root }), null, "identical endpoints");
    assert.equal(
      resolveMergeWindow({ fromCommit: "deadbeef".repeat(5), toCommit: c3, repoRoot: root }),
      null,
      "unresolvable (rewritten-history) endpoint",
    );
    assert.equal(resolveMergeWindow({ fromCommit: c3, toCommit: c1, repoRoot: root }), null, "reversed range = empty walk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishRedManifest: culprit stamped only from an exactly-one-commit complete window, carried on same breakage", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "red-manifest.json");
    const NOW = new Date("2026-08-01T03:30:00.000Z");

    // 1-commit window → stamp.
    const first = publishRedManifest({
      manifestPath: p,
      commit: "commit-one",
      now: NOW,
      failures: [{ file: "tests/x.test.ts", failureReason: "exit 1", fingerprint: "fp-x" }],
      mergeWindow: SINGLE_WINDOW,
    });
    assert.deepEqual(first.newRedFiles, ["tests/x.test.ts"]);
    const m1 = loadRedManifest(p).manifest!;
    assert.deepEqual(
      m1.entries["tests/x.test.ts"].culprit,
      { commit: "b".repeat(40), task: "#4444", mergedAt: "2026-08-18T12:00:00.000Z" },
      "sole-commit window stamps the culprit",
    );

    // Same breakage next publish, no window → culprit carried verbatim.
    const second = publishRedManifest({
      manifestPath: p,
      commit: "commit-two",
      now: new Date("2026-08-02T03:30:00.000Z"),
      failures: [
        { file: "tests/x.test.ts", failureReason: "exit 1", fingerprint: "fp-x2" },
        { file: "tests/z.test.ts", failureReason: "exit 9", fingerprint: "fp-z" },
      ],
      mergeWindow: {
        ...SINGLE_WINDOW,
        commits: [
          ...SINGLE_WINDOW.commits,
          { commit: "c".repeat(40), task: null, subject: "second commit", committedAt: "2026-08-19T12:00:00.000Z" },
        ],
      },
    });
    assert.deepEqual(second.newRedFiles, ["tests/z.test.ts"], "persisting breakage is not a NEW red");
    assert.equal(second.previousCommit, "commit-one");
    const m2 = loadRedManifest(p).manifest!;
    assert.deepEqual(
      m2.entries["tests/x.test.ts"].culprit,
      { commit: "b".repeat(40), task: "#4444", mergedAt: "2026-08-18T12:00:00.000Z" },
      "wholesale publish carries the culprit while the breakage persists",
    );
    assert.equal(m2.entries["tests/z.test.ts"].culprit, null, "multi-commit window never guesses a culprit");

    // Truncated "single"-commit window → no stamp (the window is a prefix).
    const third = publishRedManifest({
      manifestPath: p,
      commit: "commit-three",
      now: new Date("2026-08-03T03:30:00.000Z"),
      failures: [{ file: "tests/w.test.ts", failureReason: "exit 2", fingerprint: "fp-w" }],
      mergeWindow: { ...SINGLE_WINDOW, truncated: true },
    });
    assert.deepEqual(third.newRedFiles, ["tests/w.test.ts"]);
    assert.equal(
      loadRedManifest(p).manifest!.entries["tests/w.test.ts"].culprit,
      null,
      "truncated window never stamps",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("culprit window annotations ride into the feedback item text and the nightly notification", () => {
  const report = sweepReportFixture({
    newRedMergeWindow: {
      fromCommit: SINGLE_WINDOW.fromCommit,
      toCommit: SINGLE_WINDOW.toCommit,
      newReds: ["tests/x.test.ts"],
      commits: [
        {
          commit: SINGLE_WINDOW.commits[0].commit,
          task: "#4444",
          subject: "Merge task #4444: change pool cap",
        },
      ],
      truncated: false,
    },
  });
  const text = buildSweepFeedbackText(report.results[0], report);
  assert.ok(
    text.includes("Culprit merge (sole commit in the window"),
    `feedback text names the sole-commit culprit (got: ${text})`,
  );
  assert.ok(text.includes("#4444"), "feedback text cites the task ref");

  // A failing suite that is NOT a new red gets no culprit line.
  const other = { ...report.results[0], file: "tests/other.test.ts" };
  assert.ok(!buildSweepFeedbackText(other, report).includes("Culprit"), "old reds carry no culprit line");

  // Multi-commit window → the window is listed, no single culprit claimed.
  const multi = sweepReportFixture({
    newRedMergeWindow: {
      fromCommit: SINGLE_WINDOW.fromCommit,
      toCommit: SINGLE_WINDOW.toCommit,
      newReds: ["tests/x.test.ts"],
      commits: [
        { commit: "b".repeat(40), task: "#4444", subject: "Merge task #4444: change pool cap" },
        { commit: "c".repeat(40), task: null, subject: "second commit" },
      ],
      truncated: false,
    },
  });
  const multiText = buildSweepFeedbackText(multi.results[0], multi);
  assert.ok(multiText.includes("Culprit merge window (2 commit(s))"), "multi-commit window is listed as a window");
  assert.ok(!multiText.includes("sole commit"), "no single-culprit claim from a multi-commit window");

  // Nightly notification: the window line rides along.
  const notif = buildSweepNotification(report, 1);
  assert.equal(notif.shouldNotify, true);
  assert.ok(
    notif.text.includes("NEW red(s) attributed to merge window"),
    `notification names the merge window (got: ${notif.text})`,
  );
  assert.ok(notif.text.includes("tests/x.test.ts"), "notification lists the new red file");

  // No window resolved → no attribution line (never guess).
  const bare = buildSweepNotification(sweepReportFixture(), 1);
  assert.ok(!bare.text.includes("attributed to merge window"), "unresolvable window ⇒ no attribution line");
});

// ---------------------------------------------------------------------------
// 11-14. Source pins (fs — scanPaths keeps this suite's fingerprint honest)
// ---------------------------------------------------------------------------

test("run-all wiring: deferral block guarded (kill switch, publish arm, --file runs), record + wall coupling honest", () => {
  const runAll = readFileSync("tests/run-all.ts", "utf8");
  const defIdx = runAll.indexOf('process.env.TEST_FULL_DEFERRAL !== "0"');
  assert.ok(defIdx >= 0, "deferral has the TEST_FULL_DEFERRAL=0 kill switch");
  const guard = runAll.slice(Math.max(0, defIdx - 900), defIdx);
  assert.ok(
    guard.includes('process.env.TEST_GREEN_BASELINE_PUBLISH !== "1"'),
    "deferral never engages on the nightly publish arm (it must measure the full universe)",
  );
  assert.ok(guard.includes("fileArgs.length === 0"), "deferral never engages on explicit --file runs");
  assert.ok(
    runAll.includes("plan.skippingDisabledReason === null"),
    "deferral never engages under a run-level execute reason (wholesale fingerprint fall-open, integrity run, force-all)",
  );
  assert.ok(
    runAll.includes("deferralCandidatesFromPlan({"),
    "run-all builds candidates via the shared reason-gated helper — the exact path the behavioral tests exercise",
  );
  assert.ok(runAll.includes("planFullLaneDeferral("), "run-all consults the pure planner");
  assert.ok(runAll.includes("writeFullLaneDeferralRecord({"), "run-all writes the honest deferred-not-verified record");
  assert.ok(runAll.includes("!deferredSet.has(t.file)"), "deferred suites are excluded from execution");
  assert.ok(
    runAll.includes("deferredCount: deferredFiles.length"),
    "the wall evaluation sees the deferred count (a narrowed run never judges the wall)",
  );
  assert.ok(
    runAll.includes("deferredNotVerified: deferredFiles.length"),
    "the duration report carries the deferral disposition (regen refuses such measurements)",
  );
  assert.ok(runAll.includes('source: "run-all-wall"'), "a run-all wall breach feeds the breach ledger");
});

test("gate wiring: lint-wall breach is a non-blocking ALERT + ledger event; invalid artifact still hard-fails", () => {
  const gateSrc = readFileSync("scripts/gate.ts", "utf8");
  const alertIdx = gateSrc.indexOf("ALERT (non-blocking): lint phase wall");
  assert.ok(alertIdx >= 0, "gate prints the non-blocking lint-wall ALERT");
  const appendIdx = gateSrc.indexOf('source: "gate-lint-wall"');
  assert.ok(appendIdx > alertIdx, "gate records the breach event after the ALERT");
  assert.ok(
    !gateSrc.slice(alertIdx, appendIdx).includes("results.push"),
    "the wall breach never pushes a failing check result (green stays green)",
  );
  assert.ok(
    gateSrc.includes('results.push({ name: "lint-phase-wall-budget", passed: false, durationMs: 0 });'),
    "an INVALID budget artifact remains a hard gate failure (tamper defense unchanged)",
  );
});

test("scheduler wiring: the 6h staleness watchdog runs the duration-breach check", () => {
  const sched = readFileSync("server/services/regressionSweepScheduler.ts", "utf8");
  const fnIdx = sched.indexOf("async function runStalenessWatchdog(");
  assert.ok(fnIdx >= 0, "runStalenessWatchdog exists");
  assert.ok(
    sched.slice(fnIdx, fnIdx + 1200).includes("await runDurationBudgetBreachCheck();"),
    "runStalenessWatchdog awaits runDurationBudgetBreachCheck",
  );
});

test("regen wiring: a deferral-narrowed measurement is refused as a budget source", () => {
  const regen = readFileSync("scripts/regen-gate-duration-budget.ts", "utf8");
  assert.ok(
    regen.includes("(report.deferredNotVerified ?? 0) > 0"),
    "regen checks the deferral disposition",
  );
  assert.ok(regen.includes("REFUSED — source run deferred"), "regen refuses with the honest reason");
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} full-lane-deferral tests passed`);
process.exit(failures > 0 ? 1 : 0);
