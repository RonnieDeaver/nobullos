// @db-pool-intent: ambient
/**
 * Shared core for the "backfill client_id on unlinked heatmap snapshots"
 * prod-action (Task #2895).
 *
 * Background
 * ----------
 * `heatmap_snapshots.client_id` is nullable; snapshots imported before the
 * import path wired the client link show "No client linked" in the Browse
 * tab. Most of those rows CAN be linked deterministically: the snapshot
 * carries the SEMrush `campaign_id`, and the campaign → client binding
 * already exists in two places:
 *   - `semrush_location_campaigns` (client_id, location_id, semrush_campaign_id)
 *   - `client_semrush_integrations` (client_id, semrush_campaign_id)
 *
 * Matching rule (deliberately conservative — mirrors the "GBP
 * report-location ghosts" decision: surface, never guess):
 *   - Union both binding tables into (campaign_id → client_id) pairs.
 *   - A campaign is UNAMBIGUOUS iff exactly ONE distinct client_id claims
 *     it across both tables. Only those snapshots are stamped.
 *   - Campaigns claimed by 2+ clients (ambiguous) or by no client
 *     (unmatched) leave their snapshots NULL; the prod-action's status
 *     surfaces those counts to the operator instead of guessing.
 *
 * Convergence
 * -----------
 * `countPending` counts only the RESOLVABLE rows (NULL client_id AND an
 * unambiguous campaign match), so ambiguous/unmatched rows never keep the
 * action pending forever (memory "Prod-action convergence"). The UPDATE's
 * WHERE re-checks `client_id IS NULL`, so re-running is a no-op against
 * already-stamped rows, and if a new binding later makes a campaign
 * resolvable the same action picks it up on the next press.
 */
import { sql } from "drizzle-orm";

/** Drizzle handle that supports `.execute(sql)` — `api` or `worker` pool. */
export type BackfillDb = ReturnType<typeof import("../db")["getDb"]>;

/** Rows stamped per background-drain chunk. */
export const HEATMAP_CLIENT_BACKFILL_BATCH = 5000;

/**
 * (campaign_id → single client_id) mapping across BOTH binding tables,
 * restricted to campaigns claimed by exactly one distinct client. Inlined
 * into each query below so count and update share one predicate.
 */
const UNAMBIGUOUS_MAPPING_CTE = sql`
  SELECT campaign_id, MIN(client_id) AS client_id
  FROM (
    SELECT semrush_campaign_id AS campaign_id, client_id
    FROM semrush_location_campaigns
    WHERE semrush_campaign_id IS NOT NULL
    UNION
    SELECT semrush_campaign_id AS campaign_id, client_id
    FROM client_semrush_integrations
    WHERE semrush_campaign_id IS NOT NULL
  ) u
  GROUP BY campaign_id
  HAVING COUNT(DISTINCT client_id) = 1
`;

/**
 * Task #4054 — ingest-time client resolution for NEW heatmap snapshots,
 * sharing the exact backfill matching rule above so the import path and the
 * backfill can never disagree. Returns the single unambiguous client_id for
 * `campaignId`, or null when the campaign is ambiguous (2+ clients) or
 * unmatched (no binding). Callers treat null as "leave the snapshot's
 * client_id NULL" — the same conservative surface-never-guess behavior as
 * the backfill. Never throws for the caller's benefit would be wrong here:
 * callers wrap it best-effort so a resolution blip degrades to NULL (the
 * pre-#4054 behavior) instead of failing the import.
 */
export async function resolveUnambiguousClientForCampaign(
  db: BackfillDb,
  campaignId: string | null | undefined,
): Promise<string | null> {
  if (!campaignId) return null;
  const res = await db.execute(sql`
    WITH mapping AS (${UNAMBIGUOUS_MAPPING_CTE})
    SELECT client_id FROM mapping WHERE campaign_id = ${campaignId} LIMIT 1
  `);
  const rows = (res as { rows?: any[] }).rows ?? (res as any);
  const cid = rows?.[0]?.client_id;
  return typeof cid === "string" && cid.length > 0 ? cid : null;
}

/**
 * Count NULL-client snapshots whose campaign resolves unambiguously —
 * the drain's `countPending`.
 */
export async function countBackfillableNullClientSnapshots(
  db: BackfillDb,
): Promise<number> {
  const res = await db.execute(sql`
    WITH mapping AS (${UNAMBIGUOUS_MAPPING_CTE})
    SELECT COUNT(*)::int AS n
    FROM heatmap_snapshots s
    JOIN mapping m ON m.campaign_id = s.campaign_id
    WHERE s.client_id IS NULL
  `);
  const rows = (res as { rows?: any[] }).rows ?? (res as any);
  return Number(rows?.[0]?.n ?? 0);
}

export interface NullClientSnapshotSummary {
  /** NULL-client rows with exactly one candidate client — will be stamped. */
  resolvable: number;
  /** NULL-client rows whose campaign is claimed by 2+ clients — left NULL, surfaced. */
  ambiguous: number;
  /** NULL-client rows whose campaign has no client binding at all — left NULL, surfaced. */
  unmatched: number;
}

/**
 * Classify every NULL-client snapshot into resolvable / ambiguous /
 * unmatched for the status() detail, in one aggregate pass.
 */
export async function summarizeNullClientSnapshots(
  db: BackfillDb,
): Promise<NullClientSnapshotSummary> {
  const res = await db.execute(sql`
    WITH candidates AS (
      SELECT campaign_id, COUNT(DISTINCT client_id)::int AS n_clients
      FROM (
        SELECT semrush_campaign_id AS campaign_id, client_id
        FROM semrush_location_campaigns
        WHERE semrush_campaign_id IS NOT NULL
        UNION
        SELECT semrush_campaign_id AS campaign_id, client_id
        FROM client_semrush_integrations
        WHERE semrush_campaign_id IS NOT NULL
      ) u
      GROUP BY campaign_id
    )
    SELECT
      COUNT(*) FILTER (WHERE c.n_clients = 1)::int AS resolvable,
      COUNT(*) FILTER (WHERE c.n_clients > 1)::int AS ambiguous,
      COUNT(*) FILTER (WHERE c.campaign_id IS NULL)::int AS unmatched
    FROM heatmap_snapshots s
    LEFT JOIN candidates c ON c.campaign_id = s.campaign_id
    WHERE s.client_id IS NULL
  `);
  const rows = (res as { rows?: any[] }).rows ?? (res as any);
  const r = rows?.[0] ?? {};
  return {
    resolvable: Number(r.resolvable ?? 0),
    ambiguous: Number(r.ambiguous ?? 0),
    unmatched: Number(r.unmatched ?? 0),
  };
}

/**
 * Stamp up to `limit` resolvable NULL-client snapshots with their
 * unambiguous client. Returns rows updated. Idempotent: the target
 * subquery and the outer UPDATE both require `client_id IS NULL`, so a
 * re-run never restamps or overwrites an existing link.
 * FOR UPDATE SKIP LOCKED keeps concurrent chunks (or a concurrent import
 * touching the same rows) from blocking; a skipped row is simply picked
 * up by a later chunk.
 */
export async function backfillHeatmapSnapshotClientBatch(
  db: BackfillDb,
  limit: number = HEATMAP_CLIENT_BACKFILL_BATCH,
): Promise<number> {
  const res = await db.execute(sql`
    WITH mapping AS (${UNAMBIGUOUS_MAPPING_CTE}),
    target AS (
      SELECT s.id, m.client_id
      FROM heatmap_snapshots s
      JOIN mapping m ON m.campaign_id = s.campaign_id
      WHERE s.client_id IS NULL
      ORDER BY s.id
      LIMIT ${limit}
      FOR UPDATE OF s SKIP LOCKED
    )
    UPDATE heatmap_snapshots hs
    SET client_id = target.client_id
    FROM target
    WHERE hs.id = target.id
      AND hs.client_id IS NULL
  `);
  return (res as { rowCount?: number }).rowCount ?? 0;
}
