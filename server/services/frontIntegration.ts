// @db-pool-intent: mixed
// @cross-instance-safe: periodic spam-cleanup + client-matching sweeps are enqueue-only with dedupe-keyed work_queue jobs; duplicate enqueues collapse via wq_dedupe_key_idx.
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import { storage } from "../storage";
// @periodic-request-pool-exception: sanctioned mixed module (@db-pool-intent: mixed, audits/C-db-performance-findings.md P3b) — serves request-path Front API reads AND background sync; background paths route through workerDb/runWithWorkerDb.
import { db, workerDb, runWithWorkerDb, dbRetry, withDbAttribution, getDb } from "../db";
import { asc, sql, inArray, eq, max } from "drizzle-orm";
import { frontSyncEmails, workQueue, type FrontSyncEmail } from "@shared/schema";
import { bindArrayParam } from "../utils/sqlArray";
import { sourceEventLog } from "@shared/models/durablePipeline";
import { isKillSwitchEnabled } from "./killSwitches";
import {
  OAuthRefreshError,
  withSingleFlightOAuthRefresh,
  isAuthoritativeRefreshPurpose,
} from "./oauthRefresh";
import { getDefaultOAuthRefreshLease } from "./oauthRefreshLease";
import { resolveOsCanonicalHostname } from "./publicUrl";
import { stampThreadWideClientAttribution } from "./frontThreadAttribution";
import {
  frontAuthBreakerActive,
  frontAuthBreakerError,
  getFrontAuthState,
  isFrontAuthTerminalCode,
  recordFrontCallSuccess,
  resetFrontAuthBreaker,
  shouldLogFrontAuth,
  tripFrontAuthBreaker,
} from "./frontAuthBreaker";
import {
  recordFrontAuthDeath,
  markFrontAuthDeathRecovered,
  getLastFrontAuthDeath,
  type FrontAuthDeathRecord,
} from "./frontAuthDeathDiagnostics";
import crypto from "crypto";
import { PERF } from "../perfConfig";
import { frontSyncMatchStatuses, computeVersionKey } from "@shared/models/communications";

import {
  computeRateLimitPaceMs,
  parseFrontRateLimitHeaders,
  type FrontRateLimitSnapshot,
} from "./frontRateLimit";

const FRONT_API_BASE = "https://api2.frontapp.com";

/**
 * Task #2721 — latest Front rate-limit budget observed on any response from the
 * shared OAuth REST client. Surfaced so callers / diagnostics can read the
 * live per-company budget; updated on every response (2xx or error) that
 * carries the headers. In-memory + best-effort (resets on restart); the
 * authoritative brake is still the 429 / `Retry-After` retry path.
 */
let lastFrontRateLimit: FrontRateLimitSnapshot | null = null;

/** Read the most recent Front rate-limit snapshot, or null if none seen yet. */
export function getLastFrontRateLimitSnapshot(): FrontRateLimitSnapshot | null {
  return lastFrontRateLimit;
}
const FRONT_AUTH_URL = "https://app.frontapp.com/oauth/authorize";
const FRONT_TOKEN_URL = "https://app.frontapp.com/oauth/token";

const SETTINGS_KEY_ACCESS = "front_access_token";
const SETTINGS_KEY_REFRESH = "front_refresh_token";
const SETTINGS_KEY_EXPIRES = "front_token_expires_at";
const SETTINGS_KEY_OAUTH_STATE = "front_oauth_state";

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_RETRIES = 3;
const FETCH_RETRY_BASE_MS = 1000;

function getRedirectUri(): string {
  if (process.env.FRONT_REDIRECT_URI) return process.env.FRONT_REDIRECT_URI;
  // Task #3740: shared canonical OS host resolver — prefers reports.*, then a
  // custom non-marketing domain, so adding the marketing apex/www to the
  // deployment can never flip this redirect URI.
  const domain = resolveOsCanonicalHostname();
  if (!domain) throw new Error("REPLIT_DOMAINS not set — cannot build OAuth redirect URI");
  return `https://${domain}/api/integrations/front/callback`;
}

export async function getAuthorizationUrl(): Promise<string> {
  const clientId = process.env.FRONT_CLIENT_ID;
  if (!clientId) throw new Error("FRONT_CLIENT_ID not configured");

  const state = crypto.randomBytes(32).toString("hex");
  await storage.setSystemSetting(SETTINGS_KEY_OAUTH_STATE, state, "system");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    state,
  });
  return `${FRONT_AUTH_URL}?${params.toString()}`;
}

export async function validateOAuthState(state: string): Promise<boolean> {
  return withDbAttribution("oauth_callback:read_state", async () => {
    const stored = await storage.getSystemSetting(SETTINGS_KEY_OAUTH_STATE);
    if (!stored?.value || stored.value !== state) return false;
    await storage.setSystemSetting(SETTINGS_KEY_OAUTH_STATE, "", "system");
    return true;
  });
}

export async function exchangeCodeForToken(code: string, updatedBy?: string): Promise<{ access_token: string; refresh_token: string; expires_at: number }> {
  const clientId = process.env.FRONT_CLIENT_ID;
  const clientSecret = process.env.FRONT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Front OAuth credentials not configured");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  // Task #1849: external token exchange runs OUTSIDE any DB attribution
  // scope so a stuck provider can never hold an api-pool connection.
  const res = await fetch(FRONT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUri(),
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Front token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json() as any;
  await withDbAttribution("oauth_callback:persist_tokens", async () => {
    await storeTokens(data.access_token, data.refresh_token, data.expires_at, updatedBy, "connect");
  });
  return data;
}

async function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
  updatedBy?: string,
  event: "connect" | "refresh" = "refresh",
): Promise<void> {
  const actor = updatedBy ?? "system";
  await storage.setSystemSetting(SETTINGS_KEY_ACCESS, accessToken, actor);
  await storage.setSystemSetting(SETTINGS_KEY_REFRESH, refreshToken, actor);
  await storage.setSystemSetting(SETTINGS_KEY_EXPIRES, String(expiresAt), actor);
  // Task #2100 — a fresh token (operator reconnect via `connect`, or a
  // successful background `refresh`) means Front auth is healthy again.
  // Clear the auth-dead breaker so every Front surface resumes on the
  // next call without waiting out the cooldown window.
  resetFrontAuthBreaker();
  // Task #2435 — a fresh token is durable proof Front auth healed; annotate
  // any standing death as recovered so the Integrations-Hub history renders
  // a healed login-race blip as recovered instead of a permanent failure.
  void markFrontAuthDeathRecovered();
  try {
    await storage.recordAdminSettingChange({
      settingKey: SETTINGS_KEY_ACCESS,
      scope: event,
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: { event, expiresAt },
    });
  } catch (err: any) {
    console.error("[Front] credential audit insert failed:", err?.message);
  }
}

/**
 * Typed error thrown by the refresh-aware Front token accessor for
 * states that callers must distinguish (e.g. recovery worker classifies
 * `front_not_connected` as non-transient; transient refresh errors stay
 * transient). Carries an internal code so admin UIs and the historical
 * recovery worker can map to stable messages without string parsing.
 */
export type FrontAuthErrorCode =
  | "front_not_connected"
  | "front_no_refresh_token"
  | "front_refresh_failed_permanent"
  | "front_refresh_failed_transient";

export class FrontAuthError extends Error {
  readonly code: FrontAuthErrorCode;
  readonly status?: number;
  constructor(code: FrontAuthErrorCode, message: string, status?: number) {
    super(message);
    this.name = "FrontAuthError";
    this.code = code;
    this.status = status;
  }
}

async function getAccessToken(): Promise<string> {
  try {
    return await getValidFrontAccessToken({ purpose: "internal" });
  } catch (err) {
    if (err instanceof FrontAuthError && err.code === "front_not_connected") {
      // Preserve the legacy human message for existing call sites that
      // surface it directly to admins.
      throw new Error("Front not connected. Please authorize via Settings → Integrations.");
    }
    throw err;
  }
}

/**
 * Refresh-aware Front access-token accessor used by every Front API
 * call path (sync, webhook reconciliation, historical recovery, etc).
 *
 * Behavior:
 * - If no access token AND no refresh token are stored → throws
 *   `FrontAuthError("front_not_connected")`. The recovery worker maps
 *   this to "Front is not connected. Reconnect Front before continuing."
 * - If the access token is expired / within 5 min of expiry, OR the
 *   caller passes `forceRefresh: true` (used after a mid-run 401),
 *   refreshes via the OAuth refresh token.
 * - Refresh transport failures (network/timeout/5xx) become
 *   `FrontAuthError("front_refresh_failed_transient")` so callers can
 *   retry. Refresh 4xx (revoked / invalid_grant) becomes
 *   `FrontAuthError("front_refresh_failed_permanent")` so callers
 *   surface a real "reconnect" state instead of looping retries.
 *
 * Cheap when the cached token is still valid — safe to call before
 * every page request.
 */
export async function getValidFrontAccessToken(
  options?: {
    forceRefresh?: boolean;
    purpose?: string;
    /**
     * Optional callback invoked whenever the accessor performed a token
     * refresh during this call (either expiry-driven or `forceRefresh`).
     * Used by the historical recovery worker to log every mid-run
     * refresh, not just 401-triggered ones.
     */
    onRefresh?: (info: { reason: "expiry" | "forced"; purpose?: string }) => void;
    /**
     * Task #2100 — when true, ignore an open auth breaker. Only the
     * Integrations-Hub `/me` probe sets this: the probe is the dedicated
     * recovery path that detects an operator reconnect and clears the
     * breaker, so it must be allowed through even while every other
     * Front surface is backed off.
     */
    bypassBreaker?: boolean;
  },
): Promise<string> {
  // Task #2100 — global auth-dead backoff. While the breaker is open
  // (Front's refresh token is terminally rejected), short-circuit every
  // token acquisition without touching the network so live sync, webhook
  // apply, historical recovery and analytics refresh all stop hammering
  // the OAuth token endpoint and the `/me` 401-refresh path. Do NOT
  // re-trip here — re-tripping on the short-circuit would extend the
  // window forever and never let the breaker auto-close.
  if (!options?.bypassBreaker && frontAuthBreakerActive()) {
    throw new FrontAuthError("front_not_connected", frontAuthBreakerError().message);
  }

  try {
    const token = await acquireValidFrontAccessToken(options);
    // Record the success for telemetry, but do NOT reset the breaker here.
    // A returned token can be a locally-unexpired *cached* access token that
    // is actually revoked server-side, so a successful accessor return does
    // not prove Front auth is healthy. The breaker is cleared only by a real
    // token persistence (`storeTokens`, after a successful refresh/connect)
    // or a successful `/me` probe (2xx) — both of which confirm the live
    // credential works. Resetting on a cached read would re-enable the flood.
    recordFrontCallSuccess();
    return token;
  } catch (err) {
    if (err instanceof FrontAuthError && isFrontAuthTerminalCode(err.code)) {
      // Task #2267 — only an authoritative, on-demand refresh may commit
      // the auth-dead state (trip the global breaker + persist a death
      // record). The `/me` probe and any pre-expiry proactive top-up are
      // observational: when one loses a refresh-token rotation race it
      // 4xx's `invalid_grant` on a captured-but-already-consumed token.
      // Tripping the breaker from that would back off every healthy Front
      // surface, and recording a death record would make the Hub display
      // "Front died" for a connection another instance just rotated. The
      // probe is the dedicated recovery path (it resets the breaker on a
      // 2xx `/me`); it must surface `unauthorized` WITHOUT engaging the
      // backoff. Real surfaces (live sync, webhook apply, recovery) still
      // trip the breaker when they hit the same terminal failure.
      if (isAuthoritativeRefreshPurpose(options?.purpose)) {
        tripFrontAuthBreaker(err.code);
        // Task #2142 — capture a durable death record (HTTP status, body
        // snippet, environment, last successful Front call) so the
        // Integrations Hub can show *why* Front last died, not just that it
        // did. Fire-and-forget: persistence must never break this catch path.
        void recordFrontAuthDeath({
          code: err.code,
          httpStatus: err.status ?? null,
          bodySnippet: err.message ?? null,
          lastSuccessAt: getFrontAuthState().lastSuccessAt,
        });
      } else {
        console.warn(
          `[Front] Terminal auth (${err.code}) on non-authoritative '${options?.purpose}' attempt — NOT tripping breaker or recording death (rotation-race safe); surfacing to caller.`,
        );
      }
    }
    throw err;
  }
}

async function acquireValidFrontAccessToken(
  options?: {
    forceRefresh?: boolean;
    purpose?: string;
    onRefresh?: (info: { reason: "expiry" | "forced"; purpose?: string }) => void;
  },
): Promise<string> {
  let tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  let expiresSetting = await storage.getSystemSetting(SETTINGS_KEY_EXPIRES);
  let refreshSetting = await storage.getSystemSetting(SETTINGS_KEY_REFRESH);

  // Task #2416 — confirm-before-trip. A falsy cached read of BOTH tokens on
  // this hot path is NOT proof the operator disconnected: it can be a stale
  // negative cache sentinel or a transient empty read under the DB/worker-pool
  // saturation that produced the false "Reconnect Required" trips. Throwing
  // the TERMINAL `front_not_connected` here trips the auth-dead breaker on
  // every authoritative surface (live sync, webhook apply, recovery) and
  // flips the Hub badge. Before declaring the disconnect, re-read BOTH tokens
  // authoritatively (cache-bypassing) and only treat absence as real when it
  // is CONFIRMED (no access AND no refresh token). A re-read that itself
  // throws is UNKNOWN, not absent → surface a transient/retryable error
  // (non-terminal code, never trips the breaker) so the caller retries
  // instead of disconnecting. Mirrors the SEMrush guarantee (Task #2412).
  if (!tokenSetting?.value && !refreshSetting?.value) {
    let freshAccess: Awaited<ReturnType<typeof storage.getSystemSettingFresh>>;
    let freshRefresh: Awaited<ReturnType<typeof storage.getSystemSettingFresh>>;
    let freshExpires: Awaited<ReturnType<typeof storage.getSystemSettingFresh>>;
    try {
      [freshAccess, freshRefresh, freshExpires] = await Promise.all([
        storage.getSystemSettingFresh(SETTINGS_KEY_ACCESS),
        storage.getSystemSettingFresh(SETTINGS_KEY_REFRESH),
        storage.getSystemSettingFresh(SETTINGS_KEY_EXPIRES),
      ]);
    } catch (err: any) {
      // State 3 (UNKNOWN): the authoritative read itself failed. Absence is
      // NOT confirmed — surface a transient/retryable error so the caller
      // retries instead of declaring Front disconnected. Must be the
      // non-terminal `front_refresh_failed_transient` code (never in
      // TERMINAL_FRONT_AUTH_CODES), NOT `front_not_connected`, or
      // `getValidFrontAccessToken` would trip the breaker on a failed read —
      // the exact false disconnect this fix prevents.
      throw new FrontAuthError(
        "front_refresh_failed_transient",
        `Front connection state unknown — token read failed, will retry (no disconnect declared): ${err?.message ?? err}`,
      );
    }
    if (!freshAccess?.value && !freshRefresh?.value) {
      // State 2 (CONFIRMED empty): no access AND no refresh token via an
      // authoritative cache-bypassing re-read. A genuine disconnect — log the
      // observed signal so any future trip is diagnosable from logs alone.
      console.error(
        "[Front] Terminal auth (front_not_connected) — confirmed absence after cache-bypassing re-read: accessPresent=false refreshPresent=false",
      );
      throw new FrontAuthError(
        "front_not_connected",
        "Front is not connected. Reconnect Front before continuing.",
      );
    }
    // Stale cache: at least one token is actually present. Adopt the
    // authoritative values and continue — a valid access token is returned
    // below; an access-absent-but-refresh-present state routes to the refresh
    // path below instead of declaring the integration dead.
    tokenSetting = freshAccess ?? tokenSetting;
    refreshSetting = freshRefresh ?? refreshSetting;
    expiresSetting = freshExpires ?? expiresSetting;
  }

  const expiresAt = Number(expiresSetting?.value || 0);
  const now = Math.floor(Date.now() / 1000);
  const needsRefresh =
    options?.forceRefresh === true ||
    !tokenSetting?.value ||
    (expiresAt > 0 && now >= expiresAt - 300);

  if (!needsRefresh && tokenSetting?.value) {
    return tokenSetting.value;
  }

  if (!refreshSetting?.value) {
    // Strict policy (Task #1015): a missing refresh token is a true
    // disconnect — surface it immediately rather than waiting for the
    // current access token to expire or 401. The OAuth exchange always
    // stores both tokens together, so this state means the operator
    // must reconnect Front.
    throw new FrontAuthError(
      "front_no_refresh_token",
      "Front refresh token is missing. Reconnect Front before continuing.",
    );
  }

  const refreshed = await refreshAccessToken({ purpose: options?.purpose });
  try {
    options?.onRefresh?.({
      reason: options?.forceRefresh === true ? "forced" : "expiry",
      purpose: options?.purpose,
    });
  } catch {
    // onRefresh is observability-only; never let a callback throw
    // bubble up and break the recovery worker.
  }
  return refreshed;
}

// Task #1869 Step 1 / Task #1975 — Per-process single-flight guard for
// the Front OAuth refresh. Front rotates `refresh_token` on every
// refresh response; without a lock, two concurrent refreshers race and
// the loser gets `invalid_grant` against a token the winner already
// consumed. We previously classified that 4xx as
// `front_refresh_failed_permanent` and the recovery worker treated the
// window as `blocked`/`front_not_connected` even though Front was
// perfectly connected.
//
// Task #1975: the single-flight + re-read-and-retry pattern now lives
// in `withSingleFlightOAuthRefresh` so every integration that holds a
// rotating refresh token (Zoom, Google Ads, SEMrush) gets the same
// protection by construction. This wrapper unwraps the helper's
// `OAuthRefreshError` back into the legacy `FrontAuthError` so callers
// (historical recovery worker, admin badges) keep their existing
// classification contract.
async function refreshAccessToken(opts?: { purpose?: string }): Promise<string> {
  try {
    return await withSingleFlightOAuthRefresh<string>({
      integration: "front",
      purpose: opts?.purpose,
      // Task #2435 — bounded wait-and-re-read before declaring a terminal
      // refresh a permanent death. The cross-process lease serializes
      // refreshers, but a loser can still re-read the stored token in the
      // instant BEFORE the winning sibling persists the freshly-rotated one
      // (Front rotates only in the last-24h window), see a still-consumed
      // token, and surface a false `front_refresh_failed_permanent` that
      // trips the breaker and records a permanent-looking death. Polling a
      // few extra times (~3 × 150ms) lets the winner's `storeTokens` land so
      // the retry picks up the rotated token. A true revocation never
      // rotates, exhausts the window, and is still declared dead.
      terminalRotationRecheck: { attempts: 3, delayMs: 150 },
      // Task #2289 — cross-process refresh lease. Prod runs on autoscale
      // (N instances) and, before Task #2289, the workspace process too;
      // each had its own in-memory single-flight, so two processes could
      // refresh at once. Inside Front's last-24h refresh-token rotation
      // window (per dev.frontapp.com/docs/oauth: same token returned during
      // the 6-month validity, NEW token only in the final 24h) the loser
      // POSTed a consumed token and got `invalid_grant` (HTTP 400),
      // tripping the auth-dead breaker for a connection a sibling had just
      // rotated healthy. The lease serializes every process to one
      // refresher at a time; the recheck below skips a wasteful second POST
      // when a sibling refreshed while we waited for the lease.
      crossProcessLease: getDefaultOAuthRefreshLease(),
      onLeaseAcquiredRecheck: async () => {
        const [accessSetting, expiresSetting] = await Promise.all([
          storage.getSystemSetting(SETTINGS_KEY_ACCESS),
          storage.getSystemSetting(SETTINGS_KEY_EXPIRES),
        ]);
        const access = accessSetting?.value;
        if (!access) return null;
        const expiresAt = Number(expiresSetting?.value || 0);
        const now = Math.floor(Date.now() / 1000);
        // Same pre-expiry skew the accessor uses (300s). If a sibling
        // refreshed while we waited, the stored access token is now valid.
        if (expiresAt > 0 && now < expiresAt - 300) return access;
        return null;
      },
      readRefreshToken: async () =>
        (await storage.getSystemSetting(SETTINGS_KEY_REFRESH))?.value ?? null,
      refreshOnce: async ({ refreshToken }) => {
        try {
          const data = await performTokenRefreshPost(refreshToken, opts);
          await storeTokens(
            data.access_token,
            data.refresh_token || refreshToken,
            data.expires_at,
            undefined,
            "refresh",
          );
          return data.access_token;
        } catch (err) {
          if (err instanceof FrontAuthError) {
            const outcome: "terminal" | "transient" =
              err.code === "front_refresh_failed_permanent" ? "terminal" : "transient";
            throw new OAuthRefreshError("front", outcome, err.message, {
              status: err.status,
              cause: err,
            });
          }
          throw err;
        }
      },
    });
  } catch (err) {
    if (err instanceof OAuthRefreshError) {
      if (err.cause instanceof FrontAuthError) throw err.cause;
      // No `cause` → the helper raised it itself (e.g. missing refresh
      // token). Map back to the legacy code so the recovery worker
      // surfaces "reconnect Front" rather than a generic OAuth message.
      if (err.outcome === "terminal" && !err.cause) {
        throw new FrontAuthError("front_no_refresh_token", err.message);
      }
      throw new FrontAuthError(
        err.outcome === "terminal"
          ? "front_refresh_failed_permanent"
          : "front_refresh_failed_transient",
        err.message,
        err.status,
      );
    }
    throw err;
  }
}

async function performTokenRefreshPost(
  refreshToken: string,
  opts?: { purpose?: string },
): Promise<{ access_token: string; refresh_token?: string; expires_at: number }> {
  const clientId = process.env.FRONT_CLIENT_ID;
  const clientSecret = process.env.FRONT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Front OAuth credentials not configured");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(FRONT_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    throw new FrontAuthError(
      "front_refresh_failed_transient",
      `Front token refresh transport error${opts?.purpose ? ` (${opts.purpose})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    if (res.status >= 500) {
      throw new FrontAuthError(
        "front_refresh_failed_transient",
        `Front token refresh ${res.status}${opts?.purpose ? ` (${opts.purpose})` : ""}: ${snippet || "<empty body>"}`,
        res.status,
      );
    }
    throw new FrontAuthError(
      "front_refresh_failed_permanent",
      `Front token refresh ${res.status}${opts?.purpose ? ` (${opts.purpose})` : ""}: ${snippet || "<empty body>"}`,
      res.status,
    );
  }

  return await res.json() as any;
}

// Task #1975: the per-process single-flight + re-read-and-retry path
// that previously lived here moved into `withSingleFlightOAuthRefresh`
// in `oauthRefresh.ts` and is invoked from `refreshAccessToken` above.

function isTransientError(err: unknown): boolean {
  if (err instanceof TypeError && err.message.includes("fetch failed")) return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (/cycle timeout/i.test(msg)) return false;
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|network|aborted/i.test(msg);
}

const MAX_429_RETRIES = 5;

async function frontApiRequest(
  path: string,
  attempt = 0,
  parentSignal?: AbortSignal,
  onRetry?: () => void,
  forceRefreshAlreadyTried = false,
): Promise<any> {
  // Only audit the top-level call (attempt 0). Internal retries are part
  // of the same logical outbound call from the operator's POV.
  if (attempt === 0) {
    const { auditOutboundCall } = await import("./externalCallAudit");
    const { createHash } = await import("node:crypto");
    let pathOnly = path;
    const params: Record<string, string> = {};
    const qIdx = path.indexOf("?");
    if (qIdx >= 0) {
      pathOnly = path.slice(0, qIdx);
      const search = new URLSearchParams(path.slice(qIdx + 1));
      for (const [k, v] of search.entries()) params[k] = v;
    }
    return auditOutboundCall(
      { integration: "front", endpoint: pathOnly, method: "GET", dedupeParams: params },
      async () => {
        const data = await frontApiRequestImpl(path, attempt, parentSignal, onRetry, forceRefreshAlreadyTried);
        const payload = data === undefined ? "" : JSON.stringify(data);
        const bytes = Buffer.byteLength(payload, "utf8");
        const hash = bytes > 0
          ? createHash("sha256").update(payload).digest("hex").slice(0, 64)
          : undefined;
        return { value: data, statusCode: 200, responseSizeBytes: bytes, responseHash: hash };
      },
    );
  }
  return frontApiRequestImpl(path, attempt, parentSignal, onRetry, forceRefreshAlreadyTried);
}

async function frontApiRequestImpl(
  path: string,
  attempt = 0,
  parentSignal?: AbortSignal,
  onRetry?: () => void,
  forceRefreshAlreadyTried = false,
): Promise<any> {
  if (parentSignal?.aborted) {
    throw new Error("Request aborted: cycle timeout");
  }

  let token: string;
  try {
    token = await getValidFrontAccessToken({ purpose: "front_sync" });
  } catch (err) {
    if (err instanceof FrontAuthError && err.code === "front_not_connected") {
      // Preserve the legacy human message for true disconnects.
      throw new Error("Front not connected. Please authorize via Settings → Integrations.");
    }
    throw err;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const res = await fetch(`${FRONT_API_BASE}${path}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });

    // Task #2721 — record the live rate-limit budget off EVERY response
    // (success or error) so it can be surfaced/diagnosed and so the success
    // path below can self-pace before an actual 429.
    const rateLimit = parseFrontRateLimitHeaders(res);
    if (rateLimit.remaining != null || rateLimit.limit != null) {
      lastFrontRateLimit = rateLimit;
    }

    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) {
        throw new Error(`Front API rate limited after ${MAX_429_RETRIES} retries`);
      }
      const retryAfter = Number(res.headers.get("Retry-After") || 5);
      console.log(`[Front] Rate limited (attempt ${attempt + 1}/${MAX_429_RETRIES}), retrying in ${retryAfter}s`);
      onRetry?.();
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      if (parentSignal?.aborted) throw new Error("Request aborted: cycle timeout");
      return frontApiRequestImpl(path, attempt + 1, parentSignal, onRetry, forceRefreshAlreadyTried);
    }

    if (res.status === 401 && !forceRefreshAlreadyTried) {
      // One-shot forced refresh after a mid-cycle 401 — handles the case
      // where the cached access token was invalidated (rotated, revoked
      // server-side, etc) while still appearing unexpired locally.
      const text = await res.text().catch(() => "");
      const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      // Task #2100 — throttle the per-page 401-refresh warn. Under a
      // revoked-token flood every page 401s, so this line would print
      // thousands of times before the breaker trips. Cap it to one line
      // per breaker window.
      if (shouldLogFrontAuth("front_sync_401_refresh")) {
        console.warn(`[Front] Forced token refresh after 401 on ${path}: ${snippet}`);
      }
      try {
        await getValidFrontAccessToken({ forceRefresh: true, purpose: "front_sync" });
      } catch (err) {
        if (err instanceof FrontAuthError && err.code === "front_not_connected") {
          throw new Error("Front not connected. Please authorize via Settings → Integrations.");
        }
        throw err;
      }
      onRetry?.();
      if (parentSignal?.aborted) throw new Error("Request aborted: cycle timeout");
      // Retry the same page without consuming a regular attempt slot.
      return frontApiRequestImpl(path, attempt, parentSignal, onRetry, true);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Front API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    // Task #2721 — proactive self-pacing. When Front's live remaining budget is
    // low, sleep before returning so the caller's next request is throttled
    // ahead of an actual 429. No-op when the budget is healthy or the headers
    // are absent, so normal operation is unchanged.
    const paceMs = computeRateLimitPaceMs(rateLimit, Date.now());
    if (paceMs > 0) {
      if (parentSignal?.aborted) throw new Error("Request aborted: cycle timeout");
      await new Promise(r => setTimeout(r, paceMs));
    }
    return data;
  } catch (err: unknown) {
    if (parentSignal?.aborted) {
      throw new Error("Request aborted: cycle timeout");
    }
    if (isTransientError(err) && attempt < FETCH_MAX_RETRIES - 1) {
      const delay = FETCH_RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[Front] Transient error (attempt ${attempt + 1}/${FETCH_MAX_RETRIES}), retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
      onRetry?.();
      await new Promise(r => setTimeout(r, delay));
      if (parentSignal?.aborted) throw new Error("Request aborted: cycle timeout");
      return frontApiRequestImpl(path, attempt + 1, parentSignal, onRetry, forceRefreshAlreadyTried);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export async function isConnected(): Promise<boolean> {
  const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  return !!tokenSetting?.value;
}

/**
 * Task #1861 — Three-state probe outcome.
 *
 * - `connected`     → Front `/me` returned 2xx.
 * - `unauthorized`  → Front confirmed the token is bad: `/me` returned
 *                     401, or the refresh path threw a *permanent*
 *                     `FrontAuthError` (`front_refresh_failed_permanent`
 *                     / `front_no_refresh_token` / `front_not_connected`).
 *                     Operator must reconnect Front.
 * - `probe_failed`  → We couldn't reach Front: 5xx, 429, network /
 *                     timeout, `front_refresh_failed_transient`, or any
 *                     other unclassified throw. The cache layer treats
 *                     this as "preserve last-known-good" so a transient
 *                     blip never flips the badge to "Not Connected".
 *
 * The generic shape is intentionally reusable — every integration's
 * probe is a "did the upstream confirm bad creds, or did we just fail
 * to reach it?" decision. Task #1861 wires it for Front only; Zoom /
 * Slack / Google Ads / etc. can opt in later.
 */
export type ProbeOutcome = "connected" | "unauthorized" | "probe_failed";

export interface FrontProbeResult {
  outcome: ProbeOutcome;
  /** Underlying HTTP status (for `/me` responses) when available. */
  status?: number;
  /** Short, structured reason — safe to render in logs/UI. */
  reason?: string;
}

/**
 * Task #1861 — Classify a Front `/me` probe into one of three outcomes.
 *
 * Replaces the previous boolean `validateConnection()` for the
 * Integrations-Hub badge path. `validateConnection()` is preserved as
 * a thin adapter for legacy callers that still want `{ valid, error }`.
 */
export async function probeConnection(): Promise<FrontProbeResult> {
  const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  const refreshSetting = await storage.getSystemSetting(SETTINGS_KEY_REFRESH);
  if (!tokenSetting?.value && !refreshSetting?.value) {
    return { outcome: "unauthorized", reason: "no_tokens_stored" };
  }

  let token: string;
  try {
    // Task #2100 — the probe is the dedicated recovery path: it must run
    // even while the auth-dead breaker is open so an operator reconnect
    // is detected and the breaker cleared. Bypass the breaker and call
    // the validating accessor directly. Task #2267 — the `front_probe`
    // purpose is non-authoritative, so a terminal refresh here surfaces
    // `unauthorized` WITHOUT tripping the breaker or recording a death
    // record (a rotation-race blip must not back off healthy surfaces).
    token = await getValidFrontAccessToken({ purpose: "front_probe", bypassBreaker: true });
  } catch (err: any) {
    // Map FrontAuthError codes to outcomes. Transport-level refresh
    // failures (5xx / network) are transient → probe_failed. Permanent
    // refresh failures (401 / invalid_grant) and "not connected"
    // states are real disconnects → unauthorized.
    if (err instanceof FrontAuthError) {
      switch (err.code) {
        case "front_refresh_failed_transient":
          return {
            outcome: "probe_failed",
            status: err.status,
            reason: `refresh_transient${err.status ? `_${err.status}` : ""}`,
          };
        case "front_refresh_failed_permanent":
          // Task #2500 — a TERMINAL refresh on the non-authoritative
          // `front_probe` purpose is the deploy-time rotation-race case:
          // #2267's gate in getValidFrontAccessToken deliberately did NOT
          // trip the breaker or record a death for it. Surfacing
          // `unauthorized` here flips the Hub badge to Not Connected for
          // ~15s after a publish on a connection a sibling instance just
          // rotated healthy. Preserve the last-known-good badge
          // (probe_failed) UNLESS the DURABLE auth-dead breaker is already
          // open — i.e. an AUTHORITATIVE Front surface (live sync / webhook
          // apply / recovery) confirmed the death — in which case reflect
          // that durable disconnect. A genuine revocation with a still-cached
          // (not-yet-refreshed) access token is still caught by the `/me` 401
          // path below.
          if (frontAuthBreakerActive()) {
            return {
              outcome: "unauthorized",
              status: err.status,
              reason: `refresh_permanent${err.status ? `_${err.status}` : ""}`,
            };
          }
          return {
            outcome: "probe_failed",
            status: err.status,
            reason: `refresh_permanent${err.status ? `_${err.status}` : ""}`,
          };
        case "front_no_refresh_token":
        case "front_not_connected":
          return { outcome: "unauthorized", reason: err.code };
      }
    }
    // Unknown throw from the legacy `getAccessToken` "Front not
    // connected" branch — match its historical meaning.
    if (typeof err?.message === "string" && err.message.startsWith("Front not connected")) {
      return { outcome: "unauthorized", reason: "front_not_connected" };
    }
    return {
      outcome: "probe_failed",
      reason: `token_accessor_error: ${err?.message ?? "unknown"}`,
    };
  }

  // Issue the actual `/me` call with a short timeout so a hung Front
  // never holds the worker-pool refresh past the polling cadence.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${FRONT_API_BASE}/me`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
  } catch (err: any) {
    const aborted = err?.name === "AbortError";
    return {
      outcome: "probe_failed",
      reason: aborted ? "network_timeout" : `network_error: ${err?.message ?? "unknown"}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    return { outcome: "unauthorized", status: 401, reason: "http_401" };
  }
  if (res.status === 429) {
    return { outcome: "probe_failed", status: 429, reason: "http_429" };
  }
  if (res.status >= 500) {
    return { outcome: "probe_failed", status: res.status, reason: `http_${res.status}` };
  }
  if (!res.ok) {
    // 4xx other than 401/429 — conservative: treat as probe_failed so
    // we don't false-flip on a Front-side API regression. The auth
    // disconnect path is exclusively 401 + permanent refresh failure.
    return { outcome: "probe_failed", status: res.status, reason: `http_${res.status}` };
  }
  // Task #2100 — a healthy `/me` means Front auth is working: clear the
  // breaker so every backed-off Front surface resumes immediately and
  // the Integrations-Hub UI flips back to connected on the next poll.
  recordFrontCallSuccess();
  resetFrontAuthBreaker();
  // Task #2435 — a healthy `/me` is durable proof Front auth recovered;
  // annotate any standing death so the history panel renders it as healed.
  void markFrontAuthDeathRecovered();
  return { outcome: "connected", status: res.status };
}

/**
 * Legacy adapter — returns the historical `{ valid, error }` shape.
 * New code should call `probeConnection()` directly and act on the
 * three-way outcome.
 *
 * Mapping: `connected` → `{ valid: true }`. Both `unauthorized` and
 * `probe_failed` → `{ valid: false, error }` so existing callers that
 * only care about the boolean keep behaving exactly as before — except
 * the Integrations-Hub loader, which now consumes `probeConnection()`
 * directly and uses the cache's preserve-on-failure path.
 */
export async function validateConnection(): Promise<{ valid: boolean; error?: string }> {
  const probe = await probeConnection();
  if (probe.outcome === "connected") return { valid: true };
  return {
    valid: false,
    error: probe.reason
      ? `Front probe ${probe.outcome}: ${probe.reason}`
      : `Front probe ${probe.outcome}`,
  };
}

// Task #1977 — match the Slack/Zoom trigger taxonomy so the credential
// history can tell a manual disconnect apart from any future
// terminal-auth self-wipe.
export type FrontTokenClearTrigger =
  | "manual_disconnect"
  | "connect_terminal_auth_error";

// Task #2240 — in-memory credential override (test-only).
//
// Front stores its OAuth credential in the shared `system_settings`
// table, which the always-on "Start application" Front worker keeps
// re-writing in the `public` schema (it refreshes the real token on its
// own cadence). The `front-disconnect-audit` suite seeds a *fake* token
// and asserts disconnect clears it; against the shared dev DB that
// refresh races the assertion and re-seeds a real `eyJ…` JWT. When this
// override is installed (only by that suite) the disconnect path's
// credential clears go to the in-memory map instead of `system_settings`,
// so the suite owns the credential state outright and never touches a row
// the dev server also writes. Production never installs it. Mirrors the
// `setStateOverrideForTests` pattern in frontAutoClosureRegressionAlerts.ts.
let credentialStoreOverride: Map<string, string> | null = null;

export function __setFrontCredentialStoreOverrideForTests(
  store: Map<string, string> | null,
): void {
  credentialStoreOverride = store;
}

// Task #3128 — named counter for wipe/disconnect audit-write failures
// (mirrors semrushApi.ts, Task #3126). The disconnect breadcrumb is the ONLY
// durable record of a Front credential wipe; if its INSERT throws (e.g. DB
// pool exhausted), the failure must not vanish into autoscale console logs
// that expire with the deployment window. The paired low-severity operator
// alert (dedupeKey "wipe_audit_write_failed") is the durable signal; this
// counter gives tests and any in-process health surface a deterministic hook.
export const FRONT_WIPE_AUDIT_WRITE_FAILED_COUNTER = "front.wipe_audit_write_failed";
let __wipeAuditWriteFailedCount = 0;

/** Current value of the front.wipe_audit_write_failed counter (per-process). */
export function getFrontWipeAuditWriteFailedCount(): number {
  return __wipeAuditWriteFailedCount;
}

/** Test-only: reset the wipe-audit-write-failed counter. */
export function __resetFrontWipeAuditWriteFailedCountForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetFrontWipeAuditWriteFailedCountForTest is test-only");
  }
  __wipeAuditWriteFailedCount = 0;
}

// Task #3128 — injectable notify override for the audit-write-failure alert
// so tests can intercept the call without ESM live-binding issues (mirrors
// __setWipeNotifyOverrideForTest in semrushApi.ts). Production always uses
// the real dynamic-import path (override is null in production).
let __wipeAuditNotifyOverrideForTest:
  | ((id: string, payload: any, opts: any) => Promise<void>)
  | null = null;

export function __setFrontWipeAuditNotifyOverrideForTest(
  fn: ((id: string, payload: any, opts: any) => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setFrontWipeAuditNotifyOverrideForTest is test-only");
  }
  __wipeAuditNotifyOverrideForTest = fn;
}

async function clearCredentialSetting(key: string, actor: string): Promise<void> {
  if (credentialStoreOverride) {
    credentialStoreOverride.set(key, "");
    return;
  }
  await storage.setSystemSetting(key, "", actor);
}

export async function disconnect(
  updatedBy?: string,
  options?: { trigger?: FrontTokenClearTrigger; reason?: string | null; notes?: string | null },
): Promise<void> {
  stopAllIntervals();
  const actor = updatedBy ?? "system";
  const trigger: FrontTokenClearTrigger = options?.trigger ?? "manual_disconnect";
  await clearCredentialSetting(SETTINGS_KEY_ACCESS, actor);
  await clearCredentialSetting(SETTINGS_KEY_REFRESH, actor);
  await clearCredentialSetting(SETTINGS_KEY_EXPIRES, actor);
  await clearCredentialSetting(SETTINGS_KEY_OAUTH_STATE, actor);
  try {
    await storage.recordAdminSettingChange({
      settingKey: SETTINGS_KEY_ACCESS,
      scope: trigger,
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: {
        event: "disconnect",
        trigger,
        reason: options?.reason ?? null,
        notes: options?.notes ?? null,
      },
    });
  } catch (err: any) {
    // Task #3128 — an audit-write failure must not vanish into console logs
    // (autoscale logs expire with the deployment window). Bump the named
    // counter and fire a dedicated low-severity operator alert with its OWN
    // dedupeKey so the audit gap around a credential wipe stays visible.
    __wipeAuditWriteFailedCount += 1;
    console.error(
      `[Front] ${FRONT_WIPE_AUDIT_WRITE_FAILED_COUNTER} count=${__wipeAuditWriteFailedCount} — disconnect audit insert failed:`,
      err?.message,
    );
    try {
      const auditAlertPayload = {
        text:
          `*Front credential-wipe audit breadcrumb FAILED to persist* — the token clear itself succeeded, ` +
          `but the durable audit record could not be written (counter: \`${FRONT_WIPE_AUDIT_WRITE_FAILED_COUNTER}\`).\n` +
          `Trigger: \`${trigger}\`  Actor: \`${actor}\`\n` +
          `Reason: ${String(options?.reason ?? "n/a").slice(0, 300)}\n` +
          `Audit error: ${String(err?.message ?? err).slice(0, 300)}\n` +
          `Post-mortem attribution for this wipe now exists ONLY in this alert — preserve it if investigating.`,
      };
      const auditAlertOpts = {
        triggerSource: "scheduled" as const,
        dedupeKey: "wipe_audit_write_failed",
      };
      if (__wipeAuditNotifyOverrideForTest) {
        await __wipeAuditNotifyOverrideForTest(
          "integration.front.auth_failed",
          auditAlertPayload,
          auditAlertOpts,
        );
      } else {
        const { notifyByType } = await import("./notifications/dispatcher");
        await notifyByType(
          "integration.front.auth_failed",
          auditAlertPayload,
          auditAlertOpts,
        );
      }
    } catch (metaErr: any) {
      console.warn(
        "[Front] wipe-audit-failure alert failed (non-fatal):",
        metaErr?.message ?? metaErr,
      );
    }
  }
  console.log("[Front] Disconnected — all tokens and sync state cleared");
}

function stopAllIntervals(): void {
  if (clientMatchingIntervalId) {
    clearInterval(clientMatchingIntervalId);
    clientMatchingIntervalId = null;
  }
  console.log("[Front] All maintenance intervals stopped");
}

export async function listInboxes(): Promise<any[]> {
  const data = await frontApiRequest("/inboxes");
  return data._results || [];
}

export async function listTags(): Promise<any[]> {
  const data = await frontApiRequest("/tags");
  return data._results || [];
}

// ── Outbound send (Task #4334) ───────────────────────────────────────────────

/**
 * Channels the Front company token can send from. Used by the outbound-email
 * admin surface to map each user to their own-mailbox channel. Small list;
 * paginated defensively (Front pages at 50).
 */
export async function listFrontChannels(): Promise<any[]> {
  const results: any[] = [];
  let path: string | null = "/channels";
  for (let page = 0; page < 10 && path; page++) {
    const data = await frontApiRequest(path);
    results.push(...(data._results || []));
    const next: string | undefined = data._pagination?.next;
    // `next` is a fully-qualified URL; keep only the path+query for the
    // adapter's base-prefixed request helper.
    path = next ? next.replace(FRONT_API_BASE, "") : null;
  }
  return results;
}

/**
 * Thrown when a send's outcome is ambiguous: the request may have reached
 * Front (timeout mid-flight, connection reset after the request was written).
 * Callers must treat this as terminal-by-policy — alert and never auto-retry,
 * because retrying an ambiguous send is exactly how duplicates happen.
 */
export class FrontSendOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontSendOutcomeUnknownError";
  }
}

/** Thrown on a definitive vendor rejection (4xx response). Never ambiguous. */
export class FrontSendRejectedError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FrontSendRejectedError";
    this.status = status;
  }
}

function unwrapErrnoCode(err: unknown): string | undefined {
  let cur: any = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (typeof cur.code === "string") return cur.code;
    cur = cur.cause;
  }
  return undefined;
}

// Errors raised before a connection existed — the request provably never
// reached Front, so the caller may safely treat the send as not-attempted.
const PRE_CONNECTION_ERRNOS = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]);

export interface FrontSendMessageParams {
  channelId: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  /** Correlation id (outbound_emails.id) for the external-call audit trail. */
  sendId?: string;
}

export interface FrontSendMessageResult {
  messageUid: string | null;
  status: number;
}

/**
 * Send one email from a user's own-mailbox channel: POST /channels/{id}/messages.
 *
 * Retry semantics are deliberately NARROWER than the GET path
 * (frontApiRequestImpl): a message create is not idempotent, so the only
 * in-function retries are for responses that prove Front did NOT process the
 * request — 429 (rate limited) and one forced-refresh pass after a definitive
 * 401. Timeouts and mid-flight connection failures throw
 * FrontSendOutcomeUnknownError; pre-connection failures throw a plain Error
 * (safe for the caller to classify as a definitive transport failure).
 */
export async function sendFrontChannelMessage(params: FrontSendMessageParams): Promise<FrontSendMessageResult> {
  const { auditOutboundCall } = await import("./externalCallAudit");
  return auditOutboundCall(
    {
      integration: "front",
      endpoint: "/channels/{id}/messages",
      method: "POST",
      dedupeParams: {
        channel: params.channelId,
        ...(params.sendId ? { send_id: params.sendId } : {}),
      },
    },
    async () => {
      const result = await sendFrontChannelMessageImpl(params, 0, false);
      return { value: result, statusCode: result.status };
    },
  );
}

async function sendFrontChannelMessageImpl(
  params: FrontSendMessageParams,
  attempt429: number,
  forceRefreshAlreadyTried: boolean,
): Promise<FrontSendMessageResult> {
  let token: string;
  try {
    token = await getValidFrontAccessToken({ purpose: "outbound_send" });
  } catch (err) {
    if (err instanceof FrontAuthError && err.code === "front_not_connected") {
      throw new Error("Front not connected. Please authorize via Settings → Integrations.");
    }
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${FRONT_API_BASE}/channels/${encodeURIComponent(params.channelId)}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: [params.to],
        subject: params.subject,
        // Front treats `body` as the HTML body for email channels; `text`
        // is the plaintext alternative.
        body: params.bodyHtml || params.bodyText,
        text: params.bodyText,
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const code = unwrapErrnoCode(err);
    if (code && PRE_CONNECTION_ERRNOS.has(code)) {
      throw new Error(`Front send failed before connecting (${code})`);
    }
    // Timeout abort or a mid-flight failure — the request MAY have landed.
    throw new FrontSendOutcomeUnknownError(
      `Front send outcome unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const rateLimit = parseFrontRateLimitHeaders(res);
  if (rateLimit.remaining != null || rateLimit.limit != null) {
    lastFrontRateLimit = rateLimit;
  }

  if (res.status === 429) {
    // A 429 response proves the request was NOT processed — safe to retry.
    if (attempt429 >= MAX_429_RETRIES) {
      throw new Error(`Front send rate limited after ${MAX_429_RETRIES} retries`);
    }
    const retryAfter = Number(res.headers.get("Retry-After") || 5);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return sendFrontChannelMessageImpl(params, attempt429 + 1, forceRefreshAlreadyTried);
  }

  if (res.status === 401 && !forceRefreshAlreadyTried) {
    // Definitive response — the send was rejected unauthenticated, not
    // processed. One forced refresh, then one retry.
    await res.text().catch(() => "");
    try {
      await getValidFrontAccessToken({ forceRefresh: true, purpose: "outbound_send" });
    } catch (err) {
      if (err instanceof FrontAuthError && err.code === "front_not_connected") {
        throw new Error("Front not connected. Please authorize via Settings → Integrations.");
      }
      throw err;
    }
    return sendFrontChannelMessageImpl(params, attempt429, true);
  }

  if (res.status >= 500) {
    // Front answered, but a 5xx on a create is genuinely ambiguous — the
    // message may have been accepted before the error was emitted.
    const text = await res.text().catch(() => "");
    throw new FrontSendOutcomeUnknownError(
      `Front send outcome unknown: ${res.status} ${text.slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new FrontSendRejectedError(res.status, `Front send rejected: ${res.status} ${text.slice(0, 300)}`);
  }

  // 201/202 — Front acknowledges with the created message (or its uid).
  const data: any = await res.json().catch(() => null);
  const messageUid: string | null = data?.message_uid ?? data?.id ?? null;
  return { messageUid, status: res.status };
}

export async function searchConversations(query: string, limit = 25): Promise<any[]> {
  const encodedQuery = encodeURIComponent(query);
  const data = await frontApiRequest(`/conversations/search/${encodedQuery}?limit=${limit}`);
  return data._results || [];
}

export async function getConversationMessages(conversationId: string, abortSignal?: AbortSignal): Promise<any[]> {
  const { recordHydrateRetry } = await import("./frontPipelineMetrics");
  const data = await frontApiRequest(`/conversations/${conversationId}/messages`, 0, abortSignal, recordHydrateRetry);
  return data._results || [];
}

/**
 * Task #2716 — fetch EVERY message of a conversation, following Front's
 * `_pagination.next` cursor (bounded by `maxPages`). The single-page
 * {@link getConversationMessages} only returns the first page; the
 * known-conversation message backfill needs the full message list so a
 * long thread's per-message rows are all materialized, not just the
 * newest page. `_pagination.next` is a fully-qualified URL, so its origin
 * is stripped before being handed back to `frontApiRequest` (which
 * re-prefixes `FRONT_API_BASE`). Auth/rate-limit handling is inherited
 * from `frontApiRequest`.
 */
export async function getAllConversationMessages(
  conversationId: string,
  opts?: { abortSignal?: AbortSignal; maxPages?: number },
): Promise<any[]> {
  const { recordHydrateRetry } = await import("./frontPipelineMetrics");
  const maxPages = Math.max(1, opts?.maxPages ?? 20);
  const out: any[] = [];
  let path: string | null = `/conversations/${encodeURIComponent(
    conversationId,
  )}/messages`;
  let pages = 0;
  while (path && pages < maxPages) {
    const data = await frontApiRequest(
      path,
      0,
      opts?.abortSignal,
      recordHydrateRetry,
    );
    pages += 1;
    const results: any[] = data?._results ?? [];
    for (const m of results) out.push(m);
    const next: string | null = data?._pagination?.next ?? null;
    if (!next) break;
    // `_pagination.next` is a full URL (https://api2.frontapp.com/...). Strip
    // the API base / origin so frontApiRequest can re-prefix FRONT_API_BASE.
    path = next.startsWith(FRONT_API_BASE)
      ? next.slice(FRONT_API_BASE.length)
      : next.replace(/^https?:\/\/[^/]+/, "");
  }
  return out;
}

export async function getConversation(conversationId: string, abortSignal?: AbortSignal): Promise<any> {
  return frontApiRequest(`/conversations/${conversationId}`, 0, abortSignal);
}

const HYDRATE_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const HYDRATE_MAX_RETRIES = 3;
const HYDRATE_RETRY_BASE_MS = 500;

export interface HydrateSnapshotResult {
  conversation: any;
  messages: any[];
  fromCache: boolean;
}

export async function hydrateConversationSnapshot(
  conversationId: string,
  lastMessageId: string | null,
  abortSignal?: AbortSignal,
): Promise<HydrateSnapshotResult> {
  const versionKey = computeVersionKey(conversationId, lastMessageId);

  const existing = await storage.getFrontHydrateSnapshotByVersionKey(versionKey);
  if (existing) {
    return {
      conversation: existing.conversationJson,
      messages: existing.messagesJson as any[],
      fromCache: true,
    };
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < HYDRATE_MAX_RETRIES; attempt++) {
    try {
      const [conversation, messages] = await Promise.all([
        getConversation(conversationId, abortSignal),
        getConversationMessages(conversationId, abortSignal),
      ]);

      await storage.upsertFrontHydrateSnapshot({
        conversationId,
        versionKey,
        conversationJson: conversation,
        messagesJson: messages,
        messageCount: messages.length,
        expiresAt: new Date(Date.now() + HYDRATE_SNAPSHOT_TTL_MS),
      });

      return { conversation, messages, fromCache: false };
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (abortSignal?.aborted) throw lastError;
      if (attempt < HYDRATE_MAX_RETRIES - 1) {
        const delay = HYDRATE_RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError || new Error(`Hydration failed for conversation ${conversationId}`);
}

export async function getHydratedSnapshot(
  conversationId: string,
  lastMessageId?: string | null,
): Promise<HydrateSnapshotResult | null> {
  if (lastMessageId !== undefined) {
    const versionKey = computeVersionKey(conversationId, lastMessageId);
    const snapshot = await storage.getFrontHydrateSnapshotByVersionKey(versionKey);
    if (snapshot) {
      return {
        conversation: snapshot.conversationJson,
        messages: snapshot.messagesJson as any[],
        fromCache: true,
      };
    }
  }

  const snapshot = await storage.getFrontHydrateSnapshotByConversationId(conversationId);
  if (snapshot) {
    return {
      conversation: snapshot.conversationJson,
      messages: snapshot.messagesJson as any[],
      fromCache: true,
    };
  }

  return null;
}

export interface FrontIngestResult {
  created: number;
  skipped: number;
  errors: string[];
}

export async function ingestConversation(conversationId: string, clientId: string, userId: string | null, abortSignal?: AbortSignal, lastMessageId?: string | null): Promise<{ recordId: string; messageCount: number }> {
  const { getCutoverDecision, logShadowComparison } = await import("./cutoverGuard");
  const decision = getCutoverDecision("front");

  let conversation: any;
  let messages: any[];

  if (PERF.FRONT_PIPELINE_HYDRATE_ENABLED) {
    const cached = await getHydratedSnapshot(conversationId, lastMessageId);
    if (cached) {
      conversation = cached.conversation;
      messages = cached.messages;
    } else {
      const hydrated = await hydrateConversationSnapshot(conversationId, lastMessageId ?? null, abortSignal);
      conversation = hydrated.conversation;
      messages = hydrated.messages;
    }
  } else if (PERF.FRONT_LEGACY_DOUBLE_FETCH_ENABLED) {
    conversation = await getConversation(conversationId, abortSignal);
    messages = await getConversationMessages(conversationId, abortSignal);
  } else {
    throw new Error(
      `Cannot ingest conversation ${conversationId}: FRONT_PIPELINE_HYDRATE_ENABLED and FRONT_LEGACY_DOUBLE_FETCH_ENABLED are both disabled. Enable one to provide a data source.`
    );
  }

  const existingRecord = await storage.findRawCommunicationByExternalSourceId(conversationId);
  if (existingRecord) {
    throw new Error("This conversation has already been ingested");
  }

  const participants = extractParticipants(conversation, messages);
  const contentParts = messages
    .reverse()
    .map((msg: any) => {
      const sender = msg.author?.email || msg.author?.username || "Unknown";
      const time = msg.created_at ? new Date(msg.created_at * 1000).toISOString() : "";
      const body = msg.body ? stripHtml(msg.body) : "(no content)";
      return `[${time}] ${sender}:\n${body}`;
    });

  const fullContent = contentParts.join("\n\n---\n\n");
  const isInbound = messages.some((m: any) => m.is_inbound);
  const isOutbound = messages.some((m: any) => !m.is_inbound);
  let direction: "inbound" | "outbound" | "internal" = "internal";
  if (isInbound && isOutbound) direction = "inbound";
  else if (isInbound) direction = "inbound";
  else if (isOutbound) direction = "outbound";

  let legacyRecordId: string | undefined;
  let legacyError: string | undefined;
  let legacyStart = 0;
  let legacyDurationMs = 0;

  const rawRecordPayload = {
    clientId,
    sourceType: "front_email" as const,
    sourceSubtype: "email_thread" as const,
    title: conversation.subject || "Untitled conversation",
    timestamp: new Date((conversation.last_message?.created_at || conversation.created_at) * 1000),
    direction,
    participantsJson: participants,
    externalSourceId: conversationId,
    externalThreadId: conversationId,
    externalUrl: conversation._links?.self ? `https://app.frontapp.com/open/${conversationId}` : undefined,
    contentText: fullContent,
    contentPreview: fullContent.substring(0, 200),
    rawPayloadJson: { conversationId, subject: conversation.subject, status: conversation.status, messageCount: messages.length },
    processingStatus: "pending" as const,
    reviewStatus: "unreviewed" as const,
    createdBy: userId || undefined,
  };

  if (decision.runLegacy) {
    legacyStart = Date.now();
    try {
      const record = await storage.createRawCommunication(rawRecordPayload);
      legacyRecordId = record.id;
      legacyDurationMs = Date.now() - legacyStart;
    } catch (err: any) {
      legacyError = err.message;
      legacyDurationMs = Date.now() - legacyStart;
      if (!decision.shadowMode) throw err;
    }
  }

  let durableRecordId: string | undefined;
  let durableError: string | undefined;
  let durableDurationMs = 0;

  if (decision.runDurable) {
    const durableStart = Date.now();
    try {
      if (!legacyRecordId) {
        const record = await storage.createRawCommunication(rawRecordPayload);
        durableRecordId = record.id;
      } else {
        durableRecordId = legacyRecordId;
      }

      const { ingestEvent } = await import("./pipelineProcessor");
      const dedupeKey = `front:conv:${conversationId}`;
      await ingestEvent({
        sourceSystem: "front",
        sourceEventType: "conversation_ingested",
        sourceObjectId: conversationId,
        dedupeKey,
        payloadJson: {
          conversationId,
          clientId,
          rawCommunicationId: durableRecordId,
          subject: conversation.subject,
          direction,
          participants,
          contentText: fullContent,
          contentPreview: fullContent.substring(0, 200),
          status: conversation.status,
          messageCount: messages.length,
          externalUrl: conversation._links?.self ? `https://app.frontapp.com/open/${conversationId}` : undefined,
          timestamp: new Date((conversation.last_message?.created_at || conversation.created_at) * 1000).toISOString(),
          createdBy: userId || undefined,
        },
      });
      durableDurationMs = Date.now() - durableStart;
    } catch (err: any) {
      durableError = err.message;
      durableDurationMs = Date.now() - durableStart;
      console.error(`[Front] CRITICAL: Durable ingest event failed for conversation ${conversationId} after raw record ${durableRecordId} was created. Pipeline event was NOT written — manual reconciliation may be needed.`, err.message);
    }
  }

  if (decision.shadowMode) {
    const legacyOutcome = legacyError ? "error" as const : (legacyRecordId ? "success" as const : "skipped" as const);
    const durableOutcome = durableError ? "error" as const : (durableRecordId ? "success" as const : "skipped" as const);
    logShadowComparison({
      source: "front",
      operation: "ingestConversation",
      legacyOutcome,
      durableOutcome,
      match: legacyOutcome === durableOutcome,
      legacyRecordId,
      durableRecordId,
      legacyError,
      durableError,
      durationLegacyMs: legacyDurationMs,
      durableDurationMs,
      timestamp: new Date().toISOString(),
    });
  }

  const recordId = legacyRecordId || durableRecordId;
  if (!recordId) {
    throw new Error("Front ingestConversation: no record created by either legacy or durable path");
  }

  try {
    const { pipelineLog } = await import("./pipelineLogger");
    pipelineLog({
      event: "event_received",
      sourceSystem: "front",
      sourceEventType: "conversation_ingested",
      dedupeKey: `front:conv:${conversationId}`,
      sourceEventId: recordId,
    });
  } catch (logErr) {
    console.warn("[Front] Pipeline log emission failed:", logErr);
  }

  return { recordId, messageCount: messages.length };
}

export async function ingestRecentConversations(
  clientId: string,
  userId: string,
  options: { tagId?: string; inboxId?: string; query?: string; limit?: number }
): Promise<FrontIngestResult> {
  let conversations: any[];

  if (options.tagId) {
    const data = await frontApiRequest(`/tags/${options.tagId}/conversations?limit=${options.limit || 10}`);
    conversations = data._results || [];
  } else if (options.inboxId) {
    const data = await frontApiRequest(`/inboxes/${options.inboxId}/conversations?limit=${options.limit || 10}`);
    conversations = data._results || [];
  } else if (options.query) {
    conversations = await searchConversations(options.query, options.limit || 10);
  } else {
    throw new Error("Must specify tagId, inboxId, or query for bulk ingestion");
  }

  const result: FrontIngestResult = { created: 0, skipped: 0, errors: [] };

  for (const conv of conversations) {
    try {
      await ingestConversation(conv.id, clientId, userId);
      result.created++;
    } catch (err: any) {
      if (err.message?.includes("already been ingested")) {
        result.skipped++;
      } else {
        result.errors.push(`${conv.id}: ${err.message}`);
      }
    }
  }

  return result;
}

function extractParticipants(conversation: any, messages: any[]): Array<{ name?: string; email?: string; role?: string }> {
  const seen = new Set<string>();
  const participants: Array<{ name?: string; email?: string; role?: string }> = [];

  for (const msg of messages) {
    if (msg.author?.email && !seen.has(msg.author.email)) {
      seen.add(msg.author.email);
      participants.push({
        name: msg.author.first_name ? `${msg.author.first_name} ${msg.author.last_name || ""}`.trim() : msg.author.username,
        email: msg.author.email,
        role: msg.is_inbound ? "external" : "team",
      });
    }
    for (const recipient of (msg.recipients || [])) {
      const handle = recipient.handle;
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        participants.push({
          name: recipient.name || undefined,
          email: handle,
          role: recipient.role || "recipient",
        });
      }
    }
  }

  return participants;
}

function extractEnvelopeParticipants(conv: any): Array<{ name?: string; email?: string; role?: string }> {
  const seen = new Set<string>();
  const participants: Array<{ name?: string; email?: string; role?: string }> = [];

  for (const r of (conv.recipients || [])) {
    const handle = r.handle?.toLowerCase().trim();
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      participants.push({
        name: r.name || undefined,
        email: handle,
        role: r.role || "recipient",
      });
    }
  }

  if (conv.recipient?.handle) {
    const handle = conv.recipient.handle.toLowerCase().trim();
    if (!seen.has(handle)) {
      seen.add(handle);
      participants.push({
        name: conv.recipient.name || undefined,
        email: handle,
        role: conv.recipient.role || "recipient",
      });
    }
  }

  if (conv.last_message?.author?.email) {
    const authorEmail = conv.last_message.author.email.toLowerCase().trim();
    if (!seen.has(authorEmail)) {
      seen.add(authorEmail);
      participants.push({
        name: conv.last_message.author.first_name
          ? `${conv.last_message.author.first_name} ${conv.last_message.author.last_name || ""}`.trim()
          : conv.last_message.author.username,
        email: authorEmail,
        role: conv.last_message.is_inbound ? "external" : "team",
      });
    }
  }

  return participants;
}

type StageReasonCode =
  | "triage:warmup_spam"
  | "triage:automated_sender"
  | "triage:operational_domain"
  | "triage:operational_subject"
  | "triage:bot_sender"
  | "classifier:ai_operational"
  | "classifier:heuristic_operational"
  | "classifier:memory_operational"
  | "match:deterministic_email"
  | "match:deterministic_phone"
  | "match:deterministic_domain"
  | "match:heuristic"
  | "match:agent_claimed"
  | "match:none";

interface StageTrace {
  triageResult: "passed" | "dismissed";
  triageReason?: string;
  triageReasonCode?: StageReasonCode;
  deterministicAttempted: boolean;
  deterministicResult?: "matched" | "no_match";
  hydrated: boolean;
  classifierAttempted: boolean;
  classifierResult?: "operational" | "not_operational" | "error";
  aiMatcherAttempted: boolean;
  aiMatcherResult?: "claimed" | "no_claim" | "error";
  finalStage: "triage" | "deterministic" | "classifier" | "ai_matcher" | "unmatched";
}

// `performLightweightTriage` was removed in Task #1838. The canonical
// triage path is `triageSyncEmailForMatching` in
// `server/services/frontSyncEmailTriage.ts` — it owns DB-threshold
// gating AND rule-hit attribution via `recordOperationalRuleHit`. Any
// future quick-dismissal path must go through the same helper so
// thresholds stay editable and `matched_rule_id` keeps flowing.

// ============================================
// CLIENT MATCHING
// ============================================

type MatchReasonCode =
  | "exact_contact_email_unique"
  | "exact_contact_phone_unique"
  | "exact_client_domain_unique"
  | "shared_identifier_no_autoclaim"
  | "shared_phone_no_autoclaim"
  | "shared_domain_no_autoclaim"
  | "company_identifier_filtered"
  | "heuristic_subject_keyword"
  | "heuristic_participant_keyword"
  | "agent_confidence_claimed"
  | "agent_confidence_ambiguous"
  | "AGENT_STRUCTURED"
  | "AGENT_SEMANTIC"
  | "AGENT_MIXED"
  | "REPROCESS_AGENT";

interface ClientMatchResult {
  clientId: string;
  firmName: string;
  confidence: number;
  reason: string;
  matchKind?: "deterministic_unique_exact" | "domain" | "agent" | "heuristic";
  reasonCode?: MatchReasonCode;
}

function agentEvidenceToReasonCode(evidenceType?: string): "AGENT_STRUCTURED" | "AGENT_SEMANTIC" | "AGENT_MIXED" {
  if (evidenceType === "semantic") return "AGENT_SEMANTIC";
  if (evidenceType === "mixed") return "AGENT_MIXED";
  return "AGENT_STRUCTURED";
}

type MatchIndexes = {
  contactIndex: Map<string, Array<{ clientId: string; firmName: string; source: string }>>;
  domainIndex: Map<string, Array<{ clientId: string; firmName: string }>>;
  allClients: Array<{ id: string; firmName: string; contactEmail: string | null; isArchived: boolean | null }>;
};

let cachedIndexes: MatchIndexes | null = null;
let cachedIndexesExpiry = 0;
const INDEX_CACHE_TTL_MS = 60_000;

async function buildMatchIndexes(): Promise<MatchIndexes> {
  const now = Date.now();
  if (cachedIndexes && now < cachedIndexesExpiry) {
    return cachedIndexes;
  }

  const { isCompanyEmail, isCompanyDomain: isCompDomain, isPublicEmailDomain } = await import("./companyIdentity");
  const allClients = await storage.getClients();

  const contactIndex = new Map<string, Array<{ clientId: string; firmName: string; source: string }>>();
  const domainIndex = new Map<string, Array<{ clientId: string; firmName: string }>>();

  const activeClients = allClients.filter(c => !c.isArchived);
  const activeClientById = new Map(activeClients.map(c => [c.id, c]));

  for (const client of activeClients) {
    if (client.contactEmail) {
      const cEmail = client.contactEmail.toLowerCase().trim();
      if (!isCompanyEmail(cEmail)) {
        if (!contactIndex.has(cEmail)) contactIndex.set(cEmail, []);
        contactIndex.get(cEmail)!.push({ clientId: client.id, firmName: client.firmName, source: "primary_contact" });
        const cDomain = cEmail.split("@")[1];
        if (cDomain && !isPublicEmailDomain(cDomain) && !isCompDomain(cDomain)) {
          if (!domainIndex.has(cDomain)) domainIndex.set(cDomain, []);
          domainIndex.get(cDomain)!.push({ clientId: client.id, firmName: client.firmName });
        }
      }
    }
  }

  // Task #1286: replace the previous per-client `getClientContacts` fan-out
  // (one query per active client) with a single batched fetch. Phone keys are
  // sourced from `client_contacts.phones_normalized` (canonical last-10) so
  // they line up with what `findClientByPhone` matches against the GIN index.
  const activeClientIds = activeClients.map(c => c.id);
  let contactsByClient: Awaited<ReturnType<typeof storage.getClientContactsForClients>>;
  try {
    contactsByClient = await storage.getClientContactsForClients(activeClientIds);
  } catch (err) {
    console.error("[Front Match] Failed to batch-load client contacts:", err);
    contactsByClient = new Map();
  }

  for (const [clientId, contacts] of contactsByClient.entries()) {
    const client = activeClientById.get(clientId);
    if (!client) continue;
    for (const contact of contacts) {
      if (contact.emails) {
        for (const email of contact.emails) {
          if (!email) continue;
          const eLower = email.toLowerCase().trim();
          if (isCompanyEmail(eLower)) continue;
          if (!contactIndex.has(eLower)) contactIndex.set(eLower, []);
          const existing = contactIndex.get(eLower)!;
          if (!existing.some(e => e.clientId === client.id)) {
            existing.push({ clientId: client.id, firmName: client.firmName, source: "client_contacts" });
          }
          const eDomain = eLower.split("@")[1];
          if (eDomain && !isPublicEmailDomain(eDomain) && !isCompDomain(eDomain)) {
            if (!domainIndex.has(eDomain)) domainIndex.set(eDomain, []);
            const dExisting = domainIndex.get(eDomain)!;
            if (!dExisting.some(d => d.clientId === client.id)) {
              dExisting.push({ clientId: client.id, firmName: client.firmName });
            }
          }
        }
      }
      if (contact.phonesNormalized) {
        for (const normalized of contact.phonesNormalized) {
          if (!normalized) continue;
          const phoneKey = `phone:${normalized}`;
          if (!contactIndex.has(phoneKey)) contactIndex.set(phoneKey, []);
          const pExisting = contactIndex.get(phoneKey)!;
          if (!pExisting.some(e => e.clientId === client.id)) {
            pExisting.push({ clientId: client.id, firmName: client.firmName, source: "client_contacts_phone" });
          }
        }
      }
    }
  }

  cachedIndexes = { contactIndex, domainIndex, allClients };
  cachedIndexesExpiry = now + INDEX_CACHE_TTL_MS;
  return cachedIndexes;
}

export function invalidateMatchIndexCache(): void {
  cachedIndexes = null;
  cachedIndexesExpiry = 0;
}

/**
 * Task #867 — Front email auto-match resolver.
 *
 * Replaces the previous tangle of firm-name keyword scans, contact-name
 * tokens and AI auto-claim with one deterministic rule:
 *
 *   Auto-match a Front email to a client if and only if any external
 *   participant's email exactly matches a client's contact email OR the
 *   participant's domain is in the client's per-client trusted-domain list
 *   (`clients.email_domains`). Anything else → unmatched.
 *
 * AI evaluation now lives behind suggestion-only surfaces; it is no longer
 * permitted to auto-claim from inside this matcher. See
 * `server/services/frontHardMatch.ts` for the pure resolver.
 *
 * The `subject` argument is retained in the signature (callers all pass it)
 * but intentionally unused — subject keyword scanning is gone.
 */
/**
 * Outcome of running the deterministic hard matcher. Always carries an
 * explanatory `reason` (and, for ambiguous matches, the colliding
 * candidate ids) so callers can persist it on the sync row even when the
 * email is left Unmatched. Auditability is a stated goal of Task #867.
 */
type FrontMatchOutcome =
  | { match: ClientMatchResult; unmatchedReason: null; unmatchedReasonCode: null; candidateClientIds: null }
  | { match: null; unmatchedReason: string; unmatchedReasonCode: string | null; candidateClientIds: string[] | null };

/**
 * Full hard-match evaluation. Use this when the caller needs the unmatched
 * reason text (e.g. to persist it on the sync row when routing to
 * Unmatched). The legacy `matchConversationToClient` below is kept as a
 * thin wrapper that returns only the matched part so existing call sites
 * don't have to be rewritten en-masse.
 */
async function evaluateConversationHardMatch(
  participants: Array<{ name?: string; email?: string; role?: string }>,
): Promise<FrontMatchOutcome> {
  const { resolveFrontHardMatch, getHardMatchIndexes } = await import("./frontHardMatch");
  const { MATCH_REASON_CODES } = await import("./companyIdentity");
  const indexes = await getHardMatchIndexes();
  const outcome = resolveFrontHardMatch(participants, indexes);

  if (outcome.status === "matched") {
    return {
      match: {
        clientId: outcome.clientId,
        firmName: outcome.firmName,
        // Hard matches are by definition certain. Confidence kept at 1.0
        // for exact-email, 0.95 for trusted-domain so existing UI sort
        // and format conventions remain stable.
        confidence: outcome.method === "email_exact" ? 1.0 : 0.95,
        reason: outcome.reason,
        matchKind: outcome.method === "email_exact" ? "deterministic_unique_exact" : "domain",
        reasonCode: MATCH_REASON_CODES[outcome.reasonCode],
      },
      unmatchedReason: null,
      unmatchedReasonCode: null,
      candidateClientIds: null,
    };
  }

  if (outcome.status === "ambiguous") {
    console.log(`[Front HardMatch] ${outcome.reason} — routing to Unmatched`);
    const code = outcome.method === "email_exact"
      ? MATCH_REASON_CODES.SHARED_EMAIL
      : MATCH_REASON_CODES.SHARED_DOMAIN;
    return {
      match: null,
      unmatchedReason: outcome.reason,
      unmatchedReasonCode: code,
      candidateClientIds: outcome.candidateClientIds,
    };
  }

  return {
    match: null,
    unmatchedReason: outcome.reason,
    unmatchedReasonCode: null,
    candidateClientIds: null,
  };
}

/**
 * Backwards-compatible matcher used by the existing pipeline call sites:
 * returns the matched ClientMatchResult or `null`. Callers that also need
 * to surface the unmatched reason should use `evaluateConversationHardMatch`
 * directly (see the unmatched-persist sites below).
 */
async function matchConversationToClient(
  participants: Array<{ name?: string; email?: string; role?: string }>,
  _subject: string,
): Promise<ClientMatchResult | null> {
  const outcome = await evaluateConversationHardMatch(participants);
  return outcome.match;
}

/**
 * Helper: format an unmatched outcome into the `match_reason` text we
 * persist on `front_sync_emails`. Keeps the bracket-prefixed reason-code
 * convention consistent with matched rows so dashboards can group them.
 */
function formatUnmatchedReason(outcome: FrontMatchOutcome): string | null {
  if (outcome.match) return null;
  if (!outcome.unmatchedReason) return null;
  if (outcome.unmatchedReasonCode && !outcome.unmatchedReason.startsWith("[")) {
    return `[${outcome.unmatchedReasonCode}] ${outcome.unmatchedReason}`;
  }
  return outcome.unmatchedReason;
}

/**
 * Task #867 — append-only audit trail. Records the outcome of running the
 * hard matcher against one Front sync email so operators can answer
 * "why did this email move (or not move)?" after the fact. Failures here
 * never block the pipeline — audit is a side observability surface.
 */
async function recordHardMatchAudit(opts: {
  syncEmail: { id: string; conversationId: string; matchedClientId: string | null; matchStatus: string };
  source: "pipeline" | "rematch_all" | "rematch_batch" | "reprocess_dismissed" | "backfill_867" | "rematch_unmatched_backlog";
  finalMatch: ClientMatchResult | null;
}): Promise<void> {
  try {
    const { syncEmail, source, finalMatch } = opts;
    let newMethod: string;
    if (!finalMatch) {
      newMethod = "unmatched";
    } else if (finalMatch.matchKind === "deterministic_unique_exact") {
      newMethod = "email_exact";
    } else if (finalMatch.matchKind === "domain") {
      newMethod = "email_domain";
    } else {
      newMethod = finalMatch.matchKind ?? "unknown";
    }

    const previousClientId = syncEmail.matchedClientId ?? null;
    const newClientId = finalMatch?.clientId ?? null;
    let outcome: "matched" | "moved" | "unmatched" | "noop";
    if (finalMatch && !previousClientId) outcome = "matched";
    else if (finalMatch && previousClientId && previousClientId !== newClientId) outcome = "moved";
    else if (!finalMatch && previousClientId) outcome = "unmatched";
    else outcome = "noop";

    await storage.createFrontMatchAuditLog({
      syncEmailId: syncEmail.id,
      conversationId: syncEmail.conversationId,
      source,
      outcome,
      priorClientId: previousClientId,
      priorMatchStatus: syncEmail.matchStatus ?? null,
      priorMatchMethod: null,
      newClientId,
      newMatchMethod: newMethod,
      reason: finalMatch?.reasonCode ? `[${finalMatch.reasonCode}] ${finalMatch.reason}` : (finalMatch?.reason ?? null),
      matchedOn: null,
    });
  } catch (err) {
    console.warn("[Front HardMatch] audit insert failed (non-fatal):", err);
  }
}

// Task #971 (relocated by Task #4049): the automated-sender patterns now live
// in `companyIdentity.ts` (`AUTOMATED_SENDER_PATTERNS` / `isAutomatedSenderEmail`)
// so the pure hard-match resolver can consult them without importing this
// module. Re-exported here under the legacy names for existing consumers
// (`clientContactPromotion.ts`, `frontUnmatchedDiagnosis.ts`, routes).
export {
  AUTOMATED_SENDER_PATTERNS as SPAM_SENDER_PATTERNS,
  isAutomatedSenderEmail as isSpamSenderEmail,
} from "./companyIdentity";
// Re-export statements create no local binding — import the array for the
// in-module spam scans below.
import { AUTOMATED_SENDER_PATTERNS as SPAM_SENDER_PATTERNS } from "./companyIdentity";

const SPAM_SUBJECT_PATTERNS = [
  /\[GWarm\]/i, /\(Wbots\)/i,
];

const EXCLUDED_INBOX_ADDRESSES = new Set([
  "team@myattorneylawyer.com",
]);

/**
 * Task #1271 — Front sync_email ingestion triage is consolidated in
 * `server/services/frontSyncEmailTriage.ts`. Every site in this file that
 * iterates `front_sync_emails` must route them through
 * `triageSyncEmailForMatching` before invoking any matcher. The static
 * guard `scripts/lint-front-sync-email-triage.ts` enforces this; a new
 * ingestion function that lists sync_emails but skips the helper will
 * block the deploy.
 */
export { applyFilterRulesToSyncEmail } from "./frontSyncEmailTriage";
import { triageSyncEmailForMatching } from "./frontSyncEmailTriage";

function isExcludedConversation(conv: any): boolean {
  const inboxAddresses: string[] = [];

  for (const r of (conv.recipients || [])) {
    if (r.handle) inboxAddresses.push(r.handle.toLowerCase());
  }
  if (conv.recipient?.handle) {
    inboxAddresses.push(conv.recipient.handle.toLowerCase());
  }

  if (inboxAddresses.length === 0) return false;
  return inboxAddresses.some(addr => EXCLUDED_INBOX_ADDRESSES.has(addr));
}

function isWarmupSpamSubject(subject: string): boolean {
  return SPAM_SUBJECT_PATTERNS.some(pattern => pattern.test(subject));
}

// Task #2413: live heartbeat for the dashboards' "Last successful sync".
//
// The old on-demand `syncFrontEmails` loop stamped `front_last_sync_success`
// on every run; that loop was removed at the 2026-04-14 webhook cutover, so
// the setting has been frozen ever since and nothing writes it. Re-source the
// timestamp to the most-recent Front webhook landed in `source_event_log`
// (`source_system = 'front'`) — the canonical landing table for live Front
// traffic. It advances with every webhook when Front is active and freezes at
// the genuine last-activity time when Front goes quiet or auth dies, so it can
// never be a value that only ever goes stale.
export async function getLastFrontWebhookActivityAt(): Promise<Date | null> {
  return withDbAttribution("frontIntegration:lastWebhookActivity", async () => {
    const [row] = await getDb()
      .select({ latest: max(sourceEventLog.receivedAt) })
      .from(sourceEventLog)
      .where(eq(sourceEventLog.sourceSystem, "front"));
    return row?.latest ?? null;
  });
}

// Plain-English reasons for the terminal Front auth-failure codes. These are
// the only codes that trip the auth-dead breaker / record a death, so they are
// the only codes `deriveFrontLastError` ever has to translate.
const FRONT_AUTH_CODE_REASONS: Record<string, string> = {
  front_refresh_failed_permanent:
    "Front rejected the saved credentials (OAuth token revoked or expired)",
  front_no_refresh_token: "Front has no stored refresh token",
  front_not_connected: "Front is not connected",
};

// True when Front auth is currently dead — i.e. the most recent auth event the
// breaker saw was a trip with no later success. This survives the breaker's
// cooldown window (which lapses every ~5 min until something re-trips it) and
// clears the moment a successful refresh / `/me` probe records a success, so a
// genuine reconnect immediately stops surfacing the error.
function isFrontCurrentlyAuthDead(state: ReturnType<typeof getFrontAuthState>): boolean {
  if (state.breakerOpen) return true;
  if (!state.lastTrippedAt) return false;
  const trippedMs = Date.parse(state.lastTrippedAt);
  if (!Number.isFinite(trippedMs)) return false;
  const successMs = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
  return trippedMs > (Number.isFinite(successMs) ? successMs : 0);
}

// Task #2417 — derive the "last error" line shown on the Integrations-Hub Front
// card and the Pipeline Health tab from the LIVE Front auth-death diagnostics /
// auth-breaker state, instead of the retired `front_last_sync_error` setting
// (which was only ever written empty, so the surfaces showed no reason when
// Front genuinely died). Returns null while Front auth is healthy.
function deriveFrontLastError(
  state: ReturnType<typeof getFrontAuthState>,
  death: FrontAuthDeathRecord | null,
): string | null {
  if (!isFrontCurrentlyAuthDead(state)) return null;
  const code =
    death?.code ?? state.lastTrippedCode ?? state.errorCode ?? "front_not_connected";
  const base = FRONT_AUTH_CODE_REASONS[code] ?? `Front auth failure (${code})`;
  const status = death?.httpStatus ? ` (HTTP ${death.httpStatus})` : "";
  return `${base}${status} — reconnect Front in Settings → Integrations.`;
}

export async function getSyncMetadata(): Promise<{ lastError: string | null; lastSuccess: string | null }> {
  const authState = getFrontAuthState();
  const [lastActivity, lastDeath] = await Promise.all([
    getLastFrontWebhookActivityAt(),
    getLastFrontAuthDeath(),
  ]);
  return {
    lastError: deriveFrontLastError(authState, lastDeath),
    lastSuccess: lastActivity ? lastActivity.toISOString() : null,
  };
}

export async function reEvaluateExistingUnmatched(
  opts: { restrictToIds?: string[]; maxItems?: number } = {},
): Promise<{ total: number; matched: number; filterRuleHandled: number }> {
  // When maxItems is supplied (e.g. the "apply rule to recent messages"
  // flow from SuggestRulesDialog), cap the list read so an ad-hoc UI
  // trigger can't sweep the entire backlog. listUnmatchedFrontSyncEmails
  // sorts newest-first, so this naturally targets *recent* unmatched.
  const fetchLimit = opts.maxItems && opts.maxItems > 0
    ? Math.min(opts.maxItems, 10000)
    : 10000;
  const all = await storage.listUnmatchedFrontSyncEmails(fetchLimit);
  // Test-only scoping: when restrictToIds is supplied, only consider
  // the explicitly named rows. This keeps the dev DB's pre-existing
  // unmatched backlog (~hundreds of rows) from turning every test run
  // into a 3-minute scan. Production call sites pass no argument.
  const unmatchedEmails = opts.restrictToIds && opts.restrictToIds.length > 0
    ? all.filter((e) => opts.restrictToIds!.includes(e.id))
    : all;
  let matched = 0;
  let filterRuleHandled = 0;

  for (const email of unmatchedEmails) {
    try {
      const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
      const snippet = email.snippet || "";

      // Task #1271/#2637: canonical manual-filter-rule triage.
      const triage = await triageSyncEmailForMatching(email, { logTag: "Front Re-eval" });
      if (triage.outcome === "filter_rule_handled") {
        filterRuleHandled++;
        continue;
      }
      if (triage.outcome === "skip_match") {
        // never_match suppresses auto-matching for this email entirely.
        continue;
      }

      // Task #867: hard match only — no agent auto-claim fallback.
      // Use the rich evaluator so we can persist the unmatched reason
      // (ambiguity / no-signal) on the row, not just in the audit log.
      const outcome = await evaluateConversationHardMatch(participants);
      const finalMatch = outcome.match;

      if (finalMatch) {
        const applyResult = await applyMatchedConversation({
          syncEmailId: email.id,
          conversationId: email.conversationId,
          clientId: finalMatch.clientId,
          matchStatus: "auto_matched",
          matchConfidence: finalMatch.confidence,
          matchReason: finalMatch.reasonCode ? `[${finalMatch.reasonCode}] ${finalMatch.reason}` : (finalMatch.reason || null),
          participants,
          lastMessageId: email.lastMessageId,
          versionKey: email.versionKey,
        });

        if (applyResult.action === "error") {
          console.error(`[Front Re-eval] Apply failed for ${email.conversationId}: ${applyResult.error}`);
        }

        await recordHardMatchAudit({
          syncEmail: email,
          source: "pipeline",
          finalMatch,
        });

        matched++;
      } else {
        // Persist the unmatched reason text on the row so operators can
        // see *why* it stayed in Unmatched without having to dig through
        // the audit log. Only updates the reason column — leaves the
        // matchStatus/clientId untouched.
        const reasonText = formatUnmatchedReason(outcome);
        if (reasonText && reasonText !== email.matchReason) {
          await storage.updateFrontSyncEmail(email.id, { matchReason: reasonText });
        }

        await recordHardMatchAudit({
          syncEmail: email,
          source: "pipeline",
          finalMatch: null,
        });
      }
    } catch (err: any) {
      console.error(`[Front Re-eval] Error re-evaluating ${email.conversationId}:`, err.message);
    }
  }

  console.log(`[Front Re-eval] Re-evaluated ${unmatchedEmails.length} unmatched emails, matched ${matched}, filter-rule-handled ${filterRuleHandled}`);
  return { total: unmatchedEmails.length, matched, filterRuleHandled };
}

/**
 * Task #2512 — targeted re-evaluation of ONLY the unmatched rows whose
 * participants include a specific sender email or domain.
 *
 * This is the partner of `reEvaluateExistingUnmatched` for the operator
 * "attach this sender to a client → re-match the affected rows now" action.
 * Crucially it does NOT use the test-only `restrictToIds` shortcut on the
 * whole-corpus sweeps (which `lint-front-rematch-restrict-to-ids` forbids in
 * production): it issues a real, participant-scoped query
 * (`listUnmatchedFrontSyncEmailsByParticipant`) and runs the identical
 * deterministic triage → hard-match → apply pipeline over just those rows.
 *
 * Routes every row through `triageSyncEmailForMatching` (same as the full
 * sweep). Idempotent: a row that does not hard-match is left untouched
 * apart from refreshing its persisted unmatched-reason text.
 *
 * Caller is responsible for invalidating the hard-match index cache after
 * the client-data write, so this re-eval sees the freshly-added domain/email.
 */
// Re-runs the canonical triage + hard-match resolver for a SINGLE already-
// fetched unmatched row. Shared by both the single-target and batch
// (multi-target) re-eval paths so they apply identical precision rules.
async function reEvaluateUnmatchedRow(
  item: FrontSyncEmail,
): Promise<"matched" | "filterRuleHandled" | "unmatched"> {
  try {
    const participants = (item.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];

    // Task #1271/#2637 canonical triage (manual filter rules only).
    const triage = await triageSyncEmailForMatching(item, { logTag: "Front Targeted Re-eval" });
    if (triage.outcome === "filter_rule_handled") {
      return "filterRuleHandled";
    }
    if (triage.outcome === "skip_match") {
      return "unmatched";
    }

    const outcome = await evaluateConversationHardMatch(participants);
    const finalMatch = outcome.match;

    if (finalMatch) {
      const applyResult = await applyMatchedConversation({
        syncEmailId: item.id,
        conversationId: item.conversationId,
        clientId: finalMatch.clientId,
        matchStatus: "auto_matched",
        matchConfidence: finalMatch.confidence,
        matchReason: finalMatch.reasonCode ? `[${finalMatch.reasonCode}] ${finalMatch.reason}` : (finalMatch.reason || null),
        participants,
        lastMessageId: item.lastMessageId,
        versionKey: item.versionKey,
      });
      if (applyResult.action === "error") {
        console.error(`[Front Targeted Re-eval] Apply failed for ${item.conversationId}: ${applyResult.error}`);
      }
      await recordHardMatchAudit({ syncEmail: item, source: "pipeline", finalMatch });
      return "matched";
    }

    const reasonText = formatUnmatchedReason(outcome);
    if (reasonText && reasonText !== item.matchReason) {
      await storage.updateFrontSyncEmail(item.id, { matchReason: reasonText });
    }
    await recordHardMatchAudit({ syncEmail: item, source: "pipeline", finalMatch: null });
    return "unmatched";
  } catch (err: any) {
    console.error(`[Front Targeted Re-eval] Error re-evaluating ${item.conversationId}:`, err.message);
    return "unmatched";
  }
}

export async function reEvaluateUnmatchedForTarget(
  target: { email?: string; domain?: string },
): Promise<{ total: number; matched: number; filterRuleHandled: number }> {
  const email = (target.email || "").trim().toLowerCase();
  const domain = (target.domain || "").trim().toLowerCase().replace(/^@/, "");
  if (!email && !domain) {
    return { total: 0, matched: 0, filterRuleHandled: 0 };
  }

  const affected = await storage.listUnmatchedFrontSyncEmailsByParticipant({ email, domain });
  let matched = 0;
  let filterRuleHandled = 0;

  for (const item of affected) {
    const result = await reEvaluateUnmatchedRow(item);
    if (result === "matched") matched++;
    else if (result === "filterRuleHandled") filterRuleHandled++;
  }

  console.log(`[Front Targeted Re-eval] target=${email || domain} affected=${affected.length} matched=${matched} filterRuleHandled=${filterRuleHandled}`);
  return { total: affected.length, matched, filterRuleHandled };
}

/**
 * Batch counterpart to {@link reEvaluateUnmatchedForTarget}. Gathers the
 * unmatched rows affected by EACH target (email/domain), de-duplicates them
 * by id (a conversation can carry senders from more than one attached
 * domain), then runs the identical per-row triage + hard-match resolver
 * exactly once per row. Returns a SINGLE combined lift across all targets so
 * an operator attaching several domains in one go sees one total.
 *
 * Empty / whitespace-only targets are dropped; if nothing remains it
 * short-circuits WITHOUT touching storage (same no-whole-corpus-fallback
 * guarantee as the single-target path).
 */
export async function reEvaluateUnmatchedForTargets(
  targets: Array<{ email?: string; domain?: string }>,
  opts?: {
    /**
     * Workers/queues parity (E-F04): cooperative stop checked between
     * rows — the true batch boundary of this routine. Only the
     * `retroactive_reprocess` queue handler passes this (wired to its
     * kill switch); the interactive attach-domain caller is unchanged.
     * Rows already re-evaluated keep their outcomes; the remainder are
     * simply not visited (idempotent re-runs pick them up later).
     */
    shouldAbort?: () => boolean;
  },
): Promise<{ total: number; matched: number; filterRuleHandled: number; aborted?: boolean }> {
  const normalized = (Array.isArray(targets) ? targets : [])
    .map((t) => ({
      email: (t.email || "").trim().toLowerCase(),
      domain: (t.domain || "").trim().toLowerCase().replace(/^@/, ""),
    }))
    .filter((t) => t.email || t.domain);

  if (normalized.length === 0) {
    return { total: 0, matched: 0, filterRuleHandled: 0 };
  }

  const byId = new Map<string, FrontSyncEmail>();
  for (const target of normalized) {
    const affected = await storage.listUnmatchedFrontSyncEmailsByParticipant(target);
    for (const item of affected) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }

  let matched = 0;
  let filterRuleHandled = 0;
  let aborted = false;
  for (const item of byId.values()) {
    if (opts?.shouldAbort?.()) {
      aborted = true;
      break;
    }
    const result = await reEvaluateUnmatchedRow(item);
    if (result === "matched") matched++;
    else if (result === "filterRuleHandled") filterRuleHandled++;
  }

  console.log(
    `[Front Targeted Re-eval] targets=${normalized.length} affected=${byId.size} matched=${matched} filterRuleHandled=${filterRuleHandled}${aborted ? " aborted=true" : ""}`,
  );
  return { total: byId.size, matched, filterRuleHandled, ...(aborted ? { aborted: true as const } : {}) };
}

/**
 * Task #1884 — "Apply this rule to recent messages now" service helper.
 *
 * Runs a bounded sweep over BOTH recent unmatched AND recent
 * dismissed_operational rows so a freshly created operational rule
 * takes effect immediately:
 *   - Unmatched cohort: re-runs the full triage. Rows that now match the
 *     new rule transition to `dismissed_operational` (clearing them from
 *     the unmatched feed) or to `auto_matched` if a hard match resurfaces.
 *   - Dismissed_operational cohort: re-runs the classifier in-place so a
 *     row previously attributed to a different rule (or to spam scoring)
 *     gets credited to the now-matching rule — without flipping status.
 *     Hit attribution is what powers per-rule "affected" counts and the
 *     recent-hits drill-down, so re-attribution is the visible effect.
 *
 * `maxItems` caps each cohort independently. Newest-first ordering comes
 * from `listUnmatchedFrontSyncEmails` and `listFrontSyncEmails` defaults.
 */
export async function applyNewRulesToRecent(
  opts: {
    maxItems?: number;
    ruleIds?: string[];
    // Task #1958 — callers can opt out of the unmatched-cohort sweep,
    // which on dev/prod runs the full triage (including OpenAI) over
    // every recent unmatched row. The SuggestRulesDialog "Apply now"
    // flow only needs to credit the new rule against already-dismissed
    // rows, so it passes `cohorts: ["dismissed"]` and skips the
    // expensive unmatched scan. Defaults to both cohorts for backwards
    // compatibility with any caller (e.g. the legacy re-evaluate route)
    // that still expects the full sweep.
    cohorts?: Array<"unmatched" | "dismissed">;
  } = {},
): Promise<{
  unmatched: { scanned: number; filterRuleHandled: number; matched: number };
  dismissed: { scanned: number; reAttributed: number };
}> {
  const maxItems = opts.maxItems && opts.maxItems > 0 ? Math.min(opts.maxItems, 2000) : 500;
  const targetedRuleIds = Array.isArray(opts.ruleIds)
    ? opts.ruleIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const cohorts = Array.isArray(opts.cohorts) && opts.cohorts.length > 0
    ? new Set(opts.cohorts)
    : new Set<"unmatched" | "dismissed">(["unmatched", "dismissed"]);

  // Task #2637 — operational re-attribution removed. The only "apply new
  // rules to recent" work that remains is re-running the unmatched cohort
  // through the manual-filter-rule + deterministic-match triage. The
  // legacy dismissed-cohort operational re-attribution (which credited
  // operator-authored *operational* rules in-place) is gone along with the
  // operational classifier; manual block/dismiss/never_match rules already
  // move rows out of Unmatched via the unmatched sweep below.
  void targetedRuleIds;
  const unmatchedResult = cohorts.has("unmatched")
    ? await reEvaluateExistingUnmatched({ maxItems })
    : { total: 0, matched: 0, filterRuleHandled: 0 };

  return {
    unmatched: {
      scanned: unmatchedResult.total,
      filterRuleHandled: unmatchedResult.filterRuleHandled,
      matched: unmatchedResult.matched,
    },
    dismissed: { scanned: 0, reAttributed: 0 },
  };
}

export async function reprocessSyncEmailBatch(
  syncEmailIds: string[],
): Promise<{ total: number; matched: number; dismissed: number; errors: number }> {
  let matched = 0;
  let dismissed = 0;
  let errors = 0;

  if (syncEmailIds.length === 0) {
    return { total: 0, matched: 0, dismissed: 0, errors: 0 };
  }

  // Task #1787 Stage 3A — collapse the per-ID `storage.getFrontSyncEmail()`
  // N+1 into a single bulk SELECT. Hold one short DB window to fetch all
  // emails, then iterate in-memory; the per-row mutations below each
  // acquire/release their own connection, so we never hold across the
  // outbound matcher / ingest / contact-enrichment work.
  // Use getDb() so the same AsyncLocalStorage / test-sandbox routing that
  // the per-row mutations below honour also applies to this bulk fetch.
  // The worker call site wraps reprocessSyncEmailBatch in runWithWorkerDb,
  // so production still routes to the worker pool — but test sandboxes
  // (runInTxSandbox) can now see freshly-seeded rows.
  const fetchedEmails = await withDbAttribution(
    "front_sync_reprocess:batch:fetch",
    () =>
      getDb()
        .select()
        .from(frontSyncEmails)
        .where(inArray(frontSyncEmails.id, syncEmailIds)),
  );
  const emailsById = new Map<string, (typeof fetchedEmails)[number]>();
  for (const e of fetchedEmails) {
    emailsById.set(e.id, e);
  }

  for (const syncEmailId of syncEmailIds) {
    try {
      const email = emailsById.get(syncEmailId);
      if (!email) continue;

      if (isSpamEmail(email)) continue;

      const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
      const snippet = email.snippet || "";

      // Task #1271/#2637: canonical manual-filter-rule triage.
      const triage = await triageSyncEmailForMatching(email, { logTag: "Front Batch Reprocess" });
      if (triage.outcome === "filter_rule_handled") {
        dismissed++;
        continue;
      }
      if (triage.outcome === "skip_match") {
        // never_match suppresses auto-matching for this email entirely.
        continue;
      }

      // Task #867: hard match only — no agent fallback.
      const finalMatch = await matchConversationToClient(participants, email.subject || "");

      if (finalMatch) {
        await storage.updateFrontSyncEmail(email.id, {
          matchedClientId: finalMatch.clientId,
          matchStatus: "auto_matched",
          matchConfidence: finalMatch.confidence,
          matchReason: finalMatch.reasonCode ? `[${finalMatch.reasonCode}] ${finalMatch.reason}` : (finalMatch.reason || null),
        });
        try {
          const existingRawRecord = await storage.findRawCommunicationByExternalSourceId(email.conversationId);
          if (existingRawRecord) {
            await storage.updateFrontSyncEmail(email.id, {
              ingestedRecordId: existingRawRecord.id,
              processedAt: new Date(),
            });
          } else {
            const ingestResult = await ingestConversation(email.conversationId, finalMatch.clientId, null, undefined, email.lastMessageId);
            await storage.updateFrontSyncEmail(email.id, {
              ingestedRecordId: ingestResult.recordId,
              processedAt: new Date(),
            });
          }
        } catch (ingestErr: any) {
          console.error(`[Front Batch Reprocess] Ingest failed for ${email.conversationId}:`, ingestErr.message);
        }
        await enrichClientContactsFromParticipants(finalMatch.clientId, participants, {
          conversationId: email.conversationId,
          messageId: email.lastMessageId || undefined,
          subject: email.subject || undefined,
          snippet: email.snippet || undefined,
        }).catch(err => {
          console.error(`[Front Batch Reprocess] Contact enrichment failed for ${email.conversationId}:`, err);
        });
        // Task #2637: propagate the match across the whole Front thread (rollup
        // row + every per-message row), not just the row the matcher touched.
        await stampThreadWideClientAttribution(email.conversationId, finalMatch.clientId).catch(err => {
          console.error(`[Front Batch Reprocess] Thread-wide attribution failed for ${email.conversationId}:`, err);
        });
        matched++;
      }
    } catch (err: any) {
      console.error(`[Front Batch Reprocess] Error for syncEmailId ${syncEmailId}:`, err.message);
      errors++;
    }
  }

  console.log(`[Front Batch Reprocess] Processed ${syncEmailIds.length} emails: ${matched} matched, ${dismissed} dismissed, ${errors} errors`);
  return { total: syncEmailIds.length, matched, dismissed, errors };
}

type RematchTier = "deterministic" | "domain" | "agent";

interface PreClassifiedEmail {
  syncEmailId: string;
  email: Awaited<ReturnType<typeof storage.getFrontSyncEmail>>;
  tier: RematchTier;
  deterministicMatch: ClientMatchResult | null;
}

function rematchTierOrder(tier: RematchTier): number {
  switch (tier) {
    case "deterministic": return 0;
    case "domain": return 1;
    case "agent": return 2;
  }
}

export async function rematchSyncEmailBatch(
  syncEmailIds: string[],
): Promise<{ total: number; reassigned: number; newlyMatched: number; unchanged: number; skippedSpam: number; errors: number; learned: number }> {
  let reassigned = 0;
  let newlyMatched = 0;
  let unchanged = 0;
  let skippedSpam = 0;
  let errors = 0;
  const learned = 0; // Task #867: trusted-seeding from agent matches removed.

  const preClassified: PreClassifiedEmail[] = [];
  for (const syncEmailId of syncEmailIds) {
    try {
      const email = await storage.getFrontSyncEmail(syncEmailId);
      if (!email) continue;

      if (isSpamEmail(email)) {
        skippedSpam++;
        unchanged++;
        continue;
      }

      // Task #1271/#2637: canonical manual-filter-rule triage. Rematch
      // only re-buckets rows; manual block/dismiss/never_match still apply.
      const triage = await triageSyncEmailForMatching(email, {
        logTag: "Front Batch Rematch",
      });
      if (triage.outcome === "filter_rule_handled" || triage.outcome === "skip_match") {
        unchanged++;
        continue;
      }

      const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
      const legacyMatch = await matchConversationToClient(participants, email.subject || "");

      let tier: RematchTier = "agent";
      if (legacyMatch?.matchKind === "deterministic_unique_exact") {
        tier = "deterministic";
      } else if (legacyMatch?.matchKind === "domain") {
        tier = "domain";
      }

      preClassified.push({ syncEmailId, email, tier, deterministicMatch: legacyMatch });
    } catch (err: any) {
      console.error(`[Front Batch Rematch] Pre-classify error for syncEmailId ${syncEmailId}:`, err.message);
      errors++;
    }
  }

  preClassified.sort((a, b) => rematchTierOrder(a.tier) - rematchTierOrder(b.tier));

  for (const item of preClassified) {
    try {
      const email = item.email!;
      const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
      const snippet = email.snippet || "";

      // Task #867: hard match only — no agent fallback during rematch.
      const finalMatch: ClientMatchResult | null = item.deterministicMatch;

      const previousClientId = email.matchedClientId;
      const previousStatus = email.matchStatus;
      const wasAssigned = previousStatus === "auto_matched" || previousStatus === "manually_matched";

      const shouldUpdate = finalMatch !== null && (
        !wasAssigned ||
        (finalMatch.clientId !== previousClientId && finalMatch.confidence > (email.matchConfidence || 0))
      );

      if (shouldUpdate && finalMatch) {
        await storage.updateFrontSyncEmail(email.id, {
          matchedClientId: finalMatch.clientId,
          matchStatus: "auto_matched",
          matchConfidence: finalMatch.confidence,
          matchReason: finalMatch.reasonCode ? `[${finalMatch.reasonCode}] ${finalMatch.reason}` : (finalMatch.reason || null),
        });
        try {
          const existingRawRecord = await storage.findRawCommunicationByExternalSourceId(email.conversationId);
          if (existingRawRecord) {
            if (existingRawRecord.clientId !== finalMatch.clientId) {
              await storage.updateRawCommunication(existingRawRecord.id, {
                clientId: finalMatch.clientId,
              });
            }
            await storage.updateFrontSyncEmail(email.id, {
              ingestedRecordId: existingRawRecord.id,
              processedAt: new Date(),
            });
          } else {
            const ingestResult = await ingestConversation(email.conversationId, finalMatch.clientId, null, undefined, email.lastMessageId);
            await storage.updateFrontSyncEmail(email.id, {
              ingestedRecordId: ingestResult.recordId,
              processedAt: new Date(),
            });
          }
        } catch (ingestErr: any) {
          console.error(`[Front Batch Rematch] Ingest failed for ${email.conversationId}:`, ingestErr.message);
        }
        await enrichClientContactsFromParticipants(finalMatch.clientId, participants, {
          conversationId: email.conversationId,
          messageId: email.lastMessageId || undefined,
          subject: email.subject || undefined,
          snippet: email.snippet || undefined,
        }).catch(err => {
          console.error(`[Front Batch Rematch] Contact enrichment failed for ${email.conversationId}:`, err);
        });
        // Task #2637: propagate the (re)match across the whole Front thread.
        await stampThreadWideClientAttribution(email.conversationId, finalMatch.clientId).catch(err => {
          console.error(`[Front Batch Rematch] Thread-wide attribution failed for ${email.conversationId}:`, err);
        });

        // Task #867: trusted-seeding from agent matches removed.

        if (wasAssigned) {
          reassigned++;
        } else {
          newlyMatched++;
        }
      } else {
        unchanged++;
      }
    } catch (err: any) {
      console.error(`[Front Batch Rematch] Error for syncEmailId ${item.syncEmailId}:`, err.message);
      errors++;
    }
  }

  console.log(`[Front Batch Rematch] Processed ${syncEmailIds.length} emails (ordered: det→domain→agent): ${newlyMatched} matched, ${reassigned} reassigned, ${unchanged} unchanged, ${skippedSpam} spam, ${errors} errors, ${learned} learned`);
  return { total: syncEmailIds.length, reassigned, newlyMatched, unchanged, skippedSpam, errors, learned };
}

export async function enumerateSyncEmailIds(options: {
  matchStatuses: string[];
  limit: number;
  afterCursor?: { createdAt: Date; id: string };
}): Promise<{ ids: string[]; nextCursor: { createdAt: Date; id: string } | null }> {
  // Task #1573 (Audit Track C, P3b): this helper is only called from
  // background work-queue handlers (see workQueueHandlers.ts), so its
  // DB read belongs on the worker pool, not the request-scoped api pool.
  const emails = await runWithWorkerDb(() => storage.listFrontSyncEmails({
    matchStatuses: options.matchStatuses,
    limit: options.limit,
    afterCursor: options.afterCursor,
  }));

  if (emails.length === 0) {
    return { ids: [], nextCursor: null };
  }

  const lastEmail = emails[emails.length - 1];
  return {
    ids: emails.map(e => e.id),
    nextCursor: { createdAt: lastEmail.createdAt || new Date(0), id: lastEmail.id },
  };
}

export async function enumerateReprocessEmailIds(options: {
  cohort: "dismissed_operational" | "unmatched" | "all";
  limit: number;
  afterCursor?: { createdAt: Date; id: string };
}): Promise<{ ids: string[]; nextCursor: { createdAt: Date; id: string } | null }> {
  const listFilters: { matchStatus?: string; matchStatuses?: string[]; limit: number; afterCursor?: { createdAt: Date; id: string } } = {
    limit: options.limit,
    afterCursor: options.afterCursor,
  };
  if (options.cohort === "all") {
    listFilters.matchStatuses = [...frontSyncMatchStatuses];
  } else {
    listFilters.matchStatus = options.cohort;
  }
  // Task #1573 (Audit Track C, P3b): background-handler call site — see
  // sibling enumerateSyncEmailIds for the rationale.
  const emails = await runWithWorkerDb(() => storage.listFrontSyncEmails(listFilters));

  if (emails.length === 0) {
    return { ids: [], nextCursor: null };
  }

  const lastEmail = emails[emails.length - 1];
  return {
    ids: emails.map(e => e.id),
    nextCursor: { createdAt: lastEmail.createdAt || new Date(0), id: lastEmail.id },
  };
}

function isSpamEmail(email: { subject?: string | null; participantsJson?: any; snippet?: string | null }): boolean {
  const subject = email.subject || "";
  for (const pattern of SPAM_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) return true;
  }
  const participants = Array.isArray(email.participantsJson) ? email.participantsJson : [];
  for (const p of participants) {
    const addr = (p.email || "").toLowerCase();
    if (!addr) continue;
    for (const pattern of SPAM_SENDER_PATTERNS) {
      if (pattern.test(addr)) return true;
    }
  }
  return false;
}

const REPROCESS_CHUNK_SIZE = 100;
const REPROCESS_CURSOR_KEY = "front_reprocess_cursor";
const REPROCESS_YIELD_MS = 200;

type ReprocessCohort = "dismissed_operational" | "unmatched" | "all";

interface ReprocessResult {
  total: number;
  reset: number;
  matched: number;
  skippedSpam: number;
  errors: number;
  cohort: ReprocessCohort;
  resumable: boolean;
  cursorId: string | null;
  chunksProcessed: number;
}

export async function reprocessDismissedNonSpam(options?: {
  cohort?: ReprocessCohort;
  maxItems?: number;
  resume?: boolean;
  dryRun?: boolean;
  // Test-only scoping (mirrors `reEvaluateExistingUnmatched`): when supplied,
  // the sweep processes ONLY these ids and skips both cursor persistence and
  // the whole-corpus pagination scan, so a test can exercise the cohort-"all"
  // revisit-assigned behaviour against seeded rows without scanning the dev
  // DB's backlog. Production call sites pass no argument.
  restrictToIds?: string[];
}): Promise<ReprocessResult> {
  const cohort = options?.cohort ?? "dismissed_operational";
  const maxItems = options?.maxItems ?? 50000;
  const resume = options?.resume ?? true;
  const dryRun = options?.dryRun ?? false;
  const restrictToIds = options?.restrictToIds;
  const restricted = !!restrictToIds && restrictToIds.length > 0;

  const cursorKey = `${REPROCESS_CURSOR_KEY}_${cohort}`;
  let cursor: { createdAt: Date; id: string } | undefined = undefined;
  if (resume && !dryRun && !restricted) {
    const saved = await storage.getSystemSetting(cursorKey);
    if (saved?.value) {
      try {
        const parsed = JSON.parse(saved.value);
        if (parsed.createdAt && parsed.id) {
          cursor = { createdAt: new Date(parsed.createdAt), id: parsed.id };
        }
      } catch {
        cursor = undefined;
      }
    }
  }

  if (!cursor) {
    cursor = { createdAt: new Date(0), id: "" };
  }

  const result: ReprocessResult = {
    total: 0, reset: 0, matched: 0, skippedSpam: 0, errors: 0,
    cohort, resumable: false, cursorId: cursor.id || null, chunksProcessed: 0,
  };

  let processedCount = 0;

  while (processedCount < maxItems) {
    const chunkSize = Math.min(REPROCESS_CHUNK_SIZE, maxItems - processedCount);
    const listFilters: { matchStatus?: string; matchStatuses?: string[]; limit: number; afterCursor: typeof cursor } = {
      limit: chunkSize,
      afterCursor: cursor,
    };
    if (cohort === "all") {
      listFilters.matchStatuses = [...frontSyncMatchStatuses];
    } else {
      listFilters.matchStatus = cohort;
    }
    const chunk: (typeof frontSyncEmails.$inferSelect)[] = restricted
      ? await storage.getFrontSyncEmailsByIds(restrictToIds!)
      : await storage.listFrontSyncEmails(listFilters);

    if (chunk.length === 0) break;

    result.total += chunk.length;
    result.chunksProcessed++;

    for (const email of chunk) {
      cursor = { createdAt: email.createdAt || new Date(0), id: email.id };

      try {
        if (isSpamEmail(email)) {
          result.skippedSpam++;
          processedCount++;
          continue;
        }

        const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
        const snippet = email.snippet || "";

        // Task #1271/#2637: canonical manual-filter-rule triage.
        // `reprocessDismissedNonSpam` re-buckets previously dismissed rows
        // back toward matched/unmatched via the deterministic-only path.
        const triage = await triageSyncEmailForMatching(email, {
          logTag: "Front Reprocess",
        });
        if (triage.outcome === "filter_rule_handled" || triage.outcome === "skip_match") {
          processedCount++;
          result.cursorId = email.id;
          continue;
        }

        // Task #867: hard match only — no agent fallback during dismissed reprocess.
        // Use the rich evaluator so we can persist the unmatched reason on
        // the row when the email stays in Unmatched.
        const outcome = await evaluateConversationHardMatch(participants);
        const finalMatch = outcome.match;

        if (finalMatch) {
          result.matched++;
          if (!dryRun) {
            await storage.updateFrontSyncEmail(email.id, {
              matchStatus: "unmatched",
              operationalClassificationReason: null,
              matchedClientId: null,
              matchConfidence: null,
              matchReason: null,
              processedAt: null,
            });
            result.reset++;

            const applyResult = await applyMatchedConversation({
              syncEmailId: email.id,
              conversationId: email.conversationId,
              clientId: finalMatch.clientId,
              matchStatus: "auto_matched",
              matchConfidence: finalMatch.confidence,
              matchReason: finalMatch.reasonCode ? `[${finalMatch.reasonCode}] ${finalMatch.reason}` : (finalMatch.reason || null),
              operationalClassificationReason: null,
              participants,
              lastMessageId: email.lastMessageId,
              versionKey: email.versionKey,
            });

            if (applyResult.action === "error") {
              console.error(`[Front Reprocess] Apply failed for ${email.conversationId}: ${applyResult.error}`);
            }
          }
        } else {
          if (!dryRun) {
            await storage.updateFrontSyncEmail(email.id, {
              matchStatus: "unmatched",
              operationalClassificationReason: null,
              matchedClientId: null,
              matchConfidence: null,
              matchReason: formatUnmatchedReason(outcome),
              processedAt: null,
            });
            result.reset++;
          }
        }

        processedCount++;
        result.cursorId = email.id;
      } catch (err: any) {
        console.error(`[Front Reprocess] Error for ${email.conversationId}:`, err.message);
        result.errors++;
        processedCount++;
        result.cursorId = email.id;
      }
    }

    if (!dryRun && !restricted) {
      await storage.setSystemSetting(
        cursorKey,
        JSON.stringify({ createdAt: cursor!.createdAt.toISOString(), id: cursor!.id }),
        "system"
      );
    }

    // Restricted runs fetch the exact id set in a single pass; never page.
    if (restricted) break;

    if (chunk.length < chunkSize) break;

    await new Promise(resolve => setTimeout(resolve, REPROCESS_YIELD_MS));
  }

  result.resumable = processedCount >= maxItems;
  console.log(`[Front Reprocess] ${cohort} complete: ${result.total} total, ${result.reset} reset, ${result.matched} matched, ${result.skippedSpam} skipped spam, ${result.errors} errors, ${result.chunksProcessed} chunks, resumable=${result.resumable}`);
  return result;
}

// ─── Task #2637 — Re-match the dismissed_operational backlog ──────────
//
// The operational classifier was removed (Task #2637). Every Front message it
// auto-dismissed as "operational" must go back up for deterministic matching.
// This shared core re-runs ONE batch of `dismissed_operational`
// `front_sync_emails` rows through the new deterministic-only path:
//
//   1. Operator manual filter rules (block / dismiss / never_match).
//   2. Deterministic participant hard-match → auto_matched (+ thread-wide
//      client attribution) when a unique client is found, else → unmatched.
//
// CONVERGENCE INVARIANT: every fetched row MUST leave the
// `dismissed_operational` cohort in this pass — INCLUDING the per-row error
// fallback — or the background drain re-fetches the same rows forever and the
// prod-action never converges to "not needed". There is deliberately NO
// "leave the row alone" branch (the perpetual-pending trap).
export interface RematchDismissedOperationalBatchResult {
  scanned: number;
  matched: number;
  unmatched: number;
  dismissedByRule: number;
  errors: number;
}

export const REMATCH_DISMISSED_OPERATIONAL_BATCH_SIZE = 200;

export async function countDismissedOperationalSyncEmails(): Promise<number> {
  return storage.countFrontSyncEmailsByStatus("dismissed_operational");
}

export async function rematchDismissedOperationalBatch(options?: {
  batchSize?: number;
  // TEST-ONLY scoping (mirrors the whole-corpus sweeps): when supplied, the
  // batch processes ONLY these ids instead of the first N of the cohort, so an
  // offline test can assert convergence against a handful of seeded rows
  // without scanning the dev-DB backlog. Production callers (the prod-action
  // runChunk + the CLI) pass no ids; `lint-front-rematch-restrict-to-ids`
  // fails any production use of this option.
  restrictToIds?: string[];
}): Promise<RematchDismissedOperationalBatchResult> {
  const batchSize = options?.batchSize ?? REMATCH_DISMISSED_OPERATIONAL_BATCH_SIZE;
  const restrictToIds = options?.restrictToIds;
  const restricted = !!restrictToIds && restrictToIds.length > 0;

  const chunk = restricted
    ? await storage.getFrontSyncEmailsByIds(restrictToIds!)
    : await storage.listFrontSyncEmails({
        matchStatus: "dismissed_operational",
        limit: batchSize,
      });

  return processDismissedOperationalChunk(chunk);
}

// Task #2641 — id-scoped convergent re-match for the fanned-out work_queue
// drain. The prod-action enqueues `front_sync_reprocess` enumerate jobs which
// page the `dismissed_operational` cohort into DISTINCT id batches (cursor
// ordered, no overlap); each batch job calls this to run the EXACT same
// deterministic, convergent per-row attempt the serial drain used. This is the
// intended production id-scoped interface (fed by the enumerator), NOT the
// test-only `restrictToIds` shortcut on `rematchDismissedOperationalBatch`
// (which skips cursor/scan semantics and is lint-blocked for production), so it
// carries no `restrictToIds` option and never trips
// `lint-front-rematch-restrict-to-ids`.
export async function rematchDismissedOperationalByIds(
  syncEmailIds: string[],
): Promise<RematchDismissedOperationalBatchResult> {
  if (syncEmailIds.length === 0) {
    return { scanned: 0, matched: 0, unmatched: 0, dismissedByRule: 0, errors: 0 };
  }
  const chunk = await storage.getFrontSyncEmailsByIds(syncEmailIds);
  return processDismissedOperationalChunk(chunk);
}

// Shared convergent per-row loop for the dismissed_operational re-match. See the
// CONVERGENCE INVARIANT above: every fetched row still in the cohort MUST leave
// it in this pass (match → auto_matched, no-match/never_match/error → unmatched,
// operator rule → blocked/dismissed) or the drain re-fetches the same rows
// forever and the prod-action never converges to "not needed".
async function processDismissedOperationalChunk(
  chunk: FrontSyncEmail[],
): Promise<RematchDismissedOperationalBatchResult> {
  const result: RematchDismissedOperationalBatchResult = {
    scanned: 0,
    matched: 0,
    unmatched: 0,
    dismissedByRule: 0,
    errors: 0,
  };

  for (const email of chunk) {
    // A restricted (test) run may include ids already moved out of the cohort
    // by an earlier pass; only count rows that are still dismissed_operational.
    if (email.matchStatus !== "dismissed_operational") continue;
    result.scanned++;
    try {
      const participants =
        (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];

      const triage = await triageSyncEmailForMatching(email, {
        logTag: "Front Rematch Dismissed",
      });

      if (triage.outcome === "filter_rule_handled") {
        // Triage already moved the row to blocked/dismissed per an operator
        // rule; clear any stale thread-wide client attribution.
        await stampThreadWideClientAttribution(email.conversationId, null);
        result.dismissedByRule++;
        continue;
      }

      if (triage.outcome === "skip_match") {
        // never_match operator rule: do NOT auto-match, but the row still
        // leaves the cohort → Unmatched (manual linking remains possible).
        await storage.updateFrontSyncEmail(email.id, {
          matchStatus: "unmatched",
          operationalClassificationReason: null,
          matchedClientId: null,
          matchConfidence: null,
          matchReason: "[never_match] operator filter rule",
          processedAt: null,
        });
        await stampThreadWideClientAttribution(email.conversationId, null);
        result.unmatched++;
        continue;
      }

      // proceed → deterministic participant hard-match only (no AI fallback).
      const outcome = await evaluateConversationHardMatch(participants);
      const finalMatch = outcome.match;
      if (finalMatch) {
        // Clear the row to a neutral state first so it leaves the cohort even
        // if applyMatchedConversation later throws; apply then stamps it
        // auto_matched + propagates thread-wide attribution (Task #2637).
        await storage.updateFrontSyncEmail(email.id, {
          matchStatus: "unmatched",
          operationalClassificationReason: null,
          matchedClientId: null,
          matchConfidence: null,
          matchReason: null,
          processedAt: null,
        });
        const applyResult = await applyMatchedConversation({
          syncEmailId: email.id,
          conversationId: email.conversationId,
          clientId: finalMatch.clientId,
          matchStatus: "auto_matched",
          matchConfidence: finalMatch.confidence,
          matchReason: finalMatch.reasonCode
            ? `[${finalMatch.reasonCode}] ${finalMatch.reason}`
            : finalMatch.reason || null,
          operationalClassificationReason: null,
          participants,
          lastMessageId: email.lastMessageId,
          versionKey: email.versionKey,
        });
        if (applyResult.action === "error") {
          // Row is already out of the cohort (set unmatched above), so
          // convergence holds; record the apply failure and keep going.
          console.error(
            `[Front Rematch Dismissed] Apply failed for ${email.conversationId}: ${applyResult.error}`,
          );
          result.errors++;
        } else {
          result.matched++;
        }
      } else {
        await storage.updateFrontSyncEmail(email.id, {
          matchStatus: "unmatched",
          operationalClassificationReason: null,
          matchedClientId: null,
          matchConfidence: null,
          matchReason: formatUnmatchedReason(outcome),
          processedAt: null,
        });
        await stampThreadWideClientAttribution(email.conversationId, null);
        result.unmatched++;
      }
    } catch (err: any) {
      // CONVERGENCE GUARD: move the row out of the cohort even on a per-row
      // failure, or the drain re-fetches it forever (perpetual pending).
      result.errors++;
      try {
        await storage.updateFrontSyncEmail(email.id, {
          matchStatus: "unmatched",
          operationalClassificationReason: null,
          matchedClientId: null,
          matchConfidence: null,
          matchReason: `[rematch-error] ${String(err?.message ?? err).slice(0, 200)}`,
          processedAt: null,
        });
        await stampThreadWideClientAttribution(email.conversationId, null);
      } catch (inner: any) {
        // If even the fallback write fails the DB is unhealthy; rethrow so the
        // drain loop records an error and stops rather than spinning.
        throw inner;
      }
      console.error(
        `[Front Rematch Dismissed] Error for ${email.conversationId}:`,
        err?.message ?? err,
      );
    }
  }

  return result;
}

// Task #2641 — fan-out producer for the dismissed_operational drain. Instead of
// a single serial loop pinned to one worker thread (holding a cluster-wide
// advisory lock that dies on autoscale recycle and only re-arms every 6h), the
// drain runs as durable, parallel `work_queue` jobs: this enqueues ONE
// `front_sync_reprocess` enumerate job for the `dismissed_operational` cohort
// with `convergeDismissedOperational`, and `handleFrontSyncReprocess` pages the
// cohort into distinct id batches (each run via `rematchDismissedOperationalByIds`)
// plus a continuation, fanning out across the `repair` workload class. Progress
// is durable across instance recycles (any instance claims the next queued job).
export async function rematchDismissedOperationalDrainProducer(options?: {
  maxItems?: number;
}): Promise<{ jobId: string; version: number }> {
  if (!PERF.FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED) {
    throw new Error(
      "Background job enqueue disabled (FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED=false)",
    );
  }
  const { enqueueRepairJob } = await import("./repairDispatcher");
  const version = await nextProducerVersion();
  // Large ceiling so a single press drains the whole cohort; the enumerate
  // continuation stops naturally once the cohort is empty (ids.length === 0).
  const maxItems = options?.maxItems ?? 1_000_000;
  const jobId = await enqueueRepairJob({
    queueName: "front_sync_reprocess",
    workloadClass: "repair",
    payload: {
      cohort: "dismissed_operational",
      convergeDismissedOperational: true,
      maxItems,
      producerVersion: version,
    },
    priority: 50,
    maxAttempts: 3,
    dedupeKey: `producer:dismissed_operational_drain:v${version}`,
  });
  console.log(
    `[Dismissed-Operational Drain] Enqueued fan-out producer job ${jobId} (maxItems=${maxItems}, v${version})`,
  );
  return { jobId, version };
}

// Task #2641 — watchdog/observability for the fanned-out drain. Returns true
// while ANY enumerate / batch / continuation job for the convergent
// dismissed_operational drain is still pending/leased/processing in the shared
// `front_sync_reprocess` queue. The prod-action uses this so re-applying (manual
// or self-heal) while a chain is in flight is a no-op instead of piling up a
// second overlapping chain, and so `status()` can surface a stalled cohort
// (rows remain but no chain is running) rather than looking silently idle.
export async function isDismissedOperationalDrainActive(): Promise<boolean> {
  const rows = await runWithWorkerDb(() =>
    withDbAttribution("maintenance:dismissed-operational-drain-active", () =>
      getDb()
        .select({ id: workQueue.id })
        .from(workQueue)
        .where(
          sql`${workQueue.queueName} = 'front_sync_reprocess'
            AND ${workQueue.status} IN ('pending', 'leased', 'processing')
            AND ${workQueue.payload}->>'convergeDismissedOperational' = 'true'`,
        )
        .limit(1),
    ),
  );
  return rows.length > 0;
}

// ─── Task #4049 — unmatched-backlog deterministic re-match ──────────────────
//
// 96% of Front email traffic sat unmatched because zero clients had trusted
// email domains populated (the Task #867 domain tier never fired). Once the
// domain seeding action populates `clients.email_domains`, this drain re-runs
// the deterministic-only matcher across the unmatched cohort so the backlog
// catches up with the new evidence. Mirrors the Task #2641 dismissed-
// operational fan-out (durable work_queue chain, id batches, continuation),
// with one critical difference: rows legitimately REMAIN unmatched — the
// enumerate cursor (createdAt, id) advances regardless of row outcomes, so
// termination is cursor exhaustion, never cohort emptiness.

export interface RematchUnmatchedBacklogResult {
  scanned: number;
  matched: number;
  dismissedByRule: number;
  neverMatch: number;
  stillUnmatched: number;
  reasonRefreshed: number;
  errors: number;
}

/**
 * Task #4049 — id-scoped deterministic re-match over unmatched rows, fed by
 * the fanned-out `front_sync_reprocess` drain (`rematchUnmatchedBacklog`
 * payload flag). Per row (only if still `unmatched` at fetch time):
 *   filter rule → blocked/dismissed (leaves cohort, attribution cleared);
 *   never_match rule → stays unmatched with the rule reason;
 *   deterministic hard-match → auto_matched + thread-wide stamp + audit row;
 *   no match → refresh `match_reason` ONLY when it changed (the 140k+-row
 *   backlog would otherwise generate a no-op write per row per press), and
 *   record NO audit row (bulk no-match audits would add ~148k inserts of
 *   pure noise; matches and rule transitions are the auditable events).
 * Errors leave the row untouched — the cursor advances past it, so a bad row
 * cannot wedge the chain, and the next press retries it.
 */
export async function rematchUnmatchedBacklogByIds(
  syncEmailIds: string[],
): Promise<RematchUnmatchedBacklogResult> {
  if (syncEmailIds.length === 0) {
    return { scanned: 0, matched: 0, dismissedByRule: 0, neverMatch: 0, stillUnmatched: 0, reasonRefreshed: 0, errors: 0 };
  }
  const chunk = await storage.getFrontSyncEmailsByIds(syncEmailIds);
  return processUnmatchedBacklogChunk(chunk);
}

async function processUnmatchedBacklogChunk(
  chunk: FrontSyncEmail[],
): Promise<RematchUnmatchedBacklogResult> {
  const result: RematchUnmatchedBacklogResult = {
    scanned: 0,
    matched: 0,
    dismissedByRule: 0,
    neverMatch: 0,
    stillUnmatched: 0,
    reasonRefreshed: 0,
    errors: 0,
  };

  for (const email of chunk) {
    // Batches are enumerated ahead of processing — a row may have been
    // manually linked / blocked between enumeration and this batch running.
    // Only rows still in the cohort are touched (idempotent re-press).
    if (email.matchStatus !== "unmatched") continue;
    result.scanned++;
    try {
      const participants =
        (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];

      const triage = await triageSyncEmailForMatching(email, {
        logTag: "Front Rematch Unmatched",
      });

      if (triage.outcome === "filter_rule_handled") {
        // Operator rule moved the row to blocked/dismissed; clear any stale
        // thread-wide attribution (idempotent — unmatched rows carry none).
        await stampThreadWideClientAttribution(email.conversationId, null);
        result.dismissedByRule++;
        continue;
      }

      if (triage.outcome === "skip_match") {
        // never_match operator rule: row STAYS unmatched by design; make the
        // reason say so (write only on change to keep re-presses cheap).
        const neverMatchReason = "[never_match] operator filter rule";
        if (email.matchReason !== neverMatchReason) {
          await storage.updateFrontSyncEmail(email.id, { matchReason: neverMatchReason });
        }
        result.neverMatch++;
        continue;
      }

      // proceed → deterministic participant hard-match only (no AI fallback).
      const outcome = await evaluateConversationHardMatch(participants);
      const finalMatch = outcome.match;
      if (finalMatch) {
        const applyResult = await applyMatchedConversation({
          syncEmailId: email.id,
          conversationId: email.conversationId,
          clientId: finalMatch.clientId,
          matchStatus: "auto_matched",
          matchConfidence: finalMatch.confidence,
          matchReason: finalMatch.reasonCode
            ? `[${finalMatch.reasonCode}] ${finalMatch.reason}`
            : finalMatch.reason || null,
          operationalClassificationReason: null,
          participants,
          lastMessageId: email.lastMessageId,
          versionKey: email.versionKey,
        });
        if (applyResult.action === "error") {
          console.error(
            `[Front Rematch Unmatched] Apply failed for ${email.conversationId}: ${applyResult.error}`,
          );
          result.errors++;
        } else {
          await recordHardMatchAudit({
            syncEmail: email,
            source: "rematch_unmatched_backlog",
            finalMatch,
          });
          result.matched++;
        }
      } else {
        const newReason = formatUnmatchedReason(outcome);
        if (newReason && newReason !== email.matchReason) {
          await storage.updateFrontSyncEmail(email.id, { matchReason: newReason });
          result.reasonRefreshed++;
        }
        result.stillUnmatched++;
      }
    } catch (err: any) {
      // Unlike the dismissed drain there is NO cohort-exit requirement: the
      // enumerate cursor advances past this row regardless, so leave it
      // untouched for the next press instead of stamping an error state.
      result.errors++;
      console.error(
        `[Front Rematch Unmatched] Error for ${email.conversationId}:`,
        err?.message ?? err,
      );
    }
  }

  return result;
}

/**
 * Task #4049 — fan-out producer for the unmatched-backlog re-match. Enqueues
 * ONE `front_sync_reprocess` enumerate job for the `unmatched` cohort with the
 * `rematchUnmatchedBacklog` flag; `handleFrontSyncReprocess` pages the cohort
 * into distinct id batches (each run via `rematchUnmatchedBacklogByIds`) plus
 * a continuation. Captures baseline cohort counts in the payload so the final
 * continuation can report the before/after lift in `prod_action_runs`.
 */
export async function rematchUnmatchedBacklogDrainProducer(options?: {
  maxItems?: number;
}): Promise<{ jobId: string; version: number; baselineUnmatched: number; baselineAutoMatched: number }> {
  if (!PERF.FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED) {
    throw new Error(
      "Background job enqueue disabled (FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED=false)",
    );
  }
  const { enqueueRepairJob } = await import("./repairDispatcher");
  const version = await nextProducerVersion();
  const baselineUnmatched = await storage.countFrontSyncEmailsByStatus("unmatched");
  const baselineAutoMatched = await storage.countFrontSyncEmailsByStatus("auto_matched");
  // Ceiling above the whole backlog (~148k in prod) so one press walks the
  // full cohort; termination is cursor exhaustion (ids.length === 0).
  const maxItems = options?.maxItems ?? 1_000_000;
  const jobId = await enqueueRepairJob({
    queueName: "front_sync_reprocess",
    workloadClass: "repair",
    payload: {
      cohort: "unmatched",
      rematchUnmatchedBacklog: true,
      baselineUnmatched,
      baselineAutoMatched,
      startedAtIso: new Date().toISOString(),
      maxItems,
      producerVersion: version,
    },
    priority: 50,
    maxAttempts: 3,
    dedupeKey: `producer:unmatched_backlog_rematch:v${version}`,
  });
  console.log(
    `[Unmatched-Backlog Rematch] Enqueued fan-out producer job ${jobId} (maxItems=${maxItems}, v${version}, baseline unmatched=${baselineUnmatched}, auto_matched=${baselineAutoMatched})`,
  );
  return { jobId, version, baselineUnmatched, baselineAutoMatched };
}

/**
 * Task #4049 — true while ANY enumerate / batch / continuation job of the
 * unmatched-backlog re-match chain is pending/leased/processing. The prod
 * action uses this so a re-press while a chain is in flight is a no-op
 * instead of a second overlapping chain.
 */
export async function isUnmatchedBacklogRematchActive(): Promise<boolean> {
  const rows = await runWithWorkerDb(() =>
    withDbAttribution("maintenance:unmatched-backlog-rematch-active", () =>
      getDb()
        .select({ id: workQueue.id })
        .from(workQueue)
        .where(
          sql`${workQueue.queueName} = 'front_sync_reprocess'
            AND ${workQueue.status} IN ('pending', 'leased', 'processing')
            AND ${workQueue.payload}->>'rematchUnmatchedBacklog' = 'true'`,
        )
        .limit(1),
    ),
  );
  return rows.length > 0;
}

/**
 * Task #4049 — finalizer gate for the unmatched-backlog re-match chain: are
 * any fan-out BATCH jobs of the chain still in flight (pending/leased/
 * processing)? Batch jobs are discriminated from enumerate/finalize
 * continuations by the presence of `syncEmailIds` in the payload. Scoped to
 * the chain's `producerVersion` when provided so stragglers from an old
 * aborted chain cannot stall a newer chain's finalizer, and the probing job
 * excludes itself by id. The completion/lift row is only written once this
 * returns false, so the recorded counts are settled — never a mid-drain
 * snapshot.
 */
export async function hasInFlightUnmatchedRematchBatchJobs(options: {
  excludeJobId?: string;
  producerVersion?: number | null;
}): Promise<boolean> {
  const versionClause =
    options.producerVersion != null
      ? sql` AND ${workQueue.payload}->>'producerVersion' = ${String(options.producerVersion)}`
      : sql``;
  const excludeClause = options.excludeJobId
    ? sql` AND ${workQueue.id} <> ${options.excludeJobId}`
    : sql``;
  const rows = await runWithWorkerDb(() =>
    withDbAttribution("maintenance:unmatched-backlog-rematch-finalize-gate", () =>
      getDb()
        .select({ id: workQueue.id })
        .from(workQueue)
        .where(
          sql`${workQueue.queueName} = 'front_sync_reprocess'
            AND ${workQueue.status} IN ('pending', 'leased', 'processing')
            AND ${workQueue.payload}->>'rematchUnmatchedBacklog' = 'true'
            AND ${workQueue.payload}->'syncEmailIds' IS NOT NULL${versionClause}${excludeClause}`,
        )
        .limit(1),
    ),
  );
  return rows.length > 0;
}

/**
 * Task #4049 — capped estimate of unmatched rows the deterministic matcher
 * could claim under the CURRENT trusted-domain configuration: rows with at
 * least one HUMAN (non-automated) participant on a single-owner trusted
 * domain, excluding rows the resolver already adjudicated as shared-evidence
 * collisions (`[shared_…` reasons — those can never auto-match, so counting
 * them would leave the action pending forever). Powers the prod-action
 * status(); after a full pass every counted row either matched (left the
 * cohort) or received a `[shared_…` / `[automated_senders_only…` verdict, so
 * the estimate converges to 0 without manual bookkeeping.
 */
export async function countRematchableUnmatchedSyncEmails(): Promise<{
  count: number;
  capped: boolean;
  trustedDomains: number;
}> {
  const CAP = 10_000;
  const { getHardMatchIndexes } = await import("./frontHardMatch");
  const indexes = await getHardMatchIndexes();
  // Only single-owner domains can auto-claim (all-or-one rule).
  const uniqueDomains: string[] = [];
  for (const [domain, owners] of indexes.domainIndex) {
    if (owners.size === 1) uniqueDomains.push(domain);
  }
  if (uniqueDomains.length === 0) {
    return { count: 0, capped: false, trustedDomains: 0 };
  }
  const { AUTOMATED_SENDER_SQL_REGEX } = await import("./companyIdentity");
  const rows = await runWithWorkerDb(() =>
    withDbAttribution("maintenance:unmatched-backlog-rematch-estimate", () =>
      getDb().execute(sql`
        SELECT count(*)::int AS n FROM (
          SELECT 1
          FROM front_sync_emails fse
          WHERE fse.match_status = 'unmatched'
            AND (fse.match_reason IS NULL OR fse.match_reason NOT LIKE '[shared\\_%')
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(fse.participants_json) AS p
              WHERE split_part(lower(p->>'email'), '@', 2) = ANY(${bindArrayParam(uniqueDomains, "text")})
                AND NOT (lower(p->>'email') ~ ${AUTOMATED_SENDER_SQL_REGEX})
            )
          LIMIT ${CAP + 1}
        ) t
      `),
    ),
  );
  const raw = Number((rows as any).rows?.[0]?.n ?? 0);
  return {
    count: Math.min(raw, CAP),
    capped: raw > CAP,
    trustedDomains: uniqueDomains.length,
  };
}

const REMATCH_CURSOR_KEY = "front_rematch_all_cursor";

interface RematchAllResult {
  total: number;
  reassigned: number;
  unchanged: number;
  newlyMatched: number;
  skippedSpam: number;
  errors: number;
  resumable: boolean;
  cursorId: string | null;
  chunksProcessed: number;
}

export async function rematchAll(options?: {
  maxItems?: number;
  resume?: boolean;
  dryRun?: boolean;
  onProgress?: (progress: Partial<RematchAllResult> & { processed: number; maxItems: number }) => void;
  // Test-only scoping (mirrors `reEvaluateExistingUnmatched`): when supplied,
  // the sweep processes ONLY these ids and skips both cursor persistence and
  // the whole-corpus pagination scan, so a test can exercise the
  // revisit-already-matched behaviour against seeded rows without scanning the
  // dev DB's backlog. Production call sites pass no argument.
  restrictToIds?: string[];
}): Promise<RematchAllResult> {
  const maxItems = options?.maxItems ?? 50000;
  const resume = options?.resume ?? false;
  const dryRun = options?.dryRun ?? false;
  const restrictToIds = options?.restrictToIds;
  const restricted = !!restrictToIds && restrictToIds.length > 0;

  // Task #867: agent trusted-seeding removed from rematch.
  const CHECKPOINT_INTERVAL = 10;

  let cursor: { createdAt: Date; id: string } | undefined = undefined;
  if (resume && !restricted) {
    const saved = await storage.getSystemSetting(REMATCH_CURSOR_KEY);
    if (saved?.value) {
      try {
        const parsed = JSON.parse(saved.value);
        if (parsed.createdAt && parsed.id) {
          cursor = { createdAt: new Date(parsed.createdAt), id: parsed.id };
        }
      } catch {
        cursor = undefined;
      }
    }
  }

  if (!cursor) {
    cursor = { createdAt: new Date(0), id: "" };
  }

  const result: RematchAllResult = {
    total: 0, reassigned: 0, unchanged: 0, newlyMatched: 0, skippedSpam: 0, errors: 0,
    resumable: false, cursorId: cursor.id || null, chunksProcessed: 0,
  };

  let processedCount = 0;
  let sinceLastCheckpoint = 0;

  while (processedCount < maxItems) {
    const chunkSize = Math.min(REPROCESS_CHUNK_SIZE, maxItems - processedCount);
    const chunk: (typeof frontSyncEmails.$inferSelect)[] = restricted
      ? await storage.getFrontSyncEmailsByIds(restrictToIds!)
      : await storage.listFrontSyncEmails({
          matchStatuses: [...frontSyncMatchStatuses],
          limit: chunkSize,
          afterCursor: cursor,
        });

    if (chunk.length === 0) break;

    result.total += chunk.length;
    result.chunksProcessed++;

    const chunkClassified: Array<{ email: typeof chunk[0]; tier: RematchTier; deterministicMatch: ClientMatchResult | null }> = [];
    for (const email of chunk) {
      if (isSpamEmail(email)) {
        result.skippedSpam++;
        result.unchanged++;
        processedCount++;
        sinceLastCheckpoint++;
        cursor = { createdAt: email.createdAt || new Date(0), id: email.id };
        if (!dryRun && sinceLastCheckpoint >= CHECKPOINT_INTERVAL) {
          await storage.setSystemSetting(
            REMATCH_CURSOR_KEY,
            JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
            "system"
          );
          sinceLastCheckpoint = 0;
        }
        continue;
      }
      try {
        const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
        // Task #1271/#2637: canonical manual-filter-rule triage. `rematchAll`
        // only re-buckets rows; manual block/dismiss/never_match still apply.
        const triage = await triageSyncEmailForMatching(email, {
          logTag: "Front Rematch",
        });
        if (triage.outcome === "filter_rule_handled" || triage.outcome === "skip_match") {
          result.unchanged++;
          processedCount++;
          sinceLastCheckpoint++;
          cursor = { createdAt: email.createdAt || new Date(0), id: email.id };
          continue;
        }
        const legacyMatch = await matchConversationToClient(participants, email.subject || "");
        let tier: RematchTier = "agent";
        if (legacyMatch?.matchKind === "deterministic_unique_exact") tier = "deterministic";
        else if (legacyMatch?.matchKind === "domain") tier = "domain";
        chunkClassified.push({ email, tier, deterministicMatch: legacyMatch });
      } catch (classifyErr: any) {
        console.error(`[Front Rematch] Pre-classify error for ${email.conversationId}:`, classifyErr.message);
        result.errors++;
        processedCount++;
        sinceLastCheckpoint++;
        cursor = { createdAt: email.createdAt || new Date(0), id: email.id };
      }
    }

    chunkClassified.sort((a, b) => rematchTierOrder(a.tier) - rematchTierOrder(b.tier));

    for (const item of chunkClassified) {
      const email = item.email;
      cursor = { createdAt: email.createdAt || new Date(0), id: email.id };

      try {
        const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];

        // Task #867: hard match only — no agent fallback during rematch.
        const finalMatch: ClientMatchResult | null = item.deterministicMatch;

        const previousClientId = email.matchedClientId;
        const previousStatus = email.matchStatus;
        const wasAssigned = previousStatus === "auto_matched" || previousStatus === "manually_matched";

        const shouldUpdate = finalMatch !== null && (
          !wasAssigned ||
          (finalMatch.clientId !== previousClientId && finalMatch.confidence > (email.matchConfidence || 0))
        );

        if (shouldUpdate && finalMatch) {
          if (!dryRun) {
            const applyResult = await applyMatchedConversation({
              syncEmailId: email.id,
              conversationId: email.conversationId,
              clientId: finalMatch.clientId,
              matchStatus: "auto_matched",
              matchConfidence: finalMatch.confidence,
              matchReason: finalMatch.reasonCode ? `[${finalMatch.reasonCode}] ${finalMatch.reason}` : (finalMatch.reason || null),
              participants,
              lastMessageId: email.lastMessageId,
              versionKey: email.versionKey,
            });

            if (applyResult.action === "error") {
              console.error(`[Front Rematch] Apply failed for ${email.conversationId}: ${applyResult.error}`);
            }

            await recordHardMatchAudit({
              syncEmail: email,
              source: "rematch_all",
              finalMatch,
            });
          }
          if (wasAssigned) {
            result.reassigned++;
          } else {
            result.newlyMatched++;
          }
        } else {
          result.unchanged++;
          if (!dryRun && finalMatch === null) {
            await recordHardMatchAudit({
              syncEmail: email,
              source: "rematch_all",
              finalMatch: null,
            });
          }
        }

        processedCount++;
        sinceLastCheckpoint++;
        result.cursorId = email.id;
        if (options?.onProgress && processedCount % 5 === 0) {
          options.onProgress({ ...result, processed: processedCount, maxItems });
        }
      } catch (err: any) {
        console.error(`[Front Rematch] Error for ${email.conversationId}:`, err.message);
        result.errors++;
        processedCount++;
        sinceLastCheckpoint++;
        result.cursorId = email.id;
        if (options?.onProgress && processedCount % 5 === 0) {
          options.onProgress({ ...result, processed: processedCount, maxItems });
        }
      }

      if (!dryRun && sinceLastCheckpoint >= CHECKPOINT_INTERVAL) {
        await storage.setSystemSetting(
          REMATCH_CURSOR_KEY,
          JSON.stringify({ createdAt: cursor!.createdAt.toISOString(), id: cursor!.id }),
          "system"
        );
        sinceLastCheckpoint = 0;
      }
    }

    if (!dryRun && !restricted) {
      await storage.setSystemSetting(
        REMATCH_CURSOR_KEY,
        JSON.stringify({ createdAt: cursor!.createdAt.toISOString(), id: cursor!.id }),
        "system"
      );
      sinceLastCheckpoint = 0;
    }

    // Restricted runs fetch the exact id set in a single pass; never page.
    if (restricted) break;

    if (chunk.length < chunkSize) break;

    await new Promise(resolve => setTimeout(resolve, REPROCESS_YIELD_MS));
  }

  result.resumable = processedCount >= maxItems;
  if (!result.resumable && !dryRun && !restricted) {
    await storage.setSystemSetting(REMATCH_CURSOR_KEY, "", "system");
  }
  if (options?.onProgress) {
    options.onProgress({ ...result, processed: processedCount, maxItems });
  }
  console.log(`[Front Rematch] Complete (Task #867 hard-match only): ${result.total} total, ${result.reassigned} reassigned, ${result.newlyMatched} newly matched, ${result.unchanged} unchanged, ${result.skippedSpam} skipped spam, ${result.errors} errors, resumable=${result.resumable}`);
  return result;
}

export async function enrichClientContactsFromParticipants(
  clientId: string,
  participants: Array<{ name?: string; email?: string; role?: string }>,
  /**
   * Provenance for the suggestion row when no primary contact exists. The
   * import-write policy requires that any suggestion includes enough
   * conversation/message context for an operator to evaluate it later.
   */
  provenance?: { conversationId?: string; messageId?: string; subject?: string; snippet?: string },
): Promise<number> {
  let added = 0;

  const TEAM_ROLES = ["team"];
  const externalParticipants = participants.filter(p => {
    if (!p.email) return false;
    const role = (p.role || "").toLowerCase();
    return !TEAM_ROLES.includes(role);
  });

  const validEmails = [...new Set(
    externalParticipants
      .map(p => p.email?.toLowerCase().trim())
      .filter((e): e is string => !!e && e.includes("@"))
  )];

  if (validEmails.length === 0) return 0;

  const { isCompanyEmail } = await import("./companyIdentity");
  const filteredEmails = validEmails.filter(e => {
    if (isCompanyEmail(e)) return false;
    for (const pattern of SPAM_SENDER_PATTERNS) {
      if (pattern.test(e)) return false;
    }
    return true;
  });

  if (filteredEmails.length === 0) return 0;

  const emailsToAdd = filteredEmails;

  const contacts = await storage.getClientContacts(clientId);
  const allExistingEmails = new Set<string>();
  for (const c of contacts) {
    if (c.emails) {
      for (const e of c.emails) {
        if (e) allExistingEmails.add(e.toLowerCase());
      }
    }
  }

  const newEmails = emailsToAdd.filter(e => !allExistingEmails.has(e));
  if (newEmails.length === 0) return 0;

  // Task #914: Front enrichment NEVER silently appends participant emails to
  // an existing client contact. The previous behaviour (auto-extending the
  // primary contact's `emails` array on every sync) re-bloated contacts that
  // operators had just cleaned up — within minutes the next Front sync would
  // re-attach every previously-deleted vendor / no-reply / opposing-counsel
  // email. All candidate participant emails — whether the client already has
  // a contact or not — are now routed to the same `import_entity_suggestions`
  // review queue used by the no-contact case, so an operator must explicitly
  // promote them via the Command Panel before they land on a contact.
  //
  // The trusted-domain auto-promotion path in `applyMatchedConversation`
  // (matchedByDomain → `promoteEmailsToClientContact`) is the deliberate
  // operator opt-in and is intentionally left untouched.
  const { evaluateImportWrite } = await import("./importWritePolicy");
  const participantName = participants.find(p => p.name && p.email)?.name || "Auto-discovered Contact";
  const decision = evaluateImportWrite("front_enrichment", "client_contact", "create", {
    entityExists: false,
    candidateLabel: participantName,
  });
  if (decision.decision === "allow_review_suggestion") {
    try {
      await storage.createImportEntitySuggestion({
        clientId,
        entityKind: "client_contact",
        surface: "front_enrichment",
        candidate: {
          name: participantName,
          emails: newEmails,
          phones: [],
        },
        sourceRef: {
          participants: participants.slice(0, 10).map(p => ({ name: p.name, email: p.email, role: p.role })),
          conversationId: provenance?.conversationId,
          messageId: provenance?.messageId,
          subject: provenance?.subject,
          snippet: provenance?.snippet,
          capturedAt: new Date().toISOString(),
        },
        reason: decision.reason,
        status: "pending",
      });
      console.log(`[Front] Routed candidate contact for client ${clientId} (${newEmails.length} emails) to import suggestions queue`);
    } catch (sErr) {
      console.error(`[Front] Failed to record contact suggestion for client ${clientId}:`, sErr);
    }
  } else {
    console.log(`[Front] ${decision.warning || decision.reason}`);
  }
  // `added` stays 0 — no authoritative contact was created or extended.
  return added;
}

export interface ApplyItemInput {
  syncEmailId: string;
  conversationId: string;
  clientId: string;
  matchStatus: string;
  matchConfidence: number | null;
  matchReason: string | null;
  operationalClassificationReason?: string | null;
  participants: Array<{ name?: string; email?: string; role?: string }>;
  lastMessageId?: string | null;
  versionKey?: string | null;
}

export interface ApplyItemResult {
  syncEmailId: string;
  conversationId: string;
  action: "created" | "updated" | "noop" | "error";
  recordId?: string;
  contactsEnriched?: number;
  error?: string;
}

export async function applyMatchedConversation(
  item: ApplyItemInput,
): Promise<ApplyItemResult> {
  const { syncEmailId, conversationId, clientId, participants, lastMessageId } = item;
  const resultBase = { syncEmailId, conversationId };

  if (!PERF.FRONT_PIPELINE_APPLY_ENABLED) {
    return { ...resultBase, action: "noop", error: "apply_stage_disabled" };
  }

  try {
    const syncRecord = await storage.getFrontSyncEmail(syncEmailId);
    if (!syncRecord) {
      return { ...resultBase, action: "error", error: "Sync email record not found" };
    }

    const sameVersion = item.versionKey != null
      ? syncRecord.versionKey === item.versionKey
      : syncRecord.lastMessageId === lastMessageId;

    if (
      syncRecord.pipelineState === "applied" &&
      syncRecord.ingestedRecordId &&
      sameVersion &&
      syncRecord.matchedClientId === clientId
    ) {
      return { ...resultBase, action: "noop", recordId: syncRecord.ingestedRecordId };
    }

    await storage.updateFrontSyncEmail(syncEmailId, {
      matchedClientId: clientId,
      matchStatus: item.matchStatus,
      matchConfidence: item.matchConfidence,
      matchReason: item.matchReason,
      ...(item.operationalClassificationReason !== undefined
        ? { operationalClassificationReason: item.operationalClassificationReason }
        : {}),
    });

    // Task #2637: a match applied to a conversation is conversation-wide — stamp
    // the client onto every message row of the thread, not just the rollup row.
    // Task #4769: this stamp runs IMMEDIATELY after the match-fields write,
    // BEFORE the hydrated-snapshot gate below. Late matches (retroactive
    // per-client re-evals, backlog rematch) routinely land on conversations
    // whose hydrate snapshot was pruned or never existed; the gate then throws,
    // and when this stamp lived at the tail of the function those conversations
    // were left matched with NULL-client raw rows — the born-pending residue
    // the `backfill_front_message_attribution` drain mopped up daily (~70
    // rows/day routine; 18,474 after a domain-seeding Apply-all). Stamping
    // existing thread rows depends only on the committed match decision, never
    // on the snapshot — so it must not sit behind that gate. See
    // audits/front-attribution-residual-pending-2026-08.md.
    await stampThreadWideClientAttribution(conversationId, clientId).catch(err => {
      console.error(`[Front Apply] Thread-wide attribution failed for ${conversationId}:`, err);
    });

    const snapshot = await getHydratedSnapshot(conversationId, lastMessageId);
    if (!snapshot) {
      const snapshotVK = computeVersionKey(conversationId, lastMessageId ?? null);
      const directSnapshot = await storage.getFrontHydrateSnapshotByConversationId(conversationId);
      if (!directSnapshot) {
        throw new Error(`No hydrated snapshot available for conversation ${conversationId} (versionKey=${snapshotVK}). Hydration must run before apply.`);
      }
    }

    let recordId: string | undefined;
    let action: "created" | "updated" | "noop" = "noop";

    const existingRawRecord = await storage.findRawCommunicationByExternalSourceId(conversationId);

    if (existingRawRecord) {
      if (existingRawRecord.clientId !== clientId) {
        await storage.updateRawCommunication(existingRawRecord.id, { clientId });
        action = "updated";
      } else {
        action = syncRecord.ingestedRecordId === existingRawRecord.id ? "noop" : "updated";
      }
      recordId = existingRawRecord.id;
    } else {
      try {
        const ingestResult = await ingestConversation(
          conversationId,
          clientId,
          null,
          undefined,
          lastMessageId,
        );
        recordId = ingestResult.recordId;
        action = "created";
      } catch (ingestErr: any) {
        if (ingestErr.message?.includes("already been ingested")) {
          const retryLookup = await storage.findRawCommunicationByExternalSourceId(conversationId);
          if (retryLookup) {
            recordId = retryLookup.id;
            if (retryLookup.clientId !== clientId) {
              await storage.updateRawCommunication(retryLookup.id, { clientId });
              action = "updated";
            } else {
              action = "noop";
            }
          } else {
            throw ingestErr;
          }
        } else {
          throw ingestErr;
        }
      }
    }

    await storage.updateFrontSyncEmail(syncEmailId, {
      ingestedRecordId: recordId,
      processedAt: new Date(),
    });

    let contactsEnriched = 0;
    try {
      contactsEnriched = await enrichClientContactsFromParticipants(clientId, participants, {
        conversationId,
        messageId: lastMessageId || undefined,
        subject: syncRecord?.subject || undefined,
        snippet: syncRecord?.snippet || undefined,
      });
    } catch (enrichErr) {
      console.error(`[Front Apply] Contact enrichment failed for ${conversationId}:`, enrichErr);
    }

    // Task #867: when the auto-match was made by trusted-domain rule, treat
    // the matched-domain participant emails as opted-in and promote them to
    // the client's contact roster. This is what makes the trusted-domain
    // list useful — once a client adds `acme.com`, every acme participant
    // gets recorded automatically without an admin clicking through each one.
    const matchedByDomain = typeof item.matchReason === "string" && item.matchReason.startsWith("[exact_client_domain_unique]");
    if (matchedByDomain) {
      try {
        const { promoteEmailsToClientContact } = await import("./clientContactPromotion");
        const { isCompanyEmail: isCompEmail } = await import("./companyIdentity");
        const { normalizeClientEmailDomains } = await import("@shared/models/clients");
        const client = await storage.getClient(clientId);
        const trustedDomains = new Set(normalizeClientEmailDomains(client?.emailDomains as unknown));
        const candidateEmails = (participants || [])
          .map(p => (p.email || "").trim().toLowerCase())
          .filter(e => e.includes("@") && !isCompEmail(e))
          .filter(e => trustedDomains.has(e.split("@")[1] || ""));
        if (candidateEmails.length > 0) {
          await promoteEmailsToClientContact({
            clientId,
            emails: candidateEmails,
            explicitOptIn: true,
            auditSource: "trusted_domain_promotion",
          });
        }
      } catch (promoteErr) {
        console.warn(`[Front Apply] Trusted-domain contact promotion failed for ${conversationId} (non-fatal):`, promoteErr);
      }
    }

    try {
      await storage.transitionFrontSyncPipelineState(syncEmailId, "applied");
    } catch (transErr) {
      console.warn(`[Front Apply] Pipeline state transition to applied failed for ${conversationId}, continuing:`, transErr);
    }

    // Task #4332 — native inbound-reply deal trigger: a successful apply of
    // a matched conversation whose latest INBOUND message is recent mints a
    // durable reply-detected event (log-only; sequences consume it later).
    // Replay-safe via front_reply:<conversationId>:<inboundMessageId> — re-
    // applies with an unchanged latest inbound message dedupe away, and the
    // emitter's recency gate keeps historical backfill sweeps out of the
    // log. Best-effort: a trigger failure must never fail the apply.
    try {
      const snapshotMessages: any[] = snapshot?.messages ?? [];
      let latestInbound: any = null;
      for (const msg of snapshotMessages) {
        if (!msg?.is_inbound || !msg?.id) continue;
        if (!latestInbound || (msg.created_at ?? 0) > (latestInbound.created_at ?? 0)) {
          latestInbound = msg;
        }
      }
      if (latestInbound) {
        const { emitFrontInboundReplyTrigger } = await import("./dealTriggers");
        await emitFrontInboundReplyTrigger({
          conversationId,
          messageId: String(latestInbound.id),
          clientId,
          receivedAt: latestInbound.created_at
            ? new Date(latestInbound.created_at * 1000)
            : null,
          subject: syncRecord?.subject ?? null,
        });
      }
    } catch (replyErr) {
      console.warn(`[Front Apply] reply deal-trigger emit failed for ${conversationId}:`, replyErr);
    }

    return { ...resultBase, action, recordId, contactsEnriched };
  } catch (err: any) {
    console.error(`[Front Apply] Error applying ${conversationId}:`, err.message);

    try {
      await storage.transitionFrontSyncPipelineState(syncEmailId, "failed", { error: err.message });
    } catch (transErr) {
      console.warn(`[Front Apply] Failed to transition to failed state for ${conversationId}:`, transErr);
    }

    return { ...resultBase, action: "error", error: err.message };
  }
}

export interface ApplyBatchResult {
  total: number;
  created: number;
  updated: number;
  noop: number;
  errors: number;
  items: ApplyItemResult[];
}

export async function applyMatchedConversationBatch(
  items: ApplyItemInput[],
): Promise<ApplyBatchResult> {
  const result: ApplyBatchResult = {
    total: items.length,
    created: 0,
    updated: 0,
    noop: 0,
    errors: 0,
    items: [],
  };

  for (const item of items) {
    const itemResult = await applyMatchedConversation(item);
    result.items.push(itemResult);

    switch (itemResult.action) {
      case "created": result.created++; break;
      case "updated": result.updated++; break;
      case "noop": result.noop++; break;
      case "error": result.errors++; break;
    }
  }

  console.log(
    `[Front Apply Batch] Processed ${result.total}: ${result.created} created, ${result.updated} updated, ${result.noop} noop, ${result.errors} errors`,
  );

  return result;
}

export async function assignUnmatchedEmail(
  syncEmailId: string,
  clientId: string,
  userId: string,
  /**
   * Task #755 follow-up: emails the operator explicitly opted-in to add as a
   * client contact in the manual-match dialog. Empty/undefined ⇒ no contact
   * write. Default-NO is enforced server-side; we never derive this list from
   * participants automatically.
   */
  addContactEmails?: string[],
): Promise<{ recordId: string; messageCount: number; contactsAdded: number; contactCreated: boolean }> {
  const record = await storage.getFrontSyncEmail(syncEmailId);
  if (!record || record.matchStatus !== "unmatched") throw new Error("Sync email record not found or already matched");

  const ingestResult = await ingestConversation(record.conversationId, clientId, userId, undefined, record.lastMessageId);

  await storage.updateFrontSyncEmail(syncEmailId, {
    matchedClientId: clientId,
    matchStatus: "manually_matched",
    matchConfidence: 1.0,
    matchReason: `Manually assigned by user`,
    ingestedRecordId: ingestResult.recordId,
    processedAt: new Date(),
  });

  // Task #2637: an operator's manual link is conversation-wide — stamp the
  // client onto every message row of the thread, not just the ingested rollup.
  await stampThreadWideClientAttribution(record.conversationId, clientId).catch(err => {
    console.error(`[Front] Thread-wide attribution failed for ${record.conversationId}:`, err);
  });

  const assignParticipants = (record.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
  let contactsAdded = 0;
  let contactCreated = false;
  if (Array.isArray(addContactEmails) && addContactEmails.length > 0) {
    try {
      const { promoteEmailsToClientContact } = await import("./clientContactPromotion");
      const wantedSet = new Set(addContactEmails.map(e => (e || "").trim().toLowerCase()));
      const matchedParticipant = assignParticipants.find(p => p.email && wantedSet.has(p.email.toLowerCase()));
      const result = await promoteEmailsToClientContact({
        clientId,
        emails: addContactEmails,
        contactName: matchedParticipant?.name,
        userId,
        explicitOptIn: true,
      });
      contactsAdded = result.added;
      contactCreated = result.createdNewContact;
      if (result.added > 0) {
        console.log(`[Front] Operator promoted ${result.added} email(s) to client ${clientId} contact (created=${result.createdNewContact})`);
      }
    } catch (err) {
      console.error(`[Front] Operator-confirmed contact promotion failed for client ${clientId}:`, err);
    }
  }

  // fire-and-forget: decision-correction bookkeeping; caught + logged inside.
  void (async () => {
    try {
      const decisionsBySync = await storage.listAgentMatchDecisions({ communicationId: syncEmailId });
      const decisionsByConv = await storage.listAgentMatchDecisions({ communicationId: record.conversationId });
      const seen = new Set<string>();
      const allDecisions = [...decisionsBySync, ...decisionsByConv].filter(d => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      });
      for (const decision of allDecisions) {
        if (decision.status === "claimed" && decision.clientId !== clientId) {
          await storage.updateAgentMatchDecision(decision.id, {
            correctedByHuman: true,
            reviewedByHuman: true,
            correctedToClientId: clientId,
          });
        } else if (decision.clientId === clientId && decision.status !== "claimed") {
          await storage.updateAgentMatchDecision(decision.id, {
            reviewedByHuman: true,
          });
        }
      }
    } catch (err) {
      console.error("[Front] Decision correction update failed:", err);
    }
  })();

  return {
    recordId: ingestResult.recordId,
    messageCount: ingestResult.messageCount,
    contactsAdded,
    contactCreated,
  };
}

export async function dismissUnmatchedEmail(
  syncEmailId: string,
  userId: string,
  reason?: string,
): Promise<void> {
  const trimmedReason = reason?.trim();
  await storage.updateFrontSyncEmail(syncEmailId, {
    matchStatus: "dismissed",
    dismissedBy: userId,
    processedAt: new Date(),
    ...(trimmedReason ? { operationalClassificationReason: trimmedReason } : {}),
  });
}

// Auto-start sync on server boot if previously enabled
export async function initAutoSync(): Promise<void> {
    try {
      const validation = await validateConnection();
      if (validation.valid) {
        console.log("[Front] Starting maintenance jobs (Front is connected)");
        startPeriodicClientMatching();
      } else {
        console.log(`[Front] Front not connected — skipping maintenance start: ${validation.error}`);
      }
    } catch (err) {
      console.error("[Front] Init failed:", err);
    }
  }

const PRODUCER_BATCH_SIZE = 50;
const PRODUCER_VERSION_KEY = "front_producer_version";

async function nextProducerVersion(): Promise<number> {
  const saved = await storage.getSystemSetting(PRODUCER_VERSION_KEY);
  const current = saved?.value ? parseInt(saved.value, 10) || 0 : 0;
  const next = current + 1;
  await storage.setSystemSetting(PRODUCER_VERSION_KEY, String(next), "system");
  return next;
}

export async function reEvaluateExistingUnmatchedProducer(): Promise<{ total: number; enqueued: number }> {
  if (!PERF.FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED) {
    console.log("[Front Re-eval Producer] Background job enqueue disabled — skipping");
    return { total: 0, enqueued: 0 };
  }

  const version = await nextProducerVersion();
  const unmatchedEmails = await storage.listUnmatchedFrontSyncEmails(10000);

  if (unmatchedEmails.length === 0) {
    console.log("[Front Re-eval Producer] No unmatched emails to enqueue");
    return { total: 0, enqueued: 0 };
  }

  const { enqueueRepairJob } = await import("./repairDispatcher");
  let enqueued = 0;

  const nonSpamEmails = unmatchedEmails.filter(e => !isSpamEmail(e));

  for (let i = 0; i < nonSpamEmails.length; i += PRODUCER_BATCH_SIZE) {
    const batch = nonSpamEmails.slice(i, i + PRODUCER_BATCH_SIZE);
    const batchIndex = Math.floor(i / PRODUCER_BATCH_SIZE);
    const syncEmailIds = batch.map(e => e.id);
    await enqueueRepairJob({
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      payload: {
        cohort: "unmatched",
        syncEmailIds,
        maxItems: batch.length,
        resume: false,
        source: "startup_reeval",
        producerVersion: version,
      },
      priority: 90,
      maxAttempts: 2,
      dedupeKey: `reeval:reprocess:v${version}:shard${batchIndex}`,
    });
    enqueued++;
  }

  console.log(`[Front Re-eval Producer] Enqueued ${enqueued} jobs for ${unmatchedEmails.length} unmatched emails (v${version})`);
  return { total: unmatchedEmails.length, enqueued };
}

export async function rematchAllProducer(options?: {
  maxItems?: number;
  resume?: boolean;
}): Promise<{ jobId: string }> {
  if (!PERF.FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED) {
    throw new Error("Background job enqueue disabled (FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED=false)");
  }
  const { enqueueRepairJob } = await import("./repairDispatcher");
  const version = await nextProducerVersion();
  const maxItems = options?.maxItems ?? 50000;
  const resume = options?.resume ?? true;

  const paramsHash = `m${maxItems}:r${resume ? 1 : 0}`;
  const jobId = await enqueueRepairJob({
    queueName: "front_rematch_all",
    workloadClass: "repair",
    payload: { maxItems, resume, producerVersion: version },
    priority: 50,
    maxAttempts: 3,
    dedupeKey: `producer:front_rematch_all:v${version}:${paramsHash}`,
  });

  console.log(`[Rematch Producer] Enqueued front_rematch_all job ${jobId} (maxItems=${maxItems}, resume=${resume}, v${version})`);
  return { jobId };
}

export async function reprocessDismissedNonSpamProducer(options?: {
  cohort?: "dismissed_operational" | "unmatched" | "all";
  maxItems?: number;
  resume?: boolean;
}): Promise<{ jobId: string }> {
  if (!PERF.FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED) {
    throw new Error("Background job enqueue disabled (FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED=false)");
  }
  const { enqueueRepairJob } = await import("./repairDispatcher");
  const version = await nextProducerVersion();
  const cohort = options?.cohort ?? "dismissed_operational";
  const maxItems = options?.maxItems ?? 50000;
  const resume = options?.resume !== false;

  const paramsHash = `c${cohort}:m${maxItems}:r${resume ? 1 : 0}`;
  const jobId = await enqueueRepairJob({
    queueName: "front_sync_reprocess",
    workloadClass: "repair",
    payload: { cohort, maxItems, resume, producerVersion: version },
    priority: 50,
    maxAttempts: 3,
    dedupeKey: `producer:front_sync_reprocess:v${version}:${paramsHash}`,
  });

  console.log(`[Reprocess Producer] Enqueued front_sync_reprocess job ${jobId} (cohort=${cohort}, maxItems=${maxItems}, v${version})`);
  return { jobId };
}

let clientMatchingIntervalId: ReturnType<typeof setInterval> | null = null;

export function startPeriodicClientMatching(): void {
  if (clientMatchingIntervalId) return;
  if (!PERF.FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED) {
    console.log("[Front Sync] Periodic client matching skipped — background job enqueue disabled");
    return;
  }
  const intervalMs = PERF.FRONT_CLIENT_MATCHING_INTERVAL_MS;
  console.log(`[Front Sync] Starting periodic client matching via queue (every ${Math.round(intervalMs / 60_000)} minutes)`);
  clientMatchingIntervalId = setInterval(() => {
    void withDbAttribution("maintenance:front-client-matching-sweep", async () => {
    // Task #836 Phase 2: same kill-switch gate as the spam-cleanup
    // sweep — both run on the same maintenance budget.
    if (isKillSwitchEnabled("non_critical_sweeps")) return;
    try {
      const version = await nextProducerVersion();

      // Task #813:
      // - Run the periodic sweep's DB reads on the worker pool so they don't
      //   compete with API request traffic.
      // - Replace the per-client `getClientContacts` fan-out with a single
      //   batched count query, eliminating N+1 round-trips.
      // - Wrap each periodic DB call in `dbRetry` so transient Neon recycles
      //   are absorbed rather than counted as hard failures.
      const { activeClients, contactCounts } = await runWithWorkerDb(async () => {
        const allClients = await dbRetry(
          () => storage.getClients(),
          "clientMatching.sweep.getClients",
        );
        const active = allClients.filter((c) => !c.isArchived);
        const counts = active.length > 0
          ? await dbRetry(
              () => storage.getClientContactCounts(active.map((c) => c.id)),
              "clientMatching.sweep.getContactCounts",
            )
          : new Map<string, number>();
        return { activeClients: active, contactCounts: counts };
      });

      // Task #1025: route through the version-agnostic dedupe + per-client
      // ceiling helper so the periodic sweep can never re-grow the
      // duplicate backlog. `producerVersion` is still recorded in the
      // payload for diagnostics; only the dedupe key dropped it.
      const { enqueueRetroactiveReprocessSafe, periodicDedupeKey } = await import(
        "./retroactiveReprocessControl"
      );
      let enqueued = 0;
      let skippedCeiling = 0;
      let skippedDedupe = 0;
      for (const client of activeClients) {
        try {
          const hasContacts = (contactCounts.get(client.id) ?? 0) > 0
            || Boolean(client.contactEmail);
          if (!hasContacts) continue;
          const result = await enqueueRetroactiveReprocessSafe({
            clientId: client.id,
            source: "periodic_sweep",
            workloadClass: "repair",
            payload: { maxItems: 100, producerVersion: version },
            priority: 100,
            maxAttempts: 2,
            dedupeKey: periodicDedupeKey(client.id),
          });
          if (result.enqueued) {
            // enqueueRepairJob returns an existing row id on a dedupe
            // hit (no inserted=true log line). We can't distinguish
            // here without plumbing the inserted flag through; treat
            // any non-ceiling skip as best-effort enqueued.
            enqueued++;
          } else if (result.reason === "per_client_ceiling") {
            skippedCeiling++;
          } else {
            skippedDedupe++;
          }
        } catch (err: any) {
          console.error(`[Client Matching] Error enqueuing reprocess for client ${client.id}:`, err.message);
        }
      }
      console.log(
        `[Client Matching] Periodic sweep v${version}: enqueued=${enqueued} skipped_ceiling=${skippedCeiling} skipped_dedupe=${skippedDedupe} active=${activeClients.length}`,
      );
    } catch (err) {
      console.error("[Client Matching] Periodic sweep enqueue error:", err);
    }
    });
  }, intervalMs);
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Task #867 — One-time hard-match backfill.
//
// Walks every front_sync_email, runs the deterministic hard matcher against
// it, writes an audit row capturing what changed, and updates the row's
// `matched_client_id` / `match_status` / `match_reason` to match the new
// rule. Idempotent: re-running on already-matched rows produces audit rows
// with new == previous and no mutation.
// ─────────────────────────────────────────────────────────────────────────────

export interface Backfill867Result {
  total: number;
  matched: number;
  unmatched: number;
  changedClient: number;
  unchanged: number;
  errors: number;
  dryRun: boolean;
}

export async function runFrontHardMatchBackfill867(opts: {
  dryRun?: boolean;
  maxItems?: number;
  // Opt-in flags. By default the backfill ONLY touches rows whose match
  // came from the legacy auto-matcher (or have no decision at all). It
  // intentionally preserves trusted human / rule outcomes:
  //   • manually_matched rows are skipped unless `includeManual=true`
  //   • filter-rule auto-matched rows (matchReason starting with
  //     "Filter rule") are skipped unless `includeFilterRule=true`
  //   • dismissed/blocked/dismissed_operational rows are skipped unless
  //     `includeDismissed=true`
  includeManual?: boolean;
  includeFilterRule?: boolean;
  includeDismissed?: boolean;
} = {}): Promise<Backfill867Result & { skipped: number }> {
  const dryRun = opts.dryRun === true;
  const maxItems = typeof opts.maxItems === "number" && opts.maxItems > 0 ? opts.maxItems : Number.MAX_SAFE_INTEGER;
  const includeManual = opts.includeManual === true;
  const includeFilterRule = opts.includeFilterRule === true;
  const includeDismissed = opts.includeDismissed === true;

  const { resolveFrontHardMatch, getHardMatchIndexes } = await import("./frontHardMatch");
  const { MATCH_REASON_CODES } = await import("./companyIdentity");
  const { frontSyncMatchStatuses } = await import("@shared/models/communications");
  type FrontSyncMatchStatus = typeof frontSyncMatchStatuses[number];
  const indexes = await getHardMatchIndexes();

  const result: Backfill867Result & { skipped: number } = {
    total: 0, matched: 0, unmatched: 0, changedClient: 0, unchanged: 0, errors: 0, skipped: 0, dryRun,
  };

  const PAGE = 500;
  let offset = 0;
  while (result.total + result.skipped < maxItems) {
    // Task #1573 (Audit Track C, P3b): backfill is script-triggered batch
    // work; route the page query through `workerDb` directly so it lands
    // on the worker pool. (Wrapping in `runWithWorkerDb` alone would only
    // affect callers that resolve via `getDb()`; this direct Drizzle call
    // would otherwise stay on the api pool.)
    const page = await workerDb.select().from(frontSyncEmails)
      .orderBy(asc(frontSyncEmails.createdAt), asc(frontSyncEmails.id))
      .limit(PAGE).offset(offset);
    if (page.length === 0) break;

    for (const email of page) {
      if (result.total + result.skipped >= maxItems) break;

      // Preservation guard: skip rows whose decision came from a human or a
      // filter rule (the two strongest "this is right" signals) unless the
      // operator explicitly opts in.
      const status = email.matchStatus as string;
      const reasonText = (email.matchReason || "");
      const isManual = status === "manually_matched";
      const isFilterRule = /^Filter rule/i.test(reasonText);
      const isDismissed = status === "dismissed" || status === "blocked" || status === "dismissed_operational";
      if ((isManual && !includeManual) ||
          (isFilterRule && !includeFilterRule) ||
          (isDismissed && !includeDismissed)) {
        result.skipped++;
        continue;
      }

      result.total++;
      try {
        const participants = (email.participantsJson as Array<{ name?: string; email?: string; role?: string }>) || [];
        const outcome = resolveFrontHardMatch(participants, indexes);

        const previousClientId = email.matchedClientId;
        const previousStatus = email.matchStatus;

        let newClientId: string | null = null;
        let newStatus: FrontSyncMatchStatus = "unmatched";
        let matchMethod = "unmatched";
        let reasonCode: string | null = null;
        let reason: string | null = null;
        let confidence: number | null = null;

        if (outcome.status === "matched") {
          newClientId = outcome.clientId;
          newStatus = "auto_matched";
          matchMethod = outcome.method;
          reasonCode = MATCH_REASON_CODES[outcome.reasonCode];
          reason = outcome.reason;
          confidence = outcome.method === "email_exact" ? 1.0 : 0.95;
          result.matched++;
          if (previousClientId && previousClientId !== newClientId) result.changedClient++;
        } else {
          // No match (or ambiguous → no_match for the sync row).
          reason = outcome.reason;
          result.unmatched++;
        }

        const wasSame = previousClientId === newClientId && previousStatus === newStatus;
        if (wasSame) result.unchanged++;

        if (!dryRun && !wasSame) {
          await storage.updateFrontSyncEmail(email.id, {
            matchedClientId: newClientId,
            matchStatus: newStatus,
            matchConfidence: confidence,
            matchReason: reasonCode ? `[${reasonCode}] ${reason}` : reason,
          });
        }

        if (!dryRun) {
          let auditOutcome: "matched" | "moved" | "unmatched" | "noop";
          if (newClientId && !previousClientId) auditOutcome = "matched";
          else if (newClientId && previousClientId && previousClientId !== newClientId) auditOutcome = "moved";
          else if (!newClientId && previousClientId) auditOutcome = "unmatched";
          else auditOutcome = "noop";
          await storage.createFrontMatchAuditLog({
            syncEmailId: email.id,
            conversationId: email.conversationId,
            source: "backfill_867",
            outcome: auditOutcome,
            priorClientId: previousClientId ?? null,
            priorMatchStatus: previousStatus ?? null,
            priorMatchMethod: null,
            newClientId,
            newMatchMethod: matchMethod,
            reason: reasonCode ? `[${reasonCode}] ${reason}` : reason,
            matchedOn: outcome.status === "matched" ? outcome.matchedOn : null,
          });
        }
      } catch (err: any) {
        result.errors++;
        console.error(`[Front Backfill #867] Error on ${email.conversationId}:`, err?.message);
      }
    }

    if (page.length < PAGE) break;
    offset += page.length;
  }

  return result;
}

/**
 * Task #980: ranked client suggestions for the Front email "Assign to client"
 * picker. Mirrors the Twilio Link-to-client suggestion pattern from Task #969,
 * but keyed off the unmatched email's sender address rather than a phone.
 *
 * Three signal sources, all keyed off the sender email and its domain (with
 * Company Identity Layer rules — public/free-mail and company-internal
 * domains are excluded from the trusted-domain signal so we never suggest a
 * firm just because a sender used Gmail):
 *
 *   1. Trusted-domain match — `clients.emailDomains[]` (the Front hard-match
 *      "trusted domain" list, Task #867) contains the sender's domain.
 *      Strongest signal because it's the same rule the auto-matcher uses
 *      when only one client owns the domain (+100 per matching client; will
 *      collide and surface every owner when multiple firms share a domain).
 *   2. Saved contact email match — `clients.contactEmail` or any
 *      `client_contacts.emails[]` entry equals the sender email exactly
 *      (+100). Same strength as the trusted-domain signal — both mirror the
 *      hard-matcher's auto-claim rules.
 *   3. Prior matched conversations — count of `raw_communication_records`
 *      with `source_type = 'front_email'` and a non-null `client_id` whose
 *      `participants_json` contains the sender email. Each prior matched
 *      thread adds +15 (capped) so a sender with a long history with one
 *      firm floats above a sender with one prior match elsewhere.
 *
 * Suggestions are merged per-client (a single firm can hit multiple signals)
 * and returned sorted by score desc, capped at `limit`.
 */
export async function getClientSuggestionsForFrontEmail(
  email: string,
  limit = 5,
): Promise<Array<{ clientId: string; firmName: string; score: number; reasons: string[] }>> {
  const { isCompanyEmail, isCompanyDomain, isPublicEmailDomain, extractDomain, normalizeEmail } =
    await import("./companyIdentity");

  const normalized = normalizeEmail(email || "");
  if (!normalized || !normalized.includes("@") || isCompanyEmail(normalized)) return [];

  const cap = Math.max(1, Math.min(limit, 10));
  const domain = extractDomain(normalized);
  // Skip the trusted-domain signal when the sender uses a public free-mail
  // provider or the company's own domain — those are excluded from
  // `clients.emailDomains[]` by the hard matcher so suggesting on them
  // would be misleading.
  const domainEligible =
    !!domain && !isPublicEmailDomain(domain) && !isCompanyDomain(domain);

  type Bucket = { firmName: string; score: number; reasons: string[] };
  const byClient = new Map<string, Bucket>();
  const upsert = (clientId: string, firmName: string, score: number, reason: string) => {
    const cur = byClient.get(clientId);
    if (cur) {
      cur.score += score;
      cur.reasons.push(reason);
      if (firmName && !cur.firmName) cur.firmName = firmName;
    } else {
      byClient.set(clientId, { firmName: firmName || "Unknown", score, reasons: [reason] });
    }
  };

  // 1. Trusted-domain match — mirrors the Front hard-matcher (Task #867).
  if (domainEligible && domain) {
    const domainRows = await db.execute<{ id: string; firm_name: string }>(sql`
      SELECT id, firm_name
      FROM clients
      WHERE COALESCE(is_archived, false) = false
        AND email_domains IS NOT NULL
        AND ${domain} = ANY(email_domains)
      LIMIT 10
    `);
    for (const r of domainRows.rows) {
      upsert(r.id, r.firm_name, 100, `Matches saved domain @${domain}`);
    }
  }

  // 2a. Saved client primary email — `clients.contactEmail` (case-insensitive).
  const primaryRows = await db.execute<{ id: string; firm_name: string }>(sql`
    SELECT id, firm_name
    FROM clients
    WHERE COALESCE(is_archived, false) = false
      AND LOWER(COALESCE(contact_email, '')) = ${normalized}
    LIMIT 10
  `);
  for (const r of primaryRows.rows) {
    upsert(r.id, r.firm_name, 100, `Saved client email: ${normalized}`);
  }

  // 2b. Saved contact email — `client_contacts.emails[]` (unnest +
  // case-insensitive compare; no functional index on the array so we scan,
  // but the contact roster is small per client and this endpoint is
  // operator-triggered).
  const contactRows = await db.execute<{ id: string; firm_name: string; contact_name: string }>(sql`
    SELECT cl.id, cl.firm_name, cc.name AS contact_name
    FROM client_contacts cc
    INNER JOIN clients cl ON cl.id = cc.client_id
    WHERE COALESCE(cl.is_archived, false) = false
      AND EXISTS (
        SELECT 1 FROM unnest(cc.emails) AS e WHERE LOWER(e) = ${normalized}
      )
    LIMIT 10
  `);
  for (const r of contactRows.rows) {
    upsert(r.id, r.firm_name, 100, `Saved contact: ${r.contact_name}`);
  }

  // 3. Prior matched Front conversations from this sender email. Counted
  // off `raw_communication_records` (the canonical post-ingestion table)
  // so every matched thread — auto-matched, manually assigned, or
  // ai-suggested-and-accepted — feeds the signal.
  const priorRows = await db.execute<{ client_id: string; firm_name: string; n: number }>(sql`
    SELECT r.client_id, cl.firm_name, COUNT(*)::int AS n
    FROM raw_communication_records r
    INNER JOIN clients cl ON cl.id = r.client_id
    WHERE r.source_type = 'front_email'
      AND r.client_id IS NOT NULL
      AND COALESCE(cl.is_archived, false) = false
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(r.participants_json, '[]'::jsonb)) AS p
        WHERE LOWER(p->>'email') = ${normalized}
      )
    GROUP BY r.client_id, cl.firm_name
    ORDER BY n DESC
    LIMIT 10
  `);
  for (const r of priorRows.rows) {
    const n = Number(r.n) || 0;
    if (n <= 0) continue;
    const score = Math.min(60, n * 15);
    const label =
      n === 1 ? "1 prior matched email" : `${n} prior matched emails`;
    upsert(r.client_id, r.firm_name, score, label);
  }

  return Array.from(byClient.entries())
    .map(([clientId, b]) => ({ clientId, firmName: b.firmName, score: b.score, reasons: b.reasons }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
}

