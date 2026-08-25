/**
 * One-off backfill: re-correct historical `heatmap_competitor_snapshots` rows
 * whose `competitor_locality` an OLD address parse (before the Task #2291
 * Australian / Irish-Eircode / Dutch postal rules) wrongly stored as a region /
 * postal token (e.g. "NSW 2000", an Eircode "D02 AF30", a Dutch "1011 AB")
 * instead of the real city, so the Local Dominance "Market Share Leaderboard"
 * stops showing a postal token as the city.
 *
 * Background / why this shape:
 *   Task #2291 widened `parseCompetitorAddress` (in
 *   `server/services/localDominanceService.ts`) so those tokens are no longer
 *   mistaken for the locality. But the structured-location backfill (Task
 *   #2052, `scripts/backfill-competitor-structured-location.ts`) only writes
 *   when BOTH `competitor_locality` AND `competitor_street` are NULL, so it
 *   never re-corrects an already-NON-NULL but mislabeled locality. This is the
 *   missing re-correction path.
 *
 *   SEMrush exposes location only as a single concatenated `address` string —
 *   it is NOT persisted on the snapshot row, so the ONLY way to re-parse is to
 *   re-fetch `getTopCompetitors(campaignId, keywordId, reportDate)`, match the
 *   returned competitors back to the suspect rows by normalized name, re-parse
 *   each match's `address` with the CURRENT `parseCompetitorAddress`, and
 *   overwrite the locality when the new parse yields a DIFFERENT result (for a
 *   pure region/postal token this is almost always `null`). Sibling of
 *   `scripts/backfill-competitor-structured-location.ts`; shares its
 *   fetch/match core via `competitorLocalityRelabelBackfill.ts`.
 *
 * What it does:
 *   - Selects recent `heatmap_snapshots` that own at least one
 *     `heatmap_competitor_snapshots` row whose stored `competitor_locality` is
 *     (exactly) a region/postal token under the current rules and has not yet
 *     been relabel-attempted.
 *   - For each, re-fetches SEMrush `getTopCompetitors`, re-parses each match's
 *     `address`, and overwrites the mislabeled locality where the new parse
 *     differs (typically to NULL).
 *
 * Safety / behavior:
 *   - Dry-run by default. Pass `--apply` to write.
 *   - Suspect-only: correctly-parsed cities are never touched.
 *   - Idempotent: processed suspect rows are stamped
 *     `competitor_locality_relabel_attempted_at`; re-running after a clean
 *     apply produces "0 corrected".
 *   - Rate-limit / circuit-breaker aware: consults the SEMrush circuit breaker
 *     before every upstream call as a background caller, honours per-campaign
 *     backoff, and aborts the run cleanly on a SemrushRateLimitError.
 *   - Wall-clock bounded: pass `--max-minutes <n>` to stop cleanly after a
 *     budget (default 30). Re-run to resume (idempotent).
 *   - Worker DB pool tenancy: all DB work goes through `workerDb`.
 *   - Snapshots whose parent row has no `keyword_id` are skipped (cannot query
 *     SEMrush without it); their suspect rows are stamped so they converge.
 *
 * Flags:
 *   --apply            Actually write the corrections. Default: dry-run.
 *   --days <n>         Only snapshots with report_date within the last n days.
 *                      Default: 365.
 *   --limit <n>        Max number of snapshots to process this run.
 *   --client <id>      Restrict to a single client_id.
 *   --delay <ms>       Delay between SEMrush calls. Default: 350.
 *   --max-minutes <n>  Wall-clock budget; stop cleanly after n minutes.
 *                      Default: 30.
 *   --quiet            Suppress per-snapshot detail.
 *   --help             Print usage.
 *
 * Run:
 *   tsx scripts/backfill-competitor-locality-relabel.ts            # dry-run
 *   tsx scripts/backfill-competitor-locality-relabel.ts --apply    # write
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
        "tsx scripts/backfill-competitor-locality-relabel.ts [--apply] [--days <n>] [--limit <n>] [--client <id>] [--delay <ms>] [--max-minutes <n>] [--quiet]",
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
    findLocalityRelabelCandidateSnapshots,
    loadSnapshotParents,
    createReportDatesResolver,
    processLocalityRelabelSnapshot,
  } = await import("../server/services/competitorLocalityRelabelBackfill");

  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(
    `[backfill-competitor-locality-relabel] mode=${mode} days=${args.days} limit=${args.limit ?? "none"} client=${args.clientId ?? "all"} delay=${args.delayMs}ms maxMinutes=${args.maxMinutes}`,
  );

  const deadline = Date.now() + args.maxMinutes * 60 * 1000;

  const candidateRows = await findLocalityRelabelCandidateSnapshots(db, {
    sinceDays: args.days,
    clientId: args.clientId,
  });

  let candidates = candidateRows;
  if (args.limit !== undefined) candidates = candidates.slice(0, args.limit);

  console.log(
    `[backfill-competitor-locality-relabel] ${candidateRows.length} snapshot(s) have a mislabeled competitor_locality; processing ${candidates.length}.`,
  );
  if (candidates.length === 0) {
    console.log("[backfill-competitor-locality-relabel] nothing to do.");
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
  let rowsCorrected = 0;
  let snapshotsTouched = 0;
  let aborted = false;

  for (const cand of candidates) {
    if (aborted) break;
    if (Date.now() >= deadline) {
      console.warn(
        `[backfill-competitor-locality-relabel] wall-clock budget (${args.maxMinutes}m) reached — stopping cleanly. Re-run to resume (idempotent).`,
      );
      aborted = true;
      break;
    }
    const parent = parentById.get(cand.snapshotId);
    if (!parent) continue;
    processed++;

    const result = await processLocalityRelabelSnapshot(
      {
        db,
        caller: "backfill_competitor_locality_relabel",
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

    if (result.kind === "no_suspects") {
      // The candidate query already filtered to suspect rows, so this only
      // happens if they were stamped/changed between the two queries.
      continue;
    }

    if (result.kind === "circuit_open") {
      console.warn(
        `[backfill-competitor-locality-relabel] circuit breaker OPEN (state=${result.state}, retryAfter=${result.retryAfterMs ?? "?"}ms) — stopping run early to avoid pressuring a collapsed upstream.`,
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
        `[backfill-competitor-locality-relabel] SEMrush rate limited — stopping run cleanly. Re-run later to resume (idempotent).`,
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
      rowsCorrected += result.updates.length;
      if (!args.quiet) {
        console.log(
          `  ${args.apply ? "CORRECT" : "WOULD CORRECT"} snapshot=${cand.snapshotId} client=${parent.clientId ?? "-"} — ${result.updates.length}/${result.suspectRows} mislabeled row(s) re-parsed`,
        );
        for (const u of result.updates) {
          console.log(
            `      "${u.name}" locality "${u.oldLocality}" -> ${u.newLocality === null ? "(null)" : `"${u.newLocality}"`}`,
          );
        }
      }
    } else if (!args.quiet) {
      console.log(
        `  no-change snapshot=${cand.snapshotId} — ${result.competitorsReturned} competitor(s) returned, no suspect row re-parsed to a different locality`,
      );
    }

    if (args.delayMs) await sleep(args.delayMs);
  }

  console.log(`\n[backfill-competitor-locality-relabel] summary`);
  console.log(`  mode=${mode}`);
  console.log(`  candidate_snapshots=${candidateRows.length}`);
  console.log(`  processed=${processed}`);
  console.log(`  snapshots_with_corrections=${snapshotsTouched}`);
  console.log(`  rows_${args.apply ? "corrected" : "would_correct"}=${rowsCorrected}`);
  console.log(`  skipped_no_keyword=${skippedNoKeyword}`);
  console.log(`  skipped_campaign_backoff=${skippedBreaker}`);
  console.log(`  fetch_failed=${fetchFailed}`);
  console.log(`  fetch_unfillable=${fetchUnfillable}`);
  if (aborted) {
    console.log(`  run aborted early (budget, breaker open, or rate limited) — re-run to resume (idempotent).`);
  }
  if (!args.apply && rowsCorrected > 0) {
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
