// @db-pool-intent: ambient
/**
 * Shared core for the "sanitize previously saved link-preview asset URLs"
 * prod-action (Task #3413).
 *
 * Background
 * ----------
 * Task #3300 added `sanitizeAssetUrl` so NEW link-preview og:image /
 * favicon URLs must be https and resolve only to public addresses before
 * they are stored. Rows persisted BEFORE that fix — in
 * `comms_link_previews.image_url` / `favicon_url` and in preview payloads
 * already patched into `comms_messages.metadata.linkPreviews` — can still
 * hold http:// or private-IP asset URLs that logged-in browsers would
 * load (client-side SSRF probe vector).
 *
 * This module is the pure, db-injected core the prod-action drives: it
 * scans both surfaces in id-keyset chunks, re-runs `sanitizeAssetUrl`
 * over every stored asset URL, and NULLs the ones that fail. Writes are
 * single-row UPDATEs guarded by a still-equals check, so re-running is a
 * no-op against already-cleaned rows (idempotent).
 *
 * Convergence (memory "Prod-action convergence")
 * ----------------------------------------------
 * `sanitizeAssetUrl` needs a DNS lookup, so "is this row clean?" cannot
 * be decided in SQL alone. The action's `countPending` therefore counts:
 *   (statically-detectable bad rows: non-https or literal private-IP
 *    host, cheap SQL regex)  +  (1 if the one-time full DNS pass has not
 *    yet been stamped in `system_settings`).
 * The drain runs the full pass (which also catches hostnames that only
 * DNS reveals as private), then writes the stamp
 * `link_preview_sanitize_backfill_done_v1` as its final unit of work —
 * so after one press the action settles to `not-needed` instead of
 * re-DNS-scanning the whole table on every status poll.
 */
import { sql } from "drizzle-orm";
import { sanitizeAssetUrl } from "./commsUnfurl";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

/** Drizzle handle that supports `.execute(sql)` — `api` or `worker` pool. */
export type BackfillDb = ReturnType<typeof import("../db")["getDb"]>;

/** Rows scanned per background-drain chunk (each row may need DNS lookups). */
export const LINK_PREVIEW_SANITIZE_BATCH = 50;

/**
 * One-time completion stamp (system_settings key). Value = ISO timestamp
 * of the pass that finished. Presence means the full DNS pass has run at
 * least once since the sanitizer shipped, so `countPending` no longer
 * charges the +1 "full pass owed" unit.
 */
export const LINK_PREVIEW_SANITIZE_STAMP_KEY =
  "link_preview_sanitize_backfill_done_v1";

/**
 * SQL regex fragment matching asset URLs that are BAD without needing
 * DNS: not https, or an https URL whose host is a literal loopback /
 * RFC-1918 / link-local / CGNAT / localhost address. Mirrors the literal
 * subset of `BLOCKED_PATTERNS` in commsUnfurl.ts; hostnames that merely
 * RESOLVE to private IPs are only caught by the full pass.
 */
const STATIC_BAD_URL_REGEX =
  "^(?!https://)|^https://(localhost|127\\.|10\\.|192\\.168\\.|169\\.254\\.|0\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|\\[?::1)";

// Postgres regexes have no lookahead; express "not https" separately.
const badUrlPredicate = (col: string) => sql`
  (${sql.raw(col)} IS NOT NULL AND (
    ${sql.raw(col)} !~* '^https://'
    OR ${sql.raw(col)} ~* '^https://(localhost|127\\.|10\\.|192\\.168\\.|169\\.254\\.|0\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|\\[?::1)'
  ))
`;
void STATIC_BAD_URL_REGEX; // documented above; predicate built inline

function rowsOf(res: unknown): any[] {
  // Memory "Drizzle db.execute raw pg QueryResult": raw path returns a
  // pg QueryResult — read `.rows`, never index the result directly.
  return ((res as { rows?: any[] }).rows ?? (res as any)) as any[];
}

/**
 * Count `comms_link_previews` rows holding a statically-detectable bad
 * image_url or favicon_url (cheap, no DNS).
 */
export async function countStaticallyBadLinkPreviewRows(
  db: BackfillDb,
): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM comms_link_previews
    WHERE ${badUrlPredicate("image_url")} OR ${badUrlPredicate("favicon_url")}
  `);
  return Number(rowsOf(res)?.[0]?.n ?? 0);
}

/**
 * Count `comms_messages` rows whose `metadata.linkPreviews` array holds a
 * statically-detectable bad imageUrl or faviconUrl (cheap, no DNS).
 */
export async function countStaticallyBadMessagePreviewRows(
  db: BackfillDb,
): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM comms_messages m
    WHERE m.metadata IS NOT NULL
      AND jsonb_typeof(m.metadata -> 'linkPreviews') = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(m.metadata -> 'linkPreviews') p
        WHERE ${badUrlPredicate("(p ->> 'imageUrl')")}
           OR ${badUrlPredicate("(p ->> 'faviconUrl')")}
      )
  `);
  return Number(rowsOf(res)?.[0]?.n ?? 0);
}

/** Is the one-time full-pass stamp present? */
export async function isSanitizeBackfillStamped(): Promise<boolean> {
  const row = await getSystemSetting(LINK_PREVIEW_SANITIZE_STAMP_KEY);
  return Boolean(row?.value);
}

/** Write the one-time full-pass stamp (ISO timestamp of completion). */
export async function stampSanitizeBackfillDone(): Promise<void> {
  await setSystemSetting(
    LINK_PREVIEW_SANITIZE_STAMP_KEY,
    new Date().toISOString(),
  );
}

export type SanitizeFn = (raw: string | null) => Promise<string | null>;

export interface SanitizeChunkResult {
  /** Rows scanned this chunk (drives keyset progress). */
  scanned: number;
  /** Rows where at least one asset URL was nulled. */
  cleaned: number;
  /** Keyset cursor for the next chunk; null when this surface is exhausted. */
  nextCursor: string | null;
}

/**
 * Scan the next `limit` `comms_link_previews` rows (id > cursor) that
 * carry any asset URL, sanitize both URLs, and NULL failures.
 * Idempotent: the UPDATE re-checks the column still holds the exact
 * value we sanitized, so a concurrent re-unfurl is never clobbered and
 * re-runs are no-ops.
 */
export async function sanitizeLinkPreviewRowsChunk(
  db: BackfillDb,
  cursor: string | null,
  limit: number = LINK_PREVIEW_SANITIZE_BATCH,
  sanitize: SanitizeFn = sanitizeAssetUrl,
): Promise<SanitizeChunkResult> {
  const res = await db.execute(sql`
    SELECT id, image_url, favicon_url
    FROM comms_link_previews
    WHERE (image_url IS NOT NULL OR favicon_url IS NOT NULL)
      AND (${cursor === null ? sql`TRUE` : sql`id > ${cursor}`})
    ORDER BY id
    LIMIT ${limit}
  `);
  const rows = rowsOf(res);
  if (!rows || rows.length === 0) {
    return { scanned: 0, cleaned: 0, nextCursor: null };
  }
  let cleaned = 0;
  for (const row of rows) {
    const id = String(row.id);
    const imageUrl = (row.image_url ?? null) as string | null;
    const faviconUrl = (row.favicon_url ?? null) as string | null;
    // DNS lookups happen here, OUTSIDE any DB hold (each statement below
    // is its own short query — no transaction spans the network calls).
    const safeImage = imageUrl === null ? null : await sanitize(imageUrl);
    const safeFavicon = faviconUrl === null ? null : await sanitize(faviconUrl);
    const imageBad = imageUrl !== null && safeImage === null;
    const faviconBad = faviconUrl !== null && safeFavicon === null;
    if (!imageBad && !faviconBad) continue;
    const upd = await db.execute(sql`
      UPDATE comms_link_previews
      SET image_url = CASE WHEN ${imageBad} AND image_url = ${imageUrl} THEN NULL ELSE image_url END,
          favicon_url = CASE WHEN ${faviconBad} AND favicon_url = ${faviconUrl} THEN NULL ELSE favicon_url END
      WHERE id = ${id}
        AND ((${imageBad} AND image_url = ${imageUrl})
          OR (${faviconBad} AND favicon_url = ${faviconUrl}))
    `);
    if (((upd as { rowCount?: number }).rowCount ?? 0) > 0) cleaned++;
  }
  const nextCursor =
    rows.length < limit ? null : String(rows[rows.length - 1].id);
  return { scanned: rows.length, cleaned, nextCursor };
}

/**
 * Scan the next `limit` `comms_messages` rows (id > cursor) carrying a
 * `metadata.linkPreviews` array, sanitize every preview's imageUrl /
 * faviconUrl, and rewrite the array with failures nulled. The write is a
 * single-key jsonb merge (mirrors `setMessageLinkPreviews`) so other
 * metadata keys are preserved, and it is guarded by a still-equals check
 * on the previews array so a concurrent re-unfurl is never clobbered.
 */
export async function sanitizeMessagePreviewsChunk(
  db: BackfillDb,
  cursor: string | null,
  limit: number = LINK_PREVIEW_SANITIZE_BATCH,
  sanitize: SanitizeFn = sanitizeAssetUrl,
): Promise<SanitizeChunkResult> {
  const res = await db.execute(sql`
    SELECT id, metadata -> 'linkPreviews' AS previews
    FROM comms_messages
    WHERE metadata IS NOT NULL
      AND jsonb_typeof(metadata -> 'linkPreviews') = 'array'
      AND (${cursor === null ? sql`TRUE` : sql`id > ${cursor}`})
    ORDER BY id
    LIMIT ${limit}
  `);
  const rows = rowsOf(res);
  if (!rows || rows.length === 0) {
    return { scanned: 0, cleaned: 0, nextCursor: null };
  }
  let cleaned = 0;
  for (const row of rows) {
    const id = String(row.id);
    const previews = row.previews;
    if (!Array.isArray(previews)) continue;
    let changed = false;
    const next: any[] = [];
    for (const p of previews) {
      if (!p || typeof p !== "object") {
        next.push(p);
        continue;
      }
      const out = { ...p };
      const imageUrl = typeof p.imageUrl === "string" ? p.imageUrl : null;
      const faviconUrl = typeof p.faviconUrl === "string" ? p.faviconUrl : null;
      if (imageUrl !== null && (await sanitize(imageUrl)) === null) {
        out.imageUrl = null;
        changed = true;
      }
      if (faviconUrl !== null && (await sanitize(faviconUrl)) === null) {
        out.faviconUrl = null;
        changed = true;
      }
      next.push(out);
    }
    if (!changed) continue;
    const upd = await db.execute(sql`
      UPDATE comms_messages
      SET metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object('linkPreviews', ${JSON.stringify(next)}::jsonb)
      WHERE id = ${id}
        AND metadata -> 'linkPreviews' = ${JSON.stringify(previews)}::jsonb
    `);
    if (((upd as { rowCount?: number }).rowCount ?? 0) > 0) cleaned++;
  }
  const nextCursor =
    rows.length < limit ? null : String(rows[rows.length - 1].id);
  return { scanned: rows.length, cleaned, nextCursor };
}
