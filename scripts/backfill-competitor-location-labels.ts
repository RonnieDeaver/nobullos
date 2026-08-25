/**
 * One-off backfill: populate `competitor_gbp_url` on historical
 * `heatmap_competitor_snapshots` rows so the Local Dominance "Market Share
 * Leaderboard" can render a human-readable location disambiguator for older
 * snapshots too.
 *
 * Background / why this shape:
 *   Task #1966 ("Differentiate Competitor Locations") chose a *read-time*
 *   derivation strategy: `deriveCompetitorLocationLabel()` in
 *   `localDominanceService.ts` builds each row's location label on the fly
 *   from the stored `competitor_gbp_url` (preferring a `/place/<segment>/`
 *   fragment, otherwise a short stable GBP hash). It deliberately did NOT add
 *   structured `competitor_address` / `competitor_locality` /
 *   `competitor_postal_code` columns. The only lever that makes historical
 *   leaderboards read naturally is `competitor_gbp_url`: when it is NULL the
 *   read-time deriver returns `null` and the row shows no disambiguator. So
 *   this backfill re-fetches SEMrush top-competitors for recent snapshots and
 *   fills in the missing `competitor_gbp_url` by matching on competitor name.
 *
 * Shared core:
 *   The actual fetch/match/write logic lives in
 *   `server/services/competitorLocationBackfill.ts` and is shared verbatim
 *   with the `backfill_competitor_location_labels` CEO prod-action so the two
 *   stay in lockstep. This script is the CLI front-end (dry-run by default,
 *   staged via flags) for running against an explicit `DATABASE_URL`.
 *
 * Safety / behavior:
 *   - Dry-run by default. Pass `--apply` to write.
 *   - Idempotent: only ever sets `competitor_gbp_url` on rows where it IS NULL;
 *     re-running after a clean apply produces "0 updated".
 *   - Rate-limit / circuit-breaker aware: consults the SEMrush circuit breaker
 *     before every upstream call as a background caller, honours per-campaign
 *     backoff, and aborts the run cleanly on circuit-open / rate-limit. A
 *     small inter-call delay keeps pressure low.
 *   - Snapshots whose parent row has no `keyword_id` are skipped (cannot query
 *     SEMrush without it).
 *
 * Flags:
 *   --apply            Actually write `competitor_gbp_url`. Default: dry-run.
 *   --days <n>         Only snapshots with report_date within the last n days.
 *                      Default: 365.
 *   --limit <n>        Max number of snapshots to process this run. Default: no
 *                      limit (process all matching).
 *   --client <id>      Restrict to a single client_id.
 *   --delay <ms>       Delay between SEMrush calls. Default: 350.
 *   --quiet            Suppress per-snapshot detail.
 *   --help             Print usage.
 *
 * Run:
 *   tsx scripts/backfill-competitor-location-labels.ts            # dry-run
 *   tsx scripts/backfill-competitor-location-labels.ts --apply    # write
 */

// DB / service imports are deferred into main() so importing this file does
// not boot the server db pool (which starts setInterval timers).

type Args = {
  apply: boolean;
  quiet: boolean;
  days: number;
  limit?: number;
  clientId?: string;
  delayMs: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, quiet: false, days: 365, delayMs: 350 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--client") out.clientId = argv[++i];
    else if (a === "--delay") out.delayMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "tsx scripts/backfill-competitor-location-labels.ts [--apply] [--days <n>] [--limit <n>] [--client <id>] [--delay <ms>] [--quiet]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.days) || out.days <= 0) {
    console.error("--days must be a positive number");
    process.exit(2);
  }
  if (out.limit !== undefined && (!Number.isFinite(out.limit) || out.limit <= 0)) {
    console.error("--limit must be a positive number");
    process.exit(2);
  }
  if (!Number.isFinite(out.delayMs) || out.delayMs < 0) {
    console.error("--delay must be a non-negative number");
    process.exit(2);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);

  const { db } = await import("../server/db");
  const {
    findCandidateSnapshots,
    loadSnapshotParents,
    createReportDatesResolver,
    processSnapshot,
  } = await import("../server/services/competitorLocationBackfill");

  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(
    `[backfill-competitor-locations] mode=${mode} days=${args.days} limit=${args.limit ?? "none"} client=${args.clientId ?? "all"} delay=${args.delayMs}ms`,
  );

  const candidateRows = await findCandidateSnapshots(db, {
    sinceDays: args.days,
    clientId: args.clientId,
  });

  let candidates = candidateRows;
  if (args.limit !== undefined) candidates = candidates.slice(0, args.limit);

  console.log(
    `[backfill-competitor-locations] ${candidateRows.length} snapshot(s) have rows missing competitor_gbp_url; processing ${candidates.length}.`,
  );
  if (candidates.length === 0) {
    console.log("[backfill-competitor-locations] nothing to do.");
    return;
  }

  const parentById = await loadSnapshotParents(
    db,
    candidates.map((c) => c.snapshotId),
  );
  const getReportDates = createReportDatesResolver(db);

  let processed = 0;
  let skippedNoKeyword = 0;
  let skippedBreaker = 0;
  let fetchFailed = 0;
  let fetchUnfillable = 0;
  let rowsUpdated = 0;
  let snapshotsTouched = 0;
  let aborted = false;

  for (const cand of candidates) {
    if (aborted) break;
    const parent = parentById.get(cand.snapshotId);
    if (!parent) continue;
    processed++;

    const result = await processSnapshot(
      {
        db,
        caller: "backfill_competitor_locations",
        getReportDates,
        apply: args.apply,
      },
      parent,
    );

    if (result.kind === "no_keyword") {
      skippedNoKeyword++;
      if (!args.quiet) {
        console.log(
          `  SKIP snapshot=${cand.snapshotId} — parent has no keyword_id (cannot query SEMrush)`,
        );
      }
      continue;
    }

    if (result.kind === "circuit_open") {
      console.warn(
        `[backfill-competitor-locations] circuit breaker OPEN (state=${result.state}, retryAfter=${result.retryAfterMs ?? "?"}ms) — stopping run early to avoid pressuring a collapsed upstream.`,
      );
      aborted = true;
      break;
    }

    if (result.kind === "campaign_backoff") {
      skippedBreaker++;
      if (!args.quiet) {
        console.log(
          `  SKIP snapshot=${cand.snapshotId} — campaign backoff (retryAfter=${result.retryAfterMs ?? "?"}ms)`,
        );
      }
      continue;
    }

    if (result.kind === "rate_limited") {
      console.warn(
        `[backfill-competitor-locations] SEMrush rate limited — stopping run cleanly. Re-run later to resume (idempotent).`,
      );
      aborted = true;
      break;
    }

    if (result.kind === "fetch_failed") {
      fetchFailed++;
      if (!args.quiet) {
        console.log(
          `  FAIL snapshot=${cand.snapshotId} campaign=${parent.campaignId} keyword=${parent.keywordId} — ${result.error}`,
        );
      }
      if (args.delayMs) await sleep(args.delayMs);
      continue;
    }

    if (result.kind === "fetch_unfillable") {
      fetchUnfillable++;
      if (!args.quiet) {
        console.log(
          `  UNFILLABLE snapshot=${cand.snapshotId} campaign=${parent.campaignId} keyword=${parent.keywordId} — non-retryable SEMrush error, stamped attempted (converges): ${result.error}`,
        );
      }
      if (args.delayMs) await sleep(args.delayMs);
      continue;
    }

    // result.kind === "done"
    if (result.updates.length > 0) {
      snapshotsTouched++;
      rowsUpdated += result.updates.length;
      if (!args.quiet) {
        console.log(
          `  ${args.apply ? "UPDATE" : "WOULD UPDATE"} snapshot=${cand.snapshotId} client=${parent.clientId ?? "-"} — ${result.updates.length}/${result.nullRows} row(s) matched a GBP URL`,
        );
        for (const u of result.updates) {
          console.log(`      "${u.name}" -> ${u.gbpUrl}`);
        }
      }
    } else if (!args.quiet) {
      console.log(
        `  no-match snapshot=${cand.snapshotId} — ${result.competitorsReturned} competitor(s) returned, none filled a NULL row`,
      );
    }

    if (args.delayMs) await sleep(args.delayMs);
  }

  console.log(`\n[backfill-competitor-locations] summary`);
  console.log(`  mode=${mode}`);
  console.log(`  candidate_snapshots=${candidateRows.length}`);
  console.log(`  processed=${processed}`);
  console.log(`  snapshots_with_updates=${snapshotsTouched}`);
  console.log(`  rows_${args.apply ? "updated" : "would_update"}=${rowsUpdated}`);
  console.log(`  skipped_no_keyword=${skippedNoKeyword}`);
  console.log(`  skipped_campaign_backoff=${skippedBreaker}`);
  console.log(`  fetch_failed=${fetchFailed}`);
  console.log(`  fetch_unfillable=${fetchUnfillable}`);
  if (aborted) {
    console.log(`  run aborted early (breaker open or rate limited) — re-run to resume (idempotent).`);
  }
  if (!args.apply && rowsUpdated > 0) {
    console.log(`\n  Re-run with --apply to commit.`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { parseArgs };
export { normalizeCompetitorName as normalizeName } from "../server/services/competitorLocationBackfill";
