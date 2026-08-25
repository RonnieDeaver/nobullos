// @db-pool-intent: ambient
//
// Every DB helper here lazy-imports `getDb()` and inherits whichever pool the
// caller installed — mirroring feedbackSlackRelay.ts, whose relay/recording
// functions this module calls. In practice there is exactly one caller: the
// nightly sweep scheduler tick inside the dev-workspace server process.
/**
 * Task #3845 — turn nightly sweep failures into trackable feedback items.
 *
 * The run-level alert (`infra.regression_sweep.failed` in
 * regressionSweepScheduler.ts) is a one-line summary that scrolls away.
 * This module additionally files each REAL failure (non-quarantined, already
 * retry-verified by `--sweep` mode) as a `user_feedback` row — the same
 * pipeline human feedback uses — so it:
 *
 *   - lands in /admin/feedback + the planning agent's feedback view as a
 *     durable, per-test work item, and
 *   - posts to the "Ronnie thought stream" Slack channel via the shared
 *     relay, inheriting its slack_status persistence and the
 *     `feedback_slack_retry` re-drive machinery when Slack is down.
 *
 * Streak dedupe — the open row IS the state (no extra table):
 *   One item per failing test file per failure streak. "Open" means a row
 *   with `user_id = SWEEP_FEEDBACK_USER_ID AND status = 'pending'`; the test
 *   file path is stored in `current_page` (the natural "where did this come
 *   from" column, and an exact-match dedupe key). A failure that is already
 *   open files nothing on repeat nights. When the test later passes (or is
 *   skipped as green-on-identical-inputs, or leaves the sweep selection
 *   entirely) the row auto-resolves (`status = 'resolved'` + an appended
 *   recovery note), which re-arms the streak: the next failure files a fresh
 *   item.
 *
 * Noise decisions (deliberate, keep in sync with regressionSweepScheduler):
 *   - The run-level notifyByType alert STAYS — inbox + health-state summary.
 *   - The per-admin notifyUser fan-out that POST /api/feedback does is NOT
 *     mirrored here; the run-level alert already pings the inbox, and one
 *     ping per failing test would be double-noise.
 *   - Quarantined failures and flaky-passed-on-retry suites never file items
 *     (same "warnings are not failures" policy as the alert).
 *
 * Synthetic submitter: `user_feedback.user_id` is a plain varchar with no FK
 * and `user_name` is denormalized onto the row, so a reserved sentinel id is
 * safe — no users row is needed, and real-user feedback analytics can filter
 * these rows out by `user_id`. Sweep items carry no attachments, so the
 * video auto-analysis pipeline never runs for them.
 */
import { sql } from "drizzle-orm";

import {
  relayFeedbackToSlack,
  recordFeedbackSlackResult,
  FEEDBACK_SLACK_RELAY_BUDGET_MS,
  type FeedbackSlackRelayArgs,
  type FeedbackSlackResult,
} from "./feedbackSlackRelay";
import type { SweepReport, SweepTestResult } from "./regressionSweep";

/** Reserved submitter id for sweep-filed rows. Never a real OIDC sub. */
export const SWEEP_FEEDBACK_USER_ID = "system:regression-sweep";
/** Display name shown in /admin/feedback and the Slack message. */
export const SWEEP_FEEDBACK_USER_NAME = "Nightly Test Sweep";

export interface SweepFeedbackPlan {
  /** Hard failures with no open item yet — file one each. */
  toFile: SweepTestResult[];
  /** Open items whose test is no longer hard-failing — resolve them. */
  toResolve: Array<{ file: string; reason: "recovered" | "left_sweep" }>;
}

/**
 * Pure planner: given tonight's report and the test files that currently
 * have an OPEN sweep-filed item, decide what to file and what to resolve.
 *
 *   - hard failure, no open item          → file
 *   - hard failure, item already open     → nothing (streak continues)
 *   - open item, test passed tonight      → resolve ("recovered")
 *   - open item, test green-skipped       → resolve ("recovered") — the
 *     runner only green-skips a suite whose last run passed on identical
 *     inputs, so a skip is a proof of green, not an unknown
 *   - open item, quarantined failure      → nothing (muted is not fixed)
 *   - open item, absent from the report   → resolve ("left_sweep") — the
 *     test left the regression selection (deleted/renamed/deflagged) and no
 *     future sweep could ever recover it
 */
export function planSweepFeedbackActions(
  report: SweepReport,
  openFiles: readonly string[],
): SweepFeedbackPlan {
  const hardFailed = report.results.filter(
    (r) => r.outcome === "failed" && !r.quarantined,
  );
  const hardFailedFiles = new Set(hardFailed.map((r) => r.file));
  const passedFiles = new Set(
    report.results.filter((r) => r.outcome === "passed").map((r) => r.file),
  );
  const quarantinedFailedFiles = new Set(
    report.results
      .filter((r) => r.outcome === "failed" && r.quarantined)
      .map((r) => r.file),
  );
  const greenSkipped = new Set(report.skippedGreenFiles ?? []);

  const open = new Set(openFiles);
  const toFile = hardFailed.filter((r) => !open.has(r.file));

  const toResolve: SweepFeedbackPlan["toResolve"] = [];
  for (const file of open) {
    if (hardFailedFiles.has(file)) continue; // still failing → stays open
    if (passedFiles.has(file) || greenSkipped.has(file)) {
      toResolve.push({ file, reason: "recovered" });
      continue;
    }
    if (quarantinedFailedFiles.has(file)) continue; // muted, not fixed
    toResolve.push({ file, reason: "left_sweep" });
  }
  return { toFile, toResolve };
}

/** Body of the feedback item for one failing test. */
export function buildSweepFeedbackText(
  result: SweepTestResult,
  report: SweepReport,
): string {
  const lines = [
    `Nightly regression sweep failure: ${result.name}`,
    ``,
    `Test file: ${result.file}`,
    `Failure: ${result.failureReason ?? "failed"} (after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}, ${Math.round(result.elapsedMs / 1000)}s total)`,
    `Sweep run: ${report.startedAt} → ${report.finishedAt} (${report.mode} mode; ${report.hardFailed} hard failure(s) of ${report.total} executed)`,
  ];
  // Task #5030 — culprit naming: when this suite went red for the first time
  // in this sweep and the publish step resolved the merge window since the
  // previous manifest, name it here so triage starts at the culprit merge
  // instead of falling on the next unlucky task.
  const win = report.newRedMergeWindow;
  if (win && win.newReds.includes(result.file)) {
    const single = win.commits.length === 1 && !win.truncated;
    lines.push(``);
    if (single) {
      const c = win.commits[0];
      lines.push(
        `Culprit merge (sole commit in the window since the last green manifest): ${c.commit.slice(0, 10)}${c.task ? ` (${c.task})` : ""} — ${c.subject}`,
      );
    } else {
      lines.push(
        `Culprit merge window (${win.commits.length} commit(s)${win.truncated ? ", truncated" : ""}) between ${win.fromCommit.slice(0, 10)} and ${win.toCommit.slice(0, 10)}:`,
      );
      for (const c of win.commits.slice(0, 10)) {
        lines.push(`  - ${c.commit.slice(0, 10)}${c.task ? ` (${c.task})` : ""} — ${c.subject}`);
      }
      if (win.commits.length > 10) lines.push(`  … ${win.commits.length - 10} more`);
    }
  }
  lines.push(
    ``,
    `Filed automatically by the nightly sweep. This item stays open while the`,
    `test keeps failing and resolves itself once a later sweep sees it pass.`,
    `Reproduce: npm test -- --file=${result.file}`,
    `Run output: the workspace console's [RegressionSweep] lines for this night.`,
  );
  return lines.join("\n");
}

function buildRecoveryNote(
  reason: "recovered" | "left_sweep",
  report: SweepReport,
): string {
  const stamp = report.finishedAt || new Date().toISOString();
  return reason === "recovered"
    ? `\n\n[Auto-resolved] Passed in the sweep that finished ${stamp}.`
    : `\n\n[Auto-resolved] No longer part of the nightly sweep selection (deleted, renamed, or de-flagged) as of the sweep that finished ${stamp}.`;
}

// Test seam: lets the suite exercise the full file/dedupe/resolve pipeline
// without reaching Slack. Production never sets it.
let relayOverride: ((args: FeedbackSlackRelayArgs) => Promise<FeedbackSlackResult>) | null =
  null;
export function __setSweepFeedbackRelayForTest(
  fn: typeof relayOverride,
): void {
  relayOverride = fn;
}

async function listOpenSweepItems(
  submitterId: string,
): Promise<Array<{ id: number; file: string }>> {
  const { getDb, withDbAttribution } = await import("../db");
  return withDbAttribution("sweepFeedback:listOpen", async () => {
    const res = await getDb().execute(sql`
      SELECT id, current_page
      FROM user_feedback
      WHERE user_id = ${submitterId} AND status = 'pending'
    `);
    return (res.rows ?? [])
      .filter((r: any) => typeof r.current_page === "string" && r.current_page)
      .map((r: any) => ({ id: Number(r.id), file: r.current_page as string }));
  });
}

// Task #4545 — single-flight lazy ensure of the dedupe index. The insert
// below relies on user_feedback_system_pending_dedupe_idx for its
// ON CONFLICT arbiter (42P10 without it). The index is created by migration
// + the feedback-routes boot ensure, but NOT every provisioning path runs
// those before the first filing (hermetic test DBs, scheduler racing the
// boot chain), so the writer ensures it itself, once per process. The
// duplicate-collapse UPDATE mirrors the migration so index creation cannot
// fail on pre-existing pending duplicates.
let dedupeIndexEnsure: Promise<void> | null = null;
function ensureDedupeIndex(): Promise<void> {
  if (!dedupeIndexEnsure) {
    dedupeIndexEnsure = (async () => {
      const { getDb, withDbAttribution } = await import("../db");
      await withDbAttribution("sweepFeedback:ensureIndex", async () => {
        await getDb().execute(sql`
          UPDATE user_feedback
          SET status = 'resolved',
              feedback_text = feedback_text || e'\n\n[Auto-resolved] Duplicate of an earlier open item for the same test (collapsed by the dedupe-index backfill, Task #4545).'
          WHERE user_id LIKE 'system:%'
            AND status = 'pending'
            AND current_page IS NOT NULL
            AND id NOT IN (
              SELECT MIN(id)
              FROM user_feedback
              WHERE user_id LIKE 'system:%'
                AND status = 'pending'
                AND current_page IS NOT NULL
              GROUP BY user_id, current_page
            )
        `);
        await getDb().execute(sql`
          CREATE UNIQUE INDEX IF NOT EXISTS user_feedback_system_pending_dedupe_idx
            ON user_feedback (user_id, current_page)
            WHERE status = 'pending' AND user_id LIKE 'system:%' AND current_page IS NOT NULL
        `);
      });
    })().catch((err) => {
      dedupeIndexEnsure = null; // retry on the next filing
      throw err;
    });
  }
  return dedupeIndexEnsure;
}

async function insertSweepItem(
  submitterId: string,
  submitterName: string,
  result: SweepTestResult,
  report: SweepReport,
): Promise<number | null> {
  const { getDb, withDbAttribution } = await import("../db");
  const text = buildSweepFeedbackText(result, report);
  await ensureDedupeIndex();
  return withDbAttribution("sweepFeedback:file", async () => {
    // Task #4545 — conflict-safe insert: the open-row dedupe above is a
    // SELECT-then-INSERT, which races when concurrent workspaces share the
    // dev DB. The partial unique index
    // user_feedback_system_pending_dedupe_idx (status='pending' AND
    // user_id LIKE 'system:%' AND current_page IS NOT NULL) makes the race
    // lose atomically: the loser's insert returns no row (→ null), so it
    // files nothing and sends no Slack relay.
    const res = await getDb().execute(sql`
      INSERT INTO user_feedback (user_id, user_name, topic, feedback_text, current_page, screenshots)
      VALUES (${submitterId}, ${submitterName}, 'BUG_REPORT', ${text}, ${result.file}, '[]')
      ON CONFLICT (user_id, current_page)
        WHERE status = 'pending' AND user_id LIKE 'system:%' AND current_page IS NOT NULL
        DO NOTHING
      RETURNING id
    `);
    const id = (res.rows?.[0] as any)?.id;
    return id == null ? null : Number(id);
  });
}

/**
 * Resolve by FILE (not row id) so a historical duplicate pair collapses in
 * one pass. Guarded on `status = 'pending'` and the sweep submitter id, so
 * it can never touch a human-submitted row. Returns rows resolved.
 */
async function resolveSweepItemsForFile(
  submitterId: string,
  file: string,
  note: string,
): Promise<number> {
  const { getDb, withDbAttribution } = await import("../db");
  return withDbAttribution("sweepFeedback:resolve", async () => {
    const res = await getDb().execute(sql`
      UPDATE user_feedback
      SET status = 'resolved',
          feedback_text = feedback_text || ${note}
      WHERE user_id = ${submitterId}
        AND status = 'pending'
        AND current_page = ${file}
    `);
    return res.rowCount ?? 0;
  });
}

/**
 * Task #4561 — recovery-arm seams for the post-merge canary. The canary's
 * "fix main" items are per-culprit incidents filed with autoResolve:false, so
 * fileAndResolveSweepFeedback never closes them; the scheduler's recovery arm
 * instead lists the open items and resolves the ones whose broken suites have
 * all cleared from the committed red manifest. Both wrappers keep the same
 * safety rails as the internals they expose: pending-only, submitter-scoped.
 */
export async function listOpenSweepItemFiles(submitterId: string): Promise<string[]> {
  return (await listOpenSweepItems(submitterId)).map((r) => r.file);
}

/** Resolve every pending item for this submitter+file, appending `note`.
 * Returns rows resolved. Guarded on the submitter id and pending status —
 * can never touch human-submitted rows. */
export async function resolveOpenSweepItemsForFile(
  submitterId: string,
  file: string,
  note: string,
): Promise<number> {
  return resolveSweepItemsForFile(submitterId, file, note);
}

export interface SweepFeedbackSummary {
  filed: number;
  resolved: number;
}

/**
 * Drive one report's worth of filing + resolution. Caller contract: `report`
 * comes from a `--regression --sweep` run (the scheduler is the only
 * production caller). DB errors propagate — the scheduler wraps this call —
 * but a Slack relay problem never aborts OR stalls the batch: each filed
 * row's relay is raced against FEEDBACK_SLACK_RELAY_BUDGET_MS (route
 * parity), the row is already persisted before the relay starts, and
 * `feedback_slack_retry` re-drives anything not yet delivered.
 */
export async function fileAndResolveSweepFeedback(
  report: SweepReport,
  opts: { submitterId?: string; submitterName?: string; autoResolve?: boolean } = {},
): Promise<SweepFeedbackSummary> {
  const submitterId = opts.submitterId ?? SWEEP_FEEDBACK_USER_ID;
  const submitterName = opts.submitterName ?? SWEEP_FEEDBACK_USER_NAME;

  const openRows = await listOpenSweepItems(submitterId);
  let plan = planSweepFeedbackActions(
    report,
    openRows.map((r) => r.file),
  );
  // Task #4545 — incident-style callers (post-merge canary) pass PARTIAL
  // reports: each report carries only the not-yet-filed incidents, so an
  // open row's absence proves nothing about recovery. autoResolve:false
  // keeps the filing/dedupe path but drops every resolve action; the nightly
  // sweep (full report) keeps the default recovery semantics.
  if (opts.autoResolve === false) {
    plan = { toFile: plan.toFile, toResolve: [] };
  }

  let resolved = 0;
  for (const item of plan.toResolve) {
    resolved += await resolveSweepItemsForFile(
      submitterId,
      item.file,
      buildRecoveryNote(item.reason, report),
    );
  }

  let filed = 0;
  for (const failure of plan.toFile) {
    const rowId = await insertSweepItem(submitterId, submitterName, failure, report);
    if (rowId == null) continue;
    filed++;

    // Route-parity Slack handling (mirrors POST /api/feedback): the relay
    // runs to completion and persists its terminal status in the background,
    // but we only WAIT for it up to FEEDBACK_SLACK_RELAY_BUDGET_MS. A hung
    // Slack request therefore cannot stall the sweep tick — the row is
    // already persisted with slack_status 'pending', and the
    // feedback_slack_retry scheduler re-drives everything whose slack_status
    // is NOT IN ('delivered', 'undeliverable').
    const relay = relayOverride ?? relayFeedbackToSlack;
    const relayDone = relay({
      topic: "BUG_REPORT",
      userName: submitterName,
      page: failure.file,
      feedbackText: buildSweepFeedbackText(failure, report),
      screenshotCount: 0,
      videoCount: 0,
      viewUrl: null,
    })
      .catch((err: any) => {
        // relayFeedbackToSlack documents that it never throws; this is a
        // belt for the injected test relay and future edits.
        console.warn(
          `[SweepFeedback] Slack relay threw for ${failure.file}:`,
          err?.message ?? err,
        );
        return {
          status: "failed",
          reason: "Slack relay failed unexpectedly — it can be re-sent.",
        } as FeedbackSlackResult;
      })
      .then(async (result) => {
        await recordFeedbackSlackResult(rowId, result);
        return result;
      });
    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
      budgetTimer = setTimeout(() => resolve(null), FEEDBACK_SLACK_RELAY_BUDGET_MS);
    });
    const raced = await Promise.race([relayDone, budget]);
    if (budgetTimer) clearTimeout(budgetTimer);
    if (raced === null) {
      console.log(
        `[SweepFeedback] Slack relay still in flight for ${failure.file} — continuing; the retry scheduler finishes delivery.`,
      );
    }
  }

  return { filed, resolved };
}

// ---------------------------------------------------------------------------
// Task #5028 — Auto-quarantine feedback filing
// ---------------------------------------------------------------------------

/** Reserved submitter id for auto-quarantine fix-task rows (Task #5028). */
export const QUARANTINE_FEEDBACK_USER_ID = "system:flake-quarantine";
/** Display name shown in /admin/feedback. */
export const QUARANTINE_FEEDBACK_USER_NAME = "Auto-Quarantine";

export interface QuarantineFeedbackSummary {
  filed: number;
  resolved: number;
}

/**
 * Task #5028 — Drive quarantine feedback filing and resolution.
 *
 * Files a BUG_REPORT item for each newly-quarantined suite and resolves the
 * open item for each reinstated suite. Uses the same sentinel/dedupe
 * conventions as fileAndResolveSweepFeedback: the partial unique index
 * (user_id, current_page) WHERE pending AND user_id LIKE 'system:%' makes
 * ON CONFLICT DO NOTHING idempotent across concurrent ticks.
 *
 * DB errors propagate (caller wraps in try/catch). Slack relay errors never
 * stall the batch — the relay is budget-raced and the retry scheduler drives
 * pending rows.
 */
export async function fileAndResolveQuarantineFeedback(opts: {
  entered: Array<{ file: string; feedbackText: string }>;
  reinstatedFiles: string[];
}): Promise<QuarantineFeedbackSummary> {
  await ensureDedupeIndex();
  const { getDb, withDbAttribution } = await import("../db");

  let filed = 0;
  for (const entry of opts.entered) {
    const rowId: number | null = await withDbAttribution("quarantineFeedback:file", async () => {
      const res = await getDb().execute(sql`
        INSERT INTO user_feedback (user_id, user_name, topic, feedback_text, current_page, screenshots)
        VALUES (
          ${QUARANTINE_FEEDBACK_USER_ID},
          ${QUARANTINE_FEEDBACK_USER_NAME},
          'BUG_REPORT',
          ${entry.feedbackText},
          ${entry.file},
          '[]'
        )
        ON CONFLICT (user_id, current_page)
          WHERE status = 'pending' AND user_id LIKE 'system:%' AND current_page IS NOT NULL
          DO NOTHING
        RETURNING id
      `);
      const id = (res.rows?.[0] as any)?.id;
      return id == null ? null : Number(id);
    });
    if (rowId == null) continue;
    filed++;

    // Slack relay (route-parity with sweep feedback; budget-raced).
    const relay = relayOverride ?? relayFeedbackToSlack;
    const relayDone = relay({
      topic: "BUG_REPORT",
      userName: QUARANTINE_FEEDBACK_USER_NAME,
      page: entry.file,
      feedbackText: entry.feedbackText,
      screenshotCount: 0,
      videoCount: 0,
    }).catch((err: any) => {
      console.warn(`[QuarantineFeedback] Slack relay threw for ${entry.file}:`, err?.message ?? err);
      return { status: "failed", reason: "relay threw" } as FeedbackSlackResult;
    }).then(async (result) => {
      await recordFeedbackSlackResult(rowId, result);
      return result;
    });
    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((res) => {
      budgetTimer = setTimeout(() => res(null), FEEDBACK_SLACK_RELAY_BUDGET_MS);
    });
    const raced = await Promise.race([relayDone, budget]);
    if (budgetTimer) clearTimeout(budgetTimer);
    if (raced === null) {
      console.log(
        `[QuarantineFeedback] Slack relay still in flight for ${entry.file} — continuing; the retry scheduler finishes delivery.`,
      );
    }
  }

  let resolved = 0;
  for (const file of opts.reinstatedFiles) {
    const note = `\n\n[Auto-resolved] Quarantined suite reinstated (${new Date().toISOString().slice(0, 10)}): proven stable after ≥10 consecutive greens with ≥3 from nightly sweep lanes.`;
    resolved += await resolveSweepItemsForFile(QUARANTINE_FEEDBACK_USER_ID, file, note);
  }

  return { filed, resolved };
}
