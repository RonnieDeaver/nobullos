// @db-pool-intent: ambient
/**
 * Shared core for the "competitor location label" backfill.
 *
 * Background (Task #1966 / #1996 / #1997):
 *   The Local Dominance "Market Share Leaderboard" derives each row's
 *   human-readable location disambiguator at *read time* via
 *   `deriveCompetitorLocationLabel(gbpUrl, firmName)` in
 *   `localDominanceService.ts`. When a historical
 *   `heatmap_competitor_snapshots` row has a NULL `competitor_gbp_url`
 *   the deriver returns `null` and the leaderboard shows duplicate firm
 *   rows with no location label. The only lever that fixes older
 *   snapshots is filling in the missing `competitor_gbp_url`; there are
 *   deliberately NO structured locality/address columns.
 *
 *   This module re-fetches SEMrush top-competitors for a snapshot and
 *   fills the missing `competitor_gbp_url` by matching on normalized
 *   competitor name. It is consumed by two callers that share this exact
 *   logic so it stays in lockstep:
 *     - `scripts/backfill-competitor-location-labels.ts` (CLI, dry-run by
 *       default) — for ad-hoc / staged runs against an explicit
 *       `DATABASE_URL`.
 *     - the `backfill_competitor_location_labels` CEO prod-action in
 *       `prodActionsRegistry.ts` — one-press background drain against the
 *       deployed Neon database.
 *
 * Safety / behavior:
 *   - Idempotent: only ever writes `competitor_gbp_url` on rows where it
 *     IS NULL, both in the candidate filter and in the UPDATE WHERE
 *     clause. Re-running after a clean apply matches nothing.
 *   - SEMrush circuit-breaker aware: every upstream call is gated by
 *     `shouldAllowRequest` as a background caller; the caller decides how
 *     to react to `circuit_open` / `campaign_backoff` / rate-limit.
 *   - Pool-agnostic: the Drizzle handle is injected so the CLI can use
 *     the process `db` and the prod-action can use the `worker` pool via
 *     `getDb()` under `runWithWorkerDb`.
 */
import { and, eq, gte, isNull, sql, inArray } from "drizzle-orm";
import {
  heatmapSnapshots,
  heatmapCompetitorSnapshots,
  semrushCampaignMetadataCache,
} from "@shared/schema";
import {
  getTopCompetitors,
  findBestReportDate,
  SemrushRateLimitError,
  SemrushNotFoundError,
} from "./semrushApi";
import { shouldAllowRequest } from "./semrushCircuitBreaker";

// Type-only — erased at runtime, so importing this module does NOT boot
// the DB pool. Callers inject the concrete handle.
export type BackfillDb = ReturnType<typeof import("../db")["getDb"]>;

export const DEFAULT_BACKFILL_DAYS = 365;

/**
 * Task #2434 — bounded transient-retry budget shared by both competitor
 * backfills. A snapshot whose SEMrush re-fetch keeps returning a
 * *campaign-specific transient* outcome (`campaign_backoff` / `fetch_failed`)
 * is retried at most this many times across self-heal ticks; on the Nth
 * attempt the row is stamped its `*_attempted_at` marker (terminal) so the
 * action converges instead of re-counting it forever. The GLOBAL outage
 * outcomes (`circuit_open` / `rate_limited`) never burn this budget — they
 * stop the whole drain and are retried wholesale later. Campaigns proven
 * gone (absent from the metadata cache) are stamped at once, bypassing the
 * budget (see `createCampaignResolvableResolver`).
 */
export const BACKFILL_TRANSIENT_RETRY_BUDGET = 3;

export function normalizeCompetitorName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Classify a thrown SEMrush top-competitors error as *terminal*
 * (deterministic, non-retryable — the snapshot can never be filled, so
 * stamp it attempted and let the backfill converge) vs *transient*
 * (retry on a later press / tick).
 *
 * Terminal cases — kept deliberately NARROW so a transient upstream
 * regression never permanently stamps recoverable rows:
 *   - `SemrushNotFoundError` (HTTP 404): the campaign/keyword no longer
 *     exists in SEMrush.
 *   - HTTP 400 whose body is the specific "Invalid value for 'reportDate'
 *     provided" (retryable:false) rejection. This is the documented case
 *     for old snapshots whose campaign has no cached reportDates: the
 *     dateless retry in `processSnapshot` is rejected with the same 400,
 *     so there is no date we can supply that SEMrush will accept.
 *
 * Everything else (other 400 shapes, 5xx, network/timeout, auth-missing,
 * rate-limit) stays transient.
 */
export function isTerminalSemrushFetchError(err: unknown): boolean {
  if (err instanceof SemrushNotFoundError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("returned 400") && /invalid value for 'reportDate'/i.test(msg);
}

export interface CandidateSnapshot {
  snapshotId: string;
  missing: number;
}

export interface SnapshotParent {
  id: string;
  clientId: string | null;
  campaignId: string;
  keywordId: string | null;
  reportDate: Date;
}

/**
 * Candidate snapshots: recent, owning >= 1 competitor row with a NULL
 * `competitor_gbp_url`. Ordered by missing-count desc so the biggest
 * wins land first.
 */
export async function findCandidateSnapshots(
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
        isNull(heatmapCompetitorSnapshots.competitorGbpUrl),
        // Convergence: skip rows already proven unfillable (a successful
        // SEMrush re-fetch produced no name-match, or the parent has no
        // keywordId). Without this they stay NULL forever and the
        // backfill action could never settle to "not needed".
        isNull(heatmapCompetitorSnapshots.gbpUrlBackfillAttemptedAt),
        gte(heatmapSnapshots.reportDate, since),
        opts.clientId ? eq(heatmapSnapshots.clientId, opts.clientId) : undefined,
      ),
    )
    .groupBy(heatmapCompetitorSnapshots.snapshotId)
    .orderBy(sql`count(*) desc`);
  return rows.map((r) => ({ snapshotId: r.snapshotId, missing: Number(r.missing) }));
}

export async function loadSnapshotParents(
  db: BackfillDb,
  snapshotIds: string[],
): Promise<Map<string, SnapshotParent>> {
  if (snapshotIds.length === 0) return new Map();
  const parents = await db
    .select({
      id: heatmapSnapshots.id,
      clientId: heatmapSnapshots.clientId,
      campaignId: heatmapSnapshots.campaignId,
      keywordId: heatmapSnapshots.keywordId,
      reportDate: heatmapSnapshots.reportDate,
    })
    .from(heatmapSnapshots)
    .where(inArray(heatmapSnapshots.id, snapshotIds));
  return new Map(parents.map((p) => [p.id, p]));
}

/**
 * Per-campaign report-date resolver backed by the cached campaign
 * metadata. Reads each campaign's `reportDates` at most once.
 */
export function createReportDatesResolver(db: BackfillDb) {
  const cache = new Map<string, string[] | null>();
  return async function getReportDates(campaignId: string): Promise<string[] | null> {
    if (cache.has(campaignId)) return cache.get(campaignId)!;
    const [row] = await db
      .select({ reportDates: semrushCampaignMetadataCache.reportDates })
      .from(semrushCampaignMetadataCache)
      .where(eq(semrushCampaignMetadataCache.campaignId, campaignId));
    const dates = row?.reportDates ?? null;
    cache.set(campaignId, dates);
    return dates;
  };
}

/**
 * Per-campaign "is this campaign still known to SEMrush?" resolver backed
 * by the cached campaign metadata. A campaign with NO `semrush_campaign_
 * metadata_cache` row is treated as provably gone (the SEMrush sync keeps a
 * row for every active campaign; an old snapshot's campaign that is no
 * longer there is deleted / inactive). When a backfill hits a transient
 * failure for such a campaign there is no point spending the retry budget,
 * so the caller stamps it terminal at once. Reads each campaign at most
 * once. Shared by both competitor backfill prod-action drains (Task #2434).
 */
export function createCampaignResolvableResolver(db: BackfillDb) {
  const cache = new Map<string, boolean>();
  return async function isCampaignResolvable(campaignId: string): Promise<boolean> {
    if (cache.has(campaignId)) return cache.get(campaignId)!;
    const [row] = await db
      .select({ id: semrushCampaignMetadataCache.campaignId })
      .from(semrushCampaignMetadataCache)
      .where(eq(semrushCampaignMetadataCache.campaignId, campaignId));
    const resolvable = !!row;
    cache.set(campaignId, resolvable);
    return resolvable;
  };
}

export interface SnapshotUpdate {
  id: string;
  gbpUrl: string;
  name: string;
}

export type ProcessSnapshotResult =
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
      updates: SnapshotUpdate[];
    };

export interface ProcessSnapshotDeps {
  db: BackfillDb;
  caller: string;
  getReportDates: (campaignId: string) => Promise<string[] | null>;
  /** When true, write matched URLs; otherwise compute updates only. */
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
 * Outcome of the shared SEMrush top-competitors fetch. `ok` carries the
 * raw competitor list; every other variant is a non-fillable condition
 * the caller maps onto its own result type. `fetch_unfillable` is
 * deterministic/terminal (caller should stamp its attempted-marker so
 * the row converges); the rest are transient and should be retried.
 */
export type FetchCompetitorsResult =
  | { kind: "circuit_open"; state: string; retryAfterMs?: number }
  | { kind: "campaign_backoff"; retryAfterMs?: number }
  | { kind: "rate_limited" }
  | { kind: "fetch_failed"; error: string }
  | { kind: "fetch_unfillable"; error: string }
  | { kind: "ok"; competitors: Awaited<ReturnType<typeof getTopCompetitors>> };

/**
 * Shared SEMrush fetch + classify used by BOTH the GBP-URL backfill
 * (`processSnapshot`) and the structured-location backfill
 * (`processStructuredLocationSnapshot`) so the two stay in lockstep on
 * breaker gating, the dateless-retry path, and terminal-vs-transient
 * error classification. The caller owns the column-specific
 * match/write/stamp. Assumes `parent.keywordId` is non-null (callers
 * check + stamp the no-keyword case first).
 */
export async function fetchTopCompetitorsForBackfill(
  deps: {
    caller: string;
    getReportDates: (campaignId: string) => Promise<string[] | null>;
  },
  parent: SnapshotParent,
): Promise<FetchCompetitorsResult> {
  const decision = shouldAllowRequest({
    campaignId: parent.campaignId,
    caller: deps.caller,
  });
  if (!decision.allowed) {
    if (decision.reason === "circuit_open") {
      return {
        kind: "circuit_open",
        state: decision.state,
        retryAfterMs: decision.retryAfterMs,
      };
    }
    return { kind: "campaign_backoff", retryAfterMs: decision.retryAfterMs };
  }

  // Resolve the best report date for the snapshot's month; fall back to
  // dateless (getTopCompetitors itself retries dateless on a 400).
  let reportDate: string | undefined;
  const dates = await deps.getReportDates(parent.campaignId);
  if (dates?.length) {
    const d = new Date(parent.reportDate);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    reportDate = findBestReportDate(dates, month) || undefined;
  }

  let competitors: Awaited<ReturnType<typeof getTopCompetitors>> = [];
  try {
    try {
      competitors = await getTopCompetitors(
        parent.campaignId,
        parent.keywordId!,
        reportDate,
      );
    } catch (dateErr) {
      const msg = dateErr instanceof Error ? dateErr.message : String(dateErr);
      if (reportDate && msg.includes("returned 400")) {
        try {
          competitors = await getTopCompetitors(
            parent.campaignId,
            parent.keywordId!,
            undefined,
          );
        } catch (datelessErr) {
          const dlMsg =
            datelessErr instanceof Error ? datelessErr.message : String(datelessErr);
          // A dateless retry that ALSO 400s is SEMrush saying there is simply
          // no top-competitor data for this campaign+keyword — a benign no-data
          // condition. Without a reportDate the message is a generic 400 (not
          // "invalid value for 'reportDate'"), so isTerminalSemrushFetchError
          // would misclassify it as a transient `fetch_failed` and loop on it
          // forever. Treat it as an empty fetch so it flows through the `ok`
          // path and (in apply mode) the caller stamps attempted, converging.
          if (dlMsg.includes("returned 400")) {
            competitors = [];
          } else {
            throw datelessErr;
          }
        }
      } else {
        throw dateErr;
      }
    }
  } catch (err) {
    if (err instanceof SemrushRateLimitError) {
      return { kind: "rate_limited" };
    }
    const error = err instanceof Error ? err.message : String(err);
    // A deterministic, non-retryable SEMrush error (see
    // isTerminalSemrushFetchError) means this campaign+keyword can NEVER
    // be fetched. Surface it as terminal so the caller stamps attempted
    // and the backfill converges; genuinely transient failures retry.
    if (isTerminalSemrushFetchError(err)) {
      return { kind: "fetch_unfillable", error };
    }
    return { kind: "fetch_failed", error };
  }

  return { kind: "ok", competitors };
}

/**
 * Process a single candidate snapshot: gate on the breaker, re-fetch
 * SEMrush competitors, match by normalized name, and (when `apply`)
 * write `competitor_gbp_url` for the NULL rows that matched. The write
 * re-asserts `competitor_gbp_url IS NULL` so concurrent fills never get
 * clobbered.
 */
export async function processSnapshot(
  deps: ProcessSnapshotDeps,
  parent: SnapshotParent,
): Promise<ProcessSnapshotResult> {
  if (!parent.keywordId) {
    // Permanent: without a keywordId we can never query SEMrush
    // competitors for this snapshot, so its NULL rows can never be
    // filled. Stamp them attempted (apply mode only) so they stop being
    // re-counted as candidates and the backfill action converges.
    if (deps.apply) await stampBackfillAttempted(deps, parent.id);
    return { kind: "no_keyword" };
  }

  const fetched = await fetchTopCompetitorsForBackfill(deps, parent);
  if (fetched.kind !== "ok") {
    if (deps.apply) {
      if (fetched.kind === "fetch_unfillable") {
        // Deterministic, non-retryable SEMrush error: this campaign+keyword
        // can NEVER be fetched. Stamp at once so it converges.
        await stampBackfillAttempted(deps, parent.id);
      } else if (
        fetched.kind === "campaign_backoff" ||
        fetched.kind === "fetch_failed"
      ) {
        // Campaign-specific TRANSIENT failure. Converge it via the bounded
        // retry budget (Task #2434) so a campaign that keeps failing
        // transiently is not re-counted forever. A campaign proven gone is
        // stamped at once without spending the budget. The GLOBAL outage
        // outcomes (circuit_open / rate_limited) fall through and never burn
        // budget — the drain stops and retries the whole batch later.
        await convergeTransientFailure(deps, parent);
      }
    }
    return fetched;
  }
  const competitors = fetched.competitors;

  // Build a normalized-name -> gbpUrl map from the fresh results.
  const nameToGbp = new Map<string, string>();
  for (const c of competitors) {
    if (c.gbpUrl && c.name) {
      const key = normalizeCompetitorName(c.name);
      if (key && !nameToGbp.has(key)) nameToGbp.set(key, c.gbpUrl);
    }
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
        isNull(heatmapCompetitorSnapshots.competitorGbpUrl),
      ),
    );

  const updates: SnapshotUpdate[] = [];
  for (const row of nullRows) {
    const gbp = nameToGbp.get(normalizeCompetitorName(row.competitorName));
    if (gbp) updates.push({ id: row.id, gbpUrl: gbp, name: row.competitorName });
  }

  if (deps.apply && updates.length > 0) {
    for (const u of updates) {
      await deps.db
        .update(heatmapCompetitorSnapshots)
        .set({ competitorGbpUrl: u.gbpUrl })
        .where(
          and(
            eq(heatmapCompetitorSnapshots.id, u.id),
            isNull(heatmapCompetitorSnapshots.competitorGbpUrl),
          ),
        );
    }
  }

  if (deps.apply) {
    // Convergence: a successful SEMrush fetch just happened, so any row
    // still NULL here has no name-match to fill (matched rows now carry a
    // URL and fall out of the `IS NULL` filter). Stamp them attempted so
    // they stop being re-counted forever. We only reach `done` after a
    // successful fetch; transient outcomes (circuit_open / campaign_backoff
    // / rate_limited / fetch_failed) return earlier and never stamp, so
    // they keep retrying. A later SEMrush ingestion that *does* know a
    // competitor writes its URL at write time, independent of this path.
    await stampBackfillAttempted(deps, parent.id);
  }

  return {
    kind: "done",
    competitorsReturned: competitors.length,
    nullRows: nullRows.length,
    updates,
  };
}

/**
 * Mark every still-NULL competitor_gbp_url row of a snapshot as
 * backfill-attempted so findCandidateSnapshots stops returning it. Only
 * touches rows that are still NULL and not already stamped, so it is
 * idempotent and never overwrites a real URL.
 */
async function stampBackfillAttempted(
  deps: ProcessSnapshotDeps,
  snapshotId: string,
): Promise<void> {
  await deps.db
    .update(heatmapCompetitorSnapshots)
    .set({ gbpUrlBackfillAttemptedAt: new Date() })
    .where(
      and(
        eq(heatmapCompetitorSnapshots.snapshotId, snapshotId),
        isNull(heatmapCompetitorSnapshots.competitorGbpUrl),
        isNull(heatmapCompetitorSnapshots.gbpUrlBackfillAttemptedAt),
      ),
    );
}

/**
 * Task #2434 — converge a campaign-specific TRANSIENT backfill failure
 * (`campaign_backoff` / `fetch_failed`). A campaign proven gone (no
 * metadata-cache row) is stamped terminal at once. Otherwise the
 * still-NULL, unstamped rows' transient-retry budget is incremented by one;
 * once any of them reaches `BACKFILL_TRANSIENT_RETRY_BUDGET` the snapshot is
 * stamped attempted (terminal) so it stops being re-counted. Apply mode
 * only — callers gate this behind `deps.apply`.
 */
async function convergeTransientFailure(
  deps: ProcessSnapshotDeps,
  parent: SnapshotParent,
): Promise<void> {
  if (deps.isCampaignResolvable) {
    const resolvable = await deps
      .isCampaignResolvable(parent.campaignId)
      .catch(() => true);
    if (!resolvable) {
      await stampBackfillAttempted(deps, parent.id);
      return;
    }
  }
  const bumped = await deps.db
    .update(heatmapCompetitorSnapshots)
    .set({
      gbpUrlBackfillRetryCount: sql`${heatmapCompetitorSnapshots.gbpUrlBackfillRetryCount} + 1`,
    })
    .where(
      and(
        eq(heatmapCompetitorSnapshots.snapshotId, parent.id),
        isNull(heatmapCompetitorSnapshots.competitorGbpUrl),
        isNull(heatmapCompetitorSnapshots.gbpUrlBackfillAttemptedAt),
      ),
    )
    .returning({ count: heatmapCompetitorSnapshots.gbpUrlBackfillRetryCount });
  const maxCount = bumped.reduce((m, r) => Math.max(m, r.count ?? 0), 0);
  if (maxCount >= BACKFILL_TRANSIENT_RETRY_BUDGET) {
    await stampBackfillAttempted(deps, parent.id);
  }
}
