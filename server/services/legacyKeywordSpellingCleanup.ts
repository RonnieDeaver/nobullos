// @db-pool-intent: ambient
/**
 * Shared core for the "clean up legacy non-canonical keyword spellings"
 * backfill (Task #2476).
 *
 * Background
 * ----------
 * `heatmap_snapshots.keyword_name` is the SEMrush keyword a snapshot was
 * captured for. SEMrush's API and operator-managed campaign keyword lists
 * are inconsistent about casing and whitespace ("Immigration Attorney",
 * "immigration  attorney", "  plumber  "). The write path normalizes every
 * keyword through `normalizeKeyword()` (trim, collapse internal whitespace,
 * lowercase) before insert, and migration 0061 added a CHECK constraint
 * (`heatmap_snapshots_keyword_name_canonical_chk`) that forces canonical
 * spellings going forward. Task #2451 fixed the read-path *display* so the
 * same keyword stored under inconsistent legacy spellings collapses to a
 * single pill — but it did NOT rewrite the underlying rows.
 *
 * Any legacy non-canonical `keyword_name` values that predate the constraint
 * still sit in production. Normalizing them once means the data itself is
 * clean (not just the view), keeping SoV / coverage math consistent for
 * anything that groups by raw keyword in the future.
 *
 * This module is the single source of truth for that rewrite, shared
 * verbatim by two callers:
 *   - `scripts/cleanup-legacy-keyword-spellings.ts` (CLI, dry-run by
 *     default) — for ad-hoc inspection against an explicit `DATABASE_URL`.
 *   - the `cleanup_legacy_keyword_spellings` CEO prod-action in
 *     `prodActionsRegistry.ts` — one-press worker-pool background drain
 *     against the deployed database (dev can only READ prod, so a CLI run
 *     in dev changes nothing real — see memory "Backfill from
 *     read-only-prod dev").
 *
 * Canonical form
 * --------------
 * The SQL expression below mirrors `normalizeKeyword` in
 * `shared/keywordNormalization.ts` EXACTLY: trim leading/trailing
 * whitespace, collapse runs of internal whitespace to a single ASCII
 * space, lowercase. It is also identical to the expression migration 0061
 * uses for both its cleanup UPDATE and its CHECK constraint. If
 * `normalizeKeyword` ever changes, this expression AND the migration's
 * constraint must change in lockstep.
 */
import { sql, type SQL } from "drizzle-orm";

/** Drizzle handle that supports `.execute(sql)` — `api` or `worker` pool. */
export type CleanupDb = ReturnType<typeof import("../db")["getDb"]>;

/** The name of the canonical CHECK constraint added by migration 0061. */
export const CANONICAL_KEYWORD_CONSTRAINT_NAME =
  "heatmap_snapshots_keyword_name_canonical_chk";

/**
 * Canonical-form SQL expression over `heatmap_snapshots.keyword_name`,
 * byte-for-byte the same as migration 0061 and `normalizeKeyword`.
 * `'\\s+'` in this template literal yields the SQL string `'\s+'`.
 */
const CANONICAL_EXPR: SQL = sql`lower(regexp_replace(btrim(keyword_name), '\\s+', ' ', 'g'))`;

/** Default rewrite chunk size for the background drain. */
export const KEYWORD_SPELLING_CLEANUP_BATCH = 5000;

/**
 * Count `heatmap_snapshots` rows whose `keyword_name` is not already
 * canonical. Cheap aggregate; the predicate matches the rewrite below.
 */
export async function countNonCanonicalKeywordSnapshots(
  db: CleanupDb,
): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM heatmap_snapshots
    WHERE keyword_name <> ${CANONICAL_EXPR}
  `);
  const rows = (res as { rows?: any[] }).rows ?? (res as any);
  return Number(rows?.[0]?.n ?? 0);
}

/**
 * Rewrite up to `limit` non-canonical `heatmap_snapshots` rows to their
 * canonical `keyword_name`. Returns the number of rows updated. Idempotent:
 * the WHERE clause only ever matches still-non-canonical rows, so a re-run
 * against an already-clean table is a no-op (0 rows).
 *
 * This is a pure rename of the column — it never merges rows.
 * `heatmap_snapshots` has no UNIQUE constraint on
 * (campaignId, locationId, keywordName, reportDate), so the UPDATE cannot
 * collide; downstream charts that GROUP BY `keyword_name` naturally
 * aggregate the previously-duplicate rows afterwards.
 */
export async function rewriteNonCanonicalKeywordBatch(
  db: CleanupDb,
  limit: number = KEYWORD_SPELLING_CLEANUP_BATCH,
): Promise<number> {
  const res = await db.execute(sql`
    UPDATE heatmap_snapshots AS hs
    SET keyword_name = ${CANONICAL_EXPR}
    FROM (
      SELECT id
      FROM heatmap_snapshots
      WHERE keyword_name <> ${CANONICAL_EXPR}
      ORDER BY id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) AS target
    WHERE hs.id = target.id
  `);
  return (res as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Returns true iff the canonical CHECK constraint added by migration 0061
 * is present on `heatmap_snapshots`. Postgres has no
 * `ADD CONSTRAINT IF NOT EXISTS`, so callers gate the add on this check.
 */
export async function isCanonicalKeywordConstraintPresent(
  db: CleanupDb,
): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1
    FROM pg_constraint
    WHERE conname = ${CANONICAL_KEYWORD_CONSTRAINT_NAME}
      AND conrelid = 'heatmap_snapshots'::regclass
  `);
  const rows = (res as { rows?: any[] }).rows ?? (res as any);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Add the canonical CHECK constraint if it is missing, making the invariant
 * durable at the database level so a future code path or hand-written
 * backfill cannot silently reintroduce a non-canonical spelling. Safe to
 * call only AFTER every row is canonical (the constraint validates existing
 * rows on add). Mirrors migration 0061's constraint expression exactly.
 * Idempotent: a no-op when the constraint already exists.
 */
export async function ensureCanonicalKeywordConstraint(
  db: CleanupDb,
): Promise<boolean> {
  if (await isCanonicalKeywordConstraintPresent(db)) return false;
  await db.execute(sql`
    ALTER TABLE heatmap_snapshots
      ADD CONSTRAINT ${sql.raw(CANONICAL_KEYWORD_CONSTRAINT_NAME)}
      CHECK (keyword_name = ${CANONICAL_EXPR})
  `);
  return true;
}
