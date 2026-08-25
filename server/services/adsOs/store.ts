// @db-pool-intent: api
/**
 * Ads OS — jsonb document store (spec §7).
 *
 * One collection per spec §7 table. Interface: get(key) / put(key, data).
 * Keys are digits-only CIDs; alerts/tickets keyed "{product}:{cid}".
 *
 * Best-effort writes: log-and-swallow except read-modify-write paths, which
 * lock per key (Postgres advisory lock via pg_try_advisory_xact_lock) and
 * fail loudly on a failed read so they can't clobber sibling entries.
 *
 * Table DDL lives in migrations/0136_ads_os_stores.sql.
 */

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import { bindArrayParam } from "../../utils/sqlArray";
import {
  ensureAdsOsStoreTablesForSelfHeal,
  isMissingRelationError,
  recordStoreFailure,
  recordStoreSuccess,
} from "./storeSchema";

// ---------------------------------------------------------------------------
// Core get/put
// ---------------------------------------------------------------------------

/**
 * Run one store operation with health tracking + missing-table self-heal
 * (Task #3706): success/failure feeds the store health signal shown on the
 * dashboards; a "relation does not exist" failure triggers the idempotent
 * table ensure and ONE retry, so a wiped/reset DB heals on first touch
 * instead of silently blanking the subsystem. Throws on final failure —
 * callers decide whether to swallow (best-effort paths) or surface (strict
 * paths like criteria saves).
 */
async function runStoreOp<T>(op: () => Promise<T>): Promise<T> {
  try {
    const out = await op();
    recordStoreSuccess();
    return out;
  } catch (err: any) {
    recordStoreFailure(err);
    if (!isMissingRelationError(err)) throw err;
    // Structural: the store tables are gone. Recreate + retry once.
    await ensureAdsOsStoreTablesForSelfHeal();
    const out = await op();
    recordStoreSuccess();
    return out;
  }
}

async function storeGet(table: string, key: string): Promise<Record<string, any> | null> {
  try {
    return await runStoreOp(() =>
      withDbAttribution(`ads-os:store:get:${table}`, async () => {
        const db = getDb();
        const res = await db.execute(sql`
          SELECT data FROM ${sql.raw(table)} WHERE key = ${key}
        `);
        const row = res.rows?.[0] as { data: any } | undefined;
        if (!row) return null;
        const data = row.data;
        return typeof data === "string" ? JSON.parse(data) : (data as Record<string, any>);
      }),
    );
  } catch (err: any) {
    console.warn(`[AdsOs/store] get ${table}/${key} failed:`, err?.message ?? err);
    return null;
  }
}

/** Strict upsert — throws on failure (after the self-heal retry). Criteria
 *  saves use this so an "Edit criteria" save can never report ok without
 *  actually persisting (Task #3706). */
async function storePutStrict(table: string, key: string, data: Record<string, any>): Promise<void> {
  await runStoreOp(() =>
    withDbAttribution(`ads-os:store:put:${table}`, async () => {
      const db = getDb();
      const dataJson = JSON.stringify(data);
      await db.execute(sql`
        INSERT INTO ${sql.raw(table)} (key, data, updated_at)
        VALUES (${key}, ${dataJson}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE
          SET data = EXCLUDED.data,
              updated_at = EXCLUDED.updated_at
      `);
    }),
  );
}

async function storePut(table: string, key: string, data: Record<string, any>): Promise<void> {
  try {
    await storePutStrict(table, key, data);
  } catch (err: any) {
    // Best-effort: log and swallow (spec §7).
    console.warn(`[AdsOs/store] put ${table}/${key} failed:`, err?.message ?? err);
  }
}

// ---------------------------------------------------------------------------
// Score history (append-only trail inside the same jsonb doc)
// ---------------------------------------------------------------------------

/** Compact per-run snapshot kept in the doc's `history` array (oldest→newest). */
export interface ScoreHistoryEntry {
  final_score: number;
  band: string;
  generated_at: string;
}

export const SCORE_HISTORY_MAX = 12;

/**
 * Upsert a score doc while appending a compact {final_score, band, generated_at}
 * snapshot to the doc's `history` array, trimmed to the newest SCORE_HISTORY_MAX
 * entries. The append happens inside the single UPSERT statement so concurrent
 * runs can't clobber each other's history (no read-modify-write window).
 */
async function storePutWithHistory(
  table: string,
  key: string,
  data: Record<string, any>,
): Promise<void> {
  const snapshot: ScoreHistoryEntry = {
    final_score: data.final_score,
    band: data.band,
    generated_at: data.generated_at,
  };
  try {
    await runStoreOp(() =>
      withDbAttribution(`ads-os:store:put:${table}`, async () => {
      const db = getDb();
      // Insert path seeds history with just this snapshot; conflict path
      // recomputes it from the stored trail + the new entry.
      const dataJson = JSON.stringify({ ...data, history: [snapshot] });
      await db.execute(sql`
        INSERT INTO ${sql.raw(table)} (key, data, updated_at)
        VALUES (${key}, ${dataJson}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE
          SET data = EXCLUDED.data || jsonb_build_object('history', (
                SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
                FROM (
                  SELECT elem, ord
                  FROM jsonb_array_elements(
                    COALESCE(${sql.raw(table)}.data->'history', '[]'::jsonb)
                      || (EXCLUDED.data->'history')
                  ) WITH ORDINALITY AS x(elem, ord)
                  ORDER BY ord DESC
                  LIMIT ${sql.raw(String(SCORE_HISTORY_MAX))}
                ) trimmed
              )),
              updated_at = EXCLUDED.updated_at
      `);
      }),
    );
  } catch (err: any) {
    // Best-effort: log and swallow (spec §7), same as storePut.
    console.warn(`[AdsOs/store] put+history ${table}/${key} failed:`, err?.message ?? err);
  }
}

/**
 * Read the score history for a key, newest first, capped at `limit`
 * (≤ SCORE_HISTORY_MAX). Docs written before history existed synthesize a
 * single entry from their own top-level score fields.
 */
async function storeGetHistory(
  table: string,
  key: string,
  limit: number,
): Promise<ScoreHistoryEntry[]> {
  const doc = await storeGet(table, key);
  if (!doc) return [];
  const raw: any[] = Array.isArray(doc.history) ? doc.history : [];
  let entries = raw.filter(
    (e) => e && typeof e.final_score === "number" && typeof e.generated_at === "string",
  ) as ScoreHistoryEntry[];
  if (entries.length === 0 && typeof doc.final_score === "number" && doc.generated_at) {
    entries = [{ final_score: doc.final_score, band: doc.band, generated_at: doc.generated_at }];
  }
  const cap = Math.max(1, Math.min(limit, SCORE_HISTORY_MAX));
  // Stored oldest→newest; return newest first.
  return entries.slice(-cap).reverse();
}

// ---------------------------------------------------------------------------
// Collection factory
// ---------------------------------------------------------------------------

export interface AdsOsCollection {
  get(key: string): Promise<Record<string, any> | null>;
  put(key: string, data: Record<string, any>): Promise<void>;
}

/** Every table name a collection was created for. Tests assert this set
 *  equals storeSchema.ADS_OS_STORE_TABLES so a future collection can't be
 *  added without also being covered by the boot ensure (Task #3706). */
export const REGISTERED_STORE_TABLES = new Set<string>();

function makeCollection(table: string): AdsOsCollection {
  REGISTERED_STORE_TABLES.add(table);
  return {
    get: (key) => storeGet(table, key),
    put: (key, data) => storePut(table, key, data),
  };
}

function normCid(customerId: string): string {
  return customerId.replace(/[^0-9]/g, "");
}

function alertKey(product: string, customerId: string): string {
  return `${product}:${normCid(customerId)}`;
}

// ---------------------------------------------------------------------------
// Per-collection accessors (spec §7 names)
// ---------------------------------------------------------------------------

export const clientsCriteriaStore = makeCollection("ads_os_clients_criteria");
export const auditScoresStore = makeCollection("ads_os_audit_scores");
export const lsaAuditScoresStore = makeCollection("ads_os_lsa_audit_scores");
export const budgetPacingStore = makeCollection("ads_os_budget_pacing");
export const lsaBudgetPacingStore = makeCollection("ads_os_lsa_budget_pacing");
export const trafficQualityStore = makeCollection("ads_os_traffic_quality");
export const keywordActionedStore = makeCollection("ads_os_keyword_actioned");
export const pyramidBreakdownStore = makeCollection("ads_os_pyramid_breakdown");
export const accountAlertsStore = makeCollection("ads_os_account_alerts");
export const accountAlertsNotifiedStore = makeCollection("ads_os_account_alerts_notified");
export const clickupTasksStore = makeCollection("ads_os_clickup_tasks");
export const clientLogSummariesStore = makeCollection("ads_os_client_log_summaries");
export const statusChecksStore = makeCollection("ads_os_status_checks");

// ---------------------------------------------------------------------------
// Convenience wrappers with key normalization
// ---------------------------------------------------------------------------

export async function getCriteria(cid: string): Promise<Record<string, any> | null> {
  return clientsCriteriaStore.get(normCid(cid));
}
/**
 * Strict criteria read — throws on DB failure instead of returning null.
 * Use for migration/prod-action paths where a swallowed error must not be
 * mistaken for a genuinely absent document (Task #4818).
 */
export async function getCriteriaStrict(cid: string): Promise<Record<string, any> | null> {
  const normKey = normCid(cid);
  return runStoreOp(() =>
    withDbAttribution("ads-os:store:get:ads_os_clients_criteria", async () => {
      const db = getDb();
      const res = await db.execute(sql`
        SELECT data FROM ads_os_clients_criteria WHERE key = ${normKey}
      `);
      const row = res.rows?.[0] as { data: any } | undefined;
      if (!row) return null;
      const d = row.data;
      return typeof d === "string" ? JSON.parse(d) : (d as Record<string, any>);
    }),
  );
}

/**
 * Bounded strict key scan for fleet-level criteria maintenance.
 *
 * The caller supplies the maximum snapshot size. Reading one extra row lets
 * the operation fail explicitly instead of silently reconciling only a prefix
 * when the store grows beyond that reviewed bound.
 */
export async function listCriteriaKeysStrict(limit: number): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Criteria key scan limit must be a positive safe integer.");
  }
  return runStoreOp(() =>
    withDbAttribution("ads-os:store:list:ads_os_clients_criteria", async () => {
      const db = getDb();
      const res = await db.execute(sql`
        SELECT key
        FROM ads_os_clients_criteria
        ORDER BY key ASC
        LIMIT ${limit + 1}
      `);
      const keys = (res.rows as Array<{ key: string }>).map((row) =>
        normCid(String(row.key ?? "")),
      );
      if (keys.length > limit) {
        throw new Error(
          `Criteria store exceeds the reconciliation safety bound of ${limit} documents.`,
        );
      }
      return keys.filter(Boolean);
    }),
  );
}

export type PracticeAreaCriteriaPatchResult =
  | "updated"
  | "seeded"
  | "skipped-match"
  | "skipped-absent-empty";

/**
 * Atomically replace only the authoritative Practice Area mirror and its JSON
 * timestamp. The conflict path merges into the currently stored JSONB inside
 * Postgres, so an operator's concurrent edits to every sibling key survive.
 * An absent row is inserted only for a non-empty authoritative selection.
 */
export async function patchCriteriaPracticeAreasStrict(
  cid: string,
  labels: string[],
  updatedAt: Date,
): Promise<PracticeAreaCriteriaPatchResult> {
  const normKey = normCid(cid);
  const labelsJson = JSON.stringify(labels);
  const updatedAtIso = updatedAt.toISOString();
  return runStoreOp(() =>
    withDbAttribution("ads-os:store:patch-practice-areas", async () => {
      const db = getDb();
      if (labels.length === 0) {
        const updated = await db.execute(sql`
          UPDATE ads_os_clients_criteria
          SET data = data || jsonb_build_object(
                'practice_areas', ${labelsJson}::jsonb,
                'updated_at', ${updatedAtIso}::text
              ),
              updated_at = NOW()
          WHERE key = ${normKey}
            AND data->'practice_areas' IS DISTINCT FROM ${labelsJson}::jsonb
          RETURNING key
        `);
        return (updated.rows as any[]).length > 0
          ? "updated"
          : (await getCriteriaStrict(normKey)) === null
            ? "skipped-absent-empty"
            : "skipped-match";
      }

      const patched = await db.execute(sql`
        INSERT INTO ads_os_clients_criteria (key, data, updated_at)
        VALUES (
          ${normKey},
          jsonb_build_object(
            'practice_areas', ${labelsJson}::jsonb,
            'updated_at', ${updatedAtIso}::text
          ),
          NOW()
        )
        ON CONFLICT (key) DO UPDATE
          SET data = ads_os_clients_criteria.data || jsonb_build_object(
                'practice_areas', ${labelsJson}::jsonb,
                'updated_at', ${updatedAtIso}::text
              ),
              updated_at = EXCLUDED.updated_at
          WHERE ads_os_clients_criteria.data->'practice_areas'
                IS DISTINCT FROM ${labelsJson}::jsonb
        RETURNING (xmax = 0) AS inserted
      `);
      const row = (patched.rows as Array<{ inserted: boolean }>)[0];
      if (!row) return "skipped-match";
      return row.inserted ? "seeded" : "updated";
    }),
  );
}
/** STRICT save (throws on failure): a criteria save must never report ok
 *  without persisting — the silent-swallow variant is only for derived data
 *  that a refresh can regenerate (Task #3706). */
export async function putCriteria(cid: string, data: Record<string, any>): Promise<void> {
  return storePutStrict("ads_os_clients_criteria", normCid(cid), data);
}

export async function putAuditScoreWithHistory(cid: string, data: Record<string, any>): Promise<void> {
  return storePutWithHistory("ads_os_audit_scores", normCid(cid), data);
}
export async function getAuditScoreHistory(cid: string, limit = SCORE_HISTORY_MAX): Promise<ScoreHistoryEntry[]> {
  return storeGetHistory("ads_os_audit_scores", normCid(cid), limit);
}
export async function putLsaAuditScoreWithHistory(cid: string, data: Record<string, any>): Promise<void> {
  return storePutWithHistory("ads_os_lsa_audit_scores", normCid(cid), data);
}
export async function getLsaAuditScoreHistory(cid: string, limit = SCORE_HISTORY_MAX): Promise<ScoreHistoryEntry[]> {
  return storeGetHistory("ads_os_lsa_audit_scores", normCid(cid), limit);
}

export async function getAlerts(product: string, cid: string): Promise<Record<string, any> | null> {
  return accountAlertsStore.get(alertKey(product, cid));
}
export async function putAlerts(product: string, cid: string, data: Record<string, any>): Promise<void> {
  return accountAlertsStore.put(alertKey(product, cid), data);
}

/**
 * Every requested account's alerts doc in ONE round trip (AM Dashboard,
 * Task #3988): per-account gets would be ~75 serial queries on the app's
 * daily entry point. Returns a map keyed "{product}:{digits-only cid}";
 * accounts with no stored doc are simply absent. Read-only and swallowing
 * (like storeGet): a store outage degrades the badges, never the page.
 */
export async function loadAlertsMap(
  pairs: ReadonlyArray<{ product: string; cid: string }>,
): Promise<Record<string, Record<string, any>>> {
  const keys = [...new Set(pairs.map((p) => alertKey(p.product, p.cid)))];
  if (keys.length === 0) return {};
  try {
    return await runStoreOp(() =>
      withDbAttribution("ads-os:store:bulk-get:ads_os_account_alerts", async () => {
        const db = getDb();
        const res = await db.execute(sql`
          SELECT key, data FROM ads_os_account_alerts
          WHERE key = ANY(${bindArrayParam(keys, "text")})
        `);
        const out: Record<string, Record<string, any>> = {};
        for (const row of (res.rows ?? []) as Array<{ key: string; data: any }>) {
          out[row.key] = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
        }
        return out;
      }),
    );
  } catch (err: any) {
    console.warn(`[AdsOs/store] bulk alerts read failed:`, err?.message ?? err);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Paused/Off status-verification batch (AM Dashboard, Task #3988)
// ---------------------------------------------------------------------------

/** The whole batch lives in ONE document so readers can't tear between the
 *  verdicts and their generated_at (they are presented as a single claim). */
const STATUS_CHECKS_DOC_KEY = "all";

/**
 * The current verification batch: {"checks": {"{product}:{cid}": entry},
 * "generated_at": iso}, or {} when none exists / the read fails (a failed
 * read logs and degrades to "never ran" — bare chips — never throws).
 */
export async function getStatusCheckDoc(): Promise<Record<string, any>> {
  const doc = await statusChecksStore.get(STATUS_CHECKS_DOC_KEY);
  return doc ?? {};
}

/**
 * Overwrite the verification batch. STRICT write reported as a boolean:
 * a failed save renders every chip bare — exactly like a run that never
 * happened — so callers (cron / AM Refresh) must be able to say "computed
 * but not persisted" instead of leaving it to a log nobody reads.
 */
export async function saveStatusChecks(doc: Record<string, any>): Promise<boolean> {
  try {
    await runStoreOp(() =>
      withDbAttribution("ads-os:store:put:ads_os_status_checks", async () => {
        const db = getDb();
        const dataJson = JSON.stringify(doc);
        await db.execute(sql`
          INSERT INTO ads_os_status_checks (key, data, updated_at)
          VALUES (${STATUS_CHECKS_DOC_KEY}, ${dataJson}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE
            SET data = EXCLUDED.data,
                updated_at = EXCLUDED.updated_at
        `);
      }),
    );
    return true;
  } catch (err: any) {
    console.error(`[AdsOs/store] status-checks save failed:`, err?.message ?? err);
    return false;
  }
}

export async function getClickupTaskDoc(product: string, cid: string): Promise<Record<string, any> | null> {
  return clickupTasksStore.get(alertKey(product, cid));
}
export async function putClickupTaskDoc(product: string, cid: string, data: Record<string, any>): Promise<void> {
  return clickupTasksStore.put(alertKey(product, cid), data);
}

/** Per-account "already notified" Slack fingerprint snapshot (alerts digest). */
export async function getNotified(product: string, cid: string): Promise<Set<string>> {
  const doc = await accountAlertsNotifiedStore.get(alertKey(product, cid));
  const arr = Array.isArray(doc?.fingerprints) ? doc!.fingerprints : [];
  return new Set(arr.map((v: any) => String(v)));
}
export async function putNotified(product: string, cid: string, fps: Set<string>): Promise<void> {
  return accountAlertsNotifiedStore.put(alertKey(product, cid), {
    fingerprints: [...fps].sort(),
    updated_at: new Date().toISOString(),
  });
}

/** Client-log AI summaries, keyed by Google Sheet id (~1-day TTL, checked by the reader). */
export async function getClientLogSummary(sheetId: string): Promise<Record<string, any> | null> {
  return clientLogSummariesStore.get(sheetId);
}
export async function putClientLogSummary(sheetId: string, data: Record<string, any>): Promise<void> {
  return clientLogSummariesStore.put(sheetId, data);
}

// ---------------------------------------------------------------------------
// Data freshness (Task #4000 — Integrations Hub "Ads OS" lane)
// ---------------------------------------------------------------------------

/**
 * The subset of Ads OS store tables whose rows are derived from a Google Ads
 * pull (morning refresh, on-demand tools, alert sweeps). Deliberately
 * excludes operator/bookkeeping tables (criteria edits, keyword actioning,
 * ClickUp docs, Slack-notified fingerprints, OpenAI log summaries) — those
 * update without any Google data flowing, so counting them would fake
 * "fresh Ads OS data" on the hub card.
 */
const ADS_OS_GOOGLE_DATA_TABLES = [
  "ads_os_audit_scores",
  "ads_os_lsa_audit_scores",
  "ads_os_budget_pacing",
  "ads_os_lsa_budget_pacing",
  "ads_os_traffic_quality",
  "ads_os_pyramid_breakdown",
  "ads_os_account_alerts",
  "ads_os_status_checks",
] as const;

/**
 * Latest `updated_at` across the Google-pull-derived store tables — the
 * "last successful Ads OS data pull" freshness signal for the Integrations
 * Hub lane. Read-only and best-effort: any failure degrades to null (the
 * lane shows no freshness this poll), never throws into the status route.
 */
export async function getLatestAdsOsDataUpdate(): Promise<Date | null> {
  try {
    return await runStoreOp(() =>
      withDbAttribution("ads-os:store:freshness", async () => {
        const db = getDb();
        const selects = ADS_OS_GOOGLE_DATA_TABLES.map(
          (t) => `SELECT MAX(updated_at) AS ts FROM ${t}`,
        ).join(" UNION ALL ");
        const res = await db.execute(sql.raw(`SELECT MAX(ts) AS latest FROM (${selects}) u`));
        const raw = (res.rows?.[0] as { latest: Date | string | null } | undefined)?.latest ?? null;
        if (!raw) return null;
        const d = raw instanceof Date ? raw : new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
      }),
    );
  } catch (err: any) {
    console.warn(`[AdsOs/store] freshness read failed:`, err?.message ?? err);
    return null;
  }
}
