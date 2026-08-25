/* test-registration
{
  "name": "Nightly regression sweep — report classification + scheduler gating (Task #2611)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2611: the nightly regression sweep's own report-classification and scheduler-gating logic. It guards against the very rot it exists to catch, so it must run in the routine gate, not just the rarely-run full suite. It is a fast, pure, in-memory test (no DB, no spawned children, no network).",
  "scanPaths": ["server/services/regressionSweepScheduler.ts"],
  "tier": "small"
}
test-registration */
// future-date-literal-reviewed: the quarantine-ledger expiresOn 2026-09-30 is only evaluated against explicitly pinned new Date(...) arguments (both sides literal); no real-clock comparison — it cannot rot.
/**
 * Task #2611 — Unit coverage for the nightly regression sweep's pure decision
 * logic: how a run's per-file results are classified into a SweepReport, how
 * that report decides pass/fail and renders its alert text, and how the
 * scheduler gates itself to the dev workspace.
 *
 * Pure / in-memory: no DB, no spawned children, no network. It drives the
 * exported seams of `server/services/regressionSweep.ts` and
 * `server/services/regressionSweepScheduler.ts` directly, so it is safe in the
 * routine TEST_SMOKE gate (and is itself added to SMOKE_FILES so the sweep
 * infrastructure can't rot the same way the tests it guards could).
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #1724 (the pg_stat_statements nightly scheduler this mirrors),
 *   #758 (the node-cron + dev-workspace cadence pattern),
 *   #1688 (notifyByType admin in-app inbox mirror the alert relies on).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  QUARANTINED_TEST_FILES,
  buildSweepReport,
  isQuarantinedTestFile,
  parseSweepReport,
  reportIndicatesFailure,
  summarizeSweepResult,
  type SweepTestResult,
} from "../server/services/regressionSweep";
import {
  BASELINE_STALENESS_ALERT_DAYS,
  buildSweepNotification,
  poisonAlertDeliveryAcceptable,
  readAlertedBaselineStalenessStamp,
  readAlertedLintReds,
  readAlertedPoisonFiles,
  readCommittedBaselineStatus,
  shouldScheduleRegressionSweep,
  writeAlertedBaselineStalenessStamp,
  writeAlertedLintReds,
  writeAlertedPoisonFiles,
} from "../server/services/regressionSweepScheduler";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

const META = {
  startedAt: "2026-06-16T03:30:00.000Z",
  finishedAt: "2026-06-16T03:55:00.000Z",
  mode: "regression" as const,
};

function result(over: Partial<SweepTestResult>): SweepTestResult {
  return {
    name: over.name ?? "Some test",
    file: over.file ?? "tests/some.test.ts",
    outcome: over.outcome ?? "passed",
    quarantined: over.quarantined ?? false,
    attempts: over.attempts ?? 1,
    elapsedMs: over.elapsedMs ?? 1000,
    ...(over.failureReason ? { failureReason: over.failureReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Quarantine policy
// ---------------------------------------------------------------------------

// Task #3840: the ledger's one historical entry (zoom-none-rate-alert) was
// delisted — the suite and the feature it tested were deleted in Task #2637.
// The mechanism itself stays covered via an injected synthetic ledger so
// these tests never depend on a specific real quarantine existing.
test("the shipped quarantine ledger is empty (no sidelined suites)", () => {
  assert.equal(QUARANTINED_TEST_FILES.size, 0);
  assert.equal(isQuarantinedTestFile("tests/prod-actions-routes.test.ts"), false);
});

test("a ledger entry quarantines its file until (inclusive) its expiry date", () => {
  const ledger = [
    {
      file: "tests/synthetic-flaky.test.ts",
      reason: "synthetic entry for mechanism coverage",
      addedOn: "2026-06-01",
      expiresOn: "2026-09-30",
    },
  ];
  // Before + on the expiry day: quarantined.
  assert.equal(
    isQuarantinedTestFile("tests/synthetic-flaky.test.ts", new Date("2026-07-15T12:00:00Z"), ledger),
    true,
  );
  assert.equal(
    isQuarantinedTestFile("tests/synthetic-flaky.test.ts", new Date("2026-09-30T12:00:00Z"), ledger),
    true,
  );
  // After expiry: loud again.
  assert.equal(
    isQuarantinedTestFile("tests/synthetic-flaky.test.ts", new Date("2026-10-01T00:00:00Z"), ledger),
    false,
  );
  // Unlisted file: never quarantined.
  assert.equal(
    isQuarantinedTestFile("tests/other.test.ts", new Date("2026-07-15T12:00:00Z"), ledger),
    false,
  );
});

// ---------------------------------------------------------------------------
// buildSweepReport classification
// ---------------------------------------------------------------------------

test("all-passing run reports zero failures and is green", () => {
  const report = buildSweepReport(
    [result({ name: "A" }), result({ name: "B" })],
    META,
  );
  assert.equal(report.total, 2);
  assert.equal(report.passed, 2);
  assert.equal(report.hardFailed, 0);
  assert.equal(report.quarantinedFailed, 0);
  assert.equal(report.flaky, 0);
  assert.equal(reportIndicatesFailure(report), false);
});

test("a non-quarantined failure is a hard failure → sweep is red", () => {
  const report = buildSweepReport(
    [
      result({ name: "A" }),
      result({
        name: "Broken",
        outcome: "failed",
        failureReason: "exit 1",
      }),
    ],
    META,
  );
  assert.equal(report.hardFailed, 1);
  assert.deepEqual(report.hardFailedNames, ["Broken (exit 1)"]);
  assert.equal(reportIndicatesFailure(report), true);
});

test("a quarantined failure is a warning, never a hard failure → sweep stays green", () => {
  const report = buildSweepReport(
    [
      result({ name: "A" }),
      result({
        name: "Flaky zoom alert",
        file: "tests/synthetic-flaky.test.ts",
        outcome: "failed",
        quarantined: true,
        failureReason: "hang 184s",
      }),
    ],
    META,
  );
  assert.equal(report.hardFailed, 0);
  assert.equal(report.quarantinedFailed, 1);
  assert.deepEqual(report.quarantinedFailedNames, ["Flaky zoom alert (hang 184s)"]);
  assert.equal(reportIndicatesFailure(report), false);
});

test("a test that passes only on retry is flaky (a warning, not a failure)", () => {
  const report = buildSweepReport(
    [result({ name: "Recovered", outcome: "passed", attempts: 2 })],
    META,
  );
  assert.equal(report.passed, 1);
  assert.equal(report.flaky, 1);
  assert.deepEqual(report.flakyNames, ["Recovered"]);
  assert.equal(reportIndicatesFailure(report), false);
});

// ---------------------------------------------------------------------------
// summarizeSweepResult text
// ---------------------------------------------------------------------------

test("failure summary names the broken tests so the rot is identifiable", () => {
  const report = buildSweepReport(
    [
      result({
        name: "Rotted regression test",
        outcome: "failed",
        failureReason: "exit 1",
      }),
    ],
    META,
  );
  const text = summarizeSweepResult(report);
  assert.match(text, /FAILED/);
  assert.match(text, /Rotted regression test \(exit 1\)/);
});

test("passing summary states the green verdict", () => {
  const report = buildSweepReport([result({ name: "A" })], META);
  const text = summarizeSweepResult(report);
  assert.match(text, /passed/);
  assert.doesNotMatch(text, /FAILED/);
});

// Task #4595 — realized per-table migration-scoping savings ride in the
// report + summary so drift back toward full-tree re-runs is visible from
// the nightly notification, not only in .local/runs/incremental-skip.json.
test("summary surfaces migration-scoping realized skips when measured, stays silent when not", () => {
  const unmeasured = buildSweepReport([result({ name: "A" })], META);
  assert.equal(unmeasured.migrationTableScopedSkipped, null, "defaults to null (not measured)");
  assert.equal(unmeasured.migrationFullScopeSkipped, null);
  assert.doesNotMatch(summarizeSweepResult(unmeasured), /Migration scoping:/);

  const measured = buildSweepReport([result({ name: "A" })], {
    ...META,
    migrationTableScopedCount: 657,
    migrationFullScopeCount: 25,
    migrationTableScopedSkipped: 402,
    migrationFullScopeSkipped: 3,
  });
  const text = summarizeSweepResult(measured);
  assert.match(text, /Migration scoping: 402 table-scoped DB-sensitive suite\(s\) skipped this run/);
  assert.match(text, /3 full-scope skipped/);
  assert.match(text, /657 table-scoped \/ 25 full-scope/);

  // Zero realized skips is still measured — the line must appear so a
  // regression toward zero is visible, not silently indistinguishable from
  // "not measured".
  const zero = buildSweepReport([result({ name: "A" })], {
    ...META,
    migrationTableScopedCount: 657,
    migrationFullScopeCount: 25,
    migrationTableScopedSkipped: 0,
    migrationFullScopeSkipped: 0,
  });
  assert.match(summarizeSweepResult(zero), /Migration scoping: 0 table-scoped DB-sensitive suite\(s\) skipped this run/);
});

// ---------------------------------------------------------------------------
// parseSweepReport round-trip + malformed handling
// ---------------------------------------------------------------------------

test("parseSweepReport round-trips a real report and rejects garbage", () => {
  const report = buildSweepReport([result({ name: "A" })], META);
  const parsed = parseSweepReport(JSON.stringify(report));
  assert.ok(parsed);
  assert.equal(parsed!.total, 1);
  assert.equal(parseSweepReport("not json"), null);
  assert.equal(parseSweepReport("{}"), null);
});

// ---------------------------------------------------------------------------
// buildSweepNotification (scheduler decision)
// ---------------------------------------------------------------------------

test("missing report (runner crashed) is itself an alertable failure", () => {
  const n = buildSweepNotification(null, 1);
  assert.equal(n.shouldNotify, true);
  assert.match(n.text, /could not produce a report/);
});

test("a hard-failed report notifies; a green report does not", () => {
  const failed = buildSweepReport(
    [result({ name: "Broken", outcome: "failed", failureReason: "exit 1" })],
    META,
  );
  assert.equal(buildSweepNotification(failed, 1).shouldNotify, true);

  const green = buildSweepReport([result({ name: "A" })], META);
  assert.equal(buildSweepNotification(green, 0).shouldNotify, false);
});

test("a report with only quarantined failures does NOT notify", () => {
  const report = buildSweepReport(
    [
      result({
        name: "Flaky zoom alert",
        file: "tests/synthetic-flaky.test.ts",
        outcome: "failed",
        quarantined: true,
        failureReason: "hang 184s",
      }),
    ],
    META,
  );
  assert.equal(buildSweepNotification(report, 0).shouldNotify, false);
});

// ---------------------------------------------------------------------------
// Task #4104 — repeat-poison warnings ride into the report + notification
// ---------------------------------------------------------------------------

const POISON_WARNING = {
  file: "tests/broken.test.ts",
  streak: 4,
  firstSeenAt: "2026-08-05T07:30:00.000Z",
  error: "<build error: Unexpected token (12:3)>",
};

test("repeat-poison warnings ride into the sweep report and summary text", () => {
  const report = buildSweepReport([result({ name: "A" })], {
    ...META,
    repeatPoisonWarnings: [POISON_WARNING],
  });
  assert.equal(report.repeatPoisonWarnings?.length, 1);
  const text = summarizeSweepResult(report);
  assert.match(text, /REPEAT-POISONED/);
  assert.match(text, /tests\/broken\.test\.ts — poisoned 4 consecutive audit\(s\) since 2026-08-05T07:30:00\.000Z/);
  assert.match(text, /<build error: Unexpected token \(12:3\)>/);

  // No warnings ⇒ no poison lines (and legacy reports without the field
  // still summarize cleanly).
  const clean = summarizeSweepResult(buildSweepReport([result({ name: "A" })], META));
  assert.ok(!clean.includes("REPEAT-POISONED"), "no poison line when there are no warnings");
  const legacy = parseSweepReport(
    JSON.stringify({ ...buildSweepReport([result({ name: "A" })], META), repeatPoisonWarnings: undefined }),
  );
  assert.ok(legacy);
  assert.ok(!summarizeSweepResult(legacy!).includes("REPEAT-POISONED"));
});

test("a repeat-poisoned file notifies even when the sweep itself is green", () => {
  const green = buildSweepReport([result({ name: "A" })], META);
  assert.equal(buildSweepNotification(green, 0).shouldNotify, false, "control: green + no poison stays quiet");

  const poisoned = buildSweepReport([result({ name: "A" })], {
    ...META,
    repeatPoisonWarnings: [POISON_WARNING],
  });
  const n = buildSweepNotification(poisoned, 0);
  assert.equal(n.shouldNotify, true, "repeat-poison alerts despite the green verdict");
  assert.match(n.text, /REPEAT-POISONED/);
  assert.match(n.text, /tests\/broken\.test\.ts/);
});

// ---------------------------------------------------------------------------
// Task #4112 — once-per-streak repeat-poison alerting
// ---------------------------------------------------------------------------

test("an unchanged already-alerted poisoned set stays quiet on subsequent nights", () => {
  const poisoned = buildSweepReport([result({ name: "A" })], {
    ...META,
    repeatPoisonWarnings: [POISON_WARNING],
  });
  // First night: nothing alerted yet → fires.
  const first = buildSweepNotification(poisoned, 0, null, []);
  assert.equal(first.shouldNotify, true);
  assert.equal(first.poisonAlertFired, true);
  assert.deepEqual(first.poisonFiles, ["tests/broken.test.ts"]);

  // Subsequent night: same set, already alerted → quiet.
  const second = buildSweepNotification(poisoned, 0, null, first.poisonFiles);
  assert.equal(second.shouldNotify, false, "unchanged poisoned set must not re-alert");
  assert.equal(second.poisonAlertFired, false);
  assert.deepEqual(second.poisonFiles, ["tests/broken.test.ts"], "state reconciliation still sees the set");

  // Omitting the alerted set (absent/corrupt state) falls open to alerting.
  const fallOpen = buildSweepNotification(poisoned, 0);
  assert.equal(fallOpen.shouldNotify, true, "unknown alerted-state falls open to alerting");
});

test("a NEW file joining an already-alerted poisoned set alerts again", () => {
  const grown = buildSweepReport([result({ name: "A" })], {
    ...META,
    repeatPoisonWarnings: [
      POISON_WARNING,
      { ...POISON_WARNING, file: "tests/newly-broken.test.ts", streak: 3 },
    ],
  });
  const n = buildSweepNotification(grown, 0, null, ["tests/broken.test.ts"]);
  assert.equal(n.shouldNotify, true, "a new poisoned file must alert even though the old one was reported");
  assert.equal(n.poisonAlertFired, true);
  assert.deepEqual(n.poisonFiles, ["tests/broken.test.ts", "tests/newly-broken.test.ts"]);
});

test("a real sweep failure still notifies even when the poisoned set is unchanged", () => {
  const failedAndPoisoned = buildSweepReport(
    [result({ name: "A", outcome: "failed", failureReason: "boom" })],
    { ...META, repeatPoisonWarnings: [POISON_WARNING] },
  );
  const n = buildSweepNotification(failedAndPoisoned, 1, null, ["tests/broken.test.ts"]);
  assert.equal(n.shouldNotify, true, "hard failures are never suppressed by poison-alert dedupe");
  assert.equal(n.poisonAlertFired, false, "…but the poison alert itself did not re-fire");
});

test("only verifiably-delivered dispatch outcomes may commit poison-alert state", () => {
  // notifyByType RESOLVES (never throws) for skips and failures, so runOnce
  // gates the state write on poisonAlertDeliveryAcceptable. A poisoned file
  // first observed while e.g. Slack is disconnected must stay un-alerted so
  // the next night retries — otherwise the only alert for the streak is
  // permanently swallowed.
  const acceptable = (status: string, delivered = false) =>
    poisonAlertDeliveryAcceptable({ delivered, status });

  assert.equal(acceptable("success", true), true, "a real Slack delivery commits state");
  // skipped_deduped only occurs against a health-state row written on a
  // prior SUCCESSFUL delivery, so it proves the team already saw the alert.
  assert.equal(acceptable("skipped_deduped"), true);

  for (const status of [
    "failed",
    "skipped_disabled",
    "skipped_no_channel",
    "skipped_slack_disconnected",
    "skipped_killswitch",
    "skipped_unknown_id",
  ]) {
    assert.equal(acceptable(status), false, `${status} must retain state for retry`);
  }
  // Dispatch threw (notifyByType itself rejected) → no result → retry.
  assert.equal(poisonAlertDeliveryAcceptable(null), false);
  assert.equal(poisonAlertDeliveryAcceptable(undefined), false);
});

test("poison-alert state round-trips; healing prunes so re-poisoning alerts again", () => {
  const dir = mkdtempSync(join(tmpdir(), "poison-alert-state-"));
  const statePath = join(dir, "nested", "state.json");
  try {
    // Missing file → empty set (fall open to alerting).
    assert.deepEqual(readAlertedPoisonFiles(statePath), []);

    writeAlertedPoisonFiles(["tests/b.test.ts", "tests/a.test.ts"], statePath);
    assert.deepEqual(readAlertedPoisonFiles(statePath), ["tests/a.test.ts", "tests/b.test.ts"]);

    // Healing: the scheduler writes the CURRENT poisoned set after every
    // completed report, so a healed file drops out of the state…
    writeAlertedPoisonFiles([], statePath);
    assert.deepEqual(readAlertedPoisonFiles(statePath), []);
    // …and a later re-poisoning of the same file alerts again.
    const rePoisoned = buildSweepReport([result({ name: "A" })], {
      ...META,
      repeatPoisonWarnings: [POISON_WARNING],
    });
    const n = buildSweepNotification(rePoisoned, 0, null, readAlertedPoisonFiles(statePath));
    assert.equal(n.shouldNotify, true, "a healed-then-re-poisoned file must alert again");

    // Corrupt state file → empty set, never a throw.
    writeFileSync(statePath, "not json", "utf8");
    assert.deepEqual(readAlertedPoisonFiles(statePath), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task #4077 — committed-baseline staleness (skip-health alerting)
// ---------------------------------------------------------------------------

test("summarizeSweepResult surfaces committed-baseline age when the report carries it", () => {
  const withAge = buildSweepReport([result({ name: "A" })], {
    ...META,
    baselinePublishedAt: "2026-06-14T07:52:00.000Z",
    baselineAgeDays: 1.8,
  });
  const text = summarizeSweepResult(withAge);
  assert.match(text, /Committed green baseline age: 1\.8d \(published 2026-06-14T07:52:00\.000Z\)\./);

  const withoutAge = summarizeSweepResult(buildSweepReport([result({ name: "A" })], META));
  assert.ok(!withoutAge.includes("Committed green baseline"), "no baseline line when age is unknown");
});

test("a STALE committed baseline notifies even when the sweep is green", () => {
  const green = buildSweepReport([result({ name: "A" })], META);

  const fresh = buildSweepNotification(green, 0, { publishedAt: "2026-06-16T03:50:00.000Z", ageDays: 0.02 });
  assert.equal(fresh.shouldNotify, false, "fresh baseline + green sweep stays quiet");

  const stale = buildSweepNotification(green, 0, {
    publishedAt: "2026-06-13T03:50:00.000Z",
    ageDays: BASELINE_STALENESS_ALERT_DAYS + 0.5,
  });
  assert.equal(stale.shouldNotify, true, "stale baseline alerts despite the green verdict");
  assert.match(stale.text, /green baseline .*has not refreshed in 2\.5 days/);
  assert.match(stale.text, /passed: 1 of 1/, "the normal summary still leads the alert text");

  // Unknown age (no baseline / unparseable stamp) is NOT an incident.
  const unknown = buildSweepNotification(green, 0, { publishedAt: null, ageDays: null });
  assert.equal(unknown.shouldNotify, false);

  // Exactly at the threshold is still fine — strictly-greater fires.
  const boundary = buildSweepNotification(green, 0, {
    publishedAt: "x",
    ageDays: BASELINE_STALENESS_ALERT_DAYS,
  });
  assert.equal(boundary.shouldNotify, false);
});

// ---------------------------------------------------------------------------
// Task #4116 — once-per-streak baseline-staleness alerting
// ---------------------------------------------------------------------------

const STALE_STATUS = {
  publishedAt: "2026-06-13T03:50:00.000Z",
  ageDays: BASELINE_STALENESS_ALERT_DAYS + 0.5,
};

test("an unchanged already-alerted stale baseline stays quiet on subsequent nights", () => {
  const green = buildSweepReport([result({ name: "A" })], META);

  // First night: nothing alerted yet (state null) → fires.
  const first = buildSweepNotification(green, 0, STALE_STATUS, [], null);
  assert.equal(first.shouldNotify, true);
  assert.equal(first.stalenessAlertFired, true);

  // Subsequent night: same publishedAt stamp already alerted → quiet.
  const second = buildSweepNotification(green, 0, STALE_STATUS, [], STALE_STATUS.publishedAt);
  assert.equal(second.shouldNotify, false, "unchanged stale baseline must not re-alert");
  assert.equal(second.stalenessAlertFired, false);

  // Omitting the alerted stamp (absent/corrupt state) falls open to alerting.
  const fallOpen = buildSweepNotification(green, 0, STALE_STATUS, []);
  assert.equal(fallOpen.shouldNotify, true, "unknown alerted-state falls open to alerting");
  assert.equal(fallOpen.stalenessAlertFired, true);
});

test("a refreshed-then-stale-again baseline (new stamp) alerts again", () => {
  const green = buildSweepReport([result({ name: "A" })], META);
  const newEpisode = {
    publishedAt: "2026-06-20T03:50:00.000Z",
    ageDays: BASELINE_STALENESS_ALERT_DAYS + 1,
  };
  // Old episode's stamp is still in the state, but this is a NEW staleness
  // episode (different publishedAt) → fires.
  const n = buildSweepNotification(green, 0, newEpisode, [], STALE_STATUS.publishedAt);
  assert.equal(n.shouldNotify, true, "a new staleness episode must alert despite old state");
  assert.equal(n.stalenessAlertFired, true);
});

test("a real sweep failure still notifies while the stale baseline is suppressed", () => {
  const failed = buildSweepReport(
    [result({ name: "Broken", outcome: "failed", failureReason: "exit 1" })],
    META,
  );
  const n = buildSweepNotification(failed, 1, STALE_STATUS, [], STALE_STATUS.publishedAt);
  assert.equal(n.shouldNotify, true, "hard failures are never suppressed by staleness dedupe");
  assert.equal(n.stalenessAlertFired, false, "…but the staleness alert itself did not re-fire");
  assert.match(n.text, /has not refreshed in 2\.5 days/, "the staleness line still rides along as context");
});

test("baseline-staleness alert state round-trips; clearing resets the episode", () => {
  const dir = mkdtempSync(join(tmpdir(), "staleness-alert-state-"));
  const statePath = join(dir, "nested", "state.json");
  try {
    // Missing file → null (fall open to alerting).
    assert.equal(readAlertedBaselineStalenessStamp(statePath), null);

    writeAlertedBaselineStalenessStamp("2026-06-13T03:50:00.000Z", statePath);
    assert.equal(readAlertedBaselineStalenessStamp(statePath), "2026-06-13T03:50:00.000Z");

    // A fresh baseline clears the state so a later episode alerts again.
    writeAlertedBaselineStalenessStamp(null, statePath);
    assert.equal(readAlertedBaselineStalenessStamp(statePath), null);

    // Corrupt state file → null, never a throw.
    writeFileSync(statePath, "not json", "utf8");
    assert.equal(readAlertedBaselineStalenessStamp(statePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing report appends the staleness warning to its crash text", () => {
  const n = buildSweepNotification(null, 1, { publishedAt: "2026-06-10T03:50:00.000Z", ageDays: 6 });
  assert.equal(n.shouldNotify, true);
  assert.match(n.text, /could not produce a report/);
  assert.match(n.text, /has not refreshed in 6\.0 days/);
});

test("REPO INTEGRATION: readCommittedBaselineStatus reads the real committed baseline", () => {
  const status = readCommittedBaselineStatus(new Date());
  assert.ok(status.publishedAt, "committed tests/green-baseline.json carries a publishedAt stamp");
  assert.ok(status.ageDays !== null && Number.isFinite(status.ageDays) && status.ageDays >= 0, `age is a real number, got ${status.ageDays}`);

  const missing = readCommittedBaselineStatus(new Date(), "/nonexistent/baseline.json");
  assert.deepEqual(missing, { publishedAt: null, ageDays: null }, "absent baseline → nulls, never a throw");
});

// ---------------------------------------------------------------------------
// Task #4491 / #4533 — gate lint reds on main: alert line + once-per-streak
// ---------------------------------------------------------------------------

function greenReportWithLintReds(lintReds: string[] | null | undefined) {
  const report = buildSweepReport([result({ name: "A" })], META);
  if (lintReds !== undefined) report.lintReds = lintReds;
  return report;
}

test("gate lint reds on main alert even when the sweep is green, with the lint-red line riding the text", () => {
  const control = buildSweepNotification(greenReportWithLintReds([]), 0, null, null, null, []);
  assert.equal(control.shouldNotify, false, "control: green sweep + lint-green stays quiet");
  assert.deepEqual(control.lintReds, []);
  assert.equal(control.lintRedAlertFired, false);

  const n = buildSweepNotification(greenReportWithLintReds(["lint-b", "lint-a"]), 0, null, null, null, []);
  assert.equal(n.shouldNotify, true, "a NEW lint red on main pushes despite the green sweep");
  assert.equal(n.lintRedAlertFired, true);
  assert.deepEqual(n.lintReds, ["lint-a", "lint-b"], "sorted for stable state comparison");
  assert.match(n.text, /2 gate lint\(s\) RED on main/);
  assert.match(n.text, /lint-a, lint-b/);
  assert.match(n.text, /red-manifest\.json "lints"/, "the line points at the manifest section tasks will consult");
});

test("once per streak: an unchanged already-alerted lint-red set stays quiet; a NEW lint joining re-fires; omitted state falls open", () => {
  const report = greenReportWithLintReds(["lint-a"]);
  const second = buildSweepNotification(report, 0, null, null, null, ["lint-a"]);
  assert.equal(second.lintRedAlertFired, false, "unchanged alerted set must not re-fire");
  assert.equal(second.shouldNotify, false);
  assert.deepEqual(second.lintReds, ["lint-a"], "state reconciliation still sees the current set");

  const grown = buildSweepNotification(greenReportWithLintReds(["lint-a", "lint-new"]), 0, null, null, null, ["lint-a"]);
  assert.equal(grown.lintRedAlertFired, true, "a NEW lint joining the red set fires again");

  const fallOpen = buildSweepNotification(report, 0, null, null, null, null);
  assert.equal(fallOpen.lintRedAlertFired, true, "absent/corrupt alert state falls open to alerting");
});

test("blind runs never prune: lintReds null/absent (lint phase not measured) yields no fire AND no state signal", () => {
  for (const blind of [null, undefined] as const) {
    const n = buildSweepNotification(greenReportWithLintReds(blind), 0, null, null, null, []);
    assert.equal(n.lintRedAlertFired, false, "an unmeasured run can never fire the lint alert");
    assert.deepEqual(n.lintReds, [], "no measured set to reconcile");
    assert.equal(n.shouldNotify, false);
  }
  // The runOnce state reconcile is gated on Array.isArray(report.lintReds):
  // a blind run (null) must never write/clear the alerted-set state, or a
  // budget-overrun night would prune the streak and re-alert tomorrow.
  const src = readFileSync("server/services/regressionSweepScheduler.ts", "utf8");
  const reconcileIdx = src.indexOf("writeAlertedLintReds(lintReds)");
  assert.ok(reconcileIdx > 0, "runOnce reconciles the lint-red alert state");
  const guardWindow = src.slice(Math.max(0, reconcileIdx - 600), reconcileIdx);
  assert.ok(
    guardWindow.includes("Array.isArray(report.lintReds)"),
    "state reconcile is gated on the lint phase having actually MEASURED (blind runs never prune)",
  );
});

test("lint-red alert state round-trips through its dedicated state file (never throws on absent state)", () => {
  const root = mkdtempSync(join(tmpdir(), "lint-red-state-"));
  try {
    const statePath = join(root, "lint-red-alerted.json");
    assert.deepEqual(readAlertedLintReds(statePath), [], "absent state reads as empty, never throws");
    writeAlertedLintReds(["lint-b", "lint-a"], statePath);
    assert.deepEqual(readAlertedLintReds(statePath).sort(), ["lint-a", "lint-b"]);
    writeAlertedLintReds([], statePath);
    assert.deepEqual(readAlertedLintReds(statePath), [], "a lint-green measurement clears the streak state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// shouldScheduleRegressionSweep gating
// ---------------------------------------------------------------------------

test("never schedules in the deployment; schedules in the workspace by default", () => {
  const origDeploy = process.env.REPLIT_DEPLOYMENT;
  const origEnabled = process.env.REGRESSION_SWEEP_SCHEDULER_ENABLED;
  try {
    process.env.REPLIT_DEPLOYMENT = "1";
    delete process.env.REGRESSION_SWEEP_SCHEDULER_ENABLED;
    assert.equal(shouldScheduleRegressionSweep(), false, "deployment is never scheduled");

    delete process.env.REPLIT_DEPLOYMENT;
    assert.equal(shouldScheduleRegressionSweep(), true, "workspace default-on");

    process.env.REGRESSION_SWEEP_SCHEDULER_ENABLED = "false";
    assert.equal(shouldScheduleRegressionSweep(), false, "env opt-out honored");
  } finally {
    if (origDeploy === undefined) delete process.env.REPLIT_DEPLOYMENT;
    else process.env.REPLIT_DEPLOYMENT = origDeploy;
    if (origEnabled === undefined) delete process.env.REGRESSION_SWEEP_SCHEDULER_ENABLED;
    else process.env.REGRESSION_SWEEP_SCHEDULER_ENABLED = origEnabled;
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err instanceof Error ? err.stack : err);
  }
}

console.log(
  `\nregression-sweep-scheduler tests: ${tests.length - failed}/${tests.length} passed`,
);
if (failed > 0) {
  process.exitCode = 1;
  throw new Error(`${failed} regression-sweep test(s) failed`);
}
console.log("regression-sweep-scheduler.test.ts: OK");
