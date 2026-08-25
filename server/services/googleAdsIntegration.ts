// @db-pool-intent: mixed
//
// Task #1759 / reshaped by Task #4008 — this file is the platform Google Ads
// REST client. The `discoverAndUpsertCustomers` and `syncCustomer` entry
// points are invoked from the worker pool (via `runWithWorkerDb()` in
// `googleAdsSync.ts`), while operator routes (Ads Hygiene / Audit, Discover
// Customers, sync-now) call `gaqlSearchStream` on the API pool. Every storage
// helper imported here delegates to `getDb()` which inherits the caller's
// AsyncLocalStorage handle, so both pools are reachable depending on the
// entry point.

/**
 * Google Ads integration — unified single-credential model (Task #4008).
 *
 * Auth: every access token is minted by the shared env-trio path in
 * `adsOs/googleAdsClient.getEnvAccessToken()` — GOOGLE_ADS_CLIENT_ID /
 * GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN — the exact same
 * mint (one token cache + one 5-min terminal-rejection negative cache)
 * Ads OS uses. There is NO stored connection row, NO in-app OAuth flow,
 * NO refresh single-flight/breaker/forensics machinery anymore: the
 * platform-managed `google_ads_connection` died 2026-07-27 when the shared
 * OAuth client pair was repointed (a refresh token only redeems under the
 * client that minted it) and was retired in favor of the env credential.
 * Credential rotation = update the matching secret trio + restart
 * (GOOGLE_ADS.md has the runbook). Blast radius: this ONE credential powers
 * Ads Hygiene, Discover Customers, campaign/keyword sync, AND Ads OS.
 *
 * Everything below the token accessor is unchanged from the original
 * integration: a thin REST client that issues GAQL queries via
 * `searchStream`, hydrates `google_ads_customers`, and bulk-upserts
 * campaign/keyword daily stats. Operator-driven `nobull_client_id` mapping
 * lives on `google_ads_customers` and is read but never written by this
 * file.
 */

import { auditOutboundCall } from "./externalCallAudit";
import {
  getEnvAccessToken,
  getAdsOsClientAuthSnapshot,
} from "./adsOs/googleAdsClient";
import {
  bulkUpsertGoogleAdsCampaignDailyStats,
  bulkUpsertGoogleAdsCampaigns,
  bulkUpsertGoogleAdsKeywordDailyStats,
  listGoogleAdsCustomers,
  markGoogleAdsCustomerSynced,
  markGoogleAdsCustomersRemoved,
  updateGoogleAdsCustomerMapping,
  upsertGoogleAdsCustomer,
} from "../storage/googleAdsStorage";
import type {
  InsertGoogleAdsCampaign,
  InsertGoogleAdsCampaignDailyStats,
  InsertGoogleAdsKeywordDailyStats,
} from "@shared/schema";

// Bumped off the sunsetting v23 (sunset ~Jan 2027, confirmed against
// https://developers.google.com/google-ads/api/docs/sunset-dates). v24
// (released Apr 22 2026, sunset May 2027) is the newest GA version with the
// longest runway. Verified against the v24 field reference
// (developers.google.com/google-ads/api/fields/v24/*) that every field we
// select still exists unchanged: campaign.start_date_time/end_date_time (the
// v23 renames from start_date/end_date), campaign_budget.amount_micros/name,
// segments.date, metrics.{impressions,clicks,cost_micros,conversions,
// conversions_value,average_cpc,ctr}, and the ad_group_criterion.* keyword
// selections — no GAQL renames affect us v23→v24.
export const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v24";
const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

// ---------------------------------------------------------------------------
// Outbound fetch timeouts — every Google Ads HTTP call must have a bounded
// deadline so a silently-dropped socket can never permanently wedge a worker.
// GAQL searchStream returns the full result over one persistent connection (no
// pagination), so it needs a longer window than the discovery calls.
// Test-only override hooks keep the unit tests fast without touching prod.
// ---------------------------------------------------------------------------
let _gaqlTimeoutMs = 120_000; // 2 min: generous for large query result streams
let _httpTimeoutMs = 30_000; // 30 s: customer discovery
export function __setGaqlTimeoutMsForTest(ms: number): void { _gaqlTimeoutMs = ms; }
export function __setHttpTimeoutMsForTest(ms: number): void { _httpTimeoutMs = ms; }

/**
 * Returns a fetch `signal` that aborts after `ms` milliseconds plus a cleanup
 * function to cancel the timer when the request completes normally.
 */
function makeFetchAbort(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Google Ads fetch timed out after ${ms}ms`)), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

export function getDeveloperToken(): string {
  const v = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!v) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN not configured");
  return v;
}

/** Login-customer-id is the MCC top-level account that owns the OAuth
 * grant. Strip dashes — the Google Ads REST API rejects them in the
 * `login-customer-id` header. */
export function getLoginCustomerId(): string {
  const v = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  if (!v) throw new Error("GOOGLE_ADS_LOGIN_CUSTOMER_ID not configured");
  return v.replace(/[^0-9]/g, "");
}

/**
 * All five Google Ads secrets are required for any surface to work: the
 * env trio mints tokens, the developer token + login-customer-id go into
 * every API call's headers.
 */
export function isGoogleAdsConfigured(): boolean {
  return (
    !!process.env.GOOGLE_ADS_CLIENT_ID &&
    !!process.env.GOOGLE_ADS_CLIENT_SECRET &&
    !!process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    !!process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
  );
}

// ---------------------------------------------------------------------------
// Token access — thin wrapper over the shared env-trio mint
// ---------------------------------------------------------------------------

/**
 * Mint (or reuse) an access token via the shared env-trio path.
 *
 * Task #2433 — the terminal disconnect throws below are REGISTERED in
 * scripts/lint-probe-swallow-into-unauthorized.ts (DISCONNECT_THROW_ACCESSORS)
 * and must keep matching its DISCONNECT_THROW_MESSAGE_PATTERNS. Rewording them
 * away from the shared phrases ("not connected") fails that lint loudly —
 * update the pattern list in lockstep rather than letting the swallow guard
 * silently stop covering this accessor.
 *
 * Error contract (consumed by routes/googleAdsDisconnected.ts):
 *   - "Google Ads not connected — …"          → env secrets incomplete
 *   - "Google Ads credential rejected by Google: …" → Google's token endpoint
 *     terminally rejected the trio (invalid_grant / invalid_client /
 *     unauthorized_client — the 5-min negative cache in the shared mint is
 *     armed). Rotation runbook: GOOGLE_ADS.md.
 *   - anything else (network blip, timeout, 5xx) is transient and propagates
 *     verbatim — it must NOT render as "disconnected".
 */
export async function getValidAccessToken(): Promise<string> {
  if (!isGoogleAdsConfigured()) {
    throw new Error(
      "Google Ads not connected — the GOOGLE_ADS_* env secrets are incomplete (see GOOGLE_ADS.md)",
    );
  }
  const pre = getAdsOsClientAuthSnapshot();
  if (pre.authDead) {
    throw new Error(
      `Google Ads credential rejected by Google: ${pre.authDeadDetail ?? "terminal token-exchange failure"} — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md)`,
    );
  }
  try {
    return await getEnvAccessToken();
  } catch (err: any) {
    // The shared mint arms its negative cache ONLY on a terminal 4xx from
    // Google's token endpoint. If it is armed now, this failure is a
    // confirmed credential death; anything else (network/timeout/5xx) is
    // transient and must propagate without the auth-dead phrasing.
    const snap = getAdsOsClientAuthSnapshot();
    if (snap.authDead) {
      throw new Error(
        `Google Ads credential rejected by Google: ${snap.authDeadDetail ?? err?.message ?? "terminal token-exchange failure"} — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md)`,
      );
    }
    throw err;
  }
}

/**
 * "Connected" in the unified model = the env secrets are present and the
 * shared mint's terminal-rejection negative cache is NOT armed. Strictly a
 * memory/env read — never a DB read, never a network call (the status path
 * must not POST to Google's token endpoint).
 */
export function isConnected(): boolean {
  return isGoogleAdsConfigured() && !getAdsOsClientAuthSnapshot().authDead;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type GoogleAdsErrorKind =
  | "unauthenticated"
  | "permission_denied"
  | "invalid_customer"
  | "quota_exceeded"
  | "rate_limited"
  | "transient"
  | "unknown";

export interface GoogleAdsApiError extends Error {
  statusCode?: number;
  kind: GoogleAdsErrorKind;
  reason?: string;
  retryAfterSeconds?: number;
}

/**
 * Parse a Google Ads REST error envelope into a structured kind. The
 * REST API returns errors in two shapes:
 *   - Top-level: `{ error: { code, status, message, details: [...] } }`
 *   - Streamed:  `[{ error: { ... } }]`
 * `details[].errors[].errorCode` holds the typed reason (e.g.
 * `authenticationError: USER_PERMISSION_DENIED`, `quotaError: RESOURCE_EXHAUSTED`).
 */
export function classifyGoogleAdsError(
  parsed: any,
  statusCode: number,
): { kind: GoogleAdsErrorKind; reason?: string; message: string } {
  const top = parsed?.error || parsed?.[0]?.error || {};
  const message: string =
    top?.message || `Google Ads API ${statusCode || "error"}`;
  const status: string = String(top?.status || "").toUpperCase();
  const details: any[] = Array.isArray(top?.details) ? top.details : [];
  let reason: string | undefined;
  for (const d of details) {
    const errs = Array.isArray(d?.errors) ? d.errors : [];
    for (const e of errs) {
      const code = e?.errorCode || {};
      const firstKey = Object.keys(code)[0];
      if (firstKey) {
        reason = `${firstKey}:${code[firstKey]}`;
        break;
      }
    }
    if (reason) break;
  }

  const reasonU = (reason || "").toUpperCase();
  // Task #2902 — `authorizationError:USER_PERMISSION_DENIED` is a PER-CUSTOMER
  // error ("User doesn't have permission to access customer", i.e. the account
  // isn't linked under the login MCC). It previously matched the
  // unauthenticated regex, which knocked the GLOBAL connection to
  // 'disconnected' whenever a single inaccessible customer was synced —
  // killing the entire daily pull. It now falls through to
  // `permission_denied` (disable that one customer's sync). Only genuine
  // credential-level reasons (NOT_ADS_USER, OAUTH_TOKEN_*) stay global.
  if (
    statusCode === 401 ||
    status === "UNAUTHENTICATED" ||
    /NOT_ADS_USER|OAUTH_TOKEN/.test(reasonU)
  ) {
    return { kind: "unauthenticated", reason, message };
  }
  if (
    statusCode === 403 ||
    status === "PERMISSION_DENIED" ||
    /PERMISSION/.test(reasonU)
  ) {
    return { kind: "permission_denied", reason, message };
  }
  if (
    statusCode === 404 ||
    status === "NOT_FOUND" ||
    /CUSTOMER_NOT_FOUND|CUSTOMER_NOT_ENABLED|INVALID_CUSTOMER_ID/.test(reasonU)
  ) {
    return { kind: "invalid_customer", reason, message };
  }
  if (
    statusCode === 429 ||
    status === "RESOURCE_EXHAUSTED" ||
    /QUOTA|RATE_EXCEEDED|RESOURCE_EXHAUSTED/.test(reasonU)
  ) {
    return { kind: "quota_exceeded", reason, message };
  }
  if (statusCode >= 500 && statusCode < 600) {
    return { kind: "transient", reason, message };
  }
  return { kind: "unknown", reason, message };
}

function makeGoogleAdsError(
  parsed: any,
  statusCode: number,
  retryAfterHeader?: string | null,
): GoogleAdsApiError {
  const { kind, reason, message } = classifyGoogleAdsError(parsed, statusCode);
  const err = new Error(
    reason ? `${message} (${reason})` : message,
  ) as GoogleAdsApiError;
  err.statusCode = statusCode;
  err.kind = kind;
  err.reason = reason;
  const ra = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(ra) && ra > 0) err.retryAfterSeconds = ra;
  return err;
}

/**
 * Apply side-effects for a classified error. Called from `syncCustomer`
 * so failures durably propagate to the operator surfaces (per-customer
 * `sync_enabled` flip, last-error text).
 *
 * Task #4008 — the old `unauthenticated → upsert connection status:
 * "disconnected"` branch is gone with the connection row. A credential-level
 * rejection now surfaces through the shared mint's negative cache (the
 * accessor throws the "credential rejected" family and every surface backs
 * off for its 5-min window); there is no durable status to write.
 */
async function applyGoogleAdsErrorSideEffects(
  err: GoogleAdsApiError,
  customerId: string | null,
): Promise<void> {
  try {
    if (
      (err.kind === "permission_denied" || err.kind === "invalid_customer") &&
      customerId
    ) {
      await updateGoogleAdsCustomerMapping(customerId, { syncEnabled: false });
    }
  } catch (sideErr: any) {
    console.warn(
      "[GoogleAds] applyGoogleAdsErrorSideEffects failed:",
      sideErr?.message || sideErr,
    );
  }
}

// ---------------------------------------------------------------------------
// Google Ads REST — GAQL `searchStream`
// ---------------------------------------------------------------------------

interface SearchStreamRow {
  [key: string]: any;
}

/**
 * Issue a GAQL `searchStream` query against the supplied customer id. The
 * REST endpoint streams an array of result chunks; we concatenate all
 * rows into a single array because the per-customer payloads we care
 * about (campaign + keyword stats for a 90-day window) are bounded.
 *
 * Strips dashes from `customerId` and `loginCustomerId` before placing
 * them in the URL / header — the API rejects formatted ids.
 */
export async function gaqlSearchStream(
  customerId: string,
  query: string,
): Promise<SearchStreamRow[]> {
  const accessToken = await getValidAccessToken();
  const cleanCustomerId = customerId.replace(/[^0-9]/g, "");
  const loginCustomerId = getLoginCustomerId();
  const developerToken = getDeveloperToken();

  const endpoint = `customers/${cleanCustomerId}/googleAds:searchStream`;
  const body = await auditOutboundCall<SearchStreamRow[]>(
    {
      integration: "google_ads",
      endpoint,
      method: "POST",
      dedupeParams: { customerId: cleanCustomerId, query: query.replace(/\s+/g, " ").trim() },
      callerLabel: "google_ads_gaql_search_stream",
    },
    async () => {
      const { signal, clear } = makeFetchAbort(_gaqlTimeoutMs);
      let text: string;
      let res: Response;
      try {
        res = await fetch(`${GOOGLE_ADS_API_BASE}/${endpoint}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "developer-token": developerToken,
            "login-customer-id": loginCustomerId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
          signal,
        });
        text = await res.text();
        clear();
      } catch (err: any) {
        clear();
        if (err?.name === "AbortError" || err?.message?.includes("timed out")) {
          throw new Error(`Google Ads GAQL request timed out after ${_gaqlTimeoutMs}ms (transient)`);
        }
        throw err;
      }
      let parsed: any;
      try {
        parsed = text ? JSON.parse(text) : [];
      } catch {
        throw new Error(`Google Ads API returned non-JSON (${res.status})`);
      }
      if (!res.ok) {
        throw makeGoogleAdsError(
          parsed,
          res.status,
          res.headers.get("retry-after"),
        );
      }
      const rows: SearchStreamRow[] = [];
      const chunks: any[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const chunk of chunks) {
        const r = chunk?.results;
        if (Array.isArray(r)) rows.push(...r);
      }
      return {
        value: rows,
        statusCode: res.status,
        responseSizeBytes: text.length,
      };
    },
  );
  return body;
}

// ---------------------------------------------------------------------------
// Customer discovery
// ---------------------------------------------------------------------------

interface ListAccessibleCustomersResponse {
  resourceNames?: string[];
}

/**
 * Returns the list of customer ids the env-credential principal can
 * access (i.e. every customer under the MCC). Each `resourceName` is of
 * the form `customers/{customerId}`.
 */
export async function listAccessibleCustomerIds(): Promise<string[]> {
  const accessToken = await getValidAccessToken();
  const body = await auditOutboundCall<ListAccessibleCustomersResponse>(
    {
      integration: "google_ads",
      endpoint: "customers:listAccessibleCustomers",
      method: "GET",
      callerLabel: "google_ads_list_accessible",
    },
    async () => {
      const { signal, clear } = makeFetchAbort(_httpTimeoutMs);
      let res: Response;
      let text: string;
      try {
        res = await fetch(
          `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "developer-token": getDeveloperToken(),
            },
            signal,
          },
        );
        text = await res.text();
        clear();
      } catch (err: any) {
        clear();
        if (err?.name === "AbortError" || err?.message?.includes("timed out")) {
          throw new Error(`Google Ads listAccessibleCustomers timed out after ${_httpTimeoutMs}ms`);
        }
        throw err;
      }
      let json: (ListAccessibleCustomersResponse & { error?: { message?: string } }) | null = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Google Ads API returned non-JSON (${res.status})`);
      }
      if (!res.ok) {
        const err: any = new Error(
          json?.error?.message || `Google Ads listAccessibleCustomers ${res.status}`,
        );
        err.statusCode = res.status;
        throw err;
      }
      return { value: json ?? {}, statusCode: res.status, responseSizeBytes: text.length };
    },
  );
  const ids = (body.resourceNames || []).map((rn) =>
    rn.replace(/^customers\//, "").replace(/[^0-9]/g, ""),
  );
  return ids.filter((s) => s.length > 0);
}

/**
 * Hydrate the `google_ads_customers` table from a recursive Customer +
 * CustomerClient query against the MCC, then return the upserted rows.
 * Operator-managed `nobull_client_id` / `sync_enabled` columns are NOT
 * touched by this path.
 */
export async function discoverAndUpsertCustomers(): Promise<number> {
  // Discovery runs against the MCC itself so the `CustomerClient` table
  // returns every linked sub-account in one shot. The fallback below
  // covers single-account auths where the OAuth principal is itself the
  // customer rather than an MCC.
  const mccId = getLoginCustomerId();
  const query = `
    SELECT
      customer_client.client_customer,
      customer_client.id,
      customer_client.descriptive_name,
      customer_client.currency_code,
      customer_client.time_zone,
      customer_client.manager,
      customer_client.test_account,
      customer_client.status
    FROM customer_client
    WHERE customer_client.status != 'CANCELED'
  `;

  let upserted = 0;
  const discoveredIds: string[] = [];
  try {
    const rows = await gaqlSearchStream(mccId, query);
    for (const row of rows) {
      const cc = row?.customerClient;
      if (!cc) continue;
      const customerId = String(cc.id ?? "").replace(/[^0-9]/g, "");
      if (!customerId) continue;
      await upsertGoogleAdsCustomer({
        customerId,
        descriptiveName: cc.descriptiveName ?? null,
        currencyCode: cc.currencyCode ?? null,
        timeZone: cc.timeZone ?? null,
        isManager: !!cc.manager,
        isTestAccount: !!cc.testAccount,
        status: cc.status ?? null,
      });
      discoveredIds.push(customerId);
      upserted++;
    }
  } catch (err: any) {
    // Fallback: enumerate accessible customers directly.
    console.warn(
      "[GoogleAds] customer_client discovery failed, falling back to listAccessibleCustomers:",
      err?.message,
    );
    const ids = await listAccessibleCustomerIds();
    for (const id of ids) {
      await upsertGoogleAdsCustomer({
        customerId: id,
        descriptiveName: null,
        currencyCode: null,
        timeZone: null,
        isManager: false,
        isTestAccount: false,
        status: null,
      });
      discoveredIds.push(id);
      upserted++;
    }
  }

  // Task #2904 — prune rows that disappeared from the MCC. Both branches
  // above return the COMPLETE current account set (the CustomerClient
  // query already excludes CANCELED; the fallback enumerates every
  // accessible customer), so anything absent from `discoveredIds` no
  // longer exists under the MCC and must stop showing in the account
  // dropdown. `markGoogleAdsCustomersRemoved` is a hard no-op on an
  // empty set so a zero-row discovery can never mass-flag live rows,
  // and a re-appearing account is un-flagged by the upsert above (the
  // discovery upsert overwrites `status` with the live value).
  if (discoveredIds.length > 0) {
    const pruned = await markGoogleAdsCustomersRemoved(discoveredIds);
    if (pruned > 0) {
      console.log(
        `[GoogleAds] Discovery pruned ${pruned} customer row(s) no longer present in the MCC`,
      );
    }
  }
  return upserted;
}

// ---------------------------------------------------------------------------
// Daily campaign + keyword sync (per customer)
// ---------------------------------------------------------------------------

function parseDateOrNull(v: any): string | null {
  if (!v) return null;
  // Google returns dates as `YYYY-MM-DD` strings already; passthrough.
  return String(v).slice(0, 10);
}

function toNumber(v: any): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Google Ads money is reported in "micros" (1_000_000 = 1 unit of the
 * account's currency). The dollar columns are a denormalized convenience
 * for report consumers; micros remains the authoritative source. */
function microsToDollars(micros: number): number {
  if (!Number.isFinite(micros)) return 0;
  return Math.round((micros / 1_000_000) * 100) / 100;
}

export interface SyncCustomerResult {
  customerId: string;
  campaignsUpserted: number;
  campaignStatsUpserted: number;
  keywordStatsUpserted: number;
}

/**
 * Daily sync for a single customer. Pulls a lookback window of campaign
 * + keyword stats via two GAQL queries and bulk-upserts the rows. The
 * caller is responsible for opening a worker-pool DB context (the
 * storage helpers honour the current AsyncLocalStorage handle via
 * `getDb()`); this function intentionally does not import the api-pool
 * `db` directly.
 */
export async function syncCustomer(
  customerId: string,
  lookbackDays: number,
): Promise<SyncCustomerResult> {
  try {
    return await syncCustomerInner(customerId, lookbackDays);
  } catch (err: any) {
    if (err && typeof err === "object" && "kind" in err) {
      await applyGoogleAdsErrorSideEffects(
        err as GoogleAdsApiError,
        customerId.replace(/[^0-9]/g, ""),
      );
    }
    throw err;
  }
}

/**
 * Result of {@link buildSyncCustomerQueries} — the clamped lookback, the
 * inclusive UTC window, the shared `segments.date BETWEEN …` filter, and the
 * two GAQL query strings. Exported as a behavior-preserving test seam so the
 * Task #2508 regressions (invalid `DURING` filter, the non-existent
 * `metrics.conversions_value_micros` field) can be pinned without driving a
 * live sync. See `tests/google-ads-query-build.test.ts`.
 */
export interface SyncCustomerQueries {
  lookback: number;
  startDate: string;
  endDate: string;
  dateFilter: string;
  campaignQuery: string;
  keywordQuery: string;
}

/**
 * Build the GAQL date filter + campaign/keyword queries for a lookback window.
 *
 * Task #2508 — GAQL's `DURING` operator only accepts a fixed set of predefined
 * literals (TODAY, LAST_7_DAYS, LAST_30_DAYS, …) — there is NO `LAST_90_DAYS` /
 * `LAST_N_DAYS`, so the old `DURING LAST_${lookback}_DAYS` form rejected every
 * arbitrary lookback with queryError:INVALID_VALUE_WITH_DURING_OPERATOR. For an
 * arbitrary window the docs require an explicit `segments.date BETWEEN
 * 'YYYY-MM-DD' AND 'YYYY-MM-DD'` range. Window semantics: INCLUSIVE of today —
 * end = today, start = today − (lookback − 1) — so a lookback of 90 covers 90
 * calendar days ending today (the old LAST_N_DAYS literals EXCLUDED today; we
 * deliberately include it). Dates are computed in UTC; Google evaluates
 * segments.date in the account's own time zone, which is an acceptable ±1-day
 * boundary nuance for a daily-grain upsert (rows are keyed by date and re-synced
 * each run). The lookback is clamped to 1–365. The single shared `dateFilter`
 * keeps the campaign and keyword queries in lockstep.
 *
 * @param now Injectable clock (defaults to `new Date()`) so the window is
 *   deterministic in tests.
 */
export function buildSyncCustomerQueries(
  lookbackDays: number,
  now: Date = new Date(),
): SyncCustomerQueries {
  const lookback = Math.max(1, Math.min(lookbackDays, 365));
  const end = new Date(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (lookback - 1));
  const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);
  const startDate = toIsoDate(start);
  const endDate = toIsoDate(end);
  const dateFilter = `segments.date BETWEEN '${startDate}' AND '${endDate}'`;

  const campaignQuery = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.start_date_time,
      campaign.end_date_time,
      campaign.bidding_strategy_type,
      campaign_budget.amount_micros,
      campaign_budget.name,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.average_cpc,
      metrics.ctr
    FROM campaign
    WHERE ${dateFilter}
  `;

  const keywordQuery = `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.quality_info.quality_score,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.average_cpc
    FROM keyword_view
    WHERE ${dateFilter}
  `;

  return { lookback, startDate, endDate, dateFilter, campaignQuery, keywordQuery };
}

/**
 * Result of {@link mapCampaignRows} — the deduped campaign definitions and the
 * per-day campaign stats parsed from a GAQL campaign result set. Exported as a
 * behavior-preserving test seam (sibling to {@link buildSyncCustomerQueries}) so
 * the money-unit conversions can be pinned without driving a live sync. See
 * `tests/google-ads-conversion-mapping.test.ts`.
 */
export interface MappedCampaignRows {
  campaignDefs: InsertGoogleAdsCampaign[];
  campaignStats: InsertGoogleAdsCampaignDailyStats[];
}

/**
 * Parse raw GAQL campaign rows into the campaign-definition + daily-stat upsert
 * payloads.
 *
 * Money-unit contract (the regression this seam guards) — the Google Ads API
 * reports two DIFFERENT units on the same row and they must NOT be swapped:
 *   - `metrics.cost_micros`, `metrics.average_cpc`, `campaign_budget.amount_micros`
 *     are integer MICROS (1_000_000 = 1 unit of the account currency); the
 *     dollar columns are derived via `microsToDollars` (÷ 1e6).
 *   - `metrics.conversions_value` is a DOUBLE already in the account currency
 *     (e.g. dollars) — NOT micros. `metrics.conversions_value_micros` does not
 *     exist in any Google Ads API version. So conversion value is multiplied by
 *     1e6 (and rounded) to populate the authoritative micros column, and the raw
 *     double is the dollar column. Treating it as already-micros (the original
 *     Task #2508 bug) corrupts reported conversion value silently.
 */
export function mapCampaignRows(
  rows: any[],
  cleanCustomerId: string,
): MappedCampaignRows {
  const campaignDefs = new Map<string, InsertGoogleAdsCampaign>();
  const campaignStats: InsertGoogleAdsCampaignDailyStats[] = [];
  for (const row of rows) {
    const c = row?.campaign;
    const m = row?.metrics;
    const s = row?.segments;
    const b = row?.campaignBudget;
    if (!c?.id) continue;
    const campaignId = String(c.id);
    if (!campaignDefs.has(campaignId)) {
      const budgetMicros = toNumber(b?.amountMicros);
      campaignDefs.set(campaignId, {
        customerId: cleanCustomerId,
        campaignId,
        name: c.name ?? null,
        status: c.status ?? null,
        advertisingChannelType: c.advertisingChannelType ?? null,
        // Task #2902 — v23 removed `campaign.start_date`/`end_date` (GAQL
        // UNRECOGNIZED_FIELD); replaced by `start_date_time`/`end_date_time`
        // (release notes, v23 2026-01-28 breaking changes). parseDateOrNull
        // slices the first 10 chars so the stored value stays a plain date.
        startDate: parseDateOrNull(c.startDateTime),
        endDate: parseDateOrNull(c.endDateTime),
        biddingStrategyType: c.biddingStrategyType ?? null,
        budgetMicros,
        budgetDollars: microsToDollars(budgetMicros),
        budgetName: b?.name ?? null,
      });
    }
    if (s?.date && m) {
      const costMicros = toNumber(m.costMicros);
      // Task #2508 — `metrics.conversions_value` is a DOUBLE in the account's
      // currency (NOT micros — `conversions_value_micros` does not exist in the
      // Google Ads API). Convert to micros to keep the authoritative
      // `conversion_value_micros` column populated, and store the dollar value
      // directly rather than round-tripping it back from micros.
      const convValueDollars = toNumber(m.conversionsValue);
      const convValueMicros = Math.round(convValueDollars * 1_000_000);
      // Task #2902 — `metrics.average_cpc` is a DOUBLE in micros (e.g.
      // "9051417.25"); the bigint stat column rejects fractional values with
      // "invalid input syntax for type bigint". Round to an integer.
      const cpcMicros = Math.round(toNumber(m.averageCpc));
      campaignStats.push({
        customerId: cleanCustomerId,
        campaignId,
        date: parseDateOrNull(s.date)!,
        impressions: toNumber(m.impressions),
        clicks: toNumber(m.clicks),
        costMicros,
        costDollars: microsToDollars(costMicros),
        conversions: Math.round(toNumber(m.conversions)),
        conversionValueMicros: convValueMicros,
        conversionValueDollars: convValueDollars,
        averageCpcMicros: cpcMicros,
        averageCpcDollars: microsToDollars(cpcMicros),
        ctr: Math.round(toNumber(m.ctr) * 10_000),
      });
    }
  }
  return { campaignDefs: Array.from(campaignDefs.values()), campaignStats };
}

async function syncCustomerInner(
  customerId: string,
  lookbackDays: number,
): Promise<SyncCustomerResult> {
  const { campaignQuery, keywordQuery } = buildSyncCustomerQueries(lookbackDays);
  const cleanCustomerId = customerId.replace(/[^0-9]/g, "");

  // ---- campaigns + campaign daily stats ----
  const campaignRows = await gaqlSearchStream(cleanCustomerId, campaignQuery);

  const { campaignDefs, campaignStats } = mapCampaignRows(
    campaignRows,
    cleanCustomerId,
  );

  const campaignsUpserted = await bulkUpsertGoogleAdsCampaigns(campaignDefs);
  const campaignStatsUpserted = await bulkUpsertGoogleAdsCampaignDailyStats(
    campaignStats,
  );

  // ---- keyword daily stats ----
  const keywordRows = await gaqlSearchStream(cleanCustomerId, keywordQuery);
  const keywordStats: InsertGoogleAdsKeywordDailyStats[] = [];
  for (const row of keywordRows) {
    const c = row?.campaign;
    const ag = row?.adGroup;
    const agc = row?.adGroupCriterion;
    const m = row?.metrics;
    const s = row?.segments;
    if (!c?.id || !ag?.id || !agc?.criterionId || !s?.date) continue;
    const kCostMicros = toNumber(m?.costMicros);
    // Task #2902 — same fractional-DOUBLE-micros rounding as the campaign path.
    const kCpcMicros = Math.round(toNumber(m?.averageCpc));
    keywordStats.push({
      customerId: cleanCustomerId,
      campaignId: String(c.id),
      adGroupId: String(ag.id),
      criterionId: String(agc.criterionId),
      keywordText: agc.keyword?.text ?? null,
      matchType: agc.keyword?.matchType ?? null,
      date: parseDateOrNull(s.date)!,
      impressions: toNumber(m?.impressions),
      clicks: toNumber(m?.clicks),
      costMicros: kCostMicros,
      costDollars: microsToDollars(kCostMicros),
      conversions: Math.round(toNumber(m?.conversions)),
      averageCpcMicros: kCpcMicros,
      averageCpcDollars: microsToDollars(kCpcMicros),
      qualityScore:
        agc.qualityInfo?.qualityScore != null
          ? Number(agc.qualityInfo.qualityScore)
          : null,
    });
  }
  const keywordStatsUpserted = await bulkUpsertGoogleAdsKeywordDailyStats(
    keywordStats,
  );

  await markGoogleAdsCustomerSynced(cleanCustomerId, null);

  return {
    customerId: cleanCustomerId,
    campaignsUpserted,
    campaignStatsUpserted,
    keywordStatsUpserted,
  };
}

export async function listEnabledCustomerIds(): Promise<string[]> {
  const rows = await listGoogleAdsCustomers();
  return rows
    .filter((r) => r.syncEnabled && !r.isManager)
    .map((r) => r.customerId);
}
