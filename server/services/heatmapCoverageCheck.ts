/**
 * Task #651 — Auto-schedule the per-location heatmap coverage check after a
 * backfill run.
 *
 * Operators previously had to remember to run `scripts/verify-task-642.ts`
 * by hand to confirm whether the heatmap snapshots actually landed once the
 * backfill's enqueued `semrush_report_refresh` jobs drained. This service
 * wires that check into the backfill itself: at the end of a non-dry-run
 * backfill we enqueue a delayed `heatmap_coverage_check` work-queue job
 * that, when it fires, recomputes coverage gaps for the same scope, writes
 * a verification report, persists the result onto the `backfill_jobs` row,
 * and posts a Slack alert if any gaps remain (or none, depending on the
 * "alert on success" flag).
 *
 * If the refresh queue hasn't drained yet, the check job re-schedules
 * itself with a smaller recheck interval, up to a configurable cap, before
 * giving up and reporting whatever coverage exists at that point.
 *
 * All knobs live in `system_settings`:
 *   heatmap_coverage_check_after_backfill_enabled   (default "true")
 *   heatmap_coverage_check_delay_seconds            (default 3600)
 *   heatmap_coverage_check_recheck_interval_seconds (default 1800)
 *   heatmap_coverage_check_max_attempts             (default 6)
 *   heatmap_coverage_alert_slack_channel_id         (optional; blank disables Slack)
 *   heatmap_coverage_alert_on_success               (default "false")
 */

import fs from "fs";
import path from "path";
import { eq, inArray } from "drizzle-orm";
import { workerDb as db } from "../db";
import { backfillJobs, workQueue, type WorkQueueJob } from "@shared/schema";
import {
  computeCoverageGaps,
  type CoverageGap,
  type CoverageScopeUnit,
} from "./backfillJobs";
import { getSystemSettings } from "../storage/settingsStorage";
import { isConnected as isSlackConnected, postMessage } from "./slackIntegration";
import { enqueueJob } from "./workScheduler";

const WORKER_NAME = "heatmap-coverage-check";

export const HEATMAP_COVERAGE_CHECK_QUEUE = "heatmap_coverage_check";

const SETTING_ENABLED = "heatmap_coverage_check_after_backfill_enabled";
const SETTING_DELAY_SECONDS = "heatmap_coverage_check_delay_seconds";
const SETTING_RECHECK_SECONDS = "heatmap_coverage_check_recheck_interval_seconds";
const SETTING_MAX_ATTEMPTS = "heatmap_coverage_check_max_attempts";
const SETTING_SLACK_CHANNEL = "heatmap_coverage_alert_slack_channel_id";
const SETTING_ALERT_ON_SUCCESS = "heatmap_coverage_alert_on_success";

const DEFAULTS = {
  enabled: true,
  delaySeconds: 3600,
  recheckIntervalSeconds: 1800,
  maxAttempts: 6,
  alertOnSuccess: false,
};

const VERIFICATION_DIR = path.resolve(process.cwd(), "verification");

export interface CoverageCheckSettings {
  enabled: boolean;
  delaySeconds: number;
  recheckIntervalSeconds: number;
  maxAttempts: number;
  slackChannelId: string | null;
  alertOnSuccess: boolean;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (["false", "0", "off", "no"].includes(s)) return false;
  if (["true", "1", "on", "yes"].includes(s)) return true;
  return fallback;
}

function parseInt32(v: string | undefined, fallback: number, min = 1): number {
  if (v == null) return fallback;
  const n = parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

export async function getHeatmapCoverageCheckSettings(): Promise<CoverageCheckSettings> {
  const rows = await getSystemSettings([
    SETTING_ENABLED,
    SETTING_DELAY_SECONDS,
    SETTING_RECHECK_SECONDS,
    SETTING_MAX_ATTEMPTS,
    SETTING_SLACK_CHANNEL,
    SETTING_ALERT_ON_SUCCESS,
  ]);
  const channel = (rows[SETTING_SLACK_CHANNEL] || "").trim();
  return {
    enabled: parseBool(rows[SETTING_ENABLED], DEFAULTS.enabled),
    delaySeconds: parseInt32(rows[SETTING_DELAY_SECONDS], DEFAULTS.delaySeconds, 0),
    recheckIntervalSeconds: parseInt32(
      rows[SETTING_RECHECK_SECONDS],
      DEFAULTS.recheckIntervalSeconds,
      30,
    ),
    maxAttempts: parseInt32(rows[SETTING_MAX_ATTEMPTS], DEFAULTS.maxAttempts, 1),
    slackChannelId: channel.length > 0 ? channel : null,
    alertOnSuccess: parseBool(rows[SETTING_ALERT_ON_SUCCESS], DEFAULTS.alertOnSuccess),
  };
}

/**
 * Persisted, per-campaign expected scope captured during the backfill so
 * the post-drain check doesn't have to re-query SEMrush. Stored on
 * `backfill_jobs.result_json.expectedScopeByCampaign`.
 */
export type ExpectedScopeByCampaign = Record<
  string,
  { reportDates: string[]; keywords: string[] }
>;

/**
 * Build the dedupe keys used by `triggerReportRefresh` so the check job
 * can ask "are any of the refresh jobs we enqueued still pending?".
 */
export function buildRefreshDedupeKeys(
  reportDatesEnqueued: Array<{ campaignId: string; reportDate: string }>,
): string[] {
  const out = new Set<string>();
  for (const r of reportDatesEnqueued) {
    // Mirror server/services/semrushInventorySync.ts triggerReportRefresh().
    out.add(`semrush:refresh:${r.campaignId}:manual:${r.reportDate || "latest"}`);
  }
  return Array.from(out);
}

/**
 * Schedule a single heatmap coverage check for a backfill job. No-op if
 * the feature flag is off or there's nothing in scope. Idempotent via the
 * work_queue dedupe key (one pending check per backfill at a time).
 */
export async function scheduleCoverageCheckForBackfill(opts: {
  backfillJobId: string;
  delaySecondsOverride?: number;
}): Promise<{ scheduled: boolean; reason?: string; jobId?: string; runAt?: Date }> {
  const settings = await getHeatmapCoverageCheckSettings();
  if (!settings.enabled) {
    return { scheduled: false, reason: "feature_flag_disabled" };
  }
  const delaySeconds = opts.delaySecondsOverride ?? settings.delaySeconds;
  const runAt = new Date(Date.now() + delaySeconds * 1000);

  const jobId = await enqueueJob({
    queueName: HEATMAP_COVERAGE_CHECK_QUEUE,
    workloadClass: "maintenance",
    priority: 50,
    payload: {
      backfillJobId: opts.backfillJobId,
      attempt: 1,
    },
    retryAt: runAt,
    dedupeKey: `heatmap_coverage_check:${opts.backfillJobId}`,
    maxAttempts: 3,
  });

  console.log(
    `[${WORKER_NAME}] scheduled coverage check backfillJobId=${opts.backfillJobId} ` +
      `runAt=${runAt.toISOString()} jobId=${jobId}`,
  );
  return { scheduled: true, jobId, runAt };
}

interface BackfillResultJson {
  expectedScopeByCampaign?: ExpectedScopeByCampaign;
  mappings?: Array<{
    clientId: string;
    locationId: string;
    semrushCampaignId: string;
    semrushCampaignName?: string | null;
  }>;
  reportDatesEnqueued?: Array<{
    campaignId: string;
    reportDate: string;
    jobId: string | null;
  }>;
  postDrainCoverageCheck?: PostDrainCoverageCheck;
}

export interface PostDrainCoverageCheck {
  checkedAt: string;
  attempt: number;
  refreshJobsStillPending: number;
  refreshJobsTotal: number;
  drained: boolean;
  scopeUnits: number;
  gapUnits: number;
  gaps: CoverageGap[];
  reportFiles: { json: string; markdown: string };
  alertSent: boolean;
  alertChannel: string | null;
  alertSkippedReason: string | null;
  // Set when computeCoverageGaps threw. When non-null, the report is
  // INCONCLUSIVE — gapUnits=0 does NOT mean "clean coverage", it just
  // means we couldn't compute. The Slack alert and persisted record
  // surface this explicitly so an operator doesn't read a swallowed
  // failure as success.
  computeError: string | null;
}

/**
 * Count refresh jobs that the backfill enqueued and that are still in the
 * queue (pending / leased / processing). Used to decide whether to wait
 * before computing coverage.
 */
async function countPendingRefreshJobs(dedupeKeys: string[]): Promise<{ pending: number; total: number }> {
  if (dedupeKeys.length === 0) return { pending: 0, total: 0 };
  // Look up by dedupe_key — these were created by enqueueToQueue() with a
  // unique dedupe key per (campaignId, manual, reportDate). Rows that have
  // already completed get their status set to 'succeeded' / 'failed', so a
  // simple "not terminal" filter answers the question.
  const rows = await db
    .select({ status: workQueue.status, dedupeKey: workQueue.dedupeKey })
    .from(workQueue)
    .where(inArray(workQueue.dedupeKey, dedupeKeys));
  let pending = 0;
  for (const r of rows) {
    if (
      r.status === "pending" ||
      r.status === "leased" ||
      r.status === "processing"
    ) {
      pending++;
    }
  }
  return { pending, total: rows.length };
}

function buildScopeFromBackfill(
  resultJson: BackfillResultJson,
): CoverageScopeUnit[] {
  const expected = resultJson.expectedScopeByCampaign ?? {};
  const mappings = resultJson.mappings ?? [];
  const scope: CoverageScopeUnit[] = [];
  for (const m of mappings) {
    const exp = expected[m.semrushCampaignId];
    if (!exp || !Array.isArray(exp.reportDates) || exp.keywords.length === 0) {
      continue;
    }
    for (const d of exp.reportDates) {
      const day = String(d).slice(0, 10);
      if (!day) continue;
      scope.push({
        clientId: m.clientId,
        locationId: m.locationId,
        campaignId: m.semrushCampaignId,
        reportDate: day,
        expectedKeywords: exp.keywords,
      });
    }
  }
  return scope;
}

function ensureVerificationDir(): void {
  if (!fs.existsSync(VERIFICATION_DIR)) {
    fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  }
}

function writeReportFiles(
  backfillJobId: string,
  body: {
    checkedAt: string;
    attempt: number;
    refreshJobsStillPending: number;
    refreshJobsTotal: number;
    drained: boolean;
    scopeUnits: number;
    gapUnits: number;
    gaps: CoverageGap[];
    computeError: string | null;
  },
): { json: string; markdown: string } {
  ensureVerificationDir();
  const stamp = body.checkedAt.replace(/[:.]/g, "-");
  const baseName = `task-651-coverage-${backfillJobId}-${stamp}`;
  const jsonPath = path.join(VERIFICATION_DIR, `${baseName}.json`);
  const mdPath = path.join(VERIFICATION_DIR, `${baseName}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify({ backfillJobId, ...body }, null, 2));

  const md: string[] = [];
  md.push(`# Heatmap coverage check — backfill ${backfillJobId}`);
  md.push(`Generated: ${body.checkedAt}`);
  md.push("");
  if (body.computeError) {
    md.push(
      `**INCONCLUSIVE:** coverage computation failed — \`${body.computeError}\`. ` +
        `The gap count below is unreliable; treat as "unknown", not "clean".`,
    );
    md.push("");
  }
  md.push(
    `**Summary:** ${body.gapUnits} of ${body.scopeUnits} (client, location, campaign, reportDate) ` +
      `tuples have at least one missing keyword snapshot. Refresh jobs still pending: ` +
      `${body.refreshJobsStillPending}/${body.refreshJobsTotal} (drained: ${body.drained}). ` +
      `Attempt: ${body.attempt}.`,
  );
  if (body.gaps.length > 0) {
    md.push("");
    md.push("## Gap tuples");
    md.push("| Client | Location | Campaign | Report date | Observed | Expected | Missing keywords (first 5) |");
    md.push("|---|---|---|---|---|---|---|");
    for (const g of body.gaps.slice(0, 200)) {
      const sample = g.missingKeywords.slice(0, 5).join(", ").replace(/\|/g, "\\|");
      md.push(
        `| ${g.clientId} | ${g.locationId} | ${g.campaignId} | ${g.reportDate} | ${g.observed} | ${g.expected} | ${sample} |`,
      );
    }
    if (body.gaps.length > 200) {
      md.push(`\n_…and ${body.gaps.length - 200} more — see JSON report._`);
    }
  } else {
    md.push("");
    md.push("All in-scope tuples are fully covered. :tada:");
  }
  fs.writeFileSync(mdPath, md.join("\n"));

  return { json: jsonPath, markdown: mdPath };
}

async function postSlackAlert(opts: {
  channel: string;
  backfillJobId: string;
  body: PostDrainCoverageCheck;
}): Promise<{ sent: boolean; reason?: string }> {
  try {
    const connected = await isSlackConnected();
    if (!connected) return { sent: false, reason: "slack_not_connected" };
  } catch (err: any) {
    return { sent: false, reason: `slack_check_failed: ${err?.message || err}` };
  }

  const { backfillJobId, body } = opts;
  const inconclusive = !!body.computeError;
  const status = inconclusive
    ? ":question:"
    : body.gapUnits === 0
      ? ":white_check_mark:"
      : ":warning:";
  const headline = inconclusive
    ? `Heatmap backfill coverage check INCONCLUSIVE (compute failed)`
    : body.gapUnits === 0
      ? `Heatmap backfill coverage looks clean (${body.scopeUnits} tuples checked)`
      : `Heatmap backfill has ${body.gapUnits} gap tuple(s) of ${body.scopeUnits} after drain`;

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${status} *${headline}*\nBackfill job: \`${backfillJobId}\`` +
          (inconclusive
            ? `\n_Compute failed:_ \`${body.computeError}\` — gap count is unreliable.`
            : ""),
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Scope tuples*\n${body.scopeUnits}` },
        { type: "mrkdwn", text: `*Gap tuples*\n${body.gapUnits}` },
        {
          type: "mrkdwn",
          text: `*Refresh jobs still pending*\n${body.refreshJobsStillPending}/${body.refreshJobsTotal}`,
        },
        { type: "mrkdwn", text: `*Drained*\n${body.drained ? "yes" : "no"}` },
        { type: "mrkdwn", text: `*Attempt*\n${body.attempt}` },
        { type: "mrkdwn", text: `*Checked at*\n${body.checkedAt}` },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Report: \`${body.reportFiles.markdown}\``,
        },
      ],
    },
  ];

  const fallbackText = `${headline} — backfill ${backfillJobId}`;
  try {
    await postMessage(opts.channel, fallbackText, blocks);
    return { sent: true };
  } catch (err: any) {
    return { sent: false, reason: `slack_post_failed: ${err?.message || err}` };
  }
}

async function persistPostDrainResult(
  backfillJobId: string,
  resultJson: BackfillResultJson,
  postDrain: PostDrainCoverageCheck,
  gaps: CoverageGap[],
): Promise<void> {
  const merged: BackfillResultJson = {
    ...resultJson,
    postDrainCoverageCheck: postDrain,
  };
  await db
    .update(backfillJobs)
    .set({
      resultJson: merged,
      // Also refresh `coverage_gaps_json` so the existing API/UI surfaces
      // see the post-drain truth instead of the stale snapshot taken
      // immediately at backfill completion (when nothing had run yet).
      coverageGapsJson: gaps,
      updatedAt: new Date(),
    })
    .where(eq(backfillJobs.id, backfillJobId));
}

/**
 * Work-queue handler. Reads the backfill job row, decides whether to defer
 * or run, computes coverage gaps, writes verification reports, persists the
 * result, and optionally posts to Slack.
 */
export async function handleHeatmapCoverageCheckJob(job: WorkQueueJob): Promise<void> {
  const payload = (job.payload ?? {}) as { backfillJobId?: string; attempt?: number };
  const backfillJobId = payload.backfillJobId;
  const attempt = Math.max(1, Number(payload.attempt) || 1);
  if (!backfillJobId) {
    console.warn(`[${WORKER_NAME}] missing backfillJobId in payload; skipping`);
    return;
  }

  const settings = await getHeatmapCoverageCheckSettings();
  if (!settings.enabled) {
    console.log(
      `[${WORKER_NAME}] feature flag disabled; skipping check for backfill=${backfillJobId}`,
    );
    return;
  }

  const [row] = await db
    .select({
      id: backfillJobs.id,
      resultJson: backfillJobs.resultJson,
    })
    .from(backfillJobs)
    .where(eq(backfillJobs.id, backfillJobId))
    .limit(1);
  if (!row) {
    console.warn(`[${WORKER_NAME}] backfill job ${backfillJobId} not found; skipping`);
    return;
  }

  const resultJson = (row.resultJson ?? {}) as BackfillResultJson;
  const reportDatesEnqueued = resultJson.reportDatesEnqueued ?? [];
  const dedupeKeys = buildRefreshDedupeKeys(reportDatesEnqueued);
  const { pending, total } = await countPendingRefreshJobs(dedupeKeys);
  const drained = pending === 0;

  // If the queue hasn't drained and we still have attempts left, push the
  // check out by `recheckIntervalSeconds`. The dedupe key is per-backfill
  // so we re-enqueue under a distinct key suffix to avoid colliding with
  // ourselves while this row is still leased.
  if (!drained && attempt < settings.maxAttempts) {
    const nextRunAt = new Date(Date.now() + settings.recheckIntervalSeconds * 1000);
    await enqueueJob({
      queueName: HEATMAP_COVERAGE_CHECK_QUEUE,
      workloadClass: "maintenance",
      priority: 50,
      payload: {
        backfillJobId,
        attempt: attempt + 1,
      },
      retryAt: nextRunAt,
      dedupeKey: `heatmap_coverage_check:${backfillJobId}:attempt-${attempt + 1}`,
      maxAttempts: 3,
    });
    console.log(
      `[${WORKER_NAME}] backfill=${backfillJobId} not drained ` +
        `(${pending}/${total} refresh jobs pending); rescheduled attempt ${attempt + 1} ` +
        `at ${nextRunAt.toISOString()}`,
    );
    return;
  }

  // Either the queue drained, or we've burned through every attempt — run
  // the coverage computation either way so operators see whatever state we
  // got to.
  const scope = buildScopeFromBackfill(resultJson);
  let gaps: CoverageGap[] = [];
  let computeError: string | null = null;
  if (scope.length > 0) {
    try {
      gaps = await computeCoverageGaps(scope);
    } catch (err: any) {
      computeError = err?.message || String(err);
      console.warn(
        `[${WORKER_NAME}] computeCoverageGaps failed for backfill=${backfillJobId}: ${computeError}`,
      );
      // Fall through; the report and Slack alert explicitly surface
      // INCONCLUSIVE so a swallowed failure isn't read as success.
    }
  }

  const checkedAt = new Date().toISOString();
  const reportFiles = writeReportFiles(backfillJobId, {
    checkedAt,
    attempt,
    refreshJobsStillPending: pending,
    refreshJobsTotal: total,
    drained,
    scopeUnits: scope.length,
    gapUnits: gaps.length,
    gaps,
    computeError,
  });

  let alertSent = false;
  let alertSkippedReason: string | null = null;
  // Inconclusive runs (computeError set) ALWAYS alert when a channel is
  // configured — silently swallowing a compute failure is the exact
  // anti-pattern flagged in code review.
  const shouldPostSlack =
    !!settings.slackChannelId &&
    (computeError !== null || gaps.length > 0 || settings.alertOnSuccess);
  if (!settings.slackChannelId) {
    alertSkippedReason = "no_slack_channel_configured";
  } else if (!shouldPostSlack) {
    alertSkippedReason = "no_gaps_and_alert_on_success_disabled";
  }

  if (shouldPostSlack && settings.slackChannelId) {
    const sendResult = await postSlackAlert({
      channel: settings.slackChannelId,
      backfillJobId,
      body: {
        checkedAt,
        attempt,
        refreshJobsStillPending: pending,
        refreshJobsTotal: total,
        drained,
        scopeUnits: scope.length,
        gapUnits: gaps.length,
        gaps,
        reportFiles,
        alertSent: false,
        alertChannel: settings.slackChannelId,
        alertSkippedReason: null,
        computeError,
      },
    });
    alertSent = sendResult.sent;
    if (!sendResult.sent) alertSkippedReason = sendResult.reason ?? "slack_post_failed";
  }

  const postDrain: PostDrainCoverageCheck = {
    checkedAt,
    attempt,
    refreshJobsStillPending: pending,
    refreshJobsTotal: total,
    drained,
    scopeUnits: scope.length,
    gapUnits: gaps.length,
    gaps,
    reportFiles,
    alertSent,
    alertChannel: settings.slackChannelId,
    alertSkippedReason,
    computeError,
  };

  await persistPostDrainResult(backfillJobId, resultJson, postDrain, gaps);

  console.log(
    `[${WORKER_NAME}] backfill=${backfillJobId} attempt=${attempt} drained=${drained} ` +
      `pending=${pending}/${total} scope=${scope.length} gaps=${gaps.length} ` +
      (computeError ? `computeError=${JSON.stringify(computeError)} ` : "") +
      `alertSent=${alertSent}${alertSkippedReason ? ` alertSkipped=${alertSkippedReason}` : ""}`,
  );
}
