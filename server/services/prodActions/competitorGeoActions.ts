// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): Competitor/GBP location backfills — location labels, structured locations, locality relabels.
 *
 * Split verbatim out of the monolithic server/services/prodActionsRegistry.ts.
 * Every action definition, helper, and comment below is a byte-for-byte
 * relocation (the only mechanical changes: `export ` added where the
 * composition root or a sibling module now imports a symbol, and inline
 * PROD_ACTIONS array entries hoisted into named consts). Do NOT add new
 * behavior here without the usual prod-action review gates; registration
 * order lives in ./composition.ts, not in this file.
 */

import { getDb, withDbAttribution } from "../../db";
import {
  startBackgroundDrain,
  getDrainState,
  formatDrainProgress,
  isDrainRunning,
  type DrainState,
} from "../prodActionBackgroundDrain";
import {
  findCandidateSnapshots,
  loadSnapshotParents,
  createReportDatesResolver,
  createCampaignResolvableResolver,
  processSnapshot,
  DEFAULT_BACKFILL_DAYS,
} from "../competitorLocationBackfill";
import {
  findStructuredLocationCandidateSnapshots,
  processStructuredLocationSnapshot,
} from "../competitorStructuredLocationBackfill";
import {
  findLocalityRelabelCandidateSnapshots,
  processLocalityRelabelSnapshot,
} from "../competitorLocalityRelabelBackfill";
import { type ProdAction, type ProdActionDomain } from "./kernel";


// ─── Competitor location-label backfill (Local Dominance leaderboards) ──
//
// Fills missing `competitor_gbp_url` on recent `heatmap_competitor_snapshots`
// rows so `deriveCompetitorLocationLabel` (read-time, in
// localDominanceService.ts) can render a location disambiguator for older
// snapshots. Shares its fetch/match/write core verbatim with
// `scripts/backfill-competitor-location-labels.ts` via
// `competitorLocationBackfill.ts`. One-and-done: a single press starts a
// background drain that re-fetches SEMrush top-competitors a few snapshots
// per chunk on the worker pool until exhausted.
const COMPETITOR_LOCATION_BACKFILL_DAYS = DEFAULT_BACKFILL_DAYS;

const COMPETITOR_LOCATION_BACKFILL_CHUNK = 5;

const COMPETITOR_LOCATION_BACKFILL_DELAY_MS = 350;


// Task #2059 — plain-English completion summary for the competitor
// location-label backfill drain. Translates the raw `perKey` tally
// accumulated by `runChunk` into a sentence the CEO can read straight
// from the Prod Actions History panel (and the in-progress status line)
// to confirm the backfill actually closed the gap: how many snapshots it
// touched, how many competitor rows it filled vs. left NULL (no SEMrush
// match), and how many snapshots it skipped and why.
function formatCompetitorBackfillSummary(state: DrainState): string {
  const k = state.perKey ?? {};
  const filled = k.rowsUpdated ?? 0;
  const matchedSnaps = k.snapshotsMatched ?? 0;
  const stillNull = k.rowsStillNull ?? 0;

  const head =
    `${state.processed} of ${state.totalAtStart} snapshot(s) processed` +
    ` — ${filled} competitor location label(s) filled` +
    (matchedSnaps > 0 ? ` across ${matchedSnaps} snapshot(s)` : "") +
    `, ${stillNull} row(s) still unlabeled (no SEMrush match)`;

  const skips: string[] = [];
  if (k.noKeyword) skips.push(`${k.noKeyword} no keyword`);
  if (k.campaignBackoff) skips.push(`${k.campaignBackoff} SEMrush backoff`);
  if (k.fetchFailed) skips.push(`${k.fetchFailed} fetch failed`);
  if (k.fetchUnfillable) skips.push(`${k.fetchUnfillable} unfillable`);
  const skipNote =
    skips.length > 0 ? `; skipped ${skips.join(", ")}` : "";

  return `${head}${skipNote}.`;
}


export const backfillCompetitorLocationLabelsAction: ProdAction = {
  id: "backfill_competitor_location_labels",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Backfill competitor GBP URLs for location labels (Task #2017)",
  description:
    "Populates the missing `competitor_gbp_url` on historical `heatmap_competitor_snapshots` rows (report_date within the last " +
    String(COMPETITOR_LOCATION_BACKFILL_DAYS) +
    " days) so the Local Dominance Market Share Leaderboard can render a per-competitor location disambiguator for older snapshots — without it the read-time `deriveCompetitorLocationLabel` returns null and duplicate firm rows show no location. One-and-done: a single press starts a background drain that re-fetches SEMrush top-competitors for " +
    String(COMPETITOR_LOCATION_BACKFILL_CHUNK) +
    " snapshot(s) per chunk on the worker pool and fills NULL rows by matching on normalized competitor name, until no candidate snapshot remains. SEMrush circuit-breaker aware (stops cleanly on circuit-open / rate-limit; a later press resumes). Idempotent: only writes `competitor_gbp_url` where it IS NULL.",
  change:
    "Background-drain UPDATE of heatmap_competitor_snapshots.competitor_gbp_url (WHERE competitor_gbp_url IS NULL) using SEMrush getTopCompetitors matched by normalized competitor name, " +
    String(COMPETITOR_LOCATION_BACKFILL_CHUNK) +
    " snapshots/chunk on the worker pool. Snapshots whose parent has no keyword_id are skipped.",
  // Task #2086 — re-presses kick the chunked background drain forward;
  // an hourly cadence keeps it progressing without hammering SEMrush.
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    if (isDrainRunning("backfill_competitor_location_labels")) {
      const s = getDrainState("backfill_competitor_location_labels")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatCompetitorBackfillSummary(s)}`,
      };
    }
    const candidates = await withDbAttribution(
      "maintenance:prod-actions-backfill-competitor-gbp-count",
      () =>
        findCandidateSnapshots(getDb(), {
          sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
        }),
    );
    if (candidates.length === 0) {
      return {
        state: "not-needed",
        detail: "No recent competitor snapshots have a missing competitor_gbp_url.",
      };
    }
    const nullRows = candidates.reduce((sum, c) => sum + c.missing, 0);
    // Task #2123 — there is work to do but every SEMrush fetch would
    // short-circuit while the auth-breaker is open (expired/disconnected
    // login). Report amber "needs reconnect" naming SEMrush rather than a
    // misleading "pending" that would silently do nothing — mirrors the
    // Front probe-then-blocked pattern from #2111.
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail: `SEMrush login is not connected — ${candidates.length} snapshot(s) (${nullRows} NULL competitor_gbp_url row(s)) are waiting. Reconnect SEMrush in the Integrations Hub, then re-run.`,
      };
    }
    return {
      state: "pending",
      detail: `${candidates.length} snapshot(s) (${nullRows} NULL competitor_gbp_url row(s)) within the last ${COMPETITOR_LOCATION_BACKFILL_DAYS} days; a single press drains them ${COMPETITOR_LOCATION_BACKFILL_CHUNK} snapshot(s) per chunk.`,
    };
  },
  async apply(actorId) {
    // Task #2123 — if the SEMrush auth-breaker is open the drain can do
    // nothing (every getTopCompetitors fetch short-circuits with
    // SemrushAuthMissingError), so report amber "needs reconnect" up front
    // instead of starting a futile drain. Mirrors Front's #2111 blocked path.
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail:
          "SEMrush login is not connected — reconnect SEMrush in the Integrations Hub, then re-run.",
      };
    }
    // In-memory per-drain state. `attempted` prevents the chunk re-query
    // from re-selecting snapshots that were processed but had no SEMrush
    // match (their rows stay NULL, so they remain candidates). `stop` ends
    // the drain cleanly on circuit-open / rate-limit. Both are scoped to a
    // single drain run; a fresh press after restart starts clean and only
    // the genuinely-unmatched snapshots remain candidates.
    const attempted = new Set<string>();
    let stop = false;
    let getReportDates:
      | ((campaignId: string) => Promise<string[] | null>)
      | null = null;
    // Task #2434 — per-campaign "still known to SEMrush?" resolver so a
    // transient failure on a provably-gone campaign is stamped terminal at
    // once instead of spending the bounded retry budget.
    let isCampaignResolvable:
      | ((campaignId: string) => Promise<boolean>)
      | null = null;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const out = await startBackgroundDrain(
      {
        actionId: "backfill_competitor_location_labels",
        actionTitle: "Backfill competitor GBP URLs for location labels",
        attributionLabel: "maintenance:prod-actions-backfill-competitor-gbp",
        unit: "snapshot(s)",
        // Task #2059 — the final History audit detail reads as a
        // plain-English after-the-fact summary instead of the raw tally.
        formatSummary: formatCompetitorBackfillSummary,
        countPending: async () => {
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-gbp-count",
            () =>
              findCandidateSnapshots(getDb(), {
                sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
              }),
          );
          return candidates.length;
        },
        runChunk: async () => {
          if (stop) return { processed: 0 };
          // getDb() here resolves to the worker pool (runDrainLoop wraps the
          // loop in runWithWorkerDb). Create the report-date resolver once so
          // its per-campaign cache persists across chunks.
          if (!getReportDates) {
            getReportDates = await withDbAttribution(
              "maintenance:prod-actions-backfill-competitor-gbp-fetch",
              () => Promise.resolve(createReportDatesResolver(getDb())),
            );
          }
          if (!isCampaignResolvable) {
            isCampaignResolvable = await withDbAttribution(
              "maintenance:prod-actions-backfill-competitor-gbp-fetch",
              () => Promise.resolve(createCampaignResolvableResolver(getDb())),
            );
          }

          const candidates = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-gbp-count",
            () =>
              findCandidateSnapshots(getDb(), {
                sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
              }),
          );
          const fresh = candidates
            .map((c) => c.snapshotId)
            .filter((id) => !attempted.has(id))
            .slice(0, COMPETITOR_LOCATION_BACKFILL_CHUNK);
          if (fresh.length === 0) return { processed: 0 };

          const parents = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-gbp-fetch",
            () => loadSnapshotParents(getDb(), fresh),
          );
          let snapshotsProcessed = 0;
          let rowsUpdated = 0;
          let snapshotsMatched = 0;
          let rowsStillNull = 0;
          let noMatch = 0;
          let noKeyword = 0;
          let campaignBackoff = 0;
          let fetchFailed = 0;
          let fetchUnfillable = 0;

          for (const id of fresh) {
            if (stop) break;
            const parent = parents.get(id);
            if (!parent) {
              // Snapshot vanished between candidate scan and load — skip it
              // for this drain run.
              attempted.add(id);
              continue;
            }
            const res = await withDbAttribution(
              "maintenance:prod-actions-backfill-competitor-gbp-apply",
              () =>
                processSnapshot(
                  {
                    db: getDb(),
                    caller: "backfill_competitor_location_labels",
                    getReportDates: getReportDates!,
                    apply: true,
                    isCampaignResolvable: isCampaignResolvable!,
                  },
                  parent,
                ),
            );
            if (res.kind === "circuit_open" || res.kind === "rate_limited") {
              // Do NOT mark attempted — let a later press retry it.
              stop = true;
              break;
            }
            attempted.add(id);
            snapshotsProcessed++;
            if (res.kind === "no_keyword") noKeyword++;
            else if (res.kind === "campaign_backoff") campaignBackoff++;
            else if (res.kind === "fetch_failed") fetchFailed++;
            else if (res.kind === "fetch_unfillable") fetchUnfillable++;
            else {
              // `done`: a successful SEMrush fetch. Tally filled rows vs.
              // rows that stay NULL because no fresh competitor name
              // matched (the gap a second pass can never close on its own).
              rowsUpdated += res.updates.length;
              rowsStillNull += res.nullRows - res.updates.length;
              if (res.updates.length > 0) snapshotsMatched++;
              else noMatch++;
            }
            if (COMPETITOR_LOCATION_BACKFILL_DELAY_MS) {
              await sleep(COMPETITOR_LOCATION_BACKFILL_DELAY_MS);
            }
          }

          return {
            processed: snapshotsProcessed,
            perKey: {
              rowsUpdated,
              snapshotsMatched,
              ...(rowsStillNull > 0 ? { rowsStillNull } : {}),
              ...(noMatch > 0 ? { noMatch } : {}),
              ...(noKeyword > 0 ? { noKeyword } : {}),
              ...(campaignBackoff > 0 ? { campaignBackoff } : {}),
              ...(fetchFailed > 0 ? { fetchFailed } : {}),
              ...(fetchUnfillable > 0 ? { fetchUnfillable } : {}),
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ──────── Task #2052: backfill structured competitor locality / street ────────
// Sibling of backfill_competitor_location_labels above, but fills the
// structured `competitor_locality` / `competitor_street` columns (added Task
// #2020) instead of `competitor_gbp_url`. Shares its fetch/match/write core
// verbatim with `scripts/backfill-competitor-structured-location.ts` via
// `competitorStructuredLocationBackfill.ts` (itself reusing the GBP module's
// SEMrush fetch/classify helper). One-and-done: a single press starts a
// worker-pool background drain that re-fetches SEMrush top-competitors a few
// snapshots per chunk and parses each match's address until exhausted; the
// Task #2086 self-heal scheduler keeps it progressing on an hourly cadence.
export const backfillCompetitorStructuredLocationAction: ProdAction = {
  id: "backfill_competitor_structured_location",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Backfill competitor locality / street for location labels (Task #2052)",
  description:
    "Populates the missing structured `competitor_locality` / `competitor_street` on historical `heatmap_competitor_snapshots` rows (report_date within the last " +
    String(COMPETITOR_LOCATION_BACKFILL_DAYS) +
    " days) so the Local Dominance Market Share Leaderboard can render a real per-competitor Locality / Street disambiguator for snapshots captured before Task #2020 began parsing them at ingestion. One-and-done: a single press starts a background drain that re-fetches SEMrush top-competitors for " +
    String(COMPETITOR_LOCATION_BACKFILL_CHUNK) +
    " snapshot(s) per chunk on the worker pool, parses each match's `address` with the same heuristic the ingestion path uses, and fills rows where BOTH columns are NULL — until no candidate snapshot remains. SEMrush circuit-breaker aware (stops cleanly on circuit-open / rate-limit; a later press or self-heal tick resumes). Idempotent: only writes where both columns ARE NULL.",
  change:
    "Background-drain UPDATE of heatmap_competitor_snapshots.competitor_locality / competitor_street (WHERE both IS NULL) using SEMrush getTopCompetitors matched by normalized competitor name and parsed with parseCompetitorAddress, " +
    String(COMPETITOR_LOCATION_BACKFILL_CHUNK) +
    " snapshots/chunk on the worker pool. Snapshots whose parent has no keyword_id are skipped (stamped attempted so they converge).",
  // Task #2086 — re-presses kick the chunked background drain forward; an
  // hourly cadence keeps it progressing without hammering SEMrush.
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    if (isDrainRunning("backfill_competitor_structured_location")) {
      const s = getDrainState("backfill_competitor_structured_location")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const candidates = await withDbAttribution(
      "maintenance:prod-actions-backfill-competitor-structured-count",
      () =>
        findStructuredLocationCandidateSnapshots(getDb(), {
          sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
        }),
    );
    if (candidates.length === 0) {
      return {
        state: "not-needed",
        detail:
          "No recent competitor snapshots have a missing competitor_locality / competitor_street.",
      };
    }
    const nullRows = candidates.reduce((sum, c) => sum + c.missing, 0);
    // Task #2123 pattern — there is work to do but every SEMrush fetch would
    // short-circuit while the auth-breaker is open. Report amber "needs
    // reconnect" naming SEMrush rather than a misleading "pending".
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail: `SEMrush login is not connected — ${candidates.length} snapshot(s) (${nullRows} BOTH-NULL locality/street row(s)) are waiting. Reconnect SEMrush in the Integrations Hub, then re-run.`,
      };
    }
    return {
      state: "pending",
      detail: `${candidates.length} snapshot(s) (${nullRows} BOTH-NULL locality/street row(s)) within the last ${COMPETITOR_LOCATION_BACKFILL_DAYS} days; a single press drains them ${COMPETITOR_LOCATION_BACKFILL_CHUNK} snapshot(s) per chunk.`,
    };
  },
  async apply(actorId) {
    // Task #2123 pattern — if the SEMrush auth-breaker is open the drain can
    // do nothing, so report amber "needs reconnect" up front rather than
    // starting a futile drain.
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail:
          "SEMrush login is not connected — reconnect SEMrush in the Integrations Hub, then re-run.",
      };
    }
    // In-memory per-drain state. `attempted` prevents the chunk re-query from
    // re-selecting snapshots processed this run that had no SEMrush match
    // (their rows are stamped attempted at apply time, so they fall out of
    // findStructuredLocationCandidateSnapshots on the next chunk anyway —
    // `attempted` is the in-run belt-and-braces). `stop` ends the drain
    // cleanly on circuit-open / rate-limit.
    const attempted = new Set<string>();
    let stop = false;
    let getReportDates:
      | ((campaignId: string) => Promise<string[] | null>)
      | null = null;
    // Task #2434 — see GBP drain: stamp a provably-gone campaign terminal at
    // once on a transient failure rather than burning the retry budget.
    let isCampaignResolvable:
      | ((campaignId: string) => Promise<boolean>)
      | null = null;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const out = await startBackgroundDrain(
      {
        actionId: "backfill_competitor_structured_location",
        actionTitle: "Backfill competitor locality / street for location labels",
        attributionLabel: "maintenance:prod-actions-backfill-competitor-structured",
        unit: "snapshot(s)",
        countPending: async () => {
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-structured-count",
            () =>
              findStructuredLocationCandidateSnapshots(getDb(), {
                sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
              }),
          );
          return candidates.length;
        },
        runChunk: async () => {
          if (stop) return { processed: 0 };
          // getDb() resolves to the worker pool (runDrainLoop wraps the loop
          // in runWithWorkerDb). Create the report-date resolver once so its
          // per-campaign cache persists across chunks.
          if (!getReportDates) {
            getReportDates = await withDbAttribution(
              "maintenance:prod-actions-backfill-competitor-structured-fetch",
              () => Promise.resolve(createReportDatesResolver(getDb())),
            );
          }
          if (!isCampaignResolvable) {
            isCampaignResolvable = await withDbAttribution(
              "maintenance:prod-actions-backfill-competitor-structured-fetch",
              () => Promise.resolve(createCampaignResolvableResolver(getDb())),
            );
          }

          const candidates = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-structured-count",
            () =>
              findStructuredLocationCandidateSnapshots(getDb(), {
                sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
              }),
          );
          const fresh = candidates
            .map((c) => c.snapshotId)
            .filter((id) => !attempted.has(id))
            .slice(0, COMPETITOR_LOCATION_BACKFILL_CHUNK);
          if (fresh.length === 0) return { processed: 0 };

          const parents = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-structured-fetch",
            () => loadSnapshotParents(getDb(), fresh),
          );
          let snapshotsProcessed = 0;
          let rowsUpdated = 0;
          let snapshotsMatched = 0;
          let noMatch = 0;
          let noKeyword = 0;
          let campaignBackoff = 0;
          let fetchFailed = 0;
          let fetchUnfillable = 0;

          for (const id of fresh) {
            if (stop) break;
            const parent = parents.get(id);
            if (!parent) {
              attempted.add(id);
              continue;
            }
            const res = await withDbAttribution(
              "maintenance:prod-actions-backfill-competitor-structured-apply",
              () =>
                processStructuredLocationSnapshot(
                  {
                    db: getDb(),
                    caller: "backfill_competitor_structured_location",
                    getReportDates: getReportDates!,
                    apply: true,
                    isCampaignResolvable: isCampaignResolvable!,
                  },
                  parent,
                ),
            );
            if (res.kind === "circuit_open" || res.kind === "rate_limited") {
              // Do NOT mark attempted — let a later press retry it.
              stop = true;
              break;
            }
            attempted.add(id);
            snapshotsProcessed++;
            if (res.kind === "no_keyword") noKeyword++;
            else if (res.kind === "campaign_backoff") campaignBackoff++;
            else if (res.kind === "fetch_failed") fetchFailed++;
            else if (res.kind === "fetch_unfillable") fetchUnfillable++;
            else if (res.updates.length > 0) {
              rowsUpdated += res.updates.length;
              snapshotsMatched++;
            } else {
              noMatch++;
            }
            if (COMPETITOR_LOCATION_BACKFILL_DELAY_MS) {
              await sleep(COMPETITOR_LOCATION_BACKFILL_DELAY_MS);
            }
          }

          return {
            processed: snapshotsProcessed,
            perKey: {
              rowsUpdated,
              snapshotsMatched,
              ...(noMatch > 0 ? { noMatch } : {}),
              ...(noKeyword > 0 ? { noKeyword } : {}),
              ...(campaignBackoff > 0 ? { campaignBackoff } : {}),
              ...(fetchFailed > 0 ? { fetchFailed } : {}),
              ...(fetchUnfillable > 0 ? { fetchUnfillable } : {}),
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// Task #2357 — sibling of the two backfills above, but it RE-CORRECTS an
// already-NON-NULL `competitor_locality` that an OLD address parse (before the
// Task #2291 Australian / Irish-Eircode / Dutch postal rules) wrongly stored as
// a region/postal token (e.g. "NSW 2000", an Eircode). The structured-location
// backfill only writes BOTH-NULL rows, so it never re-corrects these; this one
// re-fetches SEMrush top-competitors, re-parses the address with the CURRENT
// parseCompetitorAddress, and overwrites the mislabeled locality (typically to
// NULL) when the new parse differs. Shares its fetch/match/stamp core verbatim
// with `scripts/backfill-competitor-locality-relabel.ts` via
// `competitorLocalityRelabelBackfill.ts`. One-and-done: a single press starts a
// worker-pool background drain; the Task #2086 self-heal keeps it progressing.
export const backfillCompetitorLocalityRelabelAction: ProdAction = {
  id: "backfill_competitor_locality_relabel",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Re-correct mislabeled competitor cities (Task #2357)",
  description:
    "Re-corrects historical `heatmap_competitor_snapshots` rows (report_date within the last " +
    String(COMPETITOR_LOCATION_BACKFILL_DAYS) +
    " days) whose `competitor_locality` an OLD address parse wrongly stored as a region/postal token (e.g. \"NSW 2000\", an Eircode, a Dutch \"1011 AB\") instead of the real city, so the Local Dominance Market Share Leaderboard stops showing a postal token as the city. The structured-location backfill only fills BOTH-NULL rows, so it never re-corrects these. One-and-done: a single press starts a background drain that re-fetches SEMrush top-competitors for " +
    String(COMPETITOR_LOCATION_BACKFILL_CHUNK) +
    " snapshot(s) per chunk on the worker pool, re-parses each match's address with the same heuristic the ingestion path now uses, and overwrites the mislabeled locality (typically to NULL) where the new parse differs — until no suspect snapshot remains. SEMrush circuit-breaker aware (stops cleanly on circuit-open / rate-limit; a later press or self-heal tick resumes). Suspect-only: correctly-parsed cities are never touched.",
  change:
    "Background-drain UPDATE of heatmap_competitor_snapshots.competitor_locality (WHERE the relabel marker IS NULL) for rows whose stored locality is a region/postal token under the current rules, using SEMrush getTopCompetitors matched by normalized competitor name and re-parsed with parseCompetitorAddress, " +
    String(COMPETITOR_LOCATION_BACKFILL_CHUNK) +
    " snapshots/chunk on the worker pool. Suspect rows are stamped competitor_locality_relabel_attempted_at so the action converges (no-keyword and no-name-match rows included).",
  // Task #2086 — the chunked background drain progresses on an hourly cadence
  // without hammering SEMrush.
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    if (isDrainRunning("backfill_competitor_locality_relabel")) {
      const s = getDrainState("backfill_competitor_locality_relabel")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const candidates = await withDbAttribution(
      "maintenance:prod-actions-backfill-competitor-relabel-count",
      () =>
        findLocalityRelabelCandidateSnapshots(getDb(), {
          sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
        }),
    );
    if (candidates.length === 0) {
      return {
        state: "not-needed",
        detail:
          "No recent competitor snapshots have a mislabeled competitor_locality (region/postal token stored as the city).",
      };
    }
    const suspectRows = candidates.reduce((sum, c) => sum + c.missing, 0);
    // Task #2123 pattern — there is work to do but every SEMrush fetch would
    // short-circuit while the auth-breaker is open. Report amber "needs
    // reconnect" naming SEMrush rather than a misleading "pending".
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail: `SEMrush login is not connected — ${candidates.length} snapshot(s) (${suspectRows} mislabeled locality row(s)) are waiting. Reconnect SEMrush in the Integrations Hub, then re-run.`,
      };
    }
    return {
      state: "pending",
      detail: `${candidates.length} snapshot(s) (${suspectRows} mislabeled locality row(s)) within the last ${COMPETITOR_LOCATION_BACKFILL_DAYS} days; a single press drains them ${COMPETITOR_LOCATION_BACKFILL_CHUNK} snapshot(s) per chunk.`,
    };
  },
  async apply(actorId) {
    // Task #2123 pattern — if the SEMrush auth-breaker is open the drain can
    // do nothing, so report amber "needs reconnect" up front rather than
    // starting a futile drain.
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail:
          "SEMrush login is not connected — reconnect SEMrush in the Integrations Hub, then re-run.",
      };
    }
    // In-memory per-drain state. `attempted` prevents the chunk re-query from
    // re-selecting snapshots processed this run; `stop` ends the drain cleanly
    // on circuit-open / rate-limit.
    const attempted = new Set<string>();
    let stop = false;
    let getReportDates:
      | ((campaignId: string) => Promise<string[] | null>)
      | null = null;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const out = await startBackgroundDrain(
      {
        actionId: "backfill_competitor_locality_relabel",
        actionTitle: "Re-correct mislabeled competitor cities",
        attributionLabel: "maintenance:prod-actions-backfill-competitor-relabel",
        unit: "snapshot(s)",
        countPending: async () => {
          const candidates = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-relabel-count",
            () =>
              findLocalityRelabelCandidateSnapshots(getDb(), {
                sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
              }),
          );
          return candidates.length;
        },
        runChunk: async () => {
          if (stop) return { processed: 0 };
          // getDb() resolves to the worker pool (runDrainLoop wraps the loop
          // in runWithWorkerDb). Create the report-date resolver once so its
          // per-campaign cache persists across chunks.
          if (!getReportDates) {
            getReportDates = await withDbAttribution(
              "maintenance:prod-actions-backfill-competitor-relabel-fetch",
              () => Promise.resolve(createReportDatesResolver(getDb())),
            );
          }

          const candidates = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-relabel-count",
            () =>
              findLocalityRelabelCandidateSnapshots(getDb(), {
                sinceDays: COMPETITOR_LOCATION_BACKFILL_DAYS,
              }),
          );
          const fresh = candidates
            .map((c) => c.snapshotId)
            .filter((id) => !attempted.has(id))
            .slice(0, COMPETITOR_LOCATION_BACKFILL_CHUNK);
          if (fresh.length === 0) return { processed: 0 };

          const parents = await withDbAttribution(
            "maintenance:prod-actions-backfill-competitor-relabel-fetch",
            () => loadSnapshotParents(getDb(), fresh),
          );
          let snapshotsProcessed = 0;
          let rowsCorrected = 0;
          let snapshotsMatched = 0;
          let noChange = 0;
          let noKeyword = 0;
          let campaignBackoff = 0;
          let fetchFailed = 0;
          let fetchUnfillable = 0;

          for (const id of fresh) {
            if (stop) break;
            const parent = parents.get(id);
            if (!parent) {
              attempted.add(id);
              continue;
            }
            const res = await withDbAttribution(
              "maintenance:prod-actions-backfill-competitor-relabel-apply",
              () =>
                processLocalityRelabelSnapshot(
                  {
                    db: getDb(),
                    caller: "backfill_competitor_locality_relabel",
                    getReportDates: getReportDates!,
                    apply: true,
                  },
                  parent,
                ),
            );
            if (res.kind === "circuit_open" || res.kind === "rate_limited") {
              // Do NOT mark attempted — let a later press retry it.
              stop = true;
              break;
            }
            attempted.add(id);
            snapshotsProcessed++;
            if (res.kind === "no_keyword") noKeyword++;
            else if (res.kind === "no_suspects") noChange++;
            else if (res.kind === "campaign_backoff") campaignBackoff++;
            else if (res.kind === "fetch_failed") fetchFailed++;
            else if (res.kind === "fetch_unfillable") fetchUnfillable++;
            else if (res.updates.length > 0) {
              rowsCorrected += res.updates.length;
              snapshotsMatched++;
            } else {
              noChange++;
            }
            if (COMPETITOR_LOCATION_BACKFILL_DELAY_MS) {
              await sleep(COMPETITOR_LOCATION_BACKFILL_DELAY_MS);
            }
          }

          return {
            processed: snapshotsProcessed,
            perKey: {
              rowsCorrected,
              snapshotsMatched,
              ...(noChange > 0 ? { noChange } : {}),
              ...(noKeyword > 0 ? { noKeyword } : {}),
              ...(campaignBackoff > 0 ? { campaignBackoff } : {}),
              ...(fetchFailed > 0 ? { fetchFailed } : {}),
              ...(fetchUnfillable > 0 ? { fetchUnfillable } : {}),
            },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};

// ─── Domain collection (F7) ──────────────────────────────────────────
// Membership list for the composition-root guard: every registry action
// this module defines. Operator-facing order lives in ./composition.ts.
export const competitorGeoDomain: ProdActionDomain = {
  name: "competitorGeo",
  actions: [
    backfillCompetitorLocationLabelsAction,
    backfillCompetitorStructuredLocationAction,
    backfillCompetitorLocalityRelabelAction,
  ],
};
