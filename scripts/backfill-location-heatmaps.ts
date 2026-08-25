/**
 * Task 636 — One-shot backfill for missing per-location heatmap snapshots.
 *
 * Re-runs the SEMrush refresh for every (clientId, locationId, campaignId)
 * mapping in `semrush_location_campaigns` over a date range. Multi-location
 * clients (Punchwork, Speedwell) need this to repopulate historical dashboards
 * after the task-585 location-aware fix; future scheduled imports alone won't
 * recover snapshots that were dropped or pruned.
 *
 * The backfill enqueues one refresh job per (campaignId, reportDate). The
 * `handleRefreshJob` consumer then fans out to every location mapped to that
 * campaign and writes one heatmap snapshot per (clientId, locationId).
 *
 * Usage:
 *   tsx scripts/backfill-location-heatmaps.ts --dry-run [--since 2025-01-01] [--until 2026-04-01]
 *   tsx scripts/backfill-location-heatmaps.ts --apply --confirm [--since 2025-01-01]
 *
 *   # Limit to specific clients / locations / campaigns
 *   tsx scripts/backfill-location-heatmaps.ts --apply --confirm --clients <id1>,<id2>
 *   tsx scripts/backfill-location-heatmaps.ts --apply --confirm --locations <id1>,<id2>
 *   tsx scripts/backfill-location-heatmaps.ts --apply --confirm --campaigns <camp1>,<camp2>
 *
 * Always run --dry-run first. The apply pass is idempotent: triggerReportRefresh
 * dedupes by (campaignId, trigger=manual, reportDate), so repeated runs over
 * the same window won't double-enqueue work.
 */

import { backfillLocationHeatmaps } from "../server/services/semrushInventorySync";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function splitList(v: string | boolean | undefined): string[] | undefined {
  if (typeof v !== "string") return undefined;
  const out = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

async function main() {
  const args = parseArgs(process.argv);
  const isApply = !!args["apply"];
  const isDry = !!args["dry-run"] || !isApply;

  if (isApply && !args["confirm"]) {
    console.error(
      "Refusing to apply without --confirm. Run --dry-run first and review the report.",
    );
    process.exit(2);
  }

  const opts = {
    clientIds: splitList(args["clients"] as string | undefined),
    locationIds: splitList(args["locations"] as string | undefined),
    campaignIds: splitList(args["campaigns"] as string | undefined),
    sinceDate: typeof args["since"] === "string" ? (args["since"] as string) : undefined,
    untilDate: typeof args["until"] === "string" ? (args["until"] as string) : undefined,
    dryRun: isDry,
  };

  console.log("[backfill-location-heatmaps] options:", JSON.stringify(opts));

  const result = await backfillLocationHeatmaps(opts);

  const enqueuedByCampaign = new Map<string, number>();
  for (const e of result.reportDatesEnqueued) {
    enqueuedByCampaign.set(
      e.campaignId,
      (enqueuedByCampaign.get(e.campaignId) || 0) + 1,
    );
  }

  console.log("\n=== Backfill Report ===");
  console.log(`dryRun:                 ${result.dryRun}`);
  console.log(`mappings matched:       ${result.mappings.length}`);
  console.log(`unique campaigns:       ${result.campaignsConsidered}`);
  console.log(`campaigns fetched:      ${result.campaignsFetched}`);
  console.log(`campaign fetch errors:  ${result.campaignFetchFailures.length}`);
  console.log(
    `report dates enqueued:  ${result.reportDatesEnqueued.length}` +
      (result.dryRun ? " (would enqueue — dry run)" : ""),
  );
  console.log(`report dates skipped:   ${result.reportDatesSkipped.length}`);
  console.log(`jobs enqueued:          ${result.enqueuedJobCount}`);

  if (result.campaignFetchFailures.length > 0) {
    console.log("\n-- campaign fetch failures --");
    for (const f of result.campaignFetchFailures) {
      console.log(`  ${f.campaignId}: ${f.error}`);
    }
  }

  console.log("\n-- per-campaign enqueued count --");
  for (const [c, n] of enqueuedByCampaign) {
    console.log(`  ${c}: ${n}`);
  }

  if (result.dryRun) {
    console.log("\n(no changes were applied — dry run)");
  } else if (result.jobId) {
    // Task #651: every live backfill auto-schedules a post-drain coverage
    // check on the maintenance work queue. The schedule itself is gated by
    // `system_settings.heatmap_coverage_check_after_backfill_enabled`
    // (default on); when enabled, the check fires after
    // `heatmap_coverage_check_delay_seconds` (default 1h) and re-runs every
    // `heatmap_coverage_check_recheck_interval_seconds` (default 30m) until
    // the SEMrush refresh queue drains or `heatmap_coverage_check_max_attempts`
    // (default 6) is hit. Results land at:
    //   verification/task-651-coverage-<backfillJobId>-<timestamp>.{json,md}
    // and on `backfill_jobs.result_json.postDrainCoverageCheck`. If
    // `heatmap_coverage_alert_slack_channel_id` is set, a Slack alert is
    // posted (always on gaps; on success only when
    // `heatmap_coverage_alert_on_success` is true).
    try {
      const { getHeatmapCoverageCheckSettings } = await import(
        "../server/services/heatmapCoverageCheck"
      );
      const s = await getHeatmapCoverageCheckSettings();
      if (s.enabled) {
        console.log(
          `\n[backfill-location-heatmaps] Post-drain coverage check scheduled` +
            ` (~${s.delaySeconds}s from now, recheck every ${s.recheckIntervalSeconds}s,` +
            ` max ${s.maxAttempts} attempts). Backfill jobId=${result.jobId}.` +
            (s.slackChannelId
              ? ` Slack alerts → ${s.slackChannelId}.`
              : ` Slack alerts disabled (no channel set).`),
        );
      } else {
        console.log(
          `\n[backfill-location-heatmaps] Post-drain coverage check is disabled` +
            ` via system_settings.heatmap_coverage_check_after_backfill_enabled.`,
        );
      }
    } catch (e: any) {
      // Non-fatal — the schedule call itself happens inside the backfill
      // and is idempotent; this is just informational printing.
      console.log(
        `\n[backfill-location-heatmaps] Could not read coverage-check settings (non-fatal): ${e?.message || e}`,
      );
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[backfill-location-heatmaps] FAILED:", err);
    process.exit(1);
  },
);
