// @db-pool-intent: ambient
/**
 * Shared core for the "competitor structured-location" backfill (Task #2052).
 *
 * Background (Task #2020):
 *   `heatmap_competitor_snapshots` carries two structured location
 *   disambiguators — `competitor_locality` / `competitor_street` — parsed
 *   from the SEMrush Map Rank Tracker business `address` free-text string at
 *   ingestion time via `parseCompetitorAddress` in `localDominanceService.ts`.
 *   Rows captured BEFORE Task #2020 have both fields NULL, so the read-time
 *   `deriveCompetitorLocationLabel` falls back to the GBP-URL `/place/`
 *   fragment or the opaque "GBP <hash>" label.
 *
 *   SEMrush exposes location only as a single concatenated `address` string
 *   which is NOT persisted on the snapshot row, so the only way to fill the
 *   structured columns for old rows is to re-fetch
 *   `getTopCompetitors(campaignId, keywordId, reportDate)`
 *   (SEMrush Map Rank Tracker — `/campaigns/{id}/top-competitors`, docs:
 *   https://developer.semrush.com/api/v4/map-rank-tracker-2/), match the
 *   returned competitors back to the NULL rows by normalized name, parse the
 *   `address` with the same `parseCompetitorAddress` heuristic used at
 *   ingestion, and write the result. No schema change to the ingestion path —
 *   consistent with Task #2020's architecture.
 *
 *   This is the structured-field sibling of `competitorLocationBackfill.ts`
 *   (which fills the older `competitor_gbp_url` column the same way). It
 *   reuses that module's SEMrush fetch/classify helper
 *   (`fetchTopCompetitorsForBackfill`), report-date resolver, parent loader,
 *   name normalizer, and `BackfillDb` handle injection so the two stay in
 *   lockstep on breaker gating and error classification.
 *
 * Consumed by two callers that share this exact logic:
 *   - `scripts/backfill-competitor-structured-location.ts` (CLI, dry-run by
 *     default) — for ad-hoc / staged runs against an explicit `DATABASE_URL`.
 *   - the `backfill_competitor_structured_location` CEO prod-action in
 *     `prodActionsRegistry.ts` — one-press background drain (and Task #2086
 *     self-heal cadence) against the deployed Neon database.
 *
 * Safety / behavior:
 *   - Idempotent: only ever writes the columns on rows where BOTH are NULL,
 *     in both the candidate filter and the UPDATE WHERE clause. Re-running
 *     after a clean apply matches nothing.
 *   - Convergence: rows that stay BOTH-NULL after a successful re-fetch (no
 *     name-match) — or whose parent has no keywordId — are stamped
 *     `structured_location_backfill_attempted_at` (apply mode) so they stop
 *     being re-counted and the action settles to "not needed".
 *   - SEMrush circuit-breaker aware via the shared fetch helper.
 *   - Pool-agnostic: the Drizzle handle is injected so the CLI can use the
 *     process `workerDb` and the prod-action can use the `worker` pool via
 *     `getDb()` under `runWithWorkerDb`.
 */
import { and, eq, gte, isNull, sql, inArray } from "drizzle-orm";
import {
  heatmapSnapshots,
  heatmapCompetitorSnapshots,
} from "@shared/schema";
import {
  type BackfillDb,
  type SnapshotParent,
  type CandidateSnapshot,
  fetchTopCompetitorsForBackfill,
  normalizeCompetitorName,
  BACKFILL_TRANSIENT_RETRY_BUDGET,
} from "./competitorLocationBackfill";

// Re-export the shared pieces the CLI / prod-action consume from one place so
// the structured-location callers do not have to reach into the GBP module.
export {
  DEFAULT_BACKFILL_DAYS,
  loadSnapshotParents,
  createReportDatesResolver,
  normalizeCompetitorName,
} from "./competitorLocationBackfill";
export type { BackfillDb, SnapshotParent, CandidateSnapshot } from "./competitorLocationBackfill";

/**
 * Candidate snapshots: recent, owning >= 1 competitor row with BOTH
 * `competitor_locality` AND `competitor_street` NULL and not yet stamped
 * `structured_location_backfill_attempted_at`. Ordered by missing-count desc
 * so the biggest wins land first.
 */
export async function findStructuredLocationCandidateSnapshots(
  db: BackfillDb,
  opts: { sinceDays: number; clientId?: string },
): Promise<CandidateSnapshot[]> {
  const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      snapshotId: heatmapCompetitorSnapshots.snapshotId,
      missing: sql<number>`count(*)`.as("missing"),
    })
    .from(heatmapCompetitorSnapshots)
    .innerJoin(
      heatmapSnapshots,
      eq(heatmapCompetitorSnapshots.snapshotId, heatmapSnapshots.id),
    )
    .where(
      and(
        isNull(heatmapCompetitorSnapshots.competitorLocality),
        isNull(heatmapCompetitorSnapshots.competitorStreet),
        // Convergence: skip rows already proven unfillable (a successful
        // SEMrush re-fetch produced no name-match, or the parent has no
        // keywordId). Without this they stay NULL forever and the
        // backfill action could never settle to "not needed".
        isNull(heatmapCompetitorSnapshots.structuredLocationBackfillAttemptedAt),
        gte(heatmapSnapshots.reportDate, since),
        opts.clientId ? eq(heatmapSnapshots.clientId, opts.clientId) : undefined,
      ),
    )
    .groupBy(heatmapCompetitorSnapshots.snapshotId)
    .orderBy(sql`count(*) desc`);
  return rows.map((r) => ({ snapshotId: r.snapshotId, missing: Number(r.missing) }));
}

export interface StructuredLocationUpdate {
  id: string;
  name: string;
  locality: string | null;
  street: string | null;
}

export type ProcessStructuredLocationResult =
  | { kind: "no_keyword" }
  | { kind: "circuit_open"; state: string; retryAfterMs?: number }
  | { kind: "campaign_backoff"; retryAfterMs?: number }
  | { kind: "rate_limited" }
  | { kind: "fetch_failed"; error: string }
  | { kind: "fetch_unfillable"; error: string }
  | {
      kind: "done";
      competitorsReturned: number;
      nullRows: number;
      updates: StructuredLocationUpdate[];
    };

export interface ProcessStructuredLocationDeps {
  db: BackfillDb;
  caller: string;
  getReportDates: (campaignId: string) => Promise<string[] | null>;
  /** When true, write matched locality/street; otherwise compute updates only. */
  apply: boolean;
  /**
   * Task #2434 — optional "is this campaign still known to SEMrush?"
   * resolver (see `createCampaignResolvableResolver`). When it returns
   * false on a transient failure the snapshot is stamped terminal at once
   * (proven gone) instead of spending the retry budget. Omitted (CLI /
   * tests) ⇒ every campaign is treated as resolvable, so only the bounded
   * budget path applies.
   */
  isCampaignResolvable?: (campaignId: string) => Promise<boolean>;
}

/**
 * Process a single candidate snapshot: gate on the breaker (via the shared
 * fetch helper), re-fetch SEMrush competitors, parse each match's `address`
 * with the ingestion-path `parseCompetitorAddress`, and (when `apply`) write
 * `competitor_locality` / `competitor_street` for the BOTH-NULL rows that
 * matched. The write re-asserts BOTH columns IS NULL so a concurrent fill is
 * never clobbered.
 */
export async function processStructuredLocationSnapshot(
  deps: ProcessStructuredLocationDeps,
  parent: SnapshotParent,
): Promise<ProcessStructuredLocationResult> {
  if (!parent.keywordId) {
    // Permanent: without a keywordId we can never query SEMrush, so the
    // BOTH-NULL rows can never be filled. Stamp them attempted (apply mode)
    // so they stop being re-counted and the action converges.
    if (deps.apply) await stampStructuredLocationAttempted(deps, parent.id);
    return { kind: "no_keyword" };
  }

  const fetched = await fetchTopCompetitorsForBackfill(deps, parent);
  if (fetched.kind !== "ok") {
    if (deps.apply) {
      if (fetched.kind === "fetch_unfillable") {
        // Deterministic / non-retryable → stamp at once so it converges.
        await stampStructuredLocationAttempted(deps, parent.id);
      } else if (
        fetched.kind === "campaign_backoff" ||
        fetched.kind === "fetch_failed"
      ) {
        // Campaign-specific TRANSIENT failure. Converge via the bounded
        // retry budget (Task #2434); a campaign proven gone is stamped at
        // once. GLOBAL outages (circuit_open / rate_limited) fall through and
        // never burn budget — the drain stops and retries the batch later.
        await convergeStructuredTransientFailure(deps, parent);
      }
    }
    return fetched;
  }
  const competitors = fetched.competitors;

  // Parse each returned competitor's address with the SAME heuristic the
  // ingestion path uses. Lazy-import keeps this module pool-clean on import
  // (localDominanceService imports `db` at top level).
  const { parseCompetitorAddress } = await import("./localDominanceService");

  // Build a normalized-name -> {locality, street} map from the fresh results.
  const nameToLoc = new Map<string, { locality?: string; street?: string }>();
  for (const c of competitors) {
    if (!c.name || !c.address) continue;
    const parsed = parseCompetitorAddress(c.address);
    if (!parsed.locality && !parsed.street) continue;
    const key = normalizeCompetitorName(c.name);
    if (key && !nameToLoc.has(key)) nameToLoc.set(key, parsed);
  }

  const nullRows = await deps.db
    .select({
      id: heatmapCompetitorSnapshots.id,
      competitorName: heatmapCompetitorSnapshots.competitorName,
    })
    .from(heatmapCompetitorSnapshots)
    .where(
      and(
        eq(heatmapCompetitorSnapshots.snapshotId, parent.id),
        isNull(heatmapCompetitorSnapshots.competitorLocality),
        isNull(heatmapCompetitorSnapshots.competitorStreet),
      ),
    );

  const updates: StructuredLocationUpdate[] = [];
  for (const row of nullRows) {
    const parsed = nameToLoc.get(normalizeCompetitorName(row.competitorName));
    if (parsed && (parsed.locality || parsed.street)) {
      updates.push({
        id: row.id,
        name: row.competitorName,
        locality: parsed.locality ?? null,
        street: parsed.street ?? null,
      });
    }
  }

  if (deps.apply && updates.length > 0) {
    for (const u of updates) {
      await deps.db
        .update(heatmapCompetitorSnapshots)
        .set({ competitorLocality: u.locality, competitorStreet: u.street })
        .where(
          and(
            eq(heatmapCompetitorSnapshots.id, u.id),
            isNull(heatmapCompetitorSnapshots.competitorLocality),
            isNull(heatmapCompetitorSnapshots.competitorStreet),
          ),
        );
    }
  }

  if (deps.apply) {
    // Convergence: a successful fetch just happened, so any row still
    // BOTH-NULL here has no name-match (matched rows now carry a value and
    // fall out of the IS NULL filter). Stamp them attempted so they stop
    // being re-counted forever. We only reach here after a successful fetch;
    // transient outcomes returned earlier and never stamp. A later ingestion
    // that DOES know a competitor writes its columns at write time.
    await stampStructuredLocationAttempted(deps, parent.id);
  }

  return {
    kind: "done",
    competitorsReturned: competitors.length,
    nullRows: nullRows.length,
    updates,
  };
}

/**
 * Mark every still-BOTH-NULL competitor row of a snapshot as
 * structured-location-backfill-attempted so
 * findStructuredLocationCandidateSnapshots stops returning it. Only touches
 * rows still BOTH-NULL and not already stamped, so it is idempotent and
 * never overwrites a real value.
 */
async function stampStructuredLocationAttempted(
  deps: ProcessStructuredLocationDeps,
  snapshotId: string,
): Promise<void> {
  await deps.db
    .update(heatmapCompetitorSnapshots)
    .set({ structuredLocationBackfillAttemptedAt: new Date() })
    .where(
      and(
        eq(heatmapCompetitorSnapshots.snapshotId, snapshotId),
        isNull(heatmapCompetitorSnapshots.competitorLocality),
        isNull(heatmapCompetitorSnapshots.competitorStreet),
        isNull(heatmapCompetitorSnapshots.structuredLocationBackfillAttemptedAt),
      ),
    );
}

/**
 * Task #2434 — converge a campaign-specific TRANSIENT structured-location
 * backfill failure (`campaign_backoff` / `fetch_failed`). Mirrors the
 * GBP-URL `convergeTransientFailure`: a campaign proven gone is stamped
 * terminal at once; otherwise the still-BOTH-NULL, unstamped rows'
 * transient-retry budget is incremented, and once any reaches
 * `BACKFILL_TRANSIENT_RETRY_BUDGET` the snapshot is stamped attempted so it
 * stops being re-counted. Apply mode only — callers gate this.
 */
async function convergeStructuredTransientFailure(
  deps: ProcessStructuredLocationDeps,
  parent: SnapshotParent,
): Promise<void> {
  if (deps.isCampaignResolvable) {
    const resolvable = await deps
      .isCampaignResolvable(parent.campaignId)
      .catch(() => true);
    if (!resolvable) {
      await stampStructuredLocationAttempted(deps, parent.id);
      return;
    }
  }
  const bumped = await deps.db
    .update(heatmapCompetitorSnapshots)
    .set({
      structuredLocationBackfillRetryCount: sql`${heatmapCompetitorSnapshots.structuredLocationBackfillRetryCount} + 1`,
    })
    .where(
      and(
        eq(heatmapCompetitorSnapshots.snapshotId, parent.id),
        isNull(heatmapCompetitorSnapshots.competitorLocality),
        isNull(heatmapCompetitorSnapshots.competitorStreet),
        isNull(heatmapCompetitorSnapshots.structuredLocationBackfillAttemptedAt),
      ),
    )
    .returning({
      count: heatmapCompetitorSnapshots.structuredLocationBackfillRetryCount,
    });
  const maxCount = bumped.reduce((m, r) => Math.max(m, r.count ?? 0), 0);
  if (maxCount >= BACKFILL_TRANSIENT_RETRY_BUDGET) {
    await stampStructuredLocationAttempted(deps, parent.id);
  }
}
