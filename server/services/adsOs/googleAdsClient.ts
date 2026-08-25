/**
 * Ads OS — read-only Google Ads REST client (v24).
 *
 * STRICTLY READ-ONLY. This module must never call a Google Ads mutate endpoint.
 * The automated test tests/ads-os-mutate-guard.test.ts greps this directory for
 * mutate service names and verbs and fails if any appear.
 *
 * Mirrors the REST pattern from server/services/googleAdsIntegration.ts (v24,
 * per-call AbortController timeouts, spec §4 error mapping).
 *
 * Auth (Task #4008 — unified single-credential model): access tokens are
 * exchanged HERE from the standalone env credentials GOOGLE_ADS_CLIENT_ID /
 * GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN (trimmed on read) —
 * the ONLY token source for EVERY Google Ads surface. `getEnvAccessToken()`
 * is exported as the shared mint: Ads OS pulls call it directly via
 * `adsOsGaqlSearch`, and the platform surfaces (Ads Hygiene, Discover
 * Customers, campaign/keyword sync) reach it through
 * `googleAdsIntegration.getValidAccessToken()`. The old platform-managed
 * `google_ads_connection` row and its OAuth machinery are retired — a
 * refresh token only works with the OAuth client that minted it, so the
 * repointed shared client pair killed that lane permanently (2026-07-27
 * incident). A terminally rejected env token is negative-cached briefly so
 * dead credentials don't get re-POSTed to Google on every GAQL call.
 *
 * Error mapping (spec §4):
 *   missing creds  → throw AdsOsCredsMissing  (callers return 503)
 *   quota exceeded → throw with "quota" in message (callers return 503 "quota")
 *   any other API error → throw with first error message (callers return 502)
 */

import {
  getDeveloperToken,
  getClientId,
  getClientSecret,
  getEnvRefreshToken,
  getLoginCustomerId,
} from "./config";

export const ADS_OS_API_VERSION = "v24";
const ADS_OS_API_BASE = `https://googleads.googleapis.com/${ADS_OS_API_VERSION}`;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Timeouts mirrored from googleAdsIntegration.ts
let _gaqlTimeoutMs = 120_000;
let _httpTimeoutMs = 30_000;
export function __adsOsSetGaqlTimeoutMsForTest(ms: number) { _gaqlTimeoutMs = ms; }
export function __adsOsSetHttpTimeoutMsForTest(ms: number) { _httpTimeoutMs = ms; }

function makeFetchAbort(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Ads OS fetch timed out after ${ms}ms`)), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

export class AdsOsCredsMissing extends Error {
  constructor(msg: string) { super(msg); this.name = "AdsOsCredsMissing"; }
}

export class AdsOsApiError extends Error {
  statusCode: number;
  kind: "unauthenticated" | "quota_exceeded" | "permission_denied" | "invalid_customer" | "transient" | "unknown";
  constructor(msg: string, statusCode: number, kind: AdsOsApiError["kind"]) {
    super(msg); this.statusCode = statusCode; this.kind = kind;
  }
}

function classifyAdsOsError(parsed: any, statusCode: number): AdsOsApiError {
  const top = parsed?.error || parsed?.[0]?.error || {};
  const message: string = top?.message || `Google Ads API error (${statusCode})`;
  const status = String(top?.status || "").toUpperCase();
  const details: any[] = Array.isArray(top?.details) ? top.details : [];
  let reason = "";
  for (const d of details) {
    const errs = Array.isArray(d?.errors) ? d.errors : [];
    for (const e of errs) {
      const code = e?.errorCode || {};
      const k = Object.keys(code)[0];
      if (k) { reason = `${k}:${code[k]}`; break; }
    }
    if (reason) break;
  }
  const reasonU = reason.toUpperCase();
  const displayMsg = reason ? `${message} (${reason})` : message;

  if (statusCode === 401 || status === "UNAUTHENTICATED" || /NOT_ADS_USER|OAUTH_TOKEN/.test(reasonU)) {
    return new AdsOsApiError(displayMsg, statusCode, "unauthenticated");
  }
  if (statusCode === 429 || status === "RESOURCE_EXHAUSTED" || /QUOTA|RATE_EXCEEDED|RESOURCE_EXHAUSTED/.test(reasonU)) {
    return new AdsOsApiError(`Google Ads API quota reached. ${displayMsg}`, statusCode, "quota_exceeded");
  }
  if (statusCode === 403 || status === "PERMISSION_DENIED") {
    return new AdsOsApiError(displayMsg, statusCode, "permission_denied");
  }
  if (statusCode === 404 || status === "NOT_FOUND") {
    return new AdsOsApiError(displayMsg, statusCode, "invalid_customer");
  }
  if (statusCode >= 500 && statusCode < 600) {
    return new AdsOsApiError(displayMsg, statusCode, "transient");
  }
  return new AdsOsApiError(displayMsg, statusCode, "unknown");
}

// ---------------------------------------------------------------------------
// Access-token cache
// ---------------------------------------------------------------------------

interface TokenCache { accessToken: string; expiresAtMs: number; }
let _tokenCache: TokenCache | null = null;

// Negative cache: a terminally rejected refresh token (unauthorized_client /
// invalid_grant / invalid_client) must not be re-POSTed to Google on every
// GAQL call. Cleared by the app restart that a secret edit requires.
const ENV_AUTH_DEAD_MS = 5 * 60 * 1000;
let _envAuthDeadUntilMs = 0;
let _envAuthDeadMsg = "";

/**
 * Shared env-trio access-token mint (Task #4008). ONE in-process token cache
 * + ONE terminal-rejection negative cache serve every Google Ads surface —
 * Ads OS pulls and the platform integration (`googleAdsIntegration.ts`) alike.
 * Throws `AdsOsCredsMissing` on missing/negative-cached/rejected credentials;
 * transient network failures propagate as plain Errors without arming the
 * negative cache.
 */
export async function getEnvAccessToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAtMs) {
    return _tokenCache.accessToken;
  }

  // Standalone env credentials are the ONLY auth path.
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const refreshToken = getEnvRefreshToken();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new AdsOsCredsMissing(
      "Google Ads credentials incomplete. Set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_REFRESH_TOKEN."
    );
  }

  if (Date.now() < _envAuthDeadUntilMs) {
    throw new AdsOsCredsMissing(
      `Google Ads auth unavailable: token exchange recently failed terminally (${_envAuthDeadMsg}). ` +
      `Verify GOOGLE_ADS_REFRESH_TOKEN was minted under GOOGLE_ADS_CLIENT_ID, update the secrets, and restart the app.`
    );
  }

  const { signal, clear } = makeFetchAbort(_httpTimeoutMs);
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal,
    });
    clear();
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.error_description || body?.error || "unknown";
      // 4xx from the token endpoint = the credential itself is bad (dead token,
      // wrong client) — remember briefly so we fail fast instead of re-POSTing.
      if (res.status >= 400 && res.status < 500) {
        _envAuthDeadUntilMs = Date.now() + ENV_AUTH_DEAD_MS;
        _envAuthDeadMsg = `HTTP ${res.status}: ${detail}`;
      }
      throw new AdsOsCredsMissing(`OAuth token exchange failed (${res.status}): ${detail}`);
    }
    const accessToken = body.access_token as string;
    const expiresIn = (body.expires_in as number) ?? 3600;
    _tokenCache = { accessToken, expiresAtMs: Date.now() + (expiresIn - 300) * 1000 }; // 5-min safety margin
    return accessToken;
  } catch (err: any) {
    clear();
    if (err instanceof AdsOsCredsMissing) throw err;
    throw new AdsOsCredsMissing(`OAuth token exchange failed: ${err?.message || err}`);
  }
}

// Exposed for tests only — clears the in-memory token cache.
export function __adsOsClearTokenCacheForTest() { _tokenCache = null; }

// ---------------------------------------------------------------------------
// Auth-state snapshot (Task #4000 — Integrations Hub "Ads OS" lane)
// ---------------------------------------------------------------------------

/**
 * Read-only snapshot of the in-memory auth state for the Integrations Hub
 * "Ads OS (env credentials)" lane. Strictly a memory read — it must NEVER
 * mint a token (the status poll may not POST to Google), so a cold process
 * reports hasLiveAccessToken=false / authDead=false ("unknown" to the lane
 * builder) until a real Ads OS pull exercises getAccessToken().
 */
export interface AdsOsClientAuthSnapshot {
  /** A cached, unexpired access token exists (successful mint < ~55 min ago in THIS process). */
  hasLiveAccessToken: boolean;
  accessTokenExpiresAt: string | null;
  /** The 5-min terminal-rejection negative cache is active (dead/mispaired refresh token). */
  authDead: boolean;
  authDeadDetail: string | null;
  authDeadUntil: string | null;
}

export function getAdsOsClientAuthSnapshot(): AdsOsClientAuthSnapshot {
  const now = Date.now();
  const live = !!(_tokenCache && now < _tokenCache.expiresAtMs);
  const dead = now < _envAuthDeadUntilMs;
  return {
    hasLiveAccessToken: live,
    accessTokenExpiresAt: live ? new Date(_tokenCache!.expiresAtMs).toISOString() : null,
    authDead: dead,
    authDeadDetail: dead ? _envAuthDeadMsg || null : null,
    authDeadUntil: dead ? new Date(_envAuthDeadUntilMs).toISOString() : null,
  };
}

// Exposed for tests only — clears BOTH the token cache and the terminal-
// rejection negative cache so lane-status cases start from a cold process.
export function __adsOsResetAuthStateForTest() {
  _tokenCache = null;
  _envAuthDeadUntilMs = 0;
  _envAuthDeadMsg = "";
}

// ---------------------------------------------------------------------------
// GAQL searchStream (read-only)
// ---------------------------------------------------------------------------

export interface SearchStreamRow { [field: string]: any; }

/**
 * Issues a GAQL searchStream query against a single customer id.
 * This is the ONLY write path to the Google Ads API in this module — it POSTs
 * to searchStream, which is a read endpoint (no mutations). Never call any
 * mutate endpoint from this module.
 */
export async function adsOsGaqlSearch(
  customerId: string,
  query: string,
): Promise<SearchStreamRow[]> {
  const devToken = getDeveloperToken();
  const loginCid = getLoginCustomerId();

  if (!devToken || !loginCid) {
    throw new AdsOsCredsMissing(
      "Google Ads credentials incomplete. Set GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_LOGIN_CUSTOMER_ID."
    );
  }

  const cleanId = customerId.replace(/[^0-9]/g, "");
  const endpoint = `customers/${cleanId}/googleAds:searchStream`;
  const url = `${ADS_OS_API_BASE}/${endpoint}`;

  // Up to 2 attempts: if the API rejects the token mid-flight (revoked/expired
  // between mint and use), drop the cached token and re-mint ONCE before
  // surfacing unauthenticated (refresh-and-retry before gates/errors).
  for (let attempt = 0; ; attempt++) {
    const accessToken = await getEnvAccessToken();

    const { signal, clear } = makeFetchAbort(_gaqlTimeoutMs);
    let text: string;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devToken,
          "login-customer-id": loginCid,
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
        throw new Error(`Ads OS GAQL request timed out after ${_gaqlTimeoutMs}ms (transient)`);
      }
      throw err;
    }

    let parsed: any;
    try { parsed = text ? JSON.parse(text) : []; } catch {
      throw new Error(`Google Ads API returned non-JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
      const apiErr = classifyAdsOsError(parsed, res.status);
      if (apiErr.kind === "unauthenticated" && attempt === 0) {
        _tokenCache = null;
        continue;
      }
      throw apiErr;
    }

    const rows: SearchStreamRow[] = [];
    const chunks = Array.isArray(parsed) ? parsed : [parsed];
    for (const chunk of chunks) {
      const r = chunk?.results;
      if (Array.isArray(r)) rows.push(...r);
    }
    return rows;
  }
}

// ---------------------------------------------------------------------------
// Account list (mirrors accounts.py from the source bundle)
// ---------------------------------------------------------------------------

// GAQL validated against v24 field reference.
const ACCOUNTS_QUERY = `
  SELECT
    customer_client.client_customer,
    customer_client.id,
    customer_client.descriptive_name,
    customer_client.currency_code,
    customer_client.time_zone,
    customer_client.manager,
    customer_client.test_account,
    customer_client.status,
    customer_client.level
  FROM customer_client
  WHERE customer_client.status = 'ENABLED'
  ORDER BY customer_client.level, customer_client.descriptive_name
`.trim();

export interface AdsOsAccountSummary {
  customerId: string;
  descriptiveName: string;
  currencyCode: string | null;
  timeZone: string | null;
  isManager: boolean;
  isTestAccount: boolean;
  status: string | null;
  level: number;
}

export async function listMccAccounts(opts?: { includeManagers?: boolean }): Promise<AdsOsAccountSummary[]> {
  const mccId = getLoginCustomerId();
  if (!mccId) {
    throw new AdsOsCredsMissing("GOOGLE_ADS_LOGIN_CUSTOMER_ID is not set.");
  }

  const rows = await adsOsGaqlSearch(mccId, ACCOUNTS_QUERY);
  const accounts: AdsOsAccountSummary[] = [];

  for (const row of rows) {
    const cc = row.customerClient ?? row.customer_client ?? {};
    const level = cc.level ?? cc.Level ?? 0;
    if (level === 0) continue; // MCC itself
    const isManager = !!(cc.manager ?? cc.Manager);
    if (isManager && !opts?.includeManagers) continue;

    accounts.push({
      customerId: String(cc.id ?? cc.Id ?? ""),
      descriptiveName: cc.descriptiveName ?? cc.descriptive_name ?? `Account ${cc.id}`,
      currencyCode: cc.currencyCode ?? cc.currency_code ?? null,
      timeZone: cc.timeZone ?? cc.time_zone ?? null,
      isManager,
      isTestAccount: !!(cc.testAccount ?? cc.test_account),
      status: cc.status ?? null,
      level,
    });
  }

  return accounts;
}
