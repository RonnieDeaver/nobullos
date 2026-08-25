/* test-registration
{
  "name": "Nightly sweep failures file trackable feedback items — dedupe + auto-resolve (Task #3845)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3845: guards the sweep-failure→feedback pipeline — file-on-new-failure, one-item-per-streak dedupe across repeat nights, auto-resolve on recovery/green-skip/left-sweep, and submitter isolation so human rows are never touched. Fast single-table DB test on the hermetic backend with the Slack relay stubbed; if this rots, nightly failures silently stop becoming trackable items.",
  "scanPaths": [
    "server/services/regressionSweepScheduler.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3845 — nightly sweep failures become trackable feedback items.
 *
 * Layers pinned here:
 *
 *   (A) Pure planner (`planSweepFeedbackActions`):
 *         - new hard failure with no open item        → file
 *         - hard failure already open                 → nothing (streak)
 *         - open item whose test passed               → resolve "recovered"
 *         - open item green-skipped (proven green)    → resolve "recovered"
 *         - open item absent from the whole report    → resolve "left_sweep"
 *         - quarantined failure                       → never files; an open
 *           item for it stays open (muted is not fixed)
 *
 *   (B) DB driver (`fileAndResolveSweepFeedback`, Slack relay stubbed):
 *         - files a row with the sweep submitter, test file in current_page,
 *           topic BUG_REPORT, and records the relay outcome (delivered)
 *         - repeat night: no duplicate row, no second relay call
 *         - recovery night: row → status 'resolved' + recovery note appended
 *         - re-failure after recovery: a FRESH row (streak re-armed)
 *         - relay failure: slack_status 'failed' persists (retry re-drives)
 *         - rows from other submitters (human feedback) are never touched
 *         - a HUNG relay cannot stall the driver: the wait is bounded by
 *           FEEDBACK_SLACK_RELAY_BUDGET_MS and the row stays retryable
 *
 *   (C) Scheduler ordering (source pin): runOnce dispatches the run-level
 *       notifyByType alert BEFORE feedback filing, so a slow Slack relay in
 *       the feedback step can never delay or suppress the sweep alert.
 *
 * The test uses a randomized submitter id (not the production sentinel) and
 * randomized fake test-file paths, so parallel runs and shared-DB escape
 * hatches cannot collide; everything it writes is deleted in finally.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  buildSweepReport,
  type SweepReport,
  type SweepTestResult,
} from "../server/services/regressionSweep";
import {
  planSweepFeedbackActions,
  fileAndResolveSweepFeedback,
  buildSweepFeedbackText,
  __setSweepFeedbackRelayForTest,
  SWEEP_FEEDBACK_USER_ID,
} from "../server/services/regressionSweepFeedback";
import {
  FEEDBACK_SLACK_RELAY_BUDGET_MS,
  type FeedbackSlackRelayArgs,
  type FeedbackSlackResult,
} from "../server/services/feedbackSlackRelay";

const TAG = `task-3845-${randomUUID().slice(0, 8)}`;
const SUBMITTER = `system:regression-sweep-test-${TAG}`;
const SUBMITTER_NAME = `Nightly Test Sweep (${TAG})`;

const FILE_ALPHA = `tests/${TAG}-alpha.test.ts`;
const FILE_BETA = `tests/${TAG}-beta.test.ts`;
const FILE_GAMMA = `tests/${TAG}-gamma.test.ts`;
const FILE_DELTA = `tests/${TAG}-delta.test.ts`;
const FILE_EPSILON = `tests/${TAG}-epsilon.test.ts`;

function mkResult(
  over: Partial<SweepTestResult> & { file: string },
): SweepTestResult {
  return {
    name: over.file,
    outcome: "failed",
    quarantined: false,
    attempts: 3,
    elapsedMs: 12_000,
    failureReason: "exit 1",
    ...over,
  };
}

function mkReport(
  results: SweepTestResult[],
  skippedGreenFiles: string[] = [],
): SweepReport {
  return buildSweepReport(results, {
    startedAt: "2026-08-05T07:30:00.000Z",
    finishedAt: "2026-08-05T08:10:00.000Z",
    mode: "regression",
    skippedGreen: skippedGreenFiles.length,
    skippedGreenFiles,
  });
}

interface Row {
  id: number;
  current_page: string | null;
  status: string;
  slack_status: string;
  slack_reason: string | null;
  feedback_text: string;
  topic: string;
  user_name: string;
}

async function fetchRows(submitter: string = SUBMITTER): Promise<Row[]> {
  const res: any = await db.execute(sql`
    SELECT id, current_page, status, slack_status, slack_reason, feedback_text, topic, user_name
    FROM user_feedback
    WHERE user_id = ${submitter}
    ORDER BY id
  `);
  return res.rows as Row[];
}

// ─────────────────────────────────────────────────────────────────────────────

function testPlannerFilesOnlyNewHardFailures(): void {
  const failing = mkResult({ file: FILE_ALPHA });
  const report = mkReport([failing, mkResult({ file: FILE_BETA, outcome: "passed" })]);

  // No open items → the hard failure files, the pass does nothing.
  let plan = planSweepFeedbackActions(report, []);
  assert.deepEqual(plan.toFile.map((r) => r.file), [FILE_ALPHA]);
  assert.deepEqual(plan.toResolve, []);

  // Already open → streak continues, nothing filed, nothing resolved.
  plan = planSweepFeedbackActions(report, [FILE_ALPHA]);
  assert.deepEqual(plan.toFile, []);
  assert.deepEqual(plan.toResolve, []);
  console.log("  ✓ planner files only NEW hard failures");
}

function testPlannerResolvesRecoveredAndDeparted(): void {
  const report = mkReport(
    [mkResult({ file: FILE_ALPHA, outcome: "passed" })],
    [FILE_BETA], // proven green via fingerprint skip
  );
  const plan = planSweepFeedbackActions(report, [FILE_ALPHA, FILE_BETA, FILE_GAMMA]);
  assert.deepEqual(plan.toFile, []);
  assert.deepEqual(
    plan.toResolve.slice().sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: FILE_ALPHA, reason: "recovered" },
      { file: FILE_BETA, reason: "recovered" },
      { file: FILE_GAMMA, reason: "left_sweep" },
    ].sort((a, b) => a.file.localeCompare(b.file)),
  );
  console.log("  ✓ planner resolves passed, green-skipped, and departed tests");
}

function testPlannerIgnoresQuarantinedFailures(): void {
  const report = mkReport([mkResult({ file: FILE_ALPHA, quarantined: true })]);
  // Quarantined failure never files…
  let plan = planSweepFeedbackActions(report, []);
  assert.deepEqual(plan.toFile, []);
  assert.deepEqual(plan.toResolve, []);
  // …and an already-open item for it stays open (muted is not fixed).
  plan = planSweepFeedbackActions(report, [FILE_ALPHA]);
  assert.deepEqual(plan.toFile, []);
  assert.deepEqual(plan.toResolve, []);
  console.log("  ✓ planner treats quarantined failures as neither failure nor recovery");
}

// ─────────────────────────────────────────────────────────────────────────────

async function testDriverLifecycle(): Promise<void> {
  const relayCalls: FeedbackSlackRelayArgs[] = [];
  let relayResult: FeedbackSlackResult = { status: "delivered", reason: null };
  __setSweepFeedbackRelayForTest(async (args) => {
    relayCalls.push(args);
    return relayResult;
  });

  const humanId = `human-${TAG}`;
  try {
    // A human row on the SAME test-file path — the driver must never touch it.
    await db.execute(sql`
      INSERT INTO user_feedback (user_id, user_name, topic, feedback_text, current_page, screenshots)
      VALUES (${humanId}, 'Real Person', 'BUG_REPORT', 'human-filed item', ${FILE_ALPHA}, '[]')
    `);

    const failingReport = mkReport([
      mkResult({ file: FILE_ALPHA, failureReason: "hang 184s" }),
      mkResult({ file: FILE_BETA, outcome: "passed" }),
    ]);

    // Night 1 — new failure files one row and relays it.
    let summary = await fileAndResolveSweepFeedback(failingReport, {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
    });
    assert.deepEqual(summary, { filed: 1, resolved: 0 });
    let rows = await fetchRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].current_page, FILE_ALPHA);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].slack_status, "delivered");
    assert.equal(rows[0].topic, "BUG_REPORT");
    assert.equal(rows[0].user_name, SUBMITTER_NAME);
    assert.ok(rows[0].feedback_text.includes("hang 184s"));
    assert.ok(rows[0].feedback_text.includes(`npm test -- --file=${FILE_ALPHA}`));
    assert.equal(relayCalls.length, 1);
    assert.equal(relayCalls[0].page, FILE_ALPHA);
    console.log("  ✓ night 1: new failure files one delivered item");

    // Night 2 — same failure again: no duplicate, no extra relay call.
    summary = await fileAndResolveSweepFeedback(failingReport, {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
    });
    assert.deepEqual(summary, { filed: 0, resolved: 0 });
    rows = await fetchRows();
    assert.equal(rows.length, 1);
    assert.equal(relayCalls.length, 1);
    console.log("  ✓ night 2: repeat failure files nothing (streak dedupe)");

    // Night 3 — the test recovers: the item resolves with a note.
    const recoveredReport = mkReport([
      mkResult({ file: FILE_ALPHA, outcome: "passed" }),
      mkResult({ file: FILE_BETA, outcome: "passed" }),
    ]);
    summary = await fileAndResolveSweepFeedback(recoveredReport, {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
    });
    assert.deepEqual(summary, { filed: 0, resolved: 1 });
    rows = await fetchRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "resolved");
    assert.ok(rows[0].feedback_text.includes("[Auto-resolved] Passed in the sweep"));
    console.log("  ✓ night 3: recovery resolves the item with a note");

    // Night 4 — it breaks again: a FRESH row starts a new streak.
    summary = await fileAndResolveSweepFeedback(failingReport, {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
    });
    assert.deepEqual(summary, { filed: 1, resolved: 0 });
    rows = await fetchRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, "resolved");
    assert.equal(rows[1].status, "pending");
    assert.equal(relayCalls.length, 2);
    console.log("  ✓ night 4: re-failure after recovery files a fresh item");

    // Relay failure path — the row persists with slack_status 'failed' so the
    // feedback_slack_retry scheduler re-drives it.
    relayResult = { status: "failed", reason: "Slack is temporarily unreachable — it will retry." };
    const gammaReport = mkReport([
      mkResult({ file: FILE_ALPHA, failureReason: "hang 184s" }),
      mkResult({ file: FILE_GAMMA }),
    ]);
    summary = await fileAndResolveSweepFeedback(gammaReport, {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
    });
    assert.deepEqual(summary, { filed: 1, resolved: 0 });
    rows = await fetchRows();
    const gammaRow = rows.find((r) => r.current_page === FILE_GAMMA);
    assert.ok(gammaRow);
    assert.equal(gammaRow!.status, "pending");
    assert.equal(gammaRow!.slack_status, "failed");
    assert.ok(gammaRow!.slack_reason?.includes("temporarily unreachable"));
    console.log("  ✓ relay failure persists as slack_status=failed (retryable)");

    // Departure — delta fails once, then vanishes from the report entirely
    // (deleted/renamed/de-flagged): its item resolves as left-sweep.
    relayResult = { status: "delivered", reason: null };
    await fileAndResolveSweepFeedback(mkReport([mkResult({ file: FILE_DELTA })]), {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
    });
    // NOTE: this report lists neither alpha nor gamma, so their open items
    // resolve as left-sweep here too — acceptable in this synthetic sequence;
    // the assertion targets delta's note text.
    summary = await fileAndResolveSweepFeedback(mkReport([mkResult({ file: FILE_BETA, outcome: "passed" })]), {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
    });
    assert.ok(summary.resolved >= 1);
    rows = await fetchRows();
    const deltaRow = rows.find((r) => r.current_page === FILE_DELTA);
    assert.ok(deltaRow);
    assert.equal(deltaRow!.status, "resolved");
    assert.ok(deltaRow!.feedback_text.includes("No longer part of the nightly sweep selection"));
    console.log("  ✓ a test that leaves the sweep resolves as left-sweep");

    // The human row on the same path is untouched through all of the above.
    const humanRows = await fetchRows(humanId);
    assert.equal(humanRows.length, 1);
    assert.equal(humanRows[0].status, "pending");
    assert.equal(humanRows[0].feedback_text, "human-filed item");
    console.log("  ✓ human-submitted rows on the same file are never touched");
  } finally {
    __setSweepFeedbackRelayForTest(null);
    await db.execute(sql`DELETE FROM user_feedback WHERE user_id IN (${SUBMITTER}, ${humanId})`);
  }
}

async function testHungRelayCannotStallTheDriver(): Promise<void> {
  // A relay that never settles (Slack hanging with no timeout) must not
  // stall the sweep tick: the driver's wait is bounded by the relay budget,
  // the row persists, and slack_status stays 'pending' — which the
  // feedback_slack_retry scheduler re-drives (it selects everything NOT IN
  // ('delivered', 'undeliverable')).
  __setSweepFeedbackRelayForTest(() => new Promise<FeedbackSlackResult>(() => {}));
  try {
    const t0 = Date.now();
    const summary = await fileAndResolveSweepFeedback(
      mkReport([mkResult({ file: FILE_EPSILON })]),
      { submitterId: SUBMITTER, submitterName: SUBMITTER_NAME },
    );
    const elapsed = Date.now() - t0;
    assert.deepEqual(summary, { filed: 1, resolved: 0 });
    assert.ok(
      elapsed < FEEDBACK_SLACK_RELAY_BUDGET_MS + 2000,
      `driver returned in ${elapsed}ms — bounded by the ${FEEDBACK_SLACK_RELAY_BUDGET_MS}ms relay budget`,
    );
    const rows = await fetchRows();
    const row = rows.find((r) => r.current_page === FILE_EPSILON);
    assert.ok(row);
    assert.equal(row!.status, "pending");
    assert.equal(row!.slack_status, "pending");
    console.log("  ✓ a hung Slack relay cannot stall the driver; row stays retryable");
  } finally {
    __setSweepFeedbackRelayForTest(null);
    await db.execute(sql`DELETE FROM user_feedback WHERE user_id = ${SUBMITTER}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function testAlertFiresBeforeFeedbackFiling(): void {
  // Structural pin for the reviewed failure mode: a slow Slack relay inside
  // the feedback step must never delay the run-level sweep alert, so
  // runOnce dispatches notifyByType BEFORE fileAndResolveSweepFeedback.
  const src = readFileSync("server/services/regressionSweepScheduler.ts", "utf8");
  const notifyAt = src.indexOf("await notifyByType(");
  const feedbackAt = src.indexOf("await fileAndResolveSweepFeedback(");
  assert.ok(notifyAt > -1, "runOnce dispatches the run-level alert via notifyByType");
  assert.ok(feedbackAt > -1, "runOnce drives feedback filing via fileAndResolveSweepFeedback");
  assert.ok(
    notifyAt < feedbackAt,
    "run-level alert dispatch precedes feedback filing in runOnce",
  );
  console.log("  ✓ scheduler dispatches the run-level alert before feedback filing");
}

// ─────────────────────────────────────────────────────────────────────────────

function testTextAndConstants(): void {
  const r = mkResult({ file: FILE_ALPHA, failureReason: "exit 1", attempts: 2 });
  const text = buildSweepFeedbackText(r, mkReport([r]));
  assert.ok(text.includes(FILE_ALPHA));
  assert.ok(text.includes("exit 1"));
  assert.ok(text.includes("2 attempts"));
  assert.ok(text.length < 5000, "item text fits the feedback column budget");
  // The production sentinel is reserved and never a plausible OIDC sub.
  assert.ok(SWEEP_FEEDBACK_USER_ID.startsWith("system:"));
  console.log("  ✓ item text names the file, reason, and repro command");
}

async function testConcurrentFilingCollapsesToOneRow(): Promise<void> {
  // Task #4545 — the open-row dedupe in fileAndResolveSweepFeedback is a
  // SELECT-then-INSERT; two concurrent watchdogs (workspaces sharing one dev
  // DB) can both observe no pending row. The partial unique index
  // user_feedback_system_pending_dedupe_idx + ON CONFLICT DO NOTHING must
  // collapse the race to exactly ONE pending row (and at most one relay).
  __setSweepFeedbackRelayForTest(async () => ({ ok: true, status: "delivered" } as any));
  const report = mkReport([mkResult({ file: FILE_EPSILON })]);
  try {
    const [a, b] = await Promise.all([
      fileAndResolveSweepFeedback(report, {
        submitterId: SUBMITTER,
        submitterName: SUBMITTER_NAME,
      }),
      fileAndResolveSweepFeedback(report, {
        submitterId: SUBMITTER,
        submitterName: SUBMITTER_NAME,
      }),
    ]);
    const rows = await db.execute(sql`
      SELECT id FROM user_feedback
      WHERE user_id = ${SUBMITTER} AND current_page = ${FILE_EPSILON} AND status = 'pending'
    `);
    assert.equal(
      rows.rows.length,
      1,
      "concurrent filers collapse to exactly one pending row (unique-index dedupe)",
    );
    assert.ok(
      a.filed + b.filed <= 2 && a.filed + b.filed >= 1,
      "at least one filer reports success",
    );
    console.log("  ✓ concurrent filing collapses to one pending row");
  } finally {
    __setSweepFeedbackRelayForTest(null);
    await db.execute(sql`DELETE FROM user_feedback WHERE user_id = ${SUBMITTER}`);
  }
}

async function testNoAutoResolveKeepsOlderIncidentsOpen(): Promise<void> {
  // Task #4545 — the post-merge canary files PARTIAL reports (only the
  // not-yet-filed culprits), so with autoResolve:false an incident filed on
  // an earlier tick must stay pending when a later tick files a different
  // culprit; each item dedupes independently.
  __setSweepFeedbackRelayForTest(async () => ({ ok: true, status: "delivered" } as any));
  const fileA = `post-merge-canary:${TAG}-culprit-a`;
  const fileB = `post-merge-canary:${TAG}-culprit-b`;
  try {
    // Tick 1: culprit A files.
    await fileAndResolveSweepFeedback(mkReport([mkResult({ file: fileA })]), {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
      autoResolve: false,
    });
    // Tick 2: culprit B files — A is absent from this report.
    const s2 = await fileAndResolveSweepFeedback(mkReport([mkResult({ file: fileB })]), {
      submitterId: SUBMITTER,
      submitterName: SUBMITTER_NAME,
      autoResolve: false,
    });
    assert.equal(s2.resolved, 0, "autoResolve:false never resolves anything");
    const rows = await db.execute(sql`
      SELECT current_page FROM user_feedback
      WHERE user_id = ${SUBMITTER} AND status = 'pending'
      ORDER BY current_page
    `);
    assert.deepEqual(
      rows.rows.map((r: any) => r.current_page),
      [fileA, fileB].sort(),
      "BOTH incidents stay pending — a later culprit never closes an earlier one",
    );
    // Re-drive both: open-row dedupe still holds per item.
    const s3 = await fileAndResolveSweepFeedback(
      mkReport([mkResult({ file: fileA }), mkResult({ file: fileB })]),
      { submitterId: SUBMITTER, submitterName: SUBMITTER_NAME, autoResolve: false },
    );
    assert.equal(s3.filed, 0, "open incidents dedupe independently on re-file");
    console.log("  ✓ autoResolve:false keeps older incidents open and independently deduped");
  } finally {
    __setSweepFeedbackRelayForTest(null);
    await db.execute(sql`DELETE FROM user_feedback WHERE user_id = ${SUBMITTER}`);
  }
}

async function main(): Promise<void> {
  testPlannerFilesOnlyNewHardFailures();
  testPlannerResolvesRecoveredAndDeparted();
  testPlannerIgnoresQuarantinedFailures();
  testTextAndConstants();
  testAlertFiresBeforeFeedbackFiling();
  await testDriverLifecycle();
  await testHungRelayCannotStallTheDriver();
  await testConcurrentFilingCollapsesToOneRow();
  await testNoAutoResolveKeepsOlderIncidentsOpen();
  console.log("regression-sweep-feedback: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
main().catch((err) => {
  console.error("regression-sweep-feedback: FAILED");
  console.error(err);
  process.exitCode = 1;
});
