// @db-pool-intent: ambient
/**
 * Shared core for the competitor locality-RELABEL backfill (Task #2357).
 *
 * Background:
 *   Task #2291 taught `parseCompetitorAddress` (in `localDominanceService.ts`)
 *   to recognize Australian state codes, Irish Eircodes and Dutch postal
 *   tokens so they are no longer mistaken for the city on the Local Dominance
 *   "Market Share Leaderboard". But rows ingested BEFORE that change can carry
 *   a `competitor_locality` that the OLD parser wrongly set to a region/postal
 *   token (e.g. "NSW 2000", an Eircode "D02 AF30", or a Dutch "1011 AB").
 *
 *   The existing structured-location backfill (Task #2052,
 *   `competitorStructuredLocationBackfill.ts`) only writes when BOTH
 *   `competitor_locality` AND `competitor_street` are NULL, so it never
 *   re-corrects an already-NON-NULL but mislabeled locality. This module is the
 *   missing re-correction path: it finds rows whose stored `competitor_locality`
 *   is now recognized as a region/postal token (via the exported
 *   `isRegionOrZipToken`), re-fetches SEMrush `getTopCompetitors`, re-parses the
 *   business `address` with the CURRENT `parseCompetitorAddress`, and overwrites
 *   the locality when the new parse yields a DIFFERENT result (which, for these
 *   pure region/postal tokens, is typically `null` — the segment was never a
 *   real city).
 *
 *   SEMrush exposes location only as a single concatenated `address` string
 *   which is NOT persisted on the snapshot row, so — exactly like #2052 — the
 *   only way to re-parse is to re-fetch the competitors and match them back to
 *   the stored rows by normalized name. This module reuses #2052's / the GBP
 *   module's SEMrush fetch/classify helper, report-date resolver, parent
 *   loader, name normalizer, and `BackfillDb` handle injection so all three
 *   backfills stay in lockstep on breaker gating and error classification.
 *
 * Consumed by two callers that share this exact logic:
 *   - `scripts/backfill-competitor-locality-relabel.ts` (CLI, dry-run by
 *     default) — for ad-hoc / staged runs against an explicit `DATABASE_URL`.
 *   - the `backfill_competitor_locality_relabel` CEO prod-action in
 *     `prodActionsRegistry.ts` — one-press background drain (and Task #2086
 *     self-heal cadence) against the deployed Neon database.
 *
 * Safety / behavior:
 *   - Suspect-only: only ever considers rows whose stored locality is a
 *     region/postal token under the current rules. Correctly-parsed cities are
 *     never touched.
 *   - Idempotent: a cheap SQL superset pre-filter (locality contains a digit OR
 *     is <= 3 chars) narrows the scan, then the exact `isRegionOrZipToken`
 *     check decides; processed suspect rows are stamped so a clean re-run
 *     matches nothing.
 *   - Convergence: after a successful re-fetch every still-suspect row is
 *     stamped `competitor_locality_relabel_attempted_at` (apply mode) — whether
 *     or not it name-matched — so it stops being re-counted and the action
 *     settles to "not needed". Transient SEMrush outcomes never stamp.
 *   - SEMrush circuit-breaker aware via the shared fetch helper.
 *   - Pool-agnostic: the Drizzle handle is injected.
 */
import { and, eq, gte, isNull, isNotNull, sql, inArray } from "drizzle-orm";
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
} from "./competitorLocationBackfill";

// Re-export the shared pieces the CLI / prod-action consume from one place so
// the relabel callers do not have to reach into the GBP module.
export {
  DEFAULT_BACKFILL_DAYS,
  loadSnapshotParents,
  createReportDatesResolver,
  normalizeCompetitorName,
} from "./competitorLocationBackfill";
export type { BackfillDb, SnapshotParent, CandidateSnapshot } from "./competitorLocationBackfill";

/**
 * A row whose stored `competitor_locality` is a candidate for re-correction.
 */
interface SuspectRow {
  id: string;
  competitorName: string;
  locality: string;
}

/**
 * Cheap SQL superset of "looks like a region/postal token": every region/postal
 * token either contains a digit (numeric ZIP, "NSW 2000", an Eircode, a Dutch
 * "1011 AB", "IL 60601", a Canadian "M5V 2T6") or is a bare <=3-char code
 * ("NSW", "ON", "IL"). Real city names rarely match either, so this prunes the
 * scan to a tiny set; the exact `isRegionOrZipToken` check then decides.
 */
function suspectLocalitySql() {
  return sql`(${heatmapCompetitorSnapshots.competitorLocality} ~ '[0-9]' OR char_length(trim(${heatmapCompetitorSnapshots.competitorLocality})) <= 3)`;
}

/**
 * Load the suspect rows of a single snapshot: NON-NULL locality, not yet
 * stamped relabel-attempted, passing the SQL superset, and (exactly) a
 * region/postal token under the current rules.
 */
async function loadSuspectRows(
  db: BackfillDb,
  snapshotId: string,
): Promise<SuspectRow[]> {
  const rows = await db
    .select({
      id: heatmapCompetitorSnapshots.id,
      competitorName: heatmapCompetitorSnapshots.competitorName,
      locality: heatmapCompetitorSnapshots.competitorLocality,
    })
    .from(heatmapCompetitorSnapshots)
    .where(
      and(
        eq(heatmapCompetitorSnapshots.snapshotId, snapshotId),
        isNotNull(heatmapCompetitorSnapshots.competitorLocality),
        isNull(heatmapCompetitorSnapshots.competitorLocalityRelabelAttemptedAt),
        suspectLocalitySql(),
      ),
    );
  const { isRegionOrZipToken } = await import("./localDominanceService");
  const out: SuspectRow[] = [];
  for (const r of rows) {
    const loc = r.locality;
    if (loc && isRegionOrZipToken(loc)) {
      out.push({ id: r.id, competitorName: r.competitorName, locality: loc });
    }
  }
  return out;
}

/**
 * Candidate snapshots: recent, owning >= 1 competitor row whose stored
 * `competitor_locality` is (exactly) a region/postal token an OLD parse
 * mislabeled and that has not yet been relabel-attempted. The SQL superset
 * keeps the pulled set small; the exact check + grouping is done in JS.
 * `missing` is the exact suspect-row count. Ordered by count desc so the
 * biggest wins land first.
 */
export async function findLocalityRelabelCandidateSnapshots(
  db: BackfillDb,
  opts: { sinceDays: number; clientId?: string },
): Promise<CandidateSnapshot[]> {
  const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      snapshotId: heatmapCompetitorSnapshots.snapshotId,
      id: heatmapCompetitorSnapshots.id,
      locality: heatmapCompetitorSnapshots.competitorLocality,
    })
    .from(heatmapCompetitorSnapshots)
    .innerJoin(
      heatmapSnapshots,
      eq(heatmapCompetitorSnapshots.snapshotId, heatmapSnapshots.id),
    )
    .where(
      and(
        isNotNull(heatmapCompetitorSnapshots.competitorLocality),
        isNull(heatmapCompetitorSnapshots.competitorLocalityRelabelAttemptedAt),
        suspectLocalitySql(),
        gte(heatmapSnapshots.reportDate, since),
        opts.clientId ? eq(heatmapSnapshots.clientId, opts.clientId) : undefined,
      ),
    );

  const { isRegionOrZipToken } = await import("./localDominanceService");
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.locality && isRegionOrZipToken(r.locality)) {
      counts.set(r.snapshotId, (counts.get(r.snapshotId) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([snapshotId, missing]) => ({ snapshotId, missing }))
    .sort((a, b) => b.missing - a.missing);
}

export interface LocalityRelabelUpdate {
  id: string;
  name: string;
  oldLocality: string;
  newLocality: string | null;
}

export type ProcessLocalityRelabelResult =
  | { kind: "no_keyword" }
  | { kind: "no_suspects" }
  | { kind: "circuit_open"; state: string; retryAfterMs?: number }
  | { kind: "campaign_backoff"; retryAfterMs?: number }
  | { kind: "rate_limited" }
  | { kind: "fetch_failed"; error: string }
  | { kind: "fetch_unfillable"; error: string }
  | {
      kind: "done";
      competitorsReturned: number;
      suspectRows: number;
      updates: LocalityRelabelUpdate[];
    };

export interface ProcessLocalityRelabelDeps {
  db: BackfillDb;
  caller: string;
  getReportDates: (campaignId: string) => Promise<string[] | null>;
  /** When true, write corrected localities + stamp; otherwise compute only. */
  apply: boolean;
}

/**
 * Process a single candidate snapshot: gate on the breaker (via the shared
 * fetch helper), re-fetch SEMrush competitors, re-parse each match's `address`
 * with the CURRENT `parseCompetitorAddress`, and (when `apply`) overwrite the
 * mislabeled `competitor_locality` of each suspect row whose re-parse yields a
 * DIFFERENT result. The new value is typically `null` (the stored token was
 * never a real city). The write re-asserts the relabel marker IS NULL so a
 * concurrent run never double-applies.
 */
export async function processLocalityRelabelSnapshot(
  deps: ProcessLocalityRelabelDeps,
  parent: SnapshotParent,
): Promise<ProcessLocalityRelabelResult> {
  const suspects = await loadSuspectRows(deps.db, parent.id);
  if (suspects.length === 0) return { kind: "no_suspects" };
  const suspectIds = suspects.map((s) => s.id);

  if (!parent.keywordId) {
    // Permanent: without a keywordId we can never query SEMrush, so these
    // mislabeled localities can never be re-parsed. Stamp them attempted
    // (apply mode) so they stop being re-counted and the action converges.
    if (deps.apply) await stampRelabelAttempted(deps, suspectIds);
    return { kind: "no_keyword" };
  }

  const fetched = await fetchTopCompetitorsForBackfill(deps, parent);
  if (fetched.kind !== "ok") {
    // Terminal/non-retryable → stamp so it converges; transient outcomes
    // (circuit_open / campaign_backoff / rate_limited / fetch_failed) do NOT
    // stamp, so they keep retrying on a later press / self-heal tick.
    if (fetched.kind === "fetch_unfillable" && deps.apply) {
      await stampRelabelAttempted(deps, suspectIds);
    }
    return fetched;
  }
  const competitors = fetched.competitors;

  // Re-parse each returned competitor's address with the SAME heuristic the
  // ingestion path now uses. Lazy-import keeps this module pool-clean on
  // import (localDominanceService imports `db` at top level).
  const { parseCompetitorAddress } = await import("./localDominanceService");

  // Build a normalized-name -> re-parsed locality map. We keep entries even
  // when the re-parse yields no locality (undefined) so a stored token can be
  // corrected to NULL — the whole point of this backfill.
  const nameToLocality = new Map<string, string | null>();
  for (const c of competitors) {
    if (!c.name || !c.address) continue;
    const parsed = parseCompetitorAddress(c.address);
    const key = normalizeCompetitorName(c.name);
    if (key && !nameToLocality.has(key)) {
      nameToLocality.set(key, parsed.locality ?? null);
    }
  }

  const updates: LocalityRelabelUpdate[] = [];
  for (const row of suspects) {
    const key = normalizeCompetitorName(row.competitorName);
    if (!nameToLocality.has(key)) continue; // no SEMrush match — can't re-parse
    const newLocality = nameToLocality.get(key) ?? null;
    // Only correct when the re-parse yields a DIFFERENT result. For a pure
    // region/postal token this is almost always `null`, but it could also be a
    // real city the old parser missed.
    if (newLocality !== row.locality) {
      updates.push({
        id: row.id,
        name: row.competitorName,
        oldLocality: row.locality,
        newLocality,
      });
    }
  }

  if (deps.apply && updates.length > 0) {
    for (const u of updates) {
      await deps.db
        .update(heatmapCompetitorSnapshots)
        .set({ competitorLocality: u.newLocality })
        .where(
          and(
            eq(heatmapCompetitorSnapshots.id, u.id),
            isNull(heatmapCompetitorSnapshots.competitorLocalityRelabelAttemptedAt),
          ),
        );
    }
  }

  if (deps.apply) {
    // Convergence: a successful fetch just happened. Stamp every suspect row
    // (corrected or not) so they stop being re-counted forever. Corrected
    // rows also fall out of the suspect filter naturally (their locality is
    // now NULL or a real city); the stamp covers the no-name-match rows whose
    // wrong value we could not re-parse, plus belt-and-braces for the rest.
    await stampRelabelAttempted(deps, suspectIds);
  }

  return {
    kind: "done",
    competitorsReturned: competitors.length,
    suspectRows: suspects.length,
    updates,
  };
}

/**
 * Mark the given competitor rows as relabel-attempted so
 * findLocalityRelabelCandidateSnapshots stops returning them. Only touches
 * rows not already stamped, so it is idempotent.
 */
async function stampRelabelAttempted(
  deps: ProcessLocalityRelabelDeps,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await deps.db
    .update(heatmapCompetitorSnapshots)
    .set({ competitorLocalityRelabelAttemptedAt: new Date() })
    .where(
      and(
        inArray(heatmapCompetitorSnapshots.id, ids),
        isNull(heatmapCompetitorSnapshots.competitorLocalityRelabelAttemptedAt),
      ),
    );
}
