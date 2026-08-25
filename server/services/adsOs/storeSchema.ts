// @db-pool-intent: api
/**
 * Ads OS — store schema self-heal + store health signal (Task #3706).
 *
 * Why this exists: every `ads_os_*` jsonb store table vanished from BOTH prod
 * and dev when the dev DB was replaced with a prod-shaped snapshot (the tables
 * were created by migrations/0136_ads_os_stores.sql via devMigrations, which
 * never runs in prod, and they are not in shared/schema.ts so `drizzle-kit
 * push` won't recreate them either). The store layer is best-effort
 * log-and-swallow, so the whole subsystem silently degraded: dashboard columns
 * rendered "—", criteria saves no-op'd, the morning refresh wrote nowhere.
 *
 * Two defenses live here:
 *
 *  1. `ensureAdsOsStoreTables()` — idempotent CREATE TABLE IF NOT EXISTS for
 *     every store table, mirroring 0136 exactly. Called at boot (server/index.ts
 *     Batch B, ALL environments) and as a runtime self-heal when a store op
 *     hits "relation does not exist" (store.ts retries the op once after).
 *
 *  2. Store health state — a loud, operator-facing signal that store access is
 *     structurally broken (missing tables, or persistent failures), surfaced on
 *     the Ads OS dashboards + /api/ads-os/status, so empty pacing columns are
 *     never indistinguishable from "no data yet". Individual row writes stay
 *     best-effort (spec §7).
 */

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";

/** Every jsonb store table owned by migrations/0136_ads_os_stores.sql — the
 *  single source of truth for the boot ensure. store.ts registers each
 *  collection it creates; a test asserts registrations ⊆ this list so a new
 *  collection can't silently miss the ensure. */
export const ADS_OS_STORE_TABLES = [
  "ads_os_clients_criteria",
  "ads_os_audit_scores",
  "ads_os_lsa_audit_scores",
  "ads_os_budget_pacing",
  "ads_os_lsa_budget_pacing",
  "ads_os_traffic_quality",
  "ads_os_keyword_actioned",
  "ads_os_pyramid_breakdown",
  "ads_os_account_alerts",
  "ads_os_account_alerts_notified",
  "ads_os_clickup_tasks",
  "ads_os_client_log_summaries",
  // Single-document Paused/Off verification batch (AM Dashboard, Task #3988).
  // Created by migrations/20260807095500_ads_os_status_checks.sql; listed here
  // so the boot ensure / self-heal covers it like the 0136 tables.
  "ads_os_status_checks",
] as const;

export type AdsOsStoreTable = (typeof ADS_OS_STORE_TABLES)[number];

// ---------------------------------------------------------------------------
// Store health state (per process — hydrates from real traffic + boot ensure)
// ---------------------------------------------------------------------------

/** Consecutive non-structural failures before the health flips to outage.
 *  A missing relation (42P01) flips it immediately — that's structural. */
export const STORE_FAILURE_THRESHOLD = 3;

export interface AdsOsStoreHealth {
  ok: boolean;
  /** "ok" | "missing_tables" | "errors" — what kind of outage (when !ok). */
  kind: "ok" | "missing_tables" | "errors";
  /** Human explanation for the dashboards' banner when !ok. */
  reason: string | null;
  consecutive_failures: number;
  last_error: string | null;
  last_error_at: string | null;
  last_ok_at: string | null;
}

const state: {
  kind: "ok" | "missing_tables" | "errors";
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
} = {
  kind: "ok",
  consecutiveFailures: 0,
  lastError: null,
  lastErrorAt: null,
  lastOkAt: null,
};

/** Postgres undefined_table — the structural "store is gone" signal. Drizzle/pg
 *  sometimes nests the driver error, so walk err/cause and match the message
 *  too. */
export function isMissingRelationError(err: unknown): boolean {
  let e: any = err;
  for (let depth = 0; e && depth < 5; depth++, e = e.cause) {
    if (e.code === "42P01") return true;
    const msg = String(e.message ?? "");
    if (/relation "[^"]*" does not exist/i.test(msg)) return true;
  }
  return false;
}

export function recordStoreSuccess(): void {
  state.kind = "ok";
  state.consecutiveFailures = 0;
  state.lastOkAt = new Date().toISOString();
}

export function recordStoreFailure(err: unknown): void {
  state.consecutiveFailures += 1;
  state.lastError = String((err as any)?.message ?? err);
  state.lastErrorAt = new Date().toISOString();
  if (isMissingRelationError(err)) {
    state.kind = "missing_tables"; // structural — flip immediately
  } else if (state.consecutiveFailures >= STORE_FAILURE_THRESHOLD && state.kind === "ok") {
    state.kind = "errors";
  }
}

export function getAdsOsStoreHealth(): AdsOsStoreHealth {
  const ok = state.kind === "ok";
  let reason: string | null = null;
  if (state.kind === "missing_tables") {
    reason =
      "The Ads OS store tables are missing from the database (self-heal failed or hasn't run). " +
      "Budget Pacing / Hygiene / Traffic Quality columns will be empty and criteria saves will fail " +
      `until the store is restored. Last error: ${state.lastError ?? "unknown"}`;
  } else if (state.kind === "errors") {
    reason =
      `Ads OS store reads/writes are failing (${state.consecutiveFailures} in a row). ` +
      "Pacing / Hygiene / Traffic Quality columns may be empty or stale. " +
      `Last error: ${state.lastError ?? "unknown"}`;
  }
  return {
    ok,
    kind: state.kind,
    reason,
    consecutive_failures: state.consecutiveFailures,
    last_error: state.lastError,
    last_error_at: state.lastErrorAt,
    last_ok_at: state.lastOkAt,
  };
}

/** Test hook: reset health to pristine. */
export function __testResetAdsOsStoreHealth(): void {
  state.kind = "ok";
  state.consecutiveFailures = 0;
  state.lastError = null;
  state.lastErrorAt = null;
  state.lastOkAt = null;
}

// ---------------------------------------------------------------------------
// Idempotent table ensure (mirrors migrations/0136_ads_os_stores.sql)
// ---------------------------------------------------------------------------

let ensureInFlight: Promise<void> | null = null;
let lastFailedEnsureAt = 0;
/** Self-heal retry cooldown after a FAILED ensure, so a hard DB outage doesn't
 *  add an ensure round trip to every swallowed store op. */
export const ENSURE_RETRY_COOLDOWN_MS = 30_000;

/**
 * Create any missing `ads_os_*` store tables (idempotent, single-flighted).
 * Same two-column jsonb shape as 0136. Throws when the DDL fails — boot wraps
 * it in a warn, the runtime self-heal path lets the original op error surface.
 */
export async function ensureAdsOsStoreTables(): Promise<void> {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = (async () => {
    try {
      await withDbAttribution("ads-os:store:ensure-tables", async () => {
        const db = getDb();
        for (const table of ADS_OS_STORE_TABLES) {
          await db.execute(
            sql.raw(
              `CREATE TABLE IF NOT EXISTS ${table} (\n` +
                `  key        TEXT PRIMARY KEY,\n` +
                `  data       JSONB NOT NULL,\n` +
                `  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n` +
                `)`,
            ),
          );
        }
      });
      lastFailedEnsureAt = 0;
    } catch (err) {
      lastFailedEnsureAt = Date.now();
      recordStoreFailure(err);
      throw err;
    } finally {
      ensureInFlight = null;
    }
  })();
  return ensureInFlight;
}

/**
 * Self-heal entry point used by store.ts on a missing-relation error: skips
 * (throws) while a recent ensure attempt already failed, so a persistent
 * outage doesn't hammer DDL on every op.
 */
export async function ensureAdsOsStoreTablesForSelfHeal(): Promise<void> {
  if (lastFailedEnsureAt && Date.now() - lastFailedEnsureAt < ENSURE_RETRY_COOLDOWN_MS) {
    throw new Error("Ads OS store ensure recently failed; retry cooling down");
  }
  await ensureAdsOsStoreTables();
}

/** Test hook: clear the ensure failure cooldown. */
export function __testResetEnsureCooldown(): void {
  lastFailedEnsureAt = 0;
}
