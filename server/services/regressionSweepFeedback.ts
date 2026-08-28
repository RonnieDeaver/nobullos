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
import {
  DEFERRED_FAILURE_INTAKE_MAX_ITEMS,
  normalizeDeferredFailureIntake,
  parseCanonicalSweepTimestamp,
  type DeferredFailureIntakeObservation,
  type SweepReport,
  type SweepTestResult,
} from "./regressionSweep";
import {
  DEFERRED_FAILURE_REPAIR_BATCH_MAX_ITEMS,
  DEFERRED_FAILURE_REPAIR_MAX_AGE_MS,
  buildDeferredFailureRepairRequest,
  enqueueDeferredFailureRepairRequest,
  type DeferredFailureRepairRequest,
} from "./repairDispatcher";

type DeferredFailureRepairEnqueuer = typeof enqueueDeferredFailureRepairRequest;
let deferredFailureRepairEnqueueOverride: DeferredFailureRepairEnqueuer | null = null;

/** Test seam: production always uses the durable repair dispatcher enqueue. */
export function __setDeferredFailureRepairEnqueuerForTest(
  override: DeferredFailureRepairEnqueuer | null,
): void {
  deferredFailureRepairEnqueueOverride = override;
}

/** Reserved submitter id for sweep-filed rows. Never a real OIDC sub. */
export const SWEEP_FEEDBACK_USER_ID = "system:regression-sweep";
/** Display name shown in /admin/feedback and the Slack message. */
export const SWEEP_FEEDBACK_USER_NAME = "Nightly Test Sweep";
/** One system identity for the cross-lane deferred-verification owner. */
export const DEFERRED_FAILURE_FEEDBACK_USER_ID = "system:deferred-verification";
export const DEFERRED_FAILURE_FEEDBACK_USER_NAME = "Deferred Verification";
const DEFERRED_FAILURE_TEXT_MAX = 12_000;

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

export interface DeferredFailureIntakePlan {
  create: DeferredFailureIntakeObservation[];
  update: Array<{ observation: DeferredFailureIntakeObservation; ownerId: number }>;
  /** Explicitly kept visible in feedback; never silently discarded. */
  unresolved: DeferredFailureIntakeObservation[];
}

/**
 * Pick exactly one owner per stable family. Legacy per-file sweep rows count
 * as existing owners so rollout does not create parallel repair work.
 */
export function planDeferredFailureIntake(
  report: SweepReport,
  openOwners: ReadonlyArray<{ id: number; currentPage: string }>,
): DeferredFailureIntakePlan {
  const seen = new Set<string>();
  const create: DeferredFailureIntakeObservation[] = [];
  const update: DeferredFailureIntakePlan["update"] = [];
  const unresolved: DeferredFailureIntakeObservation[] = [];
  for (const observation of normalizeDeferredFailureIntake(report)) {
    if (seen.has(observation.canonicalKey)) continue;
    seen.add(observation.canonicalKey);
    const owner = openOwners.find(
      (row) =>
        row.currentPage === observation.canonicalKey ||
        // Existing nightly repair items use the raw test file as their
        // current_page; treat one as a legitimate canonical owner.
        row.currentPage === observation.file,
    );
    if (owner) update.push({ observation, ownerId: owner.id });
    else create.push(observation);
    if (observation.classification === "unresolved") unresolved.push(observation);
  }
  return { create, update, unresolved };
}

function deferredFailureText(observation: DeferredFailureIntakeObservation): string {
  return [
    "Deferred verification failure intake",
    "",
    `Family: ${observation.canonicalKey}`,
    `Classification: ${observation.classification}`,
    `Evidence: ${observation.evidenceCodes.slice(0, 8).join(", ")}`,
    "",
    "This is a red diagnostic observation. It is not accepted green evidence,",
    "does not auto-repair, and remains open until an operator resolves the owner.",
  ].join("\n");
}

function deferredFailureEvidenceNote(observation: DeferredFailureIntakeObservation): string {
  return [
    "",
    "[Deferred intake observation]",
    `Classification: ${observation.classification}`,
    `Evidence: ${observation.evidenceCodes.slice(0, 8).join(", ")}`,
  ].join("\n");
}

async function listDeferredFailureOwners(
  observations: readonly DeferredFailureIntakeObservation[],
): Promise<Array<{ id: number; currentPage: string }>> {
  const pages = [...new Set(observations.flatMap((item) => [item.canonicalKey, item.file]))].slice(
    0,
    DEFERRED_FAILURE_INTAKE_MAX_ITEMS * 2,
  );
  if (pages.length === 0) return [];
  const { getDb, withDbAttribution } = await import("../db");
  return withDbAttribution("deferredFailureIntake:listOwners", async () => {
    const values = sql.join(pages.map((page) => sql`${page}`), sql`, `);
    const res = await getDb().execute(sql`
      SELECT id, current_page
      FROM user_feedback
      WHERE status = 'pending'
        AND user_id LIKE 'system:%'
        -- A quarantine row tracks a muting policy, not repair ownership.
        -- Keep it visible independently rather than absorbing it here.
        AND user_id <> ${QUARANTINE_FEEDBACK_USER_ID}
        AND user_id <> ${SWEEP_FEEDBACK_USER_ID}
        AND current_page IN (${values})
      ORDER BY id ASC
      LIMIT ${DEFERRED_FAILURE_INTAKE_MAX_ITEMS}
    `);
    return (res.rows ?? [])
      .filter((row: any) => Number.isInteger(Number(row.id)) && typeof row.current_page === "string")
      .map((row: any) => ({ id: Number(row.id), currentPage: row.current_page as string }));
  });
}

async function appendDeferredFailureEvidence(
  ownerId: number,
  observation: DeferredFailureIntakeObservation,
): Promise<void> {
  const { getDb, withDbAttribution } = await import("../db");
  const note = deferredFailureEvidenceNote(observation);
  await withDbAttribution("deferredFailureIntake:appendEvidence", async () => {
    // Preserve the initial owner description and the freshest observations,
    // with a fixed ceiling. The note never carries raw test output.
    await getDb().execute(sql`
      UPDATE user_feedback
      SET feedback_text =
        CASE
          WHEN length(feedback_text) > ${DEFERRED_FAILURE_TEXT_MAX - note.length}
            THEN left(feedback_text, 4_000) || E'\n… older deferred evidence trimmed …\n' ||
                 right(feedback_text, ${DEFERRED_FAILURE_TEXT_MAX - note.length - 4_050})
          ELSE feedback_text
        END || ${note}
      WHERE id = ${ownerId} AND status = 'pending' AND user_id LIKE 'system:%'
    `);
  });
}

async function insertDeferredFailureOwner(
  observation: DeferredFailureIntakeObservation,
): Promise<number | null> {
  const { getDb, withDbAttribution } = await import("../db");
  await ensureDedupeIndex();
  return withDbAttribution("deferredFailureIntake:file", async () => {
    const res = await getDb().execute(sql`
      INSERT INTO user_feedback (user_id, user_name, topic, feedback_text, current_page, screenshots)
      VALUES (
        ${DEFERRED_FAILURE_FEEDBACK_USER_ID},
        ${DEFERRED_FAILURE_FEEDBACK_USER_NAME},
        'BUG_REPORT',
        ${deferredFailureText(observation)},
        ${observation.canonicalKey},
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
}

export interface DeferredFailureIntakeSummary {
  filed: number;
  updated: number;
  unresolved: number;
  resolved: number;
  repairRequests: DeferredFailureRepairRequest[];
  repairBatch: DeferredFailureRepairBatchSummary;
}

export interface DeferredFailureRepairBatchPlan {
  /** Fresh, authoritative, non-ambiguous families selected for handoff. */
  queued: DeferredFailureRepairRequest[];
  /** Ambiguous or incomplete observations remain feedback-only. */
  manualTriage: DeferredFailureRepairRequest[];
  /** Delayed or malformed observation times are intentionally not dispatched. */
  stale: DeferredFailureRepairRequest[];
  /** Fresh candidates held for the next authoritative nightly batch. */
  capped: DeferredFailureRepairRequest[];
}

export interface DeferredFailureRepairBatchSummary {
  queued: number;
  existing: number;
  manualTriage: number;
  stale: number;
  capped: number;
  dispatchFailed: number;
}

/**
 * Decide a small, deterministic daily repair batch without changing feedback
 * ownership. The canonical key is the grouping boundary: similar observations
 * collapse, while different signatures never do.
 */
export function planDeferredFailureRepairBatch(
  requests: readonly DeferredFailureRepairRequest[],
  options: {
    now?: Date;
    maxItems?: number;
    maxAgeMs?: number;
  } = {},
): DeferredFailureRepairBatchPlan {
  const now = options.now ?? new Date();
  const maxItems = options.maxItems ?? DEFERRED_FAILURE_REPAIR_BATCH_MAX_ITEMS;
  const maxAgeMs = options.maxAgeMs ?? DEFERRED_FAILURE_REPAIR_MAX_AGE_MS;
  const seen = new Set<string>();
  const candidates: DeferredFailureRepairRequest[] = [];
  const manualTriage: DeferredFailureRepairRequest[] = [];
  const stale: DeferredFailureRepairRequest[] = [];

  for (const request of [...requests].sort((a, b) =>
    a.canonicalKey.localeCompare(b.canonicalKey),
  )) {
    // A request can be present twice when a concurrent filer won the feedback
    // insert but this pass also observed its legacy owner. One canonical family
    // must still have one queue episode.
    const key = request.canonicalKey;
    if (seen.has(key)) continue;
    seen.add(key);

    if (request.classification === "unresolved" || request.ownerFeedbackId == null) {
      manualTriage.push(request);
      continue;
    }
    const observedMs = parseCanonicalSweepTimestamp(request.observedAt);
    if (
      request.source !== "nightly" ||
      observedMs === null ||
      observedMs > now.getTime() ||
      now.getTime() - observedMs > maxAgeMs
    ) {
      stale.push(request);
      continue;
    }
    candidates.push(request);
  }

  return {
    queued: candidates.slice(0, Math.max(0, maxItems)),
    manualTriage,
    stale,
    capped: candidates.slice(Math.max(0, maxItems)),
  };
}

function isAuthoritativeDeferredRecoveryReport(
  report: SweepReport,
  nowMs = Date.now(),
): boolean {
  const observedAt = parseCanonicalSweepTimestamp(report.finishedAt);
  return (
    report.deferredFailureSource === "nightly" &&
    report.mode === "regression" &&
    report.verificationComplete === true &&
    (report.incomplete ?? 0) === 0 &&
    observedAt !== null &&
    observedAt <= nowMs &&
    nowMs - observedAt <= DEFERRED_FAILURE_REPAIR_MAX_AGE_MS
  );
}

function deferredFailureFileFromKey(key: string): string | null {
  if (!key.startsWith("deferred-failure:")) return null;
  const tail = key.slice("deferred-failure:".length);
  const separator = tail.lastIndexOf(":");
  return separator > 0 ? tail.slice(0, separator) : null;
}

/**
 * Resolve an owner only when the nightly lane has complete accounting and
 * actually observed that owner's file/family. Canaries, partial reports, and
 * stale reports do not get a path to closure.
 */
async function resolveRecoveredDeferredFailureOwners(report: SweepReport): Promise<number> {
  if (!isAuthoritativeDeferredRecoveryReport(report)) return 0;
  const observedKeys = new Set(normalizeDeferredFailureIntake(report).map((item) => item.canonicalKey));
  const recoveredFiles = new Set([
    ...report.results
      .filter((result) => result.outcome === "passed")
      .map((result) => result.file),
  ]);
  if (recoveredFiles.size === 0) return 0;

  const { getDb, withDbAttribution } = await import("../db");
  return withDbAttribution("deferredFailureIntake:resolveRecovered", async () => {
    const res = await getDb().execute(sql`
      SELECT id, current_page
      FROM user_feedback
      WHERE status = 'pending'
        AND (
          user_id = ${DEFERRED_FAILURE_FEEDBACK_USER_ID}
          OR (
            user_id LIKE 'system:%'
            AND user_id <> ${QUARANTINE_FEEDBACK_USER_ID}
            AND user_id <> ${SWEEP_FEEDBACK_USER_ID}
            AND current_page IN (${sql.join([...recoveredFiles].map((file) => sql`${file}`), sql`, `)})
          )
        )
      ORDER BY id ASC
      LIMIT ${DEFERRED_FAILURE_INTAKE_MAX_ITEMS}
    `);

    const recoverable = (res.rows ?? []).filter((row: any) => {
      if (typeof row.current_page !== "string") return false;
      if (observedKeys.has(row.current_page)) return false;
      const ownerFile = deferredFailureFileFromKey(row.current_page) ?? row.current_page;
      return recoveredFiles.has(ownerFile);
    });
    if (recoverable.length === 0) return 0;

    const ids = sql.join(recoverable.map((row: any) => sql`${Number(row.id)}`), sql`, `);
    await getDb().execute(sql`
      UPDATE user_feedback
      SET status = 'resolved',
          feedback_text = feedback_text || E'\n\n[Auto-resolved] Authoritative nightly verification observed this failure family recovered.'
      WHERE id IN (${ids}) AND status = 'pending'
    `);
    return recoverable.length;
  });
}

/**
 * Consolidate nightly, post-merge, and periodic deferred-lane observations
 * through the existing feedback owner, then sends only a bounded fresh nightly
 * batch through the repair dispatcher. It never changes sweep truth or relays
 * raw diagnostics.
 */
export async function fileDeferredFailureIntake(
  report: SweepReport,
): Promise<DeferredFailureIntakeSummary> {
  const observations = normalizeDeferredFailureIntake(report);
  const owners = await listDeferredFailureOwners(observations);
  const plan = planDeferredFailureIntake(report, owners);
  const repairRequests: DeferredFailureRepairRequest[] = [];
  let filed = 0;
  let updated = 0;

  for (const item of plan.update) {
    await appendDeferredFailureEvidence(item.ownerId, item.observation);
    updated++;
    repairRequests.push(
      buildDeferredFailureRepairRequest({
        ownerFeedbackId: item.ownerId,
        canonicalKey: item.observation.canonicalKey,
        classification: item.observation.classification,
        evidenceCodes: item.observation.evidenceCodes,
        observedAt: report.finishedAt,
        source: item.observation.source,
      }),
    );
  }
  for (const observation of plan.create) {
    const ownerId = await insertDeferredFailureOwner(observation);
    if (ownerId === null) continue; // concurrent filer owns it; next run updates it.
    filed++;
    repairRequests.push(
      buildDeferredFailureRepairRequest({
        ownerFeedbackId: ownerId,
        canonicalKey: observation.canonicalKey,
        classification: observation.classification,
        evidenceCodes: observation.evidenceCodes,
        observedAt: report.finishedAt,
        source: observation.source,
      }),
    );
  }

  const batchPlan = planDeferredFailureRepairBatch(repairRequests);
  let queued = 0;
  let existing = 0;
  let capacityCapped = 0;
  let dispatchFailed = 0;
  for (const request of batchPlan.queued) {
    try {
      const result = await (deferredFailureRepairEnqueueOverride ?? enqueueDeferredFailureRepairRequest)(
        request,
      );
      if (result.inserted) queued++;
      else if (result.capacityExhausted) capacityCapped++;
      else existing++;
    } catch (error) {
      dispatchFailed++;
      console.warn(
        `[DeferredFailureIntake] repair handoff dispatch failed for ${request.canonicalKey}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const resolved = await resolveRecoveredDeferredFailureOwners(report);
  return {
    filed,
    updated,
    unresolved: plan.unresolved.length,
    resolved,
    repairRequests,
    repairBatch: {
      queued,
      existing,
      manualTriage: batchPlan.manualTriage.length,
      stale: batchPlan.stale.length,
      capped: batchPlan.capped.length + capacityCapped,
      dispatchFailed,
    },
  };
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
