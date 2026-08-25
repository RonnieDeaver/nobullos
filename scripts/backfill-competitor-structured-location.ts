/**
 * One-off backfill: populate the structured `competitor_locality` /
 * `competitor_street` columns on historical `heatmap_competitor_snapshots`
 * rows so the Local Dominance "Market Share Leaderboard" can render real
 * "Locality / Street" disambiguators for snapshots captured BEFORE Task
 * #2020 started parsing them at ingestion.
 *
 * Background / why this shape:
 *   Task #2020 added the structured `competitor_locality` /
 *   `competitor_street` columns (migration
 *   `0084_add_competitor_structured_location.sql`) and now parses them from
 *   the SEMrush Map Rank Tracker business `address` free-text string at
 *   ingestion time via `parseCompetitorAddress` in
 *   `server/services/localDominanceService.ts`. Rows captured before that
 *   change have both fields NULL, so `deriveCompetitorLocationLabel` falls
 *   back to the GBP-URL `/place/` fragment or the opaque "GBP <hash>" label.
 *
 *   The SEMrush API exposes location only as a single concatenated `address`
 *   string — it is NOT persisted on the snapshot row, so the ONLY way to fill
 *   the structured columns for old rows is to re-fetch
 *   `getTopCompetitors(campaignId, keywordId, reportDate)`, match the returned
 *   competitors back to the NULL rows by normalized name, parse the address
 *   with the same `parseCompetitorAddress` heuristic used at ingestion, and
 *   write the result. No schema change, no ingestion-path change — consistent
 *   with Task #2020's deliberate architecture. This is the structured-field
 *   sibling of `scripts/backfill-competitor-location-labels.ts` (which fills
 *   the older `competitor_gbp_url` column the same way).
 *
 * What it does:
 *   - Selects recent `heatmap_snapshots` that own at least one
 *     `heatmap_competitor_snapshots` row with BOTH `competitor_locality` AND
 *     `competitor_street` NULL.
 *   - For each, re-fetches SEMrush `getTopCompetitors(campaignId, keywordId,
 *     reportDate)` (reportDate resolved from the cached campaign report dates
 *     for the snapshot's month, falling back to no-date).
 *   - Matches returned competitors to the NULL rows by normalized name, parses
 *     each match's `address` into (locality, street), and fills the columns
 *     only where they are currently NULL.
 *
 * Safety / behavior:
 *   - Dry-run by default. Pass `--apply` to write.
 *   - Idempotent: only ever sets the columns on rows where BOTH are NULL;
 *     re-running after a clean apply produces "0 updated".
 *   - Rate-limit / circuit-breaker aware: consults the SEMrush circuit breaker
 *     (`shouldAllowRequest`) before every upstream call as a background caller,
 *     honours per-campaign backoff, and aborts the run cleanly on a
 *     SemrushRateLimitError. A small inter-call delay keeps pressure low.
 *   - Wall-clock bounded: pass `--max-minutes <n>` to stop cleanly after a
 *     budget (default 30). Re-run to resume (idempotent).
 *   - Worker DB pool tenancy: this is a background/maintenance script, so all
 *     DB work goes through `workerDb` (never the request-scoped `api` pool).
 *   - Snapshots whose parent row has no `keyword_id` are skipped (cannot query
 *     SEMrush without it).
 *
 * Flags:
 *   --apply            Actually write the columns. Default: dry-run.
 *   --days <n>         Only snapshots with report_date within the last n days.
 *                      Default: 365.
 *   --limit <n>        Max number of snapshots to process this run. Default: no
 *                      limit (process all matching).
 *   --client <id>      Restrict to a single client_id.
 *   --delay <ms>       Delay between SEMrush calls. Default: 350.
 *   --max-minutes <n>  Wall-clock budget; stop cleanly after n minutes.
 *                      Default: 30.
 *   --quiet            Suppress per-snapshot detail.
 *   --help             Print usage.
 *
 * Run:
 *   tsx scripts/backfill-competitor-structured-location.ts            # dry-run
 *   tsx scripts/backfill-competitor-structured-location.ts --apply    # write
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
  maxMinutes: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    apply: false,
    quiet: false,
    days: 365,
    delayMs: 350,
    maxMinutes: 30,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--client") out.clientId = argv[++i];
    else if (a === "--delay") out.delayMs = Number(argv[++i]);
    else if (a === "--max-minutes") out.maxMinutes = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "tsx scripts/backfill-competitor-structured-location.ts [--apply] [--days <n>] [--limit <n>] [--client <id>] [--delay <ms>] [--max-minutes <n>] [--quiet]",
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
  if (!Number.isFinite(out.maxMinutes) || out.maxMinutes <= 0) {
    console.error("--max-minutes must be a positive number");
    process.exit(2);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);

  // Worker DB pool tenancy: this is a background/maintenance script, so use
  // `workerDb`, never the request-scoped `api` pool (`db`). The shared core
  // is imported here (deferred) so importing this file never boots the pool.
  const { workerDb: db } = await import("../server/db");
  const {
    findStructuredLocationCandidateSnapshots,
    loadSnapshotParents,
    createReportDatesResolver,
    processStructuredLocationSnapshot,
  } = await import("../server/services/competitorStructuredLocationBackfill");

  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(
    `[backfill-competitor-structured-location] mode=${mode} days=${args.days} limit=${args.limit ?? "none"} client=${args.clientId ?? "all"} delay=${args.delayMs}ms maxMinutes=${args.maxMinutes}`,
  );

  const deadline = Date.now() + args.maxMinutes * 60 * 1000;

  const candidateRows = await findStructuredLocationCandidateSnapshots(db, {
    sinceDays: args.days,
    clientId: args.clientId,
  });

  let candidates = candidateRows;
  if (args.limit !== undefined) candidates = candidates.slice(0, args.limit);

  console.log(
    `[backfill-competitor-structured-location] ${candidateRows.length} snapshot(s) have rows missing structured location; processing ${candidates.length}.`,
  );
  if (candidates.length === 0) {
    console.log("[backfill-competitor-structured-location] nothing to do.");
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
    if (Date.now() >= deadline) {
      console.warn(
        `[backfill-competitor-structured-location] wall-clock budget (${args.maxMinutes}m) reached — stopping cleanly. Re-run to resume (idempotent).`,
      );
      aborted = true;
      break;
    }
    const parent = parentById.get(cand.snapshotId);
    if (!parent) continue;
    processed++;

    const result = await processStructuredLocationSnapshot(
      {
        db,
        caller: "backfill_competitor_structured_location",
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
        `[backfill-competitor-structured-location] circuit breaker OPEN (state=${result.state}, retryAfter=${result.retryAfterMs ?? "?"}ms) — stopping run early to avoid pressuring a collapsed upstream.`,
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
        `[backfill-competitor-structured-location] SEMrush rate limited — stopping run cleanly. Re-run later to resume (idempotent).`,
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
          `  ${args.apply ? "UPDATE" : "WOULD UPDATE"} snapshot=${cand.snapshotId} client=${parent.clientId ?? "-"} — ${result.updates.length}/${result.nullRows} row(s) matched a parsed address`,
        );
        for (const u of result.updates) {
          console.log(
            `      "${u.name}" -> locality=${u.locality ?? "-"} street=${u.street ?? "-"}`,
          );
        }
      }
    } else if (!args.quiet) {
      console.log(
        `  no-match snapshot=${cand.snapshotId} — ${result.competitorsReturned} competitor(s) returned, none filled a NULL row`,
      );
    }

    if (args.delayMs) await sleep(args.delayMs);
  }

  console.log(`\n[backfill-competitor-structured-location] summary`);
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
    console.log(`  run aborted early (budget, breaker open, or rate limited) — re-run to resume (idempotent).`);
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

export { parseArgs, normalizeName };
