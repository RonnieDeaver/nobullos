// @cross-instance-safe: the self-rescheduling background-refresh setTimeout
// loop (scheduleNextBackgroundRefreshTick) only calls enqueueBackgroundRefresh(),
// which writes a time-bucketed dedupeKey ("semrush_background_refresh:campaigns:
// <bucket>") into work_queue. node/setTimeout fires the tick on every autoscale
// instance, but the dedupeKey collapses concurrent enqueues to a single job and
// the actual refresh is leased to exactly one worker via the work_queue claim.
// (Task #2397)
import { createHash } from "node:crypto";
import type { SystemSetting } from "@shared/schema";
import { storage } from "../storage";
import { PERF } from "../perfConfig";
import { withDbAttribution, withDbHoldLabel } from "../db";
import { auditOutboundCall } from "./externalCallAudit";
import {
  OAuthRefreshError,
  withSingleFlightOAuthRefresh,
  isAuthoritativeRefreshPurpose,
} from "./oauthRefresh";
import { getDefaultOAuthRefreshLease } from "./oauthRefreshLease";
import { recordDisconnectForensics } from "./integrationDisconnectForensics";
import {
  recordSemrushCallSuccess,
  resetSemrushAuthBreaker,
  semrushAuthBreakerActive,
  semrushAuthBreakerError,
  tripSemrushAuthBreaker,
} from "./semrushAuthBreaker";
// Task #3670 — v4 API-key auth mode. When SEMRUSH_V4_API_KEY is set the
// request path authenticates with `Authorization: Apikey` and the entire
// OAuth machinery below (token reads, refreshes, device flow, breaker,
// keep-alive) is dormant. Probe-verified on Map Rank Tracker Jul 31 2026
// (see KEEP_ALIVE_RUNBOOK.md).
import {
  isSemrushKeyMode,
  getSemrushV4ApiKey,
  recordSemrushKeyModeSuccess,
  getSemrushKeyModeLastSuccessAt,
} from "./semrushAuthMode";
// Task #3672 — key-mode rejected-key alert. When key-mode calls hit repeated
// 401/403 (revoked/expired SEMRUSH_V4_API_KEY), fire a once-per-streak
// operator alert; a successful key-mode call resets the streak and re-arms.
import {
  recordSemrushKeyModeRejection,
  onSemrushKeyModeCallSucceeded,
} from "./semrushKeyModeAlert";

/**
 * Task #3670 — error thrown when a key-mode call gets a 401/403: the API key
 * itself is invalid/revoked/expired. Deliberately `auth_config` (like
 * SemrushAuthMissingError) so per-location retries short-circuit, but the
 * message points at the secret, never at OAuth reconnect.
 */
export class SemrushApiKeyRejectedError extends Error {
  public readonly errorCategory = "auth_config" as const;
  constructor(message: string) {
    super(message);
    this.name = "SemrushApiKeyRejectedError";
  }
}

export class SemrushNotFoundError extends Error {
  public statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "SemrushNotFoundError";
  }
}

export class SemrushRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemrushRateLimitError";
  }
}

const BASE_URL = "https://api.semrush.com/apis/v4/map-rank-tracker/v0";
const OAUTH_DEVICE_CODE_URL = "https://oauth.semrush.com/dag/device/code";
const OAUTH_TOKEN_URL = "https://oauth.semrush.com/dag/device/token";
/**
 * Task #3666 — The token-refresh endpoint documented for the Semrush Auth
 * (standard Authorization Code) flow. The device-flow endpoint
 * (`OAUTH_TOKEN_URL`) only accepts
 * `grant_type=urn:ietf:params:oauth:grant-type:device_code`; POSTing
 * `grant_type=refresh_token` there always returns HTTP 400 `invalid_request`.
 *
 * Investigation findings (Jul 30 2026, against live SEMrush OAuth server):
 * - `/dag/device/token` + refresh_token grant → 400 `{"error":"invalid_request"}`
 * - `/oauth2/access_token` + bare refresh_token (no creds) → 400 "Check client_id"
 * - `/oauth2/access_token` + any credential guess → 401 (device-flow issues no
 *   client_id/secret, so this endpoint requires a Semrush Auth app registration)
 *
 * Conclusion: SEMrush device-flow tokens cannot be refreshed programmatically
 * without a registered Semrush Auth app (client_id + client_secret). The
 * keep-alive tick will surface the exact OAuth error so the operator can see it
 * in the Hub and the prod-action outcome. Tokens are NOT wiped on non-authoritative
 * refresh failures. A SEMrush support inquiry is the next step for a permanent fix.
 */
const OAUTH_REFRESH_URL = "https://oauth.semrush.com/oauth2/access_token";

const SETTINGS_KEY_ACCESS = "semrush_access_token";
const SETTINGS_KEY_REFRESH = "semrush_refresh_token";
const SETTINGS_KEY_EXPIRES = "semrush_token_expires_at";
const SETTINGS_KEY_DEVICE_CODE = "semrush_device_code";
const SETTINGS_KEY_USER_CODE = "semrush_user_code";
const SETTINGS_KEY_VERIFY_URI = "semrush_verify_uri";
const SETTINGS_KEY_DEVICE_EXPIRES = "semrush_device_expires_at";
/**
 * Task #3666 — wall-clock epoch-ms string recording the last time tokens were
 * successfully persisted from ANY path (proactive refresh OR device-flow
 * re-connect via pollDeviceToken). Used by the age-based rotation criterion in
 * `runSemrushTokenKeepAliveTick` to rotate every ~3.5 days regardless of
 * proximity to expiry, so a missed tick or quiet period can never leave the
 * token dangerously old.
 */
const SETTINGS_KEY_LAST_REFRESHED = "semrush_token_last_refreshed_at";

/**
 * Task #2643 — attribution for the recurring SEMrush false-disconnect.
 *
 * Operators kept filing "SEMrush auth missing" reports on a connection that
 * was actually live. The root cause is a deploy-time rotation race: two
 * autoscale instances refresh the SAME rotating refresh token, the loser
 * 4xx's on the already-consumed token, and an AUTHORITATIVE terminal refresh
 * wipes the stored tokens (after which `getAccessToken` trips the breaker on
 * a confirmed absence). The lease + single-flight collapse most of this, but
 * the lease degrades to in-process-only on DB/pool saturation — exactly the
 * condition seen right before the false trips — so the race can still slip
 * through. When it does, the only way to tell a TRUE revocation from a
 * rotation-race false trip after the fact is from the logs.
 *
 * `INSTANCE_ID` (pid + boot nonce) names the process; `fingerprintToken`
 * emits a short, NON-reversible SHA-256 prefix of the refresh token so two
 * log lines from two instances can be compared (same fingerprint racing the
 * same token = rotation race; different fingerprint = a real reconnect) WITHOUT
 * ever logging the secret itself.
 */
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function fingerprintToken(token: string | null | undefined): string {
  if (!token) return "none";
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

async function refreshTokenFingerprint(): Promise<string> {
  try {
    const row = await storage.getSystemSetting(SETTINGS_KEY_REFRESH);
    return fingerprintToken(row?.value);
  } catch {
    return "unreadable";
  }
}

/**
 * Task #1877: error thrown when SEMrush OAuth is not configured (no access
 * token, no refresh token, or refresh definitively failed). Tagged with
 * `errorCategory = "auth_config"` so `classifyLocationSyncError` immediately
 * short-circuits per-location retries (an auth-config failure is identical
 * across every location — there is no point burning the retry budget 11x).
 */
export class SemrushAuthMissingError extends Error {
  public readonly errorCategory = "auth_config" as const;
  constructor(message: string) {
    super(message);
    this.name = "SemrushAuthMissingError";
  }
}

/**
 * Task #2412: error thrown when the SEMrush connection state is genuinely
 * UNKNOWN — the authoritative cache-bypassing token re-read on the hot path
 * itself failed (DB / pool saturation), so absence is NOT confirmed. Tagged
 * with `errorCategory = "transient"` (NOT `auth_config`) so
 * `classifyLocationSyncError` treats it as retryable and it never gets
 * folded into `paused_auth` / a "Reconnect Required" disconnect. This is the
 * whole point of confirm-before-trip: a failed read must not masquerade as a
 * deterministic auth failure.
 */
export class SemrushAuthUnknownError extends Error {
  public readonly errorCategory = "transient" as const;
  constructor(message: string) {
    super(message);
    this.name = "SemrushAuthUnknownError";
  }
}

async function getAccessToken(): Promise<string> {
  // Task #2102 — auth-dead breaker short-circuit. When a prior terminal
  // refresh has tripped the breaker, throw immediately (no network) so
  // every SEMrush API call path backs off instead of re-driving the
  // doomed refresh POST. The probe (`probeConnection`) does NOT go
  // through here, so it naturally bypasses this gate and can still detect
  // an operator reconnect during the cooldown.
  if (semrushAuthBreakerActive()) {
    throw new SemrushAuthMissingError(semrushAuthBreakerError().message);
  }

  let tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);

  // Task #2412 — confirm-before-trip. A falsy access-token read on this hot
  // path is NOT proof the operator disconnected: it can be a stale negative
  // `{kind:"miss"}` cache sentinel or a transient empty read under the
  // DB/worker-pool saturation seen right before the false trips. Tripping
  // the TERMINAL `semrush_not_connected` breaker on a single falsy read
  // flips the Hub badge to "Reconnect Required" and short-circuits the
  // Local-Dominance sweep to `paused_auth` even though the stored token is
  // present and valid. Before declaring "not connected", re-read BOTH
  // tokens authoritatively (cache-bypassing) and only treat absence as real
  // when it is CONFIRMED (no access AND no refresh token). This mirrors the
  // absent-vs-unknown guarantee the probe path already has (Task #2150).
  if (!tokenSetting?.value) {
    let freshAccess: SystemSetting | undefined;
    let freshRefresh: SystemSetting | undefined;
    let validExpiryObserved = false;
    try {
      const [a, r, e] = await Promise.all([
        storage.getSystemSettingFresh(SETTINGS_KEY_ACCESS),
        storage.getSystemSettingFresh(SETTINGS_KEY_REFRESH),
        storage.getSystemSettingFresh(SETTINGS_KEY_EXPIRES),
      ]);
      freshAccess = a;
      freshRefresh = r;
      validExpiryObserved =
        !!e?.value && Date.now() <= parseInt(e.value) - 60000;
    } catch (err: any) {
      // State 3 (UNKNOWN): the authoritative read itself failed. Absence is
      // NOT confirmed — surface a transient/retryable error and do NOT trip
      // the terminal breaker or suppress the next call. Must be
      // `SemrushAuthUnknownError` (errorCategory="transient"), NOT
      // `SemrushAuthMissingError` (errorCategory="auth_config"), or the
      // location-sync classifier would treat a failed read as a permanent
      // auth failure and fold it into `paused_auth` — the exact false
      // disconnect this task fixes.
      throw new SemrushAuthUnknownError(
        `Semrush connection state unknown — token read failed, will retry (no disconnect declared): ${err?.message ?? err}`,
      );
    }

    if (freshAccess?.value) {
      // The cached read was stale (negative cache / transient empty); the
      // token is actually present. Use the freshly-read value and continue.
      tokenSetting = freshAccess;
    } else if (freshRefresh?.value) {
      // Access token absent but a refresh token IS present → attempt a
      // refresh (existing rotation / single-flight path) instead of
      // declaring the integration dead.
      return await refreshAccessTokenOrTrip("access-absent-refresh-present");
    } else {
      // State 2 (CONFIRMED empty): no access AND no refresh token via an
      // authoritative cache-bypassing re-read. A genuine disconnect. Log
      // the observed signal so any future trip is diagnosable from logs
      // alone (Task #2412 step 3).
      console.error(
        `[Semrush] Auth breaker tripping (semrush_not_connected) — confirmed absence after cache-bypassing re-read: accessPresent=false refreshPresent=false validExpiryObserved=${validExpiryObserved}`,
      );
      tripSemrushAuthBreaker("semrush_not_connected");
      throw new SemrushAuthMissingError("Semrush not connected — please authorize via Integrations Hub");
    }
  }

  // After the confirm block a non-empty access token is guaranteed (cached
  // happy path, or the fresh re-read above). Re-narrow for the type checker;
  // this branch is defensive and should not be reachable in practice.
  const accessToken = tokenSetting?.value;
  if (!accessToken) {
    tripSemrushAuthBreaker("semrush_not_connected");
    throw new SemrushAuthMissingError("Semrush not connected — please authorize via Integrations Hub");
  }

  const expiresSetting = await storage.getSystemSetting(SETTINGS_KEY_EXPIRES);
  if (expiresSetting?.value && Date.now() > parseInt(expiresSetting.value) - 60000) {
    return await refreshAccessTokenOrTrip("expiry");
  }

  return accessToken;
}

/**
 * Task #2102/#2412 — shared "refresh, and only trip the breaker on a
 * TERMINAL outcome" helper for the two `getAccessToken` paths that hit a
 * refresh: the stored access token is expired, or it is absent but a
 * refresh token is present. A terminal refresh (revoked / missing refresh
 * token) trips the breaker; a transient 5xx / network failure is retryable
 * and must NOT suppress the next request.
 */
async function refreshAccessTokenOrTrip(context: string): Promise<string> {
  try {
    // Task #2643 — thread the call-site context through as the refresh
    // `purpose` so every refresh POST is attributable in the logs. Both
    // contexts ("expiry", "access-absent-refresh-present") are AUTHORITATIVE
    // (a real API call needs a token), so `isAuthoritativeRefreshPurpose`
    // still returns true and the terminal-wipe gating is unchanged — this is
    // attribution only, not a behavior change.
    return await refreshAccessToken({ purpose: context });
  } catch (err: any) {
    console.error(`[Semrush] Token refresh (${context}) failed:`, err?.message);
    if (
      err instanceof OAuthRefreshError
        ? err.outcome === "terminal"
        : true
    ) {
      tripSemrushAuthBreaker(
        err instanceof OAuthRefreshError && /missing|no refresh/i.test(err.message)
          ? "semrush_no_refresh_token"
          : "semrush_refresh_failed_permanent",
      );
    }
    throw new SemrushAuthMissingError("Semrush not connected — token expired, please re-authorize via Integrations Hub");
  }
}

// Task #2265 / #2267 — purposes whose refresh attempts must NEVER wipe
// stored tokens on a terminal outcome now live in the shared
// `oauthRefresh` helper (`isAuthoritativeRefreshPurpose`) so Front, Zoom,
// Google Ads, and SEMrush all classify probe / proactive refreshes the
// same way.

/**
 * Task #1877: cheap, non-throwing probe used by the sweep gate to decide
 * whether to short-circuit the entire run with a `paused_auth` outcome
 * BEFORE any per-location attempts begin. Does NOT trigger a refresh.
 */
export async function hasSemrushAccessToken(): Promise<boolean> {
  // Task #3670 — key mode: auth is the API key, always "present"; the sweep
  // must never pause_auth on missing OAuth tokens while the key is set.
  if (isSemrushKeyMode()) return true;
  try {
    const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
    return !!tokenSetting?.value;
  } catch {
    return false;
  }
}

/**
 * Task #1975 — Semrush quirk: returns `invalid_request` (NOT the
 * OAuth-spec `invalid_grant`) when the refresh token is rejected. Both
 * are treated as terminal so stale tokens don't loop forever, but token
 * wipes now run via `onTerminalAfterRetry` so a concurrent refresh race
 * (one process rotates the token, another's POST then 4xx's on the
 * captured-but-already-consumed token) doesn't wipe a healthy
 * connection. The single-flight wrapper collapses concurrent callers in
 * the same process; the re-read-and-retry path covers the cross-process
 * race before declaring the connection dead.
 */
async function refreshAccessToken(opts?: {
  purpose?: string;
  /**
   * Task #3666 — the caller's intent is to rotate a STILL-FRESH token
   * (proactive keep-alive / forced rotation). In production the
   * cross-process lease is always held, so the default lease-acquired
   * recheck would return the still-valid stored access token and skip the
   * POST entirely — silently turning every proactive tick into a no-op
   * until the token was already ≤60s from death. When set, the recheck
   * only short-circuits if a sibling instance completed a rotation moments
   * ago (observed via `semrush_token_last_refreshed_at`), not merely
   * because the access token is unexpired.
   */
  proactiveRotation?: boolean;
  /**
   * Task #3666 — reactive-401 only: the bearer token a live API call just
   * got a 401 WITH. The lease-acquired recheck must never hand this exact
   * token back (its stored expiry can still look fresh — SEMrush rejected
   * it anyway); reuse is only safe when the stored token DIFFERS, i.e. a
   * sibling rotated while we waited on the lease.
   */
  rejectedAccessToken?: string;
}): Promise<string> {
  // Task #2877 — wipe-confirmation re-read: track the fingerprint of the
  // refresh token used in the LAST attempt so onTerminalAfterRetry can compare
  // it against a fresh store read. If the stored token changed (a sibling
  // rotated it during the terminal window) we abort the wipe. If it is
  // unchanged — still the same invalid token SEMrush rejected — we proceed.
  let lastTriedRefreshFp: string | null = null;

  return withSingleFlightOAuthRefresh<string>({
    integration: "semrush",
    purpose: opts?.purpose,
    // Task #2437 — bounded wait-and-re-read before a terminal refresh is
    // declared a permanent death (extends the Task #2435 Front defense). The
    // cross-process lease serializes refreshers, but a loser can still
    // re-read the stored refresh token in the instant BEFORE the winning
    // sibling persists the freshly-rotated one (SEMrush rotates on refresh),
    // see the still-consumed token, and surface a false `invalid_request`
    // (HTTP 4xx) that — for an authoritative caller — WIPES the stored tokens
    // and flips the Hub badge to Disconnected on a connection a sibling just
    // rotated healthy. Polling a few extra times lets the winner's
    // setSystemSetting land so the retry picks up the rotated token. Tuned to
    // SEMrush's 60s pre-expiry skew (the smallest of the integrations, the
    // skew probeConnection / onLeaseAcquiredRecheck use) — still ample
    // headroom for a sub-second poll, so a tighter 3×100ms (≈300ms). A true
    // revocation never rotates, exhausts the window, and is still declared
    // terminal exactly once.
    terminalRotationRecheck: { attempts: 3, delayMs: 100 },
    // Task #2289/#2361 — cross-process refresh lease. SEMrush rotates the
    // refresh token on refresh and returns `invalid_request` (not the
    // OAuth-spec `invalid_grant`) when a captured-but-already-consumed
    // token is POSTed. On autoscale two instances refreshing at once make
    // the loser 4xx on the rotated token, which historically WIPED the
    // stored tokens and flipped the Hub badge to Disconnected on a healthy
    // connection. The lease serializes every process to one refresher at a
    // time; the recheck below skips a wasteful second POST when a sibling
    // refreshed while we waited for the lease.
    crossProcessLease: getDefaultOAuthRefreshLease(),
    onLeaseAcquiredRecheck: async () => {
      const [accessSetting, expiresSetting, lastRefreshedSetting] = await Promise.all([
        storage.getSystemSetting(SETTINGS_KEY_ACCESS),
        storage.getSystemSetting(SETTINGS_KEY_EXPIRES),
        storage.getSystemSetting(SETTINGS_KEY_LAST_REFRESHED),
      ]);
      const access = accessSetting?.value;
      if (!access) return null;
      // Same 60s pre-expiry skew probeConnection uses (expiry stored in
      // ms). If a sibling refreshed while we waited, the stored access
      // token is now valid and a second POST is wasteful + race-risky.
      const expiresRaw = expiresSetting?.value;
      if (!expiresRaw) return null;
      const isExpired = Date.now() > parseInt(expiresRaw) - 60_000;
      if (isExpired) return null;
      if (opts?.rejectedAccessToken !== undefined) {
        // Task #3666 — reactive-401: the server just REJECTED this bearer
        // even though its stored expiry looks fresh. Reuse the stored token
        // only when it DIFFERS from the rejected one (a sibling rotated
        // while we waited on the lease); handing back the same rejected
        // token would 401-loop without ever POSTing a refresh.
        return access !== opts.rejectedAccessToken ? access : null;
      }
      if (opts?.proactiveRotation) {
        // Task #3666 — a proactive rotation exists precisely to rotate a
        // still-fresh token, so "access token not expired" alone must NOT
        // short-circuit it. Only skip the POST when a sibling completed a
        // rotation moments ago while we waited on the lease.
        const lastRefreshedMs = lastRefreshedSetting?.value
          ? parseInt(lastRefreshedSetting.value, 10)
          : 0;
        const siblingJustRotated =
          lastRefreshedMs > 0 &&
          Date.now() - lastRefreshedMs < SEMRUSH_PROACTIVE_SIBLING_ROTATION_SKEW_MS;
        return siblingJustRotated ? access : null;
      }
      return access;
    },
    readRefreshToken: async () =>
      (await storage.getSystemSetting(SETTINGS_KEY_REFRESH))?.value ?? null,
    refreshOnce: async ({ refreshToken, attempt }) => {
      // Task #2643 — attribution: which instance is POSTing which refresh
      // token, for what purpose. Two instances logging the same fingerprint
      // within seconds is the rotation-race signature.
      // Task #2877 — capture the fingerprint of the token we are about to POST
      // so onTerminalAfterRetry can detect whether a sibling changed it.
      lastTriedRefreshFp = fingerprintToken(refreshToken);
      console.log(
        `[Semrush] refresh_post instance=${INSTANCE_ID} purpose=${opts?.purpose ?? "authoritative"} attempt=${attempt} refreshFp=${fingerprintToken(refreshToken)}`,
      );
      let res: Response;
      try {
        // Task #3666 — use OAUTH_REFRESH_URL (the Semrush Auth flow endpoint)
        // instead of OAUTH_TOKEN_URL (device-flow only). The device-flow
        // endpoint always returns 400 invalid_request for refresh_token grants.
        //
        // Include SEMRUSH_CLIENT_ID + SEMRUSH_CLIENT_SECRET when configured
        // (set after registering a standard Semrush Auth app with SEMrush
        // support). Without them the server returns 400 "missing client_id";
        // with them it can authenticate and rotate the token pair. When the
        // env vars are absent the body degrades gracefully to the bare refresh
        // (same terminal outcome as before, but at the correct endpoint and
        // with a more informative error description).
        const refreshBody: Record<string, string> = {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        };
        const semrushClientId = process.env.SEMRUSH_CLIENT_ID;
        const semrushClientSecret = process.env.SEMRUSH_CLIENT_SECRET;
        if (semrushClientId) refreshBody.client_id = semrushClientId;
        if (semrushClientSecret) refreshBody.client_secret = semrushClientSecret;
        res = await fetch(OAUTH_REFRESH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(refreshBody).toString(),
        });
      } catch (err: any) {
        throw new OAuthRefreshError(
          "semrush",
          "transient",
          `Semrush token refresh transport error: ${err?.message ?? String(err)}`,
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const snippet = body.length > 200 ? `${body.slice(0, 200)}…` : body;
        const is4xx = res.status >= 400 && res.status < 500;
        const isDefinitive =
          is4xx &&
          (body.includes("invalid_grant") ||
            body.includes("invalid_request") ||
            body.includes("invalid_client") ||
            body.includes("unauthorized_client"));
        if (isDefinitive) {
          throw new OAuthRefreshError(
            "semrush",
            "terminal",
            `Semrush token refresh failed (HTTP ${res.status}): ${snippet || "<empty body>"}`,
            { status: res.status },
          );
        }
        throw new OAuthRefreshError(
          "semrush",
          "transient",
          `Semrush token refresh failed (HTTP ${res.status}) — will retry on next request: ${snippet || "<empty body>"}`,
          { status: res.status },
        );
      }

      let data: any;
      try {
        data = await res.json();
      } catch {
        throw new OAuthRefreshError(
          "semrush",
          "transient",
          "Semrush token refresh returned invalid JSON",
        );
      }
      const expiresAt = Date.now() + (data.expires_in || 604800) * 1000;

      await storage.setSystemSetting(SETTINGS_KEY_ACCESS, data.access_token, "system");
      await storage.setSystemSetting(SETTINGS_KEY_EXPIRES, String(expiresAt), "system");
      if (data.refresh_token) {
        await storage.setSystemSetting(SETTINGS_KEY_REFRESH, data.refresh_token, "system");
      }
      // Task #3666 — record the wall-clock time of this successful rotation so
      // the age-based keep-alive criterion can derive token age independently of
      // the expiry timestamp (which only reflects the 7-day access-token window,
      // not when it was last actively refreshed).
      await storage.setSystemSetting(SETTINGS_KEY_LAST_REFRESHED, String(Date.now()), "system");

      console.log("[Semrush] Token refreshed successfully");
      // Task #2102 — a network-confirmed refresh proves the credential is
      // live; reset the auth-dead breaker so suppressed surfaces resume.
      recordSemrushCallSuccess();
      resetSemrushAuthBreaker();
      return data.access_token as string;
    },
    onTerminalAfterRetry: async (err) => {
      // Task #2265 — only an authoritative, on-demand refresh (which already
      // re-read the freshest stored refresh token and still failed terminally
      // inside the single-flight helper) may clear credentials. A probe /
      // proactive refresh that 4xx's on a rotation-race blip must surface the
      // outcome to its caller WITHOUT wiping a connection another instance may
      // have just rotated to a healthy token.
      if (!isAuthoritativeRefreshPurpose(opts?.purpose)) {
        const wipeSkippedProviderError = (err as any)?.message ?? String(err);
        console.warn(
          `[Semrush] outcome=wipe_skipped instance=${INSTANCE_ID} purpose=${opts?.purpose} reason=non_authoritative refreshFp=${await refreshTokenFingerprint()} — NOT clearing tokens (rotation-race safe); surfacing outcome to caller: ${wipeSkippedProviderError}`,
        );
        // Task #3109 — durable wipe_skipped breadcrumb so the audit trail
        // shows every non-authoritative terminal outcome, not just the ones
        // that actually wiped. Best-effort; never blocks or throws.
        void storage.recordAdminSettingChange({
          settingKey: SETTINGS_KEY_ACCESS,
          scope: "wipe_skipped",
          changedBy: null,
          oldValues: null,
          newValues: {
            event: "token_wipe_skipped",
            instance: INSTANCE_ID,
            purpose: opts?.purpose ?? "unknown",
            reason: "non_authoritative",
            providerError: wipeSkippedProviderError.slice(0, 300),
          },
        }).catch((auditErr: any) => {
          console.error("[Semrush] wipe_skipped audit insert failed:", auditErr?.message);
        });
        // Task #3661 — durable operator-facing forensics record.
        void recordDisconnectForensics({
          integration: "semrush",
          codePath: "wipe_skipped_non_authoritative",
          purpose: opts?.purpose ?? "unknown",
          providerError: wipeSkippedProviderError,
          instanceId: INSTANCE_ID,
          summary:
            "SEMrush rejected a background token refresh terminally (health probe / keep-alive). Tokens were NOT wiped by this path, but the stored refresh token appears dead.",
          operatorAction:
            "If the SEMrush card shows Disconnected or Reconnect Required, re-authorize SEMrush in Settings → Integrations Hub.",
        });
        return;
      }
      // Task #2877 — final wipe-confirmation re-read. `terminalRotationRecheck`
      // already polled the store for up to 3×100ms waiting for a sibling's
      // rotated token to land, but there is still a narrow window between the
      // last poll and this wipe where a sibling's `setSystemSetting` can land.
      // A fresh-read here closes that window: if the stored refresh token is
      // DIFFERENT from the one we last tried, a sibling instance rotated it to a
      // new live token in that window — abort the wipe to preserve the healthy
      // connection. If the token is unchanged (or empty), it is the same invalid
      // token SEMrush rejected; proceed with wipe so the operator is prompted to
      // re-authorize. Crucially "non-empty" alone is NOT enough — a genuinely
      // revoked token stays in the store (non-empty) until wiped, so the
      // fingerprint comparison is the only safe signal.
      let freshRefreshForWipeConfirm: string | null = null;
      try {
        const confirmRow = await storage.getSystemSettingFresh(SETTINGS_KEY_REFRESH);
        freshRefreshForWipeConfirm = confirmRow?.value ?? null;
      } catch (confirmReadErr: any) {
        // Task #3661 — FAIL-SAFE, not fail-open. A confirmation re-read that
        // THROWS (DB blip / pool saturation) is indeterminate: we cannot know
        // whether a sibling rotated the token to a healthy value in the wipe
        // window. Destroying credentials on indeterminate evidence turns a
        // transient DB blip into a full re-authorization outage. Instead:
        // abort the wipe, trip the breaker (so surfaces back off and the Hub
        // shows Reconnect Required if the token really is dead — the next
        // authoritative refresh with a working DB will re-confirm and wipe),
        // and record the outcome durably.
        const confirmFailProviderError = (err as any)?.message ?? String(err);
        console.error(
          `[Semrush] outcome=wipe_confirmation_read_failed instance=${INSTANCE_ID} purpose=${opts?.purpose ?? "authoritative"} — confirmation re-read threw (${confirmReadErr?.message ?? confirmReadErr}); ABORTING wipe and tripping breaker instead. Provider error was: ${confirmFailProviderError}`,
        );
        tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
        void storage.recordAdminSettingChange({
          settingKey: SETTINGS_KEY_ACCESS,
          scope: "wipe_confirmation_read_failed",
          changedBy: null,
          oldValues: null,
          newValues: {
            event: "token_wipe_confirmation_read_failed",
            instance: INSTANCE_ID,
            purpose: opts?.purpose ?? "authoritative",
            readError: String(confirmReadErr?.message ?? confirmReadErr).slice(0, 300),
            providerError: confirmFailProviderError.slice(0, 300),
          },
        }).catch((auditErr: any) => {
          console.error(
            "[Semrush] wipe_confirmation_read_failed audit insert failed:",
            auditErr?.message,
          );
        });
        void recordDisconnectForensics({
          integration: "semrush",
          codePath: "wipe_confirmation_read_failed",
          purpose: opts?.purpose ?? "authoritative",
          providerError: confirmFailProviderError,
          fingerprintOutcome: "indeterminate_read_failed",
          instanceId: INSTANCE_ID,
          summary:
            "SEMrush rejected an authoritative token refresh terminally, but the wipe-confirmation database re-read failed, so the tokens were NOT wiped (fail-safe). The auth breaker was tripped instead.",
          operatorAction:
            "If SEMrush stays in Reconnect Required after the breaker cooldown, re-authorize SEMrush in Settings → Integrations Hub.",
        });
        return;
      }
      const freshFp = fingerprintToken(freshRefreshForWipeConfirm);
      if (freshRefreshForWipeConfirm && lastTriedRefreshFp && freshFp !== lastTriedRefreshFp) {
        const wipeAbortedProviderError = (err as any)?.message ?? String(err);
        console.warn(
          `[Semrush] outcome=wipe_aborted instance=${INSTANCE_ID} purpose=${opts?.purpose ?? "authoritative"} reason=sibling_rotated_token refreshFp_was=${lastTriedRefreshFp} refreshFp_now=${freshFp} — sibling rotated token to a new value in the wipe window; not wiping. Error was: ${wipeAbortedProviderError}`,
        );
        // Task #3109 — durable wipe_aborted breadcrumb with fingerprints so a
        // post-mortem can confirm whether this was a genuine rotation race.
        void storage.recordAdminSettingChange({
          settingKey: SETTINGS_KEY_ACCESS,
          scope: "wipe_aborted",
          changedBy: null,
          oldValues: null,
          newValues: {
            event: "token_wipe_aborted",
            instance: INSTANCE_ID,
            purpose: opts?.purpose ?? "authoritative",
            reason: "sibling_rotated_token",
            refreshFp_was: lastTriedRefreshFp,
            refreshFp_now: freshFp,
            providerError: wipeAbortedProviderError.slice(0, 300),
          },
        }).catch((auditErr: any) => {
          console.error("[Semrush] wipe_aborted audit insert failed:", auditErr?.message);
        });
        // Task #3661 — durable forensics record for the aborted wipe.
        void recordDisconnectForensics({
          integration: "semrush",
          codePath: "wipe_aborted_sibling_rotated",
          purpose: opts?.purpose ?? "authoritative",
          providerError: wipeAbortedProviderError,
          fingerprintOutcome: `changed (${lastTriedRefreshFp} → ${freshFp})`,
          instanceId: INSTANCE_ID,
          summary:
            "A terminal SEMrush refresh was about to wipe tokens, but a sibling instance rotated the refresh token to a new value in the wipe window (rotation race) — the wipe was aborted and the connection preserved.",
          operatorAction:
            "No action needed — this was a protective abort. If SEMrush shows Disconnected anyway, re-authorize in Settings → Integrations Hub.",
        });
        return;
      }
      // Task #2643 — attribution: a TRUE revocation and a rotation-race loser
      // are indistinguishable at this point except by correlating instances.
      // Stamp the wipe with the instance + the fingerprint of the token we are
      // about to clear so a post-mortem can tell whether a sibling rotated it
      // healthy at the same moment (false trip) or it was genuinely revoked.
      const wipePurpose = opts?.purpose ?? "authoritative";
      const wipeProviderError = (err as any)?.message ?? String(err);
      const wipeFp = await refreshTokenFingerprint();
      console.warn(
        `[Semrush] outcome=wipe instance=${INSTANCE_ID} purpose=${wipePurpose} refreshFp=${wipeFp} — clearing tokens after terminal authoritative refresh; re-authorization required: ${wipeProviderError}`,
      );
      await storage.setSystemSetting(SETTINGS_KEY_ACCESS, "", "system");
      await storage.setSystemSetting(SETTINGS_KEY_REFRESH, "", "system");
      await storage.setSystemSetting(SETTINGS_KEY_EXPIRES, "", "system");
      // Task #3661 — durable operator-facing forensics record for the wipe.
      void recordDisconnectForensics({
        integration: "semrush",
        codePath: "authoritative_wipe",
        purpose: wipePurpose,
        providerError: wipeProviderError,
        fingerprintOutcome: `unchanged (${wipeFp}) — genuine revocation`,
        instanceId: INSTANCE_ID,
        summary:
          "SEMrush rejected an authoritative token refresh terminally and the stored refresh token's fingerprint was unchanged (genuinely revoked/expired) — the tokens were wiped.",
        operatorAction:
          "Re-authorize SEMrush in Settings → Integrations Hub to restore the connection.",
      });
      // Task #3109 — durable wipe breadcrumb + immediate operator alert. Both
      // are fire-and-forget so they never block the wipe path or surface errors
      // to the caller. The alert uses dedupeKey "auto_wipe" so it is NOT
      // suppressed by the sweep-based "global" disconnect alert, and fires
      // immediately (bypassing the 30-min grace window) so operators are
      // notified at the moment of the wipe, not up to an hour later.
      void (async () => {
        try {
          await storage.recordAdminSettingChange({
            settingKey: SETTINGS_KEY_ACCESS,
            scope: "wipe",
            changedBy: null,
            oldValues: null,
            newValues: {
              event: "token_wiped",
              instance: INSTANCE_ID,
              purpose: wipePurpose,
              refreshFp: wipeFp,
              providerError: wipeProviderError.slice(0, 300),
            },
          });
        } catch (auditErr: any) {
          // Task #3126 — an audit-write failure must not vanish into console
          // logs (autoscale logs expire with the deployment window). Bump the
          // named counter and fire a dedicated low-severity operator alert on
          // the same notification type with its OWN dedupeKey so it is not
          // suppressed by the "auto_wipe" or "global" disconnect alerts.
          __wipeAuditWriteFailedCount += 1;
          console.error(
            `[Semrush] ${WIPE_AUDIT_WRITE_FAILED_COUNTER} count=${__wipeAuditWriteFailedCount} — wipe audit insert failed:`,
            auditErr?.message,
          );
          try {
            const auditNotifyFn = __wipeNotifyOverrideForTest;
            const auditAlertPayload = {
              text:
                `*SEMrush wipe audit breadcrumb FAILED to persist* — the token wipe itself succeeded, ` +
                `but the durable audit record could not be written (counter: \`${WIPE_AUDIT_WRITE_FAILED_COUNTER}\`).\n` +
                `Instance: \`${INSTANCE_ID}\`  Purpose: \`${wipePurpose}\`  RefreshFp: \`${wipeFp}\`\n` +
                `Audit error: ${String(auditErr?.message ?? auditErr).slice(0, 300)}\n` +
                `Original provider error: ${wipeProviderError.slice(0, 300)}\n` +
                `Post-mortem attribution for this wipe now exists ONLY in this alert — preserve it if investigating.`,
            };
            const auditAlertOpts = {
              triggerSource: "scheduled" as const,
              dedupeKey: "wipe_audit_write_failed",
            };
            if (auditNotifyFn) {
              await auditNotifyFn(
                "integration.semrush.auth_or_circuit_open",
                auditAlertPayload,
                auditAlertOpts,
              );
            } else {
              const { notifyByType } = await import("./notifications/dispatcher");
              await notifyByType(
                "integration.semrush.auth_or_circuit_open",
                auditAlertPayload,
                auditAlertOpts,
              );
            }
          } catch (metaErr: any) {
            console.warn(
              "[Semrush] wipe-audit-failure alert failed (non-fatal):",
              metaErr?.message ?? metaErr,
            );
          }
        }
        const notifyFn = __wipeNotifyOverrideForTest;
        try {
          if (notifyFn) {
            await notifyFn(
              "integration.semrush.auth_or_circuit_open",
              {
                text:
                  `*SEMrush credentials automatically wiped after terminal OAuth failure.*\n` +
                  `Instance: \`${INSTANCE_ID}\`  Purpose: \`${wipePurpose}\`\n` +
                  `Provider error: ${wipeProviderError.slice(0, 300)}\n` +
                  `Action required: re-authorize SEMrush in *Settings → Integrations Hub* to restore the Local Dominance sync.`,
              },
              { triggerSource: "scheduled", dedupeKey: "auto_wipe" },
            );
          } else {
            const { notifyByType } = await import("./notifications/dispatcher");
            await notifyByType(
              "integration.semrush.auth_or_circuit_open",
              {
                text:
                  `*SEMrush credentials automatically wiped after terminal OAuth failure.*\n` +
                  `Instance: \`${INSTANCE_ID}\`  Purpose: \`${wipePurpose}\`\n` +
                  `Provider error: ${wipeProviderError.slice(0, 300)}\n` +
                  `Action required: re-authorize SEMrush in *Settings → Integrations Hub* to restore the Local Dominance sync.`,
              },
              { triggerSource: "scheduled", dedupeKey: "auto_wipe" },
            );
          }
        } catch (alertErr: any) {
          console.warn("[Semrush] wipe alert failed (non-fatal):", alertErr?.message ?? alertErr);
        }
      })();
    },
  });
}

/**
 * Task #2266 — test seam for the authoritative-vs-non-authoritative
 * token-wipe gating in `refreshAccessToken`. Delegates to the real refresh
 * path (single-flight helper + `onTerminalAfterRetry`) so a test can drive a
 * terminal refresh from a probe / proactive caller (must NOT wipe tokens) and
 * from an authoritative caller (default purpose — MUST wipe) without standing
 * up a full API GET. Test-only; never call from production code.
 */
export async function __refreshAccessTokenForTest(opts?: {
  purpose?: string;
  proactiveRotation?: boolean;
  rejectedAccessToken?: string;
}): Promise<string> {
  return refreshAccessToken(opts);
}

// ── Proactive keep-alive ─────────────────────────────────────────────────────

/**
 * Kill switch for the proactive SEMrush token keep-alive scheduler. Default
 * ON — a config-read blip must not silently stop rotation and let the 7-day
 * access token quietly expire.
 */
export const SEMRUSH_KEEPALIVE_ENABLED_SETTING = "semrush_token_keepalive_enabled";
const SEMRUSH_KEEPALIVE_OFF_TOKENS = new Set(["false", "0", "off", "no"]);

/**
 * Rotate the SEMrush access token when it is within this many milliseconds of
 * its expiry. The access token lasts 7 days (604800 s); rotating 48 h early
 * leaves two missed-tick days of headroom while staying well inside the 30-day
 * rotating-refresh-token window.
 */
export const SEMRUSH_KEEPALIVE_REFRESH_BEFORE_EXPIRY_MS = 48 * 60 * 60 * 1000;
/**
 * Task #3666 — rotate proactively when the stored token has been alive for at
 * least 3.5 days, regardless of how far it is from expiry. This bounds the
 * quiet-period gap to half the 7-day access-token lifetime, so a missed tick
 * or deployment pause can never leave a near-death refresh token unrotated.
 * 3.5 days is more than the 48-h expiry window but short enough that a single
 * missed 6-hour tick is never catastrophic.
 */
export const SEMRUSH_KEEPALIVE_MAX_AGE_MS = Math.floor(3.5 * 24 * 60 * 60 * 1000);
/**
 * Task #3666 — when a proactive rotation holds the cross-process lease and
 * finds `semrush_token_last_refreshed_at` within this window, a sibling
 * instance just rotated while we waited; reuse its token instead of POSTing
 * a second (wasteful, race-risky) rotation.
 */
export const SEMRUSH_PROACTIVE_SIBLING_ROTATION_SKEW_MS = 10 * 60 * 1000;

export type SemrushKeepAliveTickResult =
  | {
      action: "skipped";
      reason: "disabled" | "breaker_open" | "no_tokens" | "fresh" | "key_mode";
    }
  | { action: "refreshed" }
  | { action: "transient_error"; message: string }
  | { action: "terminal_error"; oauthError: string | null };

/**
 * Read the default-ON keep-alive kill switch. Fail-safe: any read error
 * leaves the feature ENABLED (a config blip must not silently stop proactive
 * rotation and let the token quietly expire).
 */
export async function isSemrushTokenKeepAliveEnabled(): Promise<boolean> {
  try {
    const row = await storage.getSystemSetting(SEMRUSH_KEEPALIVE_ENABLED_SETTING);
    const raw = row?.value?.trim().toLowerCase();
    if (!raw) return true;
    return !SEMRUSH_KEEPALIVE_OFF_TOKENS.has(raw);
  } catch (err: any) {
    console.error(
      "[SemrushKeepAlive] Failed to read enabled flag, defaulting to enabled:",
      err?.message ?? err,
    );
    return true;
  }
}

/**
 * One proactive keep-alive pass. Decides whether the stored SEMrush token
 * needs a pre-emptive rotation and, if so, drives it through the shared
 * single-flight + cross-process-lease refresh path. Pure of any scheduling /
 * locking concerns so it is directly unit-testable.
 *
 * NON-authoritative: a terminal refresh failure here does NOT engage the
 * auth-dead breaker or wipe tokens — only the on-demand path in
 * `getAccessToken` may do that.
 */
export async function runSemrushTokenKeepAliveTick(opts?: {
  /**
   * Task #3666 — bypass the freshness / age checks and force one rotation
   * unconditionally (while still respecting kill-switch, breaker, and
   * no-tokens guards). Used by the CEO prod-action so the operator can
   * prove the refresh endpoint is working immediately after a publish,
   * without waiting for the scheduled rotation window to open.
   */
  force?: boolean;
}): Promise<SemrushKeepAliveTickResult> {
  // Task #3670 — key mode: nothing to keep alive (the API key never
  // expires on a 7-day clock). The whole OAuth rotation path is dormant.
  if (isSemrushKeyMode()) {
    return { action: "skipped", reason: "key_mode" };
  }
  if (!(await isSemrushTokenKeepAliveEnabled())) {
    return { action: "skipped", reason: "disabled" };
  }
  // Breaker already engaged → operator reconnect required; a proactive
  // refresh can't clear it and would just churn a known-bad token.
  if (semrushAuthBreakerActive()) {
    return { action: "skipped", reason: "breaker_open" };
  }

  let refreshSetting: Awaited<ReturnType<typeof storage.getSystemSetting>>;
  let expiresSetting: Awaited<ReturnType<typeof storage.getSystemSetting>>;
  let lastRefreshedSetting: Awaited<ReturnType<typeof storage.getSystemSetting>>;
  try {
    [refreshSetting, expiresSetting, lastRefreshedSetting] = await Promise.all([
      storage.getSystemSetting(SETTINGS_KEY_REFRESH),
      storage.getSystemSetting(SETTINGS_KEY_EXPIRES),
      storage.getSystemSetting(SETTINGS_KEY_LAST_REFRESHED),
    ]);
  } catch (err: any) {
    return { action: "transient_error", message: `token read failed: ${err?.message ?? err}` };
  }

  // No stored refresh token → SEMrush was never connected or was reset.
  if (!refreshSetting?.value) {
    return { action: "skipped", reason: "no_tokens" };
  }

  const expiresAtMs = expiresSetting?.value ? parseInt(expiresSetting.value, 10) : 0;
  const now = Date.now();

  if (!opts?.force) {
    // Task #3666 — age-based criterion: also rotate when the token has been
    // alive for ≥ SEMRUSH_KEEPALIVE_MAX_AGE_MS (~3.5 days) regardless of
    // proximity to expiry, so a quiet period or missed tick never leaves a
    // near-expiry token unrotated.
    // If semrush_token_last_refreshed_at has never been written (pre-#3666
    // deployments), fall back to deriving issue time from expiresAt − 7 days
    // (the fixed device-flow access-token lifetime).
    const lastRefreshedMs = lastRefreshedSetting?.value
      ? parseInt(lastRefreshedSetting.value, 10)
      : expiresAtMs > 0
        ? expiresAtMs - 7 * 24 * 60 * 60 * 1000
        : 0;
    const ageMs = lastRefreshedMs > 0 ? now - lastRefreshedMs : Infinity;
    const withinExpiryWindow =
      expiresAtMs > 0 && now >= expiresAtMs - SEMRUSH_KEEPALIVE_REFRESH_BEFORE_EXPIRY_MS;
    const ageExceeded = ageMs >= SEMRUSH_KEEPALIVE_MAX_AGE_MS;

    // Still well clear of both the expiry window and the max-age threshold.
    if (!withinExpiryWindow && !ageExceeded) {
      return { action: "skipped", reason: "fresh" };
    }
  }

  // Within the rotation window (or expiry/access unknown) → rotate now.
  // Terminal failures do NOT engage the breaker here (non-authoritative
  // purpose).
  try {
    // Task #3666 — `proactiveRotation` disables the lease recheck's
    // "access token still fresh → skip POST" fast path (which would
    // otherwise no-op every proactive rotation in production, where the
    // lease is always held), while keeping the sibling-just-rotated guard.
    await refreshAccessToken({ purpose: "proactive", proactiveRotation: true });
    return { action: "refreshed" };
  } catch (err: any) {
    if (err instanceof OAuthRefreshError) {
      if (err.outcome === "terminal") {
        console.warn(
          `[SemrushKeepAlive] Proactive refresh hit a terminal error (breaker NOT engaged — keep-alive is non-authoritative): ${err.message}`,
        );
        return { action: "terminal_error", oauthError: err.message ?? null };
      }
      return { action: "transient_error", message: err.message };
    }
    return { action: "transient_error", message: err?.message ?? String(err) };
  }
}

/**
 * Task #1975 — Outcome-aware probe for the /api/integrations/all-status
 * loader. The loader's preserve pattern requires a result of
 *   { outcome: "connected" | "unauthorized" | "probe_failed", reason? }
 * so a transient probe error (network / 5xx) keeps the previously-
 * cached value instead of flipping the badge to Not Connected.
 */
export type SemrushProbeOutcome = "connected" | "unauthorized" | "probe_failed";
export interface SemrushProbeResult {
  outcome: SemrushProbeOutcome;
  reason?: string;
}

/**
 * Task #1975 — Shared cached probe loader. Both
 * `/api/integrations/all-status` and `/api/semrush/status` go through
 * `getCachedIntegrationStatus("semrush", semrushCachedProbeLoader)` so
 * they read from the same cache entry — preserve semantics apply to
 * both routes uniformly. A transient probe blip can no longer flap the
 * UI between the two endpoints.
 */
export interface SemrushCachedProbeValue {
  connected: boolean;
  disconnectReason: string | null;
}
export async function semrushCachedProbeLoader(): Promise<
  | { outcome: "commit"; value: SemrushCachedProbeValue; freshTtlMs: number }
  | { outcome: "preserve"; lastProbeError: string }
> {
  const probe = await probeConnection().catch((err: any) => ({
    outcome: "probe_failed" as const,
    reason: `probe_threw: ${err?.message ?? "unknown"}`,
  }));
  if (probe.outcome === "probe_failed") {
    return { outcome: "preserve", lastProbeError: probe.reason ?? "probe_failed" };
  }
  const connected = probe.outcome === "connected";
  return {
    outcome: "commit",
    value: { connected, disconnectReason: connected ? null : (probe.reason ?? null) },
    freshTtlMs: connected ? 60_000 : 15_000,
  };
}

export async function probeConnection(): Promise<SemrushProbeResult> {
  // Task #3670 — key mode: connection status is derived from the API key
  // itself via a lightweight live GET (campaigns?size=1), NEVER from stored
  // OAuth token presence/expiry. 401/403 = key problem (invalid/revoked);
  // anything else non-2xx / network error preserves last-known state via
  // probe_failed. Caching/TTLs handled by semrushCachedProbeLoader.
  if (isSemrushKeyMode()) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await fetch(`${BASE_URL}/campaigns?size=1`, {
          headers: { Authorization: `Apikey ${getSemrushV4ApiKey()}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (response.ok) {
        recordSemrushKeyModeSuccess();
        // Task #3672 — probe success also proves the key is live.
        onSemrushKeyModeCallSucceeded();
        return { outcome: "connected" };
      }
      if (response.status === 401 || response.status === 403) {
        // Task #3672 — a probe 401/403 is the same revoked-key signal as a
        // live call's; count it toward the rejected-key alert streak.
        await recordSemrushKeyModeRejection(response.status, "/campaigns");
        return {
          outcome: "unauthorized",
          reason: `api_key_rejected (HTTP ${response.status}) — check the SEMRUSH_V4_API_KEY secret`,
        };
      }
      return { outcome: "probe_failed", reason: `probe HTTP ${response.status}` };
    } catch (err: any) {
      return {
        outcome: "probe_failed",
        reason: (err?.message ?? "probe_failed").slice(0, 200),
      };
    }
  }
  const [tokenSetting, refreshSetting, expiresSetting] = await Promise.all([
    storage.getSystemSetting(SETTINGS_KEY_ACCESS),
    storage.getSystemSetting(SETTINGS_KEY_REFRESH),
    storage.getSystemSetting(SETTINGS_KEY_EXPIRES),
  ]);
  if (!tokenSetting?.value && !refreshSetting?.value) {
    return { outcome: "unauthorized", reason: "no_tokens_stored" };
  }
  const isExpired =
    !!expiresSetting?.value &&
    Date.now() > parseInt(expiresSetting.value) - 60_000;
  if (tokenSetting?.value && !isExpired) {
    return { outcome: "connected" };
  }
  if (!refreshSetting?.value) {
    return { outcome: "unauthorized", reason: "no_refresh_token" };
  }
  try {
    await refreshAccessToken({ purpose: "probe" });
    return { outcome: "connected" };
  } catch (err: any) {
    if (err instanceof OAuthRefreshError && err.outcome === "terminal") {
      // Task #2500 — a TERMINAL refresh on the non-authoritative `probe`
      // purpose is the deploy-time rotation-race case: #2267's
      // onTerminalAfterRetry deliberately did NOT wipe the stored tokens or
      // trip the auth-dead breaker for it. Surfacing `unauthorized` here
      // flips the Hub badge to Not Connected for ~15s after a publish on a
      // connection a sibling instance just rotated healthy. Preserve the
      // last-known-good badge (probe_failed) UNLESS the DURABLE auth-dead
      // breaker is already open — i.e. an AUTHORITATIVE refresh confirmed the
      // death (which also wipes the tokens, so the `no_tokens_stored` check
      // at the top of this probe surfaces the disconnect too). The route
      // reconciles the breaker into `reconnectRequired` regardless.
      if (semrushAuthBreakerActive()) {
        return {
          outcome: "unauthorized",
          reason: (err.message ?? "terminal_refresh").slice(0, 200),
        };
      }
      return {
        outcome: "probe_failed",
        reason: (err.message ?? "terminal_refresh").slice(0, 200),
      };
    }
    return {
      outcome: "probe_failed",
      reason: (err?.message ?? "probe_failed").slice(0, 200),
    };
  }
}

const API_TIMEOUT_MS = 30_000;

/**
 * Task #2643 — fire-and-forget recovery of `paused_auth` rows after the auth
 * breaker self-heals between sweeps. Dynamic import avoids the module cycle
 * (`semrushLocationSyncState` statically imports this file). Best-effort: a
 * failure here only delays recovery to the next Local-Dominance sweep, which
 * does the same clear at its top — never throws into the hot API path.
 */
async function recoverPausedAuthAfterAuthRestored(reason: string): Promise<void> {
  try {
    const { recoverPausedAuthRows } = await import("./semrushLocationSyncState");
    const { locationRows, integrationRows } = await recoverPausedAuthRows();
    if (locationRows > 0 || integrationRows > 0) {
      console.log(
        `[Semrush] paused_auth recovered (${reason}) — locationRows=${locationRows} integrationRows=${integrationRows}`,
      );
    }
  } catch (err: any) {
    console.warn(
      `[Semrush] paused_auth recovery (${reason}) failed (non-fatal, next sweep clears): ${err?.message ?? err}`,
    );
  }
}

async function apiGet(path: string, params?: Record<string, string>, externalSignal?: AbortSignal): Promise<any> {
  if (externalSignal?.aborted) {
    throw new Error(`Sync cancelled before SEMrush API call to ${path}`);
  }

  const breaker = await import("./semrushCircuitBreaker");
  try {
    const result = await apiGetInner(path, params, externalSignal);
    breaker.recordSuccess();
    // Task #3670 — key mode: track last successful key-authenticated call
    // for the Hub/admin "API key mode" surfaces (in-memory + throttled
    // persist; no per-call DB churn).
    if (isSemrushKeyMode()) {
      recordSemrushKeyModeSuccess();
      // Task #3672 — a successful key-authenticated call proves the key is
      // live: reset the rejection streak and re-arm the rejected-key alert.
      onSemrushKeyModeCallSucceeded();
    }
    // Task #2643 — self-heal the AUTH breaker from healthy traffic. The auth
    // breaker only ever cleared on a successful refresh or an operator
    // reconnect; a successful authenticated API call recorded success on the
    // CIRCUIT (vendor-outage) breaker, not the auth breaker. So a FALSE trip
    // (e.g. a rotation-race wipe that a sibling immediately healed, or a
    // transient blip that was misclassified) had no path back to healthy from
    // ordinary traffic. A bearer-token API call that returns 200 is proof the
    // credential is live, so clear the auth breaker. Guarded by
    // `semrushAuthBreakerActive()` so the durable signal is only written when
    // the breaker is actually open — no per-call DB write churn on the happy
    // path. (A call can land here with the breaker open via the narrow race
    // where the token was acquired BEFORE a concurrent caller tripped it.)
    if (semrushAuthBreakerActive()) {
      console.warn(
        `[Semrush] outcome=self_heal instance=${INSTANCE_ID} — authenticated API call succeeded while auth breaker open; clearing breaker (was a false trip) and recovering paused_auth rows`,
      );
      recordSemrushCallSuccess();
      resetSemrushAuthBreaker();
      void recoverPausedAuthAfterAuthRestored("self_heal");
    }
    return result;
  } catch (err: any) {
    // Task #953: only feed the breaker outcomes that genuinely
    // represent vendor collapse. Excluded:
    //  - caller-side cancellations (`Sync cancelled …`) — local choice
    //  - `SemrushNotFoundError` (404) — legitimate "not found" semantics
    //  - auth/token errors — local config / re-auth required, not an
    //    upstream outage; counting these would prematurely trip the
    //    breaker for an unrelated symptom
    const msg = String(err?.message || err || "");
    const isCancellation = externalSignal?.aborted || /Sync cancelled/i.test(msg);
    const isNotFound = err?.name === "SemrushNotFoundError";
    const classified = breaker.classifyError(err);
    if (!isCancellation && !isNotFound && classified !== "auth") {
      breaker.recordFailure(classified);
    }
    throw err;
  }
}

async function apiGetInner(path: string, params?: Record<string, string>, externalSignal?: AbortSignal): Promise<any> {
  return auditOutboundCall(
    {
      integration: "semrush",
      endpoint: path,
      method: "GET",
      dedupeParams: params,
    },
    async () => {
      const data = await apiGetInnerImpl(path, params, externalSignal);
      const payload = data === undefined ? "" : JSON.stringify(data);
      const bytes = Buffer.byteLength(payload, "utf8");
      const hash = bytes > 0
        ? createHash("sha256").update(payload).digest("hex").slice(0, 64)
        : undefined;
      return { value: data, statusCode: 200, responseSizeBytes: bytes, responseHash: hash };
    },
  );
}

async function apiGetInnerImpl(path: string, params?: Record<string, string>, externalSignal?: AbortSignal): Promise<any> {
  // Task #3670 — key mode: authenticate with `Authorization: Apikey` and
  // bypass the OAuth token read/refresh path entirely. A 401/403 here is a
  // KEY problem (invalid/revoked/expired key) — never an OAuth wipe or a
  // device-flow "re-authorize" prompt.
  const keyMode = isSemrushKeyMode();
  const token = keyMode ? null : await getAccessToken();
  const authHeader = keyMode ? `Apikey ${getSemrushV4ApiKey()}` : `Bearer ${token}`;
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    if (err.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new Error(`Sync cancelled during SEMrush API call to ${url.pathname}`);
      }
      throw new Error(`SEMrush API request timed out after ${API_TIMEOUT_MS / 1000}s for ${url.pathname}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status !== 429) {
      console.error(`[Semrush] API error ${res.status} for ${url.pathname}${url.search}: ${body}`);
    }
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("retry-after");
      const parsedRetryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const retryAfterMs = !isNaN(parsedRetryAfter) && parsedRetryAfter > 0 ? parsedRetryAfter * 1000 : 0;
      const maxRetries = PERF.SEMRUSH_429_MAX_RETRIES_PER_REQUEST;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const expDelay = PERF.SEMRUSH_429_BASE_BACKOFF_MS * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * PERF.SEMRUSH_429_JITTER_MS);
        const delay = retryAfterMs > 0
          ? Math.max(retryAfterMs, expDelay)
          : Math.min(expDelay + jitter, PERF.SEMRUSH_429_MAX_BACKOFF_MS);
        await new Promise(r => setTimeout(r, delay));
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), API_TIMEOUT_MS);
        try {
          const retryAuthHeader = keyMode ? authHeader : `Bearer ${await getAccessToken()}`;
          const retry = await fetch(url.toString(), {
            headers: { Authorization: retryAuthHeader },
            signal: retryController.signal,
          });
          clearTimeout(retryTimeout);
          if (retry.ok) return retry.json();
          if (retry.status !== 429) {
            const retryBody = await retry.text().catch(() => "");
            throw new Error(`SEMrush API returned ${retry.status}: ${retryBody || retry.statusText}`);
          }
        } catch (retryErr: any) {
          clearTimeout(retryTimeout);
          if (retryErr.name === "AbortError") {
            throw new Error(`SEMrush API retry timed out after ${API_TIMEOUT_MS / 1000}s for ${url.pathname}`);
          }
          if (attempt === maxRetries - 1) throw retryErr;
        }
      }
      throw new SemrushRateLimitError(`SEMrush API rate limited (429) after ${maxRetries} retries for ${url.pathname}`);
    }
    if (res.status === 404) {
      throw new SemrushNotFoundError(`Semrush API 404: ${body || "Not Found"}`);
    }
    if (keyMode && (res.status === 401 || res.status === 403)) {
      // Task #3670 — key rejected. No refresh, no token wipe, no breaker,
      // no device-flow message: the fix is rotating the SEMRUSH_V4_API_KEY
      // secret, not reconnecting OAuth.
      // Task #3672 — count the rejection toward the once-per-streak operator
      // alert (never throws; awaited so the streak count is durable before
      // the caller sees the error).
      await recordSemrushKeyModeRejection(res.status, url.pathname);
      throw new SemrushApiKeyRejectedError(
        `SEMrush API key rejected (HTTP ${res.status}) for ${url.pathname} — the SEMRUSH_V4_API_KEY secret is invalid, revoked, or lacks Map Rank Tracker access`,
      );
    }
    if (res.status === 401) {
      try {
        // Task #2643 — tag the reactive-401 recovery refresh with an
        // attributable, AUTHORITATIVE purpose (a live API call got a 401, so
        // wiping on a terminal failure is correct). Routes through the same
        // single-flight + cross-process lease as every other refresh.
        const newToken = await refreshAccessToken({ purpose: "401_retry", rejectedAccessToken: token ?? undefined });
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), API_TIMEOUT_MS);
        try {
          const retry = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${newToken}` },
            signal: retryController.signal,
          });
          clearTimeout(retryTimeout);
          if (retry.ok) return retry.json();
          console.error(`[Semrush] Retry after refresh still failed: ${retry.status}`);
        } catch (retryErr: any) {
          clearTimeout(retryTimeout);
          if (retryErr.name === "AbortError") {
            throw new Error(`SEMrush API retry timed out after ${API_TIMEOUT_MS / 1000}s for ${url.pathname}`);
          }
          throw retryErr;
        }
      } catch (refreshErr: any) {
        console.error(`[Semrush] Token refresh failed during 401 recovery:`, refreshErr?.message);
      }
      throw new Error("Semrush not connected — token expired, please re-authorize via Integrations Hub");
    }
    throw new Error(`SEMrush API returned ${res.status}: ${body || res.statusText}`);
  }

  return res.json();
}

export async function startDeviceAuthorization(): Promise<{
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}> {
  const res = await fetch(OAUTH_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Semrush device authorization failed: ${res.status} ${body}`);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error("Semrush device authorization returned invalid response");
  }

  const expiresAt = Date.now() + (data.expires_in || 1800) * 1000;
  const pollInterval = data.interval || 5;

  await storage.setSystemSetting(SETTINGS_KEY_DEVICE_CODE, data.device_code, "system");
  await storage.setSystemSetting(SETTINGS_KEY_USER_CODE, data.user_code, "system");
  await storage.setSystemSetting(SETTINGS_KEY_VERIFY_URI, data.verification_uri || "https://oauth.semrush.com/device", "system");
  await storage.setSystemSetting(SETTINGS_KEY_DEVICE_EXPIRES, String(expiresAt), "system");

  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri_complete || data.verification_uri || "https://oauth.semrush.com/device",
    expiresIn: data.expires_in || 1800,
  };
}

export async function pollDeviceToken(): Promise<{ success: boolean; error?: string }> {
  const deviceCodeSetting = await storage.getSystemSetting(SETTINGS_KEY_DEVICE_CODE);
  if (!deviceCodeSetting?.value) return { success: false, error: "No pending device authorization" };

  const expiresAtSetting = await storage.getSystemSetting(SETTINGS_KEY_DEVICE_EXPIRES);
  if (expiresAtSetting?.value && Date.now() > parseInt(expiresAtSetting.value)) {
    await clearDeviceAuth();
    return { success: false, error: "Device authorization expired — please try again" };
  }

  const deviceCode = deviceCodeSetting.value;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    }).toString(),
  });

  let data: any;
  const rawText = await res.text();
  try {
    data = JSON.parse(rawText);
  } catch {
    await clearDeviceAuth();
    return { success: false, error: "Invalid response from Semrush" };
  }

  if (data.access_token) {
    const tokenExpiresAt = Date.now() + (data.expires_in || 604800) * 1000;
    await storage.setSystemSetting(SETTINGS_KEY_ACCESS, data.access_token, "system");
    await storage.setSystemSetting(SETTINGS_KEY_EXPIRES, String(tokenExpiresAt), "system");
    if (data.refresh_token) {
      await storage.setSystemSetting(SETTINGS_KEY_REFRESH, data.refresh_token, "system");
    }
    // Task #3666 — record issue time so the age-based keep-alive criterion
    // can compute token age starting from this reconnect, not from expiry−7d.
    await storage.setSystemSetting(SETTINGS_KEY_LAST_REFRESHED, String(Date.now()), "system");
    await clearDeviceAuth();
    // Task #2102 — operator reconnect supplies a fresh refresh token;
    // clear any auth-dead breaker so suppressed surfaces resume at once.
    recordSemrushCallSuccess();
    resetSemrushAuthBreaker();
    console.log("[Semrush] OAuth authorization completed successfully");
    return { success: true };
  }

  if (data.error === "authorization_pending") {
    return { success: false, error: "authorization_pending" };
  }

  if (data.error === "slow_down") {
    return { success: false, error: "authorization_pending" };
  }

  await clearDeviceAuth();
  return { success: false, error: data.error || "Authorization failed" };
}

// Task #2240 — in-memory credential override (test-only).
//
// SEMrush stores its OAuth credential in the shared `system_settings`
// table, which the always-on "Start application" SEMrush worker keeps
// re-writing in the `public` schema as it refreshes the real token. The
// `semrush-disconnect-audit` suite seeds a *fake* token and asserts
// disconnect clears it; against the shared dev DB that refresh races the
// assertion and re-seeds a real token. When this override is installed
// (only by that suite) the disconnect path's credential + device-auth
// clears go to the in-memory map instead of `system_settings`, so the
// suite owns the credential state outright and never touches a row the
// dev server also writes. Production never installs it. Mirrors the
// `setStateOverrideForTests` pattern in frontAutoClosureRegressionAlerts.ts.
let credentialStoreOverride: Map<string, string> | null = null;

export function __setSemrushCredentialStoreOverrideForTests(
  store: Map<string, string> | null,
): void {
  credentialStoreOverride = store;
}

// Task #3109 — injectable notify override for the automatic-wipe alert so
// tests can intercept the call without ESM live-binding issues. Follows the
// pattern from semrushDisconnectAlert.ts. Production always uses the real
// dynamic-import path (override is null in production).
let __wipeNotifyOverrideForTest: ((id: string, payload: any, opts: any) => Promise<void>) | null = null;

// Task #3126 — named counter for wipe audit-write failures. In-process
// observability: incremented whenever the durable wipe breadcrumb INSERT
// throws (e.g. DB pool exhausted). The paired low-severity operator alert
// (dedupeKey "wipe_audit_write_failed") is the durable signal; this counter
// gives tests and any in-process health surface a deterministic hook.
export const WIPE_AUDIT_WRITE_FAILED_COUNTER = "semrush.wipe_audit_write_failed";
let __wipeAuditWriteFailedCount = 0;

/** Current value of the semrush.wipe_audit_write_failed counter (per-process). */
export function getSemrushWipeAuditWriteFailedCount(): number {
  return __wipeAuditWriteFailedCount;
}

/** Test-only: reset the wipe-audit-write-failed counter. */
export function __resetSemrushWipeAuditWriteFailedCountForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetSemrushWipeAuditWriteFailedCountForTest is test-only");
  }
  __wipeAuditWriteFailedCount = 0;
}

export function __setWipeNotifyOverrideForTest(
  fn: ((id: string, payload: any, opts: any) => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setWipeNotifyOverrideForTest is test-only");
  }
  __wipeNotifyOverrideForTest = fn;
}

async function clearCredentialSetting(key: string, actor: string): Promise<void> {
  if (credentialStoreOverride) {
    credentialStoreOverride.set(key, "");
    return;
  }
  await storage.setSystemSetting(key, "", actor);
}

async function clearDeviceAuth(): Promise<void> {
  await clearCredentialSetting(SETTINGS_KEY_DEVICE_CODE, "system");
  await clearCredentialSetting(SETTINGS_KEY_USER_CODE, "system");
  await clearCredentialSetting(SETTINGS_KEY_VERIFY_URI, "system");
  await clearCredentialSetting(SETTINGS_KEY_DEVICE_EXPIRES, "system");
}

// Task #1977 — match the Slack trigger taxonomy so the credential history
// can tell a manual disconnect apart from any future terminal-auth wipe.
export type SemrushTokenClearTrigger =
  | "manual_disconnect"
  | "connect_terminal_auth_error";

export async function disconnect(
  updatedBy?: string,
  options?: { trigger?: SemrushTokenClearTrigger; reason?: string | null; notes?: string | null },
): Promise<void> {
  const actor = updatedBy ?? "system";
  const trigger: SemrushTokenClearTrigger = options?.trigger ?? "manual_disconnect";
  await clearCredentialSetting(SETTINGS_KEY_ACCESS, actor);
  await clearCredentialSetting(SETTINGS_KEY_REFRESH, actor);
  await clearCredentialSetting(SETTINGS_KEY_EXPIRES, actor);
  await clearDeviceAuth();
  // Task #1977 — leave a scoped audit breadcrumb for every credential clear.
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
    console.error("[Semrush] disconnect audit insert failed:", err?.message);
  }
  // Task #3661 — durable forensics record for the manual credential clear.
  void recordDisconnectForensics({
    integration: "semrush",
    codePath: trigger,
    purpose: null,
    providerError: options?.reason ?? null,
    instanceId: INSTANCE_ID,
    summary:
      trigger === "manual_disconnect"
        ? `SEMrush was manually disconnected${updatedBy && updatedBy !== "system" ? ` by ${updatedBy}` : ""}.`
        : "SEMrush credentials were cleared after a terminal auth error during the connect flow.",
    operatorAction: "Reconnect SEMrush in Settings → Integrations Hub when ready.",
  });
  console.log("[Semrush] Disconnected");
}

/**
 * Task #1975 — Unified status read for SEMrush.
 *
 * `connected` / `expired` now derive from `probeConnection()` so the
 * `/api/semrush/status` endpoint and the `/api/integrations/all-status`
 * loader share one classification path. `pendingAuth` (device-flow
 * UI state) is still read from `system_settings` directly because the
 * probe doesn't know about it.
 *
 * `disconnectReason` (terminal — set on `unauthorized` outcome) and
 * `lastProbeError` (transient — set on `probe_failed` outcome) follow
 * the same shape every other integration in the Hub uses, so a 5xx /
 * network blip never flips the badge to Not Connected.
 */
export async function getConnectionStatus(): Promise<{
  connected: boolean;
  expired: boolean;
  pendingAuth?: { userCode: string; verificationUri: string };
  disconnectReason: string | null;
  lastProbeError: string | null;
  /** Task #3670 — how SEMrush is authenticating right now. */
  authMode: "api_key" | "oauth";
  /** Task #3670 — last successful key-authenticated call (key mode only). */
  keyModeLastSuccessAt: string | null;
}> {
  // Task #3670 — key mode: status comes from the key probe alone; the
  // device-flow expired/pendingAuth sub-states never apply (stale OAuth
  // settings must not surface a reconnect prompt while the key is active).
  if (isSemrushKeyMode()) {
    const probe = await probeConnection();
    return {
      connected: probe.outcome === "connected",
      expired: false,
      pendingAuth: undefined,
      disconnectReason: probe.outcome === "unauthorized" ? probe.reason ?? null : null,
      lastProbeError: probe.outcome === "probe_failed" ? probe.reason ?? null : null,
      authMode: "api_key",
      keyModeLastSuccessAt: await getSemrushKeyModeLastSuccessAt(),
    };
  }
  const [probe, expiresSetting, deviceCodeSetting, userCodeSetting, verifyUriSetting, deviceExpiresSetting] =
    await Promise.all([
      probeConnection(),
      storage.getSystemSetting(SETTINGS_KEY_EXPIRES),
      storage.getSystemSetting(SETTINGS_KEY_DEVICE_CODE),
      storage.getSystemSetting(SETTINGS_KEY_USER_CODE),
      storage.getSystemSetting(SETTINGS_KEY_VERIFY_URI),
      storage.getSystemSetting(SETTINGS_KEY_DEVICE_EXPIRES),
    ]);

  const connected = probe.outcome === "connected";
  const expired =
    !connected &&
    !!expiresSetting?.value &&
    Date.now() > parseInt(expiresSetting.value) - 60_000;

  let pendingAuth: { userCode: string; verificationUri: string } | undefined;
  if (
    !connected &&
    deviceCodeSetting?.value &&
    userCodeSetting?.value &&
    deviceExpiresSetting?.value &&
    Date.now() < parseInt(deviceExpiresSetting.value)
  ) {
    pendingAuth = {
      userCode: userCodeSetting.value,
      verificationUri: verifyUriSetting?.value || "https://oauth.semrush.com/device",
    };
  }

  return {
    connected,
    expired,
    pendingAuth,
    disconnectReason: probe.outcome === "unauthorized" ? probe.reason ?? null : null,
    lastProbeError: probe.outcome === "probe_failed" ? probe.reason ?? null : null,
    authMode: "oauth",
    keyModeLastSuccessAt: null,
  };
}

interface LatLng {
  lat: number;
  lng: number;
}

interface SemrushGridSettings {
  template: string;
  unit: string;
  distance: number;
  basePoint?: LatLng;
  base_point?: LatLng;
  centerPoint?: LatLng;
  center_point?: LatLng;
}

function getGridBasePoint(grid: SemrushGridSettings | undefined): LatLng | undefined {
  return grid?.basePoint || grid?.base_point || grid?.centerPoint || grid?.center_point;
}

export interface SemrushCampaign {
  id: string;
  businessName: string;
  campaignName?: string;
  address?: string;
  location?: string;
  gridSettings?: SemrushGridSettings;
  keywords?: Array<{ id: string; name: string; status: string }>;
  schedule?: string;
  createdAt?: string;
}

export interface SemrushKeyword {
  id: string;
  name: string;
  status: string;
}

export interface SemrushHeatmapPoint {
  point: { id: string; lat: number; lng: number };
  rank: number | null;
  diff: number | null;
}

// Task #1973: cache entry now carries the completion flag so consumers
// can treat an incomplete fetch as stale even when the timestamp is fresh.
interface CampaignKeywordsCacheEntry {
  keywords: SemrushKeyword[];
  timestamp: number;
  complete: boolean;
  incompleteReason?: SemrushKeywordInventoryIncompleteReason;
}
const campaignKeywordsCache = new Map<string, CampaignKeywordsCacheEntry>();
const campaignLocationCache = new Map<string, { location: string | null; timestamp: number }>();
const KEYWORD_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedCampaignList: { campaigns: SemrushCampaign[]; timestamp: number } | null = null;
const CAMPAIGN_LIST_CACHE_TTL_MS = 60 * 60 * 1000;
// Task #1785: configurable cadence. Falls back to the env default when
// the live `system_settings` lookup hasn't loaded yet; bucket math uses
// the snapshot in `getBackgroundRefreshIntervalMs()` so a setting flip
// rolls cleanly into a new bucket on the next tick.
function getBackgroundRefreshIntervalMs(): number {
  try {
    // Lazy access via require-free relative import — semrushCadenceGate
    // caches the value for 30s so this is cheap to call every tick.
    // We deliberately keep a synchronous default-fallback path to avoid
    // making the bucket calc async.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("./semrushCadenceGate");
    const cached = mod._peekCachedIntervalMs?.();
    if (typeof cached === "number" && cached > 0) return cached;
  } catch {}
  return PERF.SEMRUSH_BACKGROUND_REFRESH_INTERVAL_MS;
}
const BACKGROUND_REFRESH_INTERVAL_MS = PERF.SEMRUSH_BACKGROUND_REFRESH_INTERVAL_MS;
const ENRICHMENT_RETRY_INTERVAL_MS = 2 * 60 * 1000;
let backgroundRefreshTimer: ReturnType<typeof setInterval> | null = null;
let enrichmentRetryTimer: ReturnType<typeof setTimeout> | null = null;
let backgroundRefreshRunning = false;
let enrichedCacheReady = false;
let enrichmentStartedAt: number | null = null;
const ENRICHMENT_READY_THRESHOLD = 0.5;
const ENRICHMENT_TIMEOUT_GATE_MS = 15_000;

export function clearCampaignCache(): void {
  cachedCampaignList = null;
  enrichedCacheReady = false;
  enrichmentStartedAt = null;
  console.log("[Semrush] Campaign cache force-cleared — next request will fetch fresh data from API");
}

export function isEnrichmentComplete(): boolean {
  if (enrichedCacheReady) return true;
  if (!cachedCampaignList) return false;
  const camps = cachedCampaignList.campaigns;
  if (camps.length === 0) return false;

  const enrichedCount = camps.filter(c =>
    (c.keywords && c.keywords.length > 0) || (c.location || c.address)
  ).length;
  const ratio = enrichedCount / camps.length;

  if (ratio >= 1) {
    enrichedCacheReady = true;
    return true;
  }

  if (ratio >= ENRICHMENT_READY_THRESHOLD) {
    enrichedCacheReady = true;
    console.log(`[Semrush] Enrichment threshold met: ${enrichedCount}/${camps.length} (${(ratio * 100).toFixed(0)}%)`);
    return true;
  }

  if (enrichmentStartedAt && (Date.now() - enrichmentStartedAt) > ENRICHMENT_TIMEOUT_GATE_MS) {
    enrichedCacheReady = true;
    console.log(`[Semrush] Enrichment timeout reached after ${((Date.now() - enrichmentStartedAt) / 1000).toFixed(0)}s, returning ${enrichedCount}/${camps.length} campaigns`);
    return true;
  }

  return false;
}

function getCachedKeywords(campaignId: string): SemrushKeyword[] | null {
  const entry = campaignKeywordsCache.get(campaignId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > KEYWORD_CACHE_TTL_MS) {
    campaignKeywordsCache.delete(campaignId);
    return null;
  }
  // Task #1973: never serve an incomplete inventory as a fresh cache
  // hit. Callers that filter enrichment candidates with
  // `!getCachedKeywords(c.id)` would otherwise keep skipping a campaign
  // that needs a real refresh — exactly the heatmap-tile failure mode
  // we're closing. Use getCachedKeywordInventoryMeta() if you need the
  // partial list (e.g. UI rendering with an "incomplete" badge).
  if (!entry.complete) return null;
  return entry.keywords;
}

/**
 * Task #1973: returns the completion meta for the cached keyword inventory
 * (or `null` when no cache entry / expired). An entry with `complete=false`
 * must be treated as stale by every consumer (UI cache-age check AND the
 * demand-driven cadence gate), so the next request triggers a real refresh
 * rather than serving the partial list indefinitely.
 */
export function getCachedKeywordInventoryMeta(campaignId: string): {
  complete: boolean;
  incompleteReason?: SemrushKeywordInventoryIncompleteReason;
  timestamp: number;
} | null {
  const entry = campaignKeywordsCache.get(campaignId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > KEYWORD_CACHE_TTL_MS) return null;
  return {
    complete: entry.complete,
    incompleteReason: entry.incompleteReason,
    timestamp: entry.timestamp,
  };
}

// ── Task #1973: structured `semrush_keyword_inventory_bailout` event +
// 24h in-memory counter (surfaced on the SEMrush Operations Console).
// Ring is bounded so we never grow without limit; entries older than 24h
// are pruned lazily on read.
const KEYWORD_INVENTORY_BAILOUT_WINDOW_MS = 24 * 60 * 60 * 1000;
const KEYWORD_INVENTORY_BAILOUT_RING_CAP = 1000;
interface KeywordInventoryBailoutEntry {
  ts: number;
  campaignId: string;
  incompleteReason: SemrushKeywordInventoryIncompleteReason;
  pagesWalked: number;
  keywordCount: number;
}
const keywordInventoryBailouts: KeywordInventoryBailoutEntry[] = [];

function recordKeywordInventoryBailout(entry: Omit<KeywordInventoryBailoutEntry, "ts">): void {
  keywordInventoryBailouts.push({ ...entry, ts: Date.now() });
  if (keywordInventoryBailouts.length > KEYWORD_INVENTORY_BAILOUT_RING_CAP) {
    keywordInventoryBailouts.splice(0, keywordInventoryBailouts.length - KEYWORD_INVENTORY_BAILOUT_RING_CAP);
  }
}

export function getKeywordInventoryBailoutStats(): {
  countInWindow: number;
  windowMs: number;
  byReason: Record<string, number>;
  recent: KeywordInventoryBailoutEntry[];
} {
  const cutoff = Date.now() - KEYWORD_INVENTORY_BAILOUT_WINDOW_MS;
  // Prune lazily so the ring doesn't accumulate dead entries.
  while (keywordInventoryBailouts.length > 0 && keywordInventoryBailouts[0].ts < cutoff) {
    keywordInventoryBailouts.shift();
  }
  const byReason: Record<string, number> = {};
  for (const e of keywordInventoryBailouts) {
    byReason[e.incompleteReason] = (byReason[e.incompleteReason] ?? 0) + 1;
  }
  return {
    countInWindow: keywordInventoryBailouts.length,
    windowMs: KEYWORD_INVENTORY_BAILOUT_WINDOW_MS,
    byReason,
    recent: keywordInventoryBailouts.slice(-10).map((e) => ({ ...e })),
  };
}

/** Test-only: reset the in-memory bailout ring between runs. */
export function __resetKeywordInventoryBailoutsForTest(): void {
  keywordInventoryBailouts.length = 0;
}

const ENRICHMENT_TIMEOUT_MS = 8000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let idx = 0;
  const delayMs = PERF.SEMRUSH_CAMPAIGN_START_DELAY_MS;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      if (i > 0) await new Promise(r => setTimeout(r, delayMs));
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (e: any) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

function filterCampaignsByQuery(campaigns: SemrushCampaign[], query: string): SemrushCampaign[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return campaigns;
  return campaigns.filter(c => {
    const haystack = [
      c.businessName,
      (c as any).campaignName,
      c.address,
      c.location,
      (c as any).name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return tokens.every(t => haystack.includes(t));
  });
}

export async function listCampaigns(query?: string): Promise<SemrushCampaign[]> {
  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  const effectiveQuery = trimmedQuery.length > 0 ? trimmedQuery : undefined;

  if (!effectiveQuery && cachedCampaignList && cachedCampaignList.campaigns.length > 0) {
    const cacheAge = Date.now() - cachedCampaignList.timestamp;
    if (cacheAge > CAMPAIGN_LIST_CACHE_TTL_MS * 2) {
      // Task #978 Phase 2: was inline `refreshCampaignCache()` on the
      // API request path — that's exactly how the API pool got pinned
      // to 100% during stale-cache windows. Now we just enqueue and
      // serve stale data immediately. Idempotent dedupe prevents
      // multiple concurrent stale-cache requests from stacking jobs.
      console.log(`[Semrush] Cache stale (${(cacheAge / 60000).toFixed(0)}min), enqueueing background refresh`);
      void enqueueBackgroundRefresh("stale_cache_request");
    }
    return cachedCampaignList.campaigns.map(c => ({ ...c }));
  }

  // Task #1960: when a query is provided, prefer filtering the warm cache
  // (the SEMrush /campaigns `search` param has been observed to be ignored,
  // returning the unfiltered list). Falling through to a live fetch would
  // also work, but the cache is more reliable and avoids API pressure.
  if (effectiveQuery && cachedCampaignList && cachedCampaignList.campaigns.length > 0) {
    const cacheAge = Date.now() - cachedCampaignList.timestamp;
    if (cacheAge > CAMPAIGN_LIST_CACHE_TTL_MS * 2) {
      console.log(`[Semrush] Cache stale (${(cacheAge / 60000).toFixed(0)}min), enqueueing background refresh`);
      void enqueueBackgroundRefresh("stale_cache_request");
    }
    return filterCampaignsByQuery(
      cachedCampaignList.campaigns.map(c => ({ ...c })),
      effectiveQuery,
    );
  }

  const mapped = await fetchAndMapCampaigns(effectiveQuery);

  applyCachedEnrichment(mapped);

  if (!effectiveQuery) {
    cachedCampaignList = { campaigns: mapped, timestamp: Date.now() };

    if (!enrichedCacheReady) {
      enrichmentStartedAt = Date.now();
      void enqueueBackgroundRefresh("initial_enrichment");
    }

    ensureBackgroundRefreshRunning();

    return mapped;
  }

  // Task #1960: defensive client-side filter in case SEMrush returned the
  // unfiltered list despite the `search` param.
  return filterCampaignsByQuery(mapped, effectiveQuery);
}

/**
 * Task #978 Phase 3: lightweight startup readiness check. Replaces the
 * previous inline enrichment pass that held the API pool for 1.5–3.2M ms
 * (1,300–2,015 checkouts) within a single 5-min window after every
 * restart. Now we only:
 *   1. Probe connection state (cheap DB read).
 *   2. Enqueue a single semrush_background_refresh job (idempotent).
 *   3. Start the periodic enqueue scheduler.
 * The actual refresh runs through the worker pool via the
 * semrush_background_refresh handler, which respects kill-switches and
 * pool-pressure backoff. The first request that needs campaign data
 * after startup gets stale-or-empty cache served immediately while the
 * job runs — same pattern that already applied to mid-day cache refreshes.
 */
export async function startupEnrichment(): Promise<void> {
  try {
    const status = await withDbHoldLabel(
      "startup:semrush-enrichment-init:probe",
      () => getConnectionStatus(),
    );
    if (!status.connected) {
      console.log("[Semrush] Startup readiness skipped — not connected");
      return;
    }
    const cacheState = getCacheWarmStatus();
    console.log(
      `[Semrush] Startup readiness: cache=${cacheState.state} (campaigns=${cacheState.campaignCount}, ageMs=${cacheState.ageMs ?? "n/a"})`,
    );
    const jobId = await enqueueBackgroundRefresh("startup");
    if (jobId) {
      console.log(`[Semrush] Startup: enqueued background refresh job ${jobId}`);
    } else {
      console.log(
        `[Semrush] Startup: refresh enqueue skipped (kill switch or duplicate)`,
      );
    }
    ensureBackgroundRefreshRunning();
  } catch (err: any) {
    console.warn(`[Semrush] Startup readiness check failed: ${err?.message}`);
  }
}

/**
 * Task #978 Phase 3 (3.4): expose cache warm state for health/debug
 * endpoints. Lets operators see whether SEMrush is fresh / stale / cold
 * without having to grep logs after a restart.
 */
export function getCacheWarmStatus(): {
  state: "fresh" | "stale_usable" | "missing";
  campaignCount: number;
  ageMs: number | null;
  enrichedReady: boolean;
} {
  if (!cachedCampaignList || cachedCampaignList.campaigns.length === 0) {
    return { state: "missing", campaignCount: 0, ageMs: null, enrichedReady: false };
  }
  const ageMs = Date.now() - cachedCampaignList.timestamp;
  const state = ageMs <= CAMPAIGN_LIST_CACHE_TTL_MS ? "fresh" : "stale_usable";
  return {
    state,
    campaignCount: cachedCampaignList.campaigns.length,
    ageMs,
    enrichedReady: enrichedCacheReady,
  };
}

async function fetchAndMapCampaigns(query?: string): Promise<SemrushCampaign[]> {
  const MAX_PAGES = 20;
  const allCampaigns: any[] = [];
  const seenIds = new Set<string>();

  let cachedTotalElements: number | undefined;
  let pageSize: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // Task #2185: request newest-first ordering. The SEMrush Map Rank
    // Tracker API v0 GET /campaigns endpoint documents `sort` with fields
    // `createdAt | businessName` and directions `ASC | DESC`
    // (https://developer.semrush.com/api/v4/map-rank-tracker-2/). Sorting by
    // `createdAt,DESC` guarantees brand-new campaigns land on the first
    // page(s), so they can never be dropped by the 20-page fetch cap even on
    // a large tenant. If the account ignores `sort` (as it does `search`,
    // see Task #1960) this is a harmless no-op.
    const params: Record<string, string> = { page: String(page), sort: "createdAt,DESC" };
    if (query) params.search = query;

    const result = await apiGet("/campaigns", params);

    let items = result?.data?.content || result?.content || result?.data?.campaigns || result?.data || result || [];
    if (!Array.isArray(items)) {
      if (page === 0) {
        if (Array.isArray(result?.data?.content)) { items = result.data.content; }
        else if (Array.isArray(result?.content)) { items = result.content; }
        else {
          console.warn("[Semrush] listCampaigns returned unexpected format on page 0");
          break;
        }
      } else {
        console.warn(`[Semrush] listCampaigns returned non-array on page ${page}, stopping`);
        break;
      }
    }

    if (items.length === 0) break;

    if (page === 0) pageSize = items.length;

    let duplicatesOnPage = 0;
    for (const c of items) {
      const cid = String(c.id || c.campaignId || "");
      if (cid && seenIds.has(cid)) { duplicatesOnPage++; continue; }
      if (cid) seenIds.add(cid);
      allCampaigns.push(c);
    }

    if (duplicatesOnPage > 0 && duplicatesOnPage === items.length) {
      console.warn(`[Semrush] Page ${page} returned only duplicates, stopping`);
      break;
    }

    const totalElements = result?.data?.page?.total_elements ?? result?.data?.totalElements ?? result?.totalElements ?? result?.data?.total ?? result?.total;
    const totalPages = result?.data?.page?.total_pages ?? result?.data?.totalPages ?? result?.totalPages;
    if (typeof totalElements === "number") cachedTotalElements = totalElements;
    if (typeof totalElements === "number" && allCampaigns.length >= totalElements) break;
    if (typeof totalPages === "number" && page >= totalPages - 1) break;

    if (pageSize && items.length < pageSize) break;
  }

  const finalTotalElements = cachedTotalElements;
  console.log(`[Semrush] Fetched ${allCampaigns.length} campaigns (deduped)${query ? ` (query="${query}")` : ""}${typeof finalTotalElements === "number" ? ` (API total_elements: ${finalTotalElements})` : ""}`);

  return allCampaigns.map((c: any) => {
    const grid = c.gridSettings || c.grid_settings || c.grid;
    const address = c.address || c.businessAddress || c.business_address || undefined;
    const basePoint = grid?.basePoint || grid?.base_point || grid?.centerPoint || grid?.center_point;
    const location = c.locationName || c.location_name || c.location || c.city
      || c.region || grid?.locationName || grid?.location_name || grid?.location
      || grid?.city || grid?.name
      || undefined;
    const rawName = c.name || c.title || "";
    const bizName = c.business?.name || c.businessName || c.business_name || "";
    const displayName = bizName || rawName || `Campaign ${c.id || ""}`;
    return {
      id: String(c.id || c.campaignId || ""),
      businessName: displayName,
      campaignName: rawName !== displayName ? rawName : undefined,
      address: address || c.business?.address || undefined,
      location: typeof location === "string" ? location : undefined,
      gridSettings: grid || undefined,
      keywords: c.keywords || undefined,
      schedule: c.schedule || undefined,
      createdAt: c.createdAt || c.created_at || undefined,
    };
  });
}

function applyCachedEnrichment(mapped: SemrushCampaign[]): void {
  for (const c of mapped) {
    if (!c.keywords) {
      // Task #1973: only apply cached keywords when the last fetch was
      // complete. An incomplete cache entry is treated as stale — leaving
      // c.keywords undefined lets enrichCampaigns refetch it instead of
      // serving the partial list as if it were canonical.
      const meta = getCachedKeywordInventoryMeta(c.id);
      if (meta?.complete) {
        const cached = getCachedKeywords(c.id);
        if (cached && cached.length > 0) {
          c.keywords = cached;
        }
      }
    }
    if (!c.location && !c.address && campaignLocationCache.has(c.id)) {
      const entry = campaignLocationCache.get(c.id);
      if (entry && (Date.now() - entry.timestamp) < KEYWORD_CACHE_TTL_MS && entry.location) {
        c.location = entry.location;
      }
    }
  }
}

async function refreshCampaignCache(): Promise<void> {
  if (backgroundRefreshRunning) return;
  backgroundRefreshRunning = true;
  try {
    // Task #978 Phase 2 (Ticket 4): break the refresh into named
    // sub-attribution stages so the pool dashboard can pinpoint which
    // step is the actual DB-hold offender (vs the previous single
    // `scheduler:semrush-background-refresh` blob that hid 11.5M ms
    // of mixed work under one label).
    const status = await withDbHoldLabel(
      "worker:semrush_background_refresh:probe",
      () => getConnectionStatus(),
    );
    if (!status.connected) {
      console.log("[Semrush] Background refresh skipped — not connected");
      return;
    }

    console.log("[Semrush] Background refresh: fetching campaigns and enriching...");
    if (!enrichmentStartedAt) enrichmentStartedAt = Date.now();
    // External HTTP fan-out — should not hold a DB connection. The label
    // applies only to incidental DB checkouts (config reads, breaker
    // state lookups) that happen during the call.
    const mapped = await withDbHoldLabel(
      "worker:semrush_background_refresh:fetch_campaigns",
      () => fetchAndMapCampaigns(),
    );
    await withDbHoldLabel(
      "worker:semrush_background_refresh:enrich_campaigns",
      () => enrichCampaigns(mapped),
    );
    applyCachedEnrichment(mapped);

    cachedCampaignList = { campaigns: mapped, timestamp: Date.now() };
    const withKeywords = mapped.filter(c => c.keywords && c.keywords.length > 0).length;
    const withLocation = mapped.filter(c => c.location || c.address).length;
    const enrichedCount = mapped.filter(c =>
      (c.keywords && c.keywords.length > 0) || (c.location || c.address)
    ).length;
    const ratio = mapped.length > 0 ? enrichedCount / mapped.length : 0;
    if (ratio >= ENRICHMENT_READY_THRESHOLD) {
      enrichedCacheReady = true;
    }
    console.log(`[Semrush] Background refresh complete: ${mapped.length} campaigns cached (${withKeywords} with keywords, ${withLocation} with location), enriched=${enrichedCount}/${mapped.length}, enrichedCacheReady=${enrichedCacheReady}`);
  } catch (err: any) {
    // Task #978: rethrow so the work-queue handler sees the failure and
    // can apply its retry/backoff policy. Previously errors were
    // swallowed here, which (a) hid systemic problems behind a stale
    // cache and (b) made `maxAttempts` on the queue job effectively a
    // no-op. The legacy callers (listCampaigns, retry timer) wrap their
    // call in `.catch()` so they remain unaffected.
    console.warn(`[Semrush] Background refresh failed: ${err?.message}`);
    throw err;
  } finally {
    backgroundRefreshRunning = false;
  }
}

// Task #2185: user-triggerable, cache-bypassing campaign refresh.
//
// Brand-new SEMrush campaigns (created after the last background cache cycle)
// are invisible to the picker / auto-match until the hourly background refresh
// runs — which can be stalled or skipped by the demand-driven cadence gate.
// `clearCampaignCache()` alone is not enough: it only nulls the in-memory
// list and relies on a *later* read to re-fetch + enrich. This forces both the
// re-page of the SEMrush `/campaigns` listing AND inline enrichment of the
// newly-discovered campaigns synchronously, so the fresh list is in cache
// before the picker or auto-match reads it.
//
// Runs in the request (api-pool) context. `fetchAndMapCampaigns` is pure HTTP;
// `enrichCampaigns` wraps its own DB writes in `runWithWorkerDb`, so calling it
// here does not violate DB pool tenancy.
interface ForceRefreshCampaignsDeps {
  getConnectionStatus: typeof getConnectionStatus;
  fetchAndMapCampaigns: typeof fetchAndMapCampaigns;
  enrichCampaigns: typeof enrichCampaigns;
}
let __forceRefreshCampaignsDepsOverride: Partial<ForceRefreshCampaignsDeps> | null = null;

/**
 * Test-only: override forceRefreshCampaigns' external dependencies
 * (connection probe, HTTP fetch/map, enrichment) so the orchestration —
 * the connection gate, cache bypass, and the `enrichedCacheReady` flip that
 * lets auto-match skip its enrichment wait — can be exercised deterministically
 * without standing up SEMrush OAuth or the network.
 */
export function __setForceRefreshCampaignsDepsForTest(
  o: Partial<ForceRefreshCampaignsDeps> | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setForceRefreshCampaignsDepsForTest is test-only");
  }
  __forceRefreshCampaignsDepsOverride = o;
}

export async function forceRefreshCampaigns(): Promise<{
  campaigns: SemrushCampaign[];
  count: number;
  enrichmentComplete: boolean;
}> {
  const deps = __forceRefreshCampaignsDepsOverride;
  // Explicit connection check — fail loudly rather than serving a stale list.
  const status = await (deps?.getConnectionStatus ?? getConnectionStatus)();
  if (!status.connected) {
    throw new Error("SEMrush not connected — please authorize via Integrations Hub");
  }

  // Bypass the cache: drop the (possibly frozen) list so we genuinely re-page
  // SEMrush and discover campaigns created since the last cache cycle.
  clearCampaignCache();
  enrichmentStartedAt = Date.now();

  const mapped = await (deps?.fetchAndMapCampaigns ?? fetchAndMapCampaigns)();
  applyCachedEnrichment(mapped);
  try {
    await (deps?.enrichCampaigns ?? enrichCampaigns)(mapped);
  } catch (err: any) {
    // Enrichment is best-effort — a partial pass must not block the freshly
    // fetched list (which already contains the new campaigns) from reaching
    // the picker / auto-match.
    console.warn(`[Semrush] Force-refresh enrichment partial: ${err?.message ?? err}`);
  }
  applyCachedEnrichment(mapped);

  cachedCampaignList = { campaigns: mapped, timestamp: Date.now() };
  // Mark ready so the auto-match enrichment gate doesn't re-wait against a
  // list we just refreshed synchronously.
  enrichedCacheReady = true;

  const enrichedCount = mapped.filter(c =>
    (c.keywords && c.keywords.length > 0) || (c.location || c.address)
  ).length;
  console.log(`[Semrush] Force refresh complete: ${mapped.length} campaigns re-fetched (${enrichedCount} enriched)`);

  return {
    campaigns: mapped.map(c => ({ ...c })),
    count: mapped.length,
    enrichmentComplete: true,
  };
}

// Task #978 Phase 2: enqueue (rather than execute) the background
// campaign-cache refresh so the work runs through the controlled work
// scheduler. Idempotency is per refresh-window bucket so repeated ticks
// (or simultaneous startup/listCampaigns triggers) collapse to a single
// row in the queue.
export async function enqueueBackgroundRefresh(reason: string): Promise<string | null> {
  try {
    const { enqueueJob } = await import("./workScheduler");
    const { isKillSwitchEnabled } = await import("./killSwitches");
    if (isKillSwitchEnabled("semrush_background_refresh")) {
      return null;
    }
    // Task #1784: queue-drain pause must short-circuit at the enqueue
    // site, not only at claim. The hourly setInterval keeps firing
    // regardless of pause state; without this guard the pending pile
    // grows for the entire pause window even though no worker will
    // ever claim the rows.
    const { isQueuePaused } = await import("./queueDrainControl");
    if (isQueuePaused("semrush_background_refresh")) {
      try {
        const { workerLog } = await import("./workerLogger");
        workerLog({
          worker: "semrush_background_refresh",
          event: "semrush_refresh_enqueue_skipped_queue_paused",
          workloadClass: "ingestion",
          reason,
        });
      } catch {}
      return null;
    }
    // Task #1785: demand-driven gate. The campaign-list cache is a
    // tenant-wide cache (no per-client identity at this layer) so we
    // gate on the master switch + staleness only. When the demand-
    // driven switch is OFF we still allow the legacy "refresh-on-timer"
    // path through, matching the kill-switch fallback semantics.
    try {
      const { evaluateRefreshGate } = await import("./semrushCadenceGate");
      const lastRefreshedAt = cachedCampaignList ? new Date(cachedCampaignList.timestamp) : null;
      const decision = await evaluateRefreshGate({
        queueName: "semrush_background_refresh",
        lastRefreshedAt,
        // Task #1785 review-remediation: tenant-wide caller. The gate
        // resolves the active check via `anyClientActiveInWindow` so
        // a tenant with zero recently-viewed clients skips the
        // campaign-list refresh instead of silently bypassing.
        tenantWide: true,
      });
      if (!decision.allow) {
        try {
          const { workerLog } = await import("./workerLogger");
          workerLog({
            worker: "semrush_background_refresh",
            event: "semrush_refresh_enqueue_skipped_demand_gate",
            workloadClass: "ingestion",
            reason,
            decisionReason: decision.reason,
          });
        } catch {}
        return null;
      }
    } catch (gateErr: any) {
      console.warn(`[Semrush] cadence gate evaluation failed (allowing through): ${gateErr?.message}`);
    }
    const intervalMs = getBackgroundRefreshIntervalMs();
    const bucket = Math.floor(Date.now() / intervalMs);
    const dedupeKey = `semrush_background_refresh:campaigns:${bucket}`;
    const id = await enqueueJob({
      queueName: "semrush_background_refresh",
      workloadClass: "ingestion",
      priority: 50,
      payload: { reason, bucket },
      dedupeKey,
      maxAttempts: 3,
    });
    return id;
  } catch (err: any) {
    console.warn(`[Semrush] enqueueBackgroundRefresh failed: ${err?.message}`);
    return null;
  }
}

// Task #978 Phase 2: exported for the work-queue handler. Wraps the
// existing in-memory refresh body. Wrapped in `withDbAttribution` so
// the worker-side label is visible even when called outside the
// scheduler (e.g. tests). The `processJob` wrapper already adds
// `worker:semrush_background_refresh`; this is a no-op refinement.
export async function runBackgroundRefreshJob(opts: { jobId?: string } = {}): Promise<void> {
  await withDbAttribution("worker:semrush_background_refresh:run", () =>
    refreshCampaignCache().catch((err: any) => {
      console.warn(
        `[Semrush] Background refresh job ${opts.jobId ?? ""} failed: ${err?.message}`,
      );
      throw err;
    }),
  );
}

// Task #1785: re-read the interval on every tick so a settings flip
// changes the scheduler cadence without a restart. We implement this
// as a self-rescheduling setTimeout (rather than a single setInterval
// set at startup) so the period genuinely tracks the live setting.
let backgroundRefreshLastIntervalMs: number | null = null;
async function scheduleNextBackgroundRefreshTick(): Promise<void> {
  // Task #1785: await live cadence settings before each tick so a
  // system_setting change deterministically takes effect on the next
  // tick (rather than one tick late through the perfConfig cache).
  try {
    const { getCadenceSettings } = await import("./semrushCadenceGate");
    const s = await getCadenceSettings();
    backgroundRefreshLastIntervalMs = s.intervalMs;
  } catch {
    backgroundRefreshLastIntervalMs = getBackgroundRefreshIntervalMs();
  }
  backgroundRefreshTimer = setTimeout(() => {
    void enqueueBackgroundRefresh("scheduled_tick");
    void scheduleNextBackgroundRefreshTick();
  }, backgroundRefreshLastIntervalMs ?? getBackgroundRefreshIntervalMs());
  if ((backgroundRefreshTimer as any).unref) (backgroundRefreshTimer as any).unref();
}

function ensureBackgroundRefreshRunning(): void {
  if (backgroundRefreshTimer) return;
  void scheduleNextBackgroundRefreshTick();
  console.log(
    `[Semrush] Background refresh enqueue scheduler started (cadence re-read live each tick) — work runs in worker pool via semrush_background_refresh queue`,
  );
}

async function enrichCampaigns(mapped: SemrushCampaign[]): Promise<void> {
  const concurrency = PERF.SEMRUSH_ENRICHMENT_CONCURRENCY;
  const campaignDelay = PERF.SEMRUSH_CAMPAIGN_START_DELAY_MS;

  // Task #953: skip the entire enrichment pass unless the breaker is
  // fully `closed`. Enrichment is a multi-campaign fan-out
  // (`runWithConcurrency` over every campaign needing keywords +
  // location + reverse-geocode) — admitting it during `half_open`
  // would consume a single probe budget but then issue dozens of
  // upstream calls, defeating the bounded-probe guarantee. The
  // single-call `listCampaigns` performed earlier in
  // `refreshCampaignCache` is the actual upstream probe; once its
  // outcome closes (or re-opens) the breaker, the next scheduled
  // refresh will run enrichment in `closed` state.
  const breakerMod = await import("./semrushCircuitBreaker");
  const breakerStateAtStart = breakerMod.getBreakerStatus().state;
  if (breakerStateAtStart !== "closed") {
    console.log(
      `[Semrush] Enrichment deferred — upstream collapse (state=${breakerStateAtStart})`,
    );
    return;
  }

  // Pool Epic Phase 1.2: read-through persistent enrichment cache.
  // Gated by `semrush_persistent_enrichment_cache_enabled` (default
  // OFF). When on, we batch-hydrate the in-memory `campaignKeywordsCache`
  // from the durable `semrush_enrichment_cache` table BEFORE deciding
  // which campaigns still need an HTTP fetch. Failures (table missing,
  // worker DB unavailable) degrade silently — the legacy HTTP path
  // still runs.
  let persistentCacheEnabled = false;
  try {
    const { isPoolEpicSwitchEnabled, ensurePoolEpicSwitchesLoaded } =
      await import("./poolEpicKillSwitches");
    await ensurePoolEpicSwitchesLoaded();
    persistentCacheEnabled = isPoolEpicSwitchEnabled(
      "semrush_persistent_enrichment_cache_enabled",
    );
  } catch (err: any) {
    console.warn(
      `[Semrush] Persistent cache switch read failed (degrading to legacy path): ${err?.message ?? err}`,
    );
  }

  if (persistentCacheEnabled) {
    const candidates = mapped.filter(
      (c) => !c.keywords && c.id && !getCachedKeywords(c.id),
    );
    if (candidates.length > 0) {
      try {
        const [{ runWithWorkerDb }, { getSemrushEnrichmentCacheByIds }] =
          await Promise.all([
            import("../db"),
            import("../storage/semrushEnrichmentCacheStorage"),
          ]);
        const hits = await runWithWorkerDb(() =>
          getSemrushEnrichmentCacheByIds(
            candidates.map((c) => c.id),
            KEYWORD_CACHE_TTL_MS,
          ),
        );
        let hydrated = 0;
        for (const c of candidates) {
          const row = hits.get(c.id);
          if (!row) continue;
          const keywords = Array.isArray(row.keywordsJson)
            ? (row.keywordsJson as SemrushKeyword[])
            : [];
          // Task #1973: tag the in-memory entry with the persistent
          // row's completion flag. Older rows (pre-migration 0081)
          // default to `complete=true`, matching the legacy assumption.
          const rowComplete = (row as any).complete !== false;
          const rowIncompleteReason = (row as any).incompleteReason
            ? ((row as any).incompleteReason as SemrushKeywordInventoryIncompleteReason)
            : undefined;
          campaignKeywordsCache.set(c.id, {
            keywords,
            timestamp: row.lastRefreshedAt.getTime(),
            complete: rowComplete,
            ...(rowIncompleteReason ? { incompleteReason: rowIncompleteReason } : {}),
          });
          // Only project an incomplete inventory onto the campaign when
          // we have nothing better; this matches applyCachedEnrichment's
          // policy of treating incomplete as stale.
          if (keywords.length > 0 && rowComplete) c.keywords = keywords;
          if (!c.location && row.location) c.location = row.location;
          if (!c.address && row.address) c.address = row.address;
          hydrated++;
        }
        if (hydrated > 0) {
          console.log(
            `[Semrush] Persistent cache hydrated ${hydrated}/${candidates.length} campaigns (Phase 1.2)`,
          );
        }
      } catch (err: any) {
        console.warn(
          `[Semrush] Persistent enrichment cache read failed (degrading to legacy path): ${err?.message ?? err}`,
        );
      }
    }
  }

  const campaignsNeedingEnrichment = mapped.filter(
    (c) => !c.keywords && c.id && !getCachedKeywords(c.id)
  );

  if (campaignsNeedingEnrichment.length > 0) {
    console.log(`[Semrush] Enriching ${campaignsNeedingEnrichment.length} campaigns with keywords (concurrency=${concurrency}, timeout=${ENRICHMENT_TIMEOUT_MS}ms, delay=${campaignDelay}ms)`);
    // Task #1973: use the meta-bearing fetch so the in-memory + persistent
    // caches are tagged with completeness; downstream consumers treat
    // incomplete entries as stale regardless of timestamp.
    const keywordResults = await runWithConcurrency(
      campaignsNeedingEnrichment.map((c) => () => withTimeout(getCampaignKeywordsWithMeta(c.id), ENRICHMENT_TIMEOUT_MS)),
      concurrency
    );

    let enriched = 0, failed = 0, deferred429 = 0, incomplete = 0;
    const failedSamples: string[] = [];
    for (let i = 0; i < campaignsNeedingEnrichment.length; i++) {
      const result = keywordResults[i];
      if (result.status === "fulfilled") {
        enriched++;
        const meta = result.value;
        const keywords = meta.keywords;
        if (!meta.complete) incomplete++;
        // Only project keywords onto the campaign when the fetch
        // was complete — otherwise the list misrepresents the inventory
        // and the heatmap-tile picker would surface "missing keyword"
        // failures for entries that were just dropped by pagination.
        if (keywords.length > 0 && meta.complete) {
          campaignsNeedingEnrichment[i].keywords = keywords;
        }
        campaignKeywordsCache.set(campaignsNeedingEnrichment[i].id, {
          keywords,
          timestamp: Date.now(),
          complete: meta.complete,
          ...(meta.incompleteReason ? { incompleteReason: meta.incompleteReason } : {}),
        });
        // Pool Epic Phase 1.2: write-through to the durable cache.
        // Fire-and-forget on the worker pool, gated on the same kill
        // switch as the read-through. Failures are logged and never
        // block the request path.
        if (persistentCacheEnabled) {
          const c = campaignsNeedingEnrichment[i];
          void (async () => {
            try {
              const [{ runWithWorkerDb }, { upsertSemrushEnrichmentCache }] =
                await Promise.all([
                  import("../db"),
                  import("../storage/semrushEnrichmentCacheStorage"),
                ]);
              await runWithWorkerDb(() =>
                upsertSemrushEnrichmentCache({
                  campaignId: c.id,
                  businessName: c.businessName ?? null,
                  location: c.location ?? null,
                  address: c.address ?? null,
                  keywordsJson: keywords as any,
                  keywordCount: keywords.length,
                  payloadHash: null,
                  source: "background_refresh",
                  notes: null,
                  complete: meta.complete,
                  incompleteReason: meta.incompleteReason ?? null,
                }),
              );
            } catch (err: any) {
              console.warn(
                `[Semrush] Persistent enrichment cache write failed campaign=${c.id}: ${err?.message ?? err}`,
              );
            }
          })();
        }
      } else if (result.status === "rejected") {
        if (result.reason?.name === "SemrushRateLimitError") {
          deferred429++;
        } else {
          failed++;
          if (failedSamples.length < PERF.LOG_SAMPLE_LIMIT) {
            failedSamples.push(`${campaignsNeedingEnrichment[i].id}: ${result.reason?.message || result.reason}`);
          }
        }
      }
    }
    console.log(`[Semrush] Keyword enrichment: attempted=${campaignsNeedingEnrichment.length}, succeeded=${enriched}, incomplete=${incomplete}, failed=${failed}, deferred_429=${deferred429}${deferred429 > 0 ? " (rate-limited, will retry next cycle)" : ""}`);
    if (failedSamples.length > 0) {
      console.warn(`[Semrush] Keyword failures (sample): ${failedSamples.join("; ")}`);
    }

    const failureRate = (failed + deferred429) / campaignsNeedingEnrichment.length;
    // Task #953: only schedule the eager retry when the breaker is still
    // closed. Once the breaker has tripped, the circuit-breaker cooldown
    // governs recovery — scheduling another full enrichment pass two
    // minutes later was the second-order amplifier behind the continuous
    // pressure pattern.
    const breakerStatus = breakerMod.getBreakerStatus();
    if (failureRate > 0.5 && !enrichmentRetryTimer && breakerStatus.state === "closed" && breakerStateAtStart === "closed") {
      console.log(`[Semrush] High failure rate (${Math.round(failureRate * 100)}%), scheduling retry in ${ENRICHMENT_RETRY_INTERVAL_MS / 1000}s`);
      enrichmentRetryTimer = setTimeout(() => {
        enrichmentRetryTimer = null;
        // Task #978 Phase 2: route the eager retry through the queue so
        // it inherits kill-switch + pool-pressure backoff + dedupe
        // (rather than firing a second uncontrolled inline pass that
        // bypasses every safety the new queue gives us).
        void enqueueBackgroundRefresh("enrichment_retry");
      }, ENRICHMENT_RETRY_INTERVAL_MS);
    } else if (failureRate > 0.5 && breakerStatus.state !== "closed") {
      console.log(
        `[Semrush] High failure rate (${Math.round(failureRate * 100)}%) — eager retry suppressed (breaker state=${breakerStatus.state})`,
      );
    }
  }

  const campaignsNeedingLocation = mapped.filter(
    (c) => !c.location && !c.address && c.id
  );
  const campaignsWithCachedLocation = campaignsNeedingLocation.filter(
    (c) => campaignLocationCache.has(c.id) && (Date.now() - (campaignLocationCache.get(c.id)?.timestamp || 0)) < KEYWORD_CACHE_TTL_MS
  );
  const campaignsToFetchLocation = campaignsNeedingLocation.filter(
    (c) => !campaignLocationCache.has(c.id) || (Date.now() - (campaignLocationCache.get(c.id)?.timestamp || 0)) >= KEYWORD_CACHE_TTL_MS
  );

  for (const c of campaignsWithCachedLocation) {
    const cached = campaignLocationCache.get(c.id);
    if (cached?.location) c.location = cached.location;
  }

  if (campaignsToFetchLocation.length > 0) {
    console.log(`[Semrush] Enriching ${campaignsToFetchLocation.length} campaigns with location (concurrency=${concurrency}, timeout=${ENRICHMENT_TIMEOUT_MS}ms)`);
    const detailResults = await runWithConcurrency(
      campaignsToFetchLocation.map((c) => () => withTimeout(getCampaign(c.id), ENRICHMENT_TIMEOUT_MS)),
      concurrency
    );

    for (let i = 0; i < campaignsToFetchLocation.length; i++) {
      const r = detailResults[i];
      if (r.status === "fulfilled") {
        const d = r.value;
        if (i === 0) {
          const detailLocFields = Object.keys(d).filter(k =>
            /loc|city|region|state|addr|area|geo|place|grid/i.test(k)
          );
          console.log(`[Semrush] Campaign detail keys: ${Object.keys(d).join(", ")}`);
          if (detailLocFields.length > 0) {
            console.log(`[Semrush] Detail location fields: ${detailLocFields.map(k => `${k}=${JSON.stringify(d[k])}`).join(", ")}`);
          }
        }
        const detailGrid = d.gridSettings || d.grid_settings || d.grid;
        const detailBasePoint = detailGrid?.basePoint || detailGrid?.base_point || detailGrid?.centerPoint || detailGrid?.center_point;
        const loc = d.locationName || d.location_name || d.location || d.city
          || d.region || d.address || d.businessAddress || d.business_address
          || detailGrid?.locationName || detailGrid?.location
          || detailGrid?.city || detailGrid?.name
          || null;
        const locStr = typeof loc === "string" ? loc : null;
        campaignsToFetchLocation[i].location = locStr || undefined;
        campaignLocationCache.set(campaignsToFetchLocation[i].id, {
          location: locStr,
          timestamp: Date.now(),
        });
      }
    }
  }

  const { reverseGeocode } = await import("../mcu/geocoding");
  const coordPattern = /^-?\d+\.\d+,\s*-?\d+\.\d+$/;
  const campaignsNeedingReverseGeocode = mapped.filter(c => {
    if (c.location && !coordPattern.test(c.location)) return false;
    if (c.address && !coordPattern.test(c.address)) return false;
    const bp = getGridBasePoint(c.gridSettings);
    return bp?.lat != null && bp?.lng != null;
  });

  if (campaignsNeedingReverseGeocode.length > 0) {
    console.log(`[Semrush] Reverse-geocoding ${campaignsNeedingReverseGeocode.length} campaigns (concurrency=${concurrency}, timeout=${ENRICHMENT_TIMEOUT_MS}ms)`);
    const geoResults = await runWithConcurrency(
      campaignsNeedingReverseGeocode.map(c => () => {
        const bp = getGridBasePoint(c.gridSettings)!;
        return withTimeout(reverseGeocode(Number(bp.lat), Number(bp.lng)), ENRICHMENT_TIMEOUT_MS);
      }),
      concurrency
    );
    for (let i = 0; i < campaignsNeedingReverseGeocode.length; i++) {
      const r = geoResults[i];
      if (r.status === "fulfilled" && r.value) {
        campaignsNeedingReverseGeocode[i].location = r.value;
        campaignLocationCache.set(campaignsNeedingReverseGeocode[i].id, {
          location: r.value,
          timestamp: Date.now(),
        });
      }
    }
  }
}

export async function getCampaign(campaignId: string, signal?: AbortSignal): Promise<any> {
  const result = await apiGet(`/campaigns/${campaignId}`, undefined, signal);
  const campaign = result?.data || result;
  if (campaign.reportDates && Array.isArray(campaign.reportDates)) {
    campaign.reportDates = campaign.reportDates.sort(
      (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime()
    );
  }
  return campaign;
}

export function findBestReportDate(reportDates: string[], reportMonth: string): string | null {
  if (!reportDates || reportDates.length === 0) return null;

  const [year, month] = reportMonth.split("-").map(Number);
  if (!year || !month) return null;

  const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);
  const startOfMonth = new Date(year, month - 1, 1, 0, 0, 0, 0);

  const candidates = reportDates
    .map((d) => ({ date: d, ts: new Date(d).getTime() }))
    .filter((d) => d.ts <= endOfMonth.getTime() && d.ts >= startOfMonth.getTime())
    .sort((a, b) => b.ts - a.ts);

  if (candidates.length > 0) return candidates[0].date;

  const beforeEnd = reportDates
    .map((d) => ({ date: d, ts: new Date(d).getTime() }))
    .filter((d) => d.ts <= endOfMonth.getTime())
    .sort((a, b) => b.ts - a.ts);

  if (beforeEnd.length > 0) return beforeEnd[0].date;

  return null;
}

export async function getCampaignKeywords(campaignId: string, signal?: AbortSignal): Promise<SemrushKeyword[]> {
  return (await getCampaignKeywordsWithMeta(campaignId, signal)).keywords;
}

/**
 * Same as getCampaignKeywords but also reports whether the keyword list was
 * fetched in full. `complete=false` means pagination was cut short (abort,
 * page-cap, or unknown-total heuristic exit) and callers must NOT use the
 * returned list as a canonical "all known keywords" set — e.g. for
 * stale-keyword pruning. `complete=true` means we either reached
 * total_elements, hit a short final page after at least one full page, or got
 * an empty/short first page that we can be confident represents the full set.
 */
export type SemrushKeywordInventoryIncompleteReason =
  | "page_cap_reached"
  | "aborted"
  | "non_array_payload"
  // Task #1973: SEMrush returned the same first-id on page N as on page
  // N-1, which means the `page` query param was ignored upstream. Bail
  // immediately rather than walking the whole cap on a duplicate payload.
  | "page_param_ignored";

const DEFAULT_KEYWORD_INVENTORY_MAX_PAGES = 20;
const KEYWORD_INVENTORY_MAX_PAGES_SETTING = "semrush_keyword_inventory_max_pages";

/**
 * Task #1877: Read the tunable inventory page-cap from `system_settings`,
 * falling back to the historic default of 20. Caps at 200 pages to keep a
 * runaway / malformed value from looping forever.
 */
async function getKeywordInventoryMaxPages(): Promise<number> {
  try {
    const row = await storage.getSystemSetting(KEYWORD_INVENTORY_MAX_PAGES_SETTING);
    if (!row?.value) return DEFAULT_KEYWORD_INVENTORY_MAX_PAGES;
    const n = Number.parseInt(row.value, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_KEYWORD_INVENTORY_MAX_PAGES;
    return Math.min(200, n);
  } catch {
    return DEFAULT_KEYWORD_INVENTORY_MAX_PAGES;
  }
}

// Task #1973: SEMrush's page-size knob. The API documents a default
// of 100; sending it explicitly removes ambiguity for the few campaign
// shapes where omitting it returned a different page count than asking
// for it. Kept conservative to stay well under any single-request body
// cap.
const KEYWORD_INVENTORY_PAGE_SIZE = 100;

export interface SemrushKeywordInventoryResult {
  keywords: SemrushKeyword[];
  complete: boolean;
  incompleteReason?: SemrushKeywordInventoryIncompleteReason;
  pagesWalked: number;
  maxPages: number;
}

/**
 * Task #1973: pure paginator extracted from `getCampaignKeywordsWithMeta`
 * so the completion-detection contract can be unit-tested with a mocked
 * `apiGetFn` (no live SEMrush, no auth). The completion priority is:
 *   1. `total_elements` known AND we've collected at least that many.
 *   2. An explicit "no more pages" flag from the payload — any of
 *      `last`, `lastPage`, `hasMore===false`, `hasNext===false`,
 *      absent cursor where one was present on a prior page.
 *   3. Same first-id on page N as page N-1 → the `page` param is
 *      being ignored upstream; bail with `page_param_ignored` instead
 *      of burning the rest of the cap on duplicate payloads.
 *   4. Short final page (fewer items than the first page).
 *   5. Empty page.
 * Falls through to `page_cap_reached` only when none of the above fire.
 */
export async function paginateKeywordInventory(
  apiGetFn: (path: string, params?: Record<string, string>, signal?: AbortSignal) => Promise<any>,
  campaignId: string,
  maxPages: number,
  signal?: AbortSignal,
): Promise<SemrushKeywordInventoryResult> {
  const allKeywords: any[] = [];
  const seenIds = new Set<string>();
  let complete = false;
  let pagesWalked = 0;
  let incompleteReason: SemrushKeywordInventoryIncompleteReason | undefined;
  let previousFirstId: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) break;
    pagesWalked++;
    const result = await apiGetFn(
      `/campaigns/${campaignId}/keywords`,
      { page: String(page), size: String(KEYWORD_INVENTORY_PAGE_SIZE) },
      signal,
    );

    const data = result?.data ?? result;
    const keywords = data?.keywords || data?.content || (Array.isArray(data) ? data : []);
    if (!Array.isArray(keywords)) {
      console.warn(`[Semrush] getCampaignKeywords(${campaignId}): non-array keywords payload at page ${page} — marking incomplete`);
      incompleteReason = "non_array_payload";
      break;
    }
    if (keywords.length === 0) {
      // Empty page — list exhausted.
      complete = true;
      break;
    }

    // Task #1973: page-param-ignored detection. If the first id of this
    // page matches the first id of the previous page, SEMrush ignored
    // the `page` query parameter (observed in production for some
    // campaign shapes). Bail immediately — walking the rest of the cap
    // would just stack the same payload over and over.
    const firstIdRaw = keywords[0]?.keyword?.id ?? keywords[0]?.id;
    const firstId = firstIdRaw != null ? String(firstIdRaw) : null;
    if (page > 0 && firstId !== null && previousFirstId !== null && firstId === previousFirstId) {
      console.warn(`[Semrush] getCampaignKeywords(${campaignId}): page=${page} returned the same first id as page=${page - 1} — \`page\` query param appears to be ignored upstream, marking incomplete`);
      incompleteReason = "page_param_ignored";
      break;
    }
    previousFirstId = firstId;

    for (const kw of keywords) {
      const kid = String(kw.keyword?.id || kw.id || "");
      if (kid && seenIds.has(kid)) continue;
      if (kid) seenIds.add(kid);
      allKeywords.push(kw);
    }

    // (1) Authoritative total_elements.
    const totalElements = data?.page?.total_elements
      ?? data?.page?.totalElements
      ?? data?.totalElements
      ?? result?.totalElements;
    if (typeof totalElements === "number" && allKeywords.length >= totalElements) {
      complete = true;
      break;
    }

    // (2) Explicit "no more pages" flag — accept several shapes since
    // SEMrush wraps pagination metadata under either `data.page` or the
    // top level depending on the endpoint shape.
    const pageMeta = data?.page ?? {};
    const isLast = pageMeta.last === true
      || pageMeta.lastPage === true
      || pageMeta.hasNext === false
      || pageMeta.hasMore === false
      || data?.last === true
      || data?.hasMore === false
      || data?.hasNext === false;
    if (isLast) {
      complete = true;
      break;
    }
    const cursorShape = (pageMeta.nextCursor !== undefined)
      || (data?.nextCursor !== undefined)
      || (pageMeta.next !== undefined)
      || (data?.next !== undefined);
    if (cursorShape) {
      const nextCursor = pageMeta.nextCursor ?? data?.nextCursor ?? pageMeta.next ?? data?.next;
      if (nextCursor == null || nextCursor === "" || nextCursor === false) {
        complete = true;
        break;
      }
    }

    // (3) Short-final page (only safe AFTER first-id-equality has been
    // ruled out above). Compare against the REQUESTED size we sent
    // upstream (`size=KEYWORD_INVENTORY_PAGE_SIZE`), not against the
    // first page's actual length — otherwise a single-page payload of
    // 17 keywords on page 0 would never trigger this branch and force
    // an unnecessary page=1 call (which can itself produce a
    // `page_param_ignored` false-incomplete).
    if (keywords.length < KEYWORD_INVENTORY_PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (signal?.aborted) {
    complete = false;
    if (!incompleteReason) incompleteReason = "aborted";
  }
  if (pagesWalked >= maxPages && !complete && !incompleteReason) {
    console.warn(`[Semrush] getCampaignKeywords(${campaignId}): hit MAX_PAGES=${maxPages} without confirming completion (got ${allKeywords.length} keywords) — marked incomplete`);
    incompleteReason = "page_cap_reached";
  }

  return {
    keywords: allKeywords.map((kw: any) => ({
      id: kw.keyword?.id || kw.id,
      name: kw.keyword?.name || kw.name,
      status: kw.status || "UNKNOWN",
    })),
    complete,
    ...(incompleteReason ? { incompleteReason } : {}),
    pagesWalked,
    maxPages,
  };
}

export async function getCampaignKeywordsWithMeta(
  campaignId: string,
  signal?: AbortSignal
): Promise<SemrushKeywordInventoryResult> {
  const maxPages = await getKeywordInventoryMaxPages();
  const result = await paginateKeywordInventory(apiGet, campaignId, maxPages, signal);

  // Task #1973: emit a structured bailout event + bump the 24h counter
  // whenever the fetch ended without confirming completion. Operators see
  // this on the SEMrush Operations Console; an upward trend means either
  // a real inventory exceeding the cap OR SEMrush API contract drift.
  if (!result.complete && result.incompleteReason && result.incompleteReason !== "aborted") {
    recordKeywordInventoryBailout({
      campaignId,
      incompleteReason: result.incompleteReason,
      pagesWalked: result.pagesWalked,
      keywordCount: result.keywords.length,
    });
    try {
      const { workerLog } = await import("./workerLogger");
      workerLog({
        worker: "semrush_keyword_inventory",
        event: "no_op",
        bailoutEvent: "semrush_keyword_inventory_bailout",
        campaignId,
        incompleteReason: result.incompleteReason,
        pagesWalked: result.pagesWalked,
        maxPages: result.maxPages,
        keywordCount: result.keywords.length,
      });
    } catch {}
  }

  return result;
}

export async function getHeatmapData(
  campaignId: string,
  keywordId: string,
  options?: { cid?: string; placeIds?: string[]; reportDate?: string },
  signal?: AbortSignal
): Promise<{
  keyword: { id: string; name: string };
  date: string;
  positions: SemrushHeatmapPoint[];
}> {
  const params: Record<string, string> = { keywordId };
  if (options?.cid) params.cid = options.cid;
  if (options?.placeIds?.length) params.placeIds = options.placeIds.join(",");
  if (options?.reportDate) params.reportDate = options.reportDate;

  const result = await apiGet(`/campaigns/${campaignId}/heatmap`, params, signal);
  const data = result?.data || result;

  return {
    keyword: data.keyword || { id: keywordId, name: "" },
    date: data.date || new Date().toISOString(),
    positions: (data.positions || []).map((p: any) => ({
      point: {
        id: p.point?.id || `pt-${p.lat || p.point?.lat}-${p.lng || p.point?.lng}`,
        lat: p.point?.coordinates?.lat ?? p.point?.lat ?? p.lat,
        lng: p.point?.coordinates?.lng ?? p.point?.lng ?? p.lng,
      },
      rank: p.rank ?? p.position ?? null,
      diff: p.diff ?? null,
    })),
  };
}

export async function getCampaignMetrics(
  campaignId: string,
  keywordId: string,
  options?: { cid?: string; placeIds?: string[] },
  signal?: AbortSignal
): Promise<{
  shareOfVoice: number | null;
  averagePosition: number | null;
  timeSeries: Array<{ date: string; shareOfVoice: number; averagePosition: number }>;
}> {
  const params: Record<string, string> = { keywordId };
  if (options?.cid) params.cid = options.cid;
  if (options?.placeIds?.length) params.placeIds = options.placeIds.join(",");

  if (!options?.cid && !options?.placeIds?.length) {
    console.warn(`[Semrush] getCampaignMetrics called without cid or placeIds — API requires at least one`);
    return { shareOfVoice: null, averagePosition: null, timeSeries: [] };
  }

  const result = await apiGet(`/campaigns/${campaignId}/metrics`, params, signal);
  const data = result?.data || result;

  const timeSeries: Array<{ date: string; shareOfVoice: number; averagePosition: number }> = [];

  const sovMap = data.sharesOfVoice || data.shareOfVoice || {};
  const posMap = data.averagePositions || data.averagePosition || {};

  if (typeof sovMap === "object" && sovMap !== null && !Array.isArray(sovMap)) {
    const allDates = new Set([...Object.keys(sovMap), ...Object.keys(posMap)]);
    for (const dateKey of Array.from(allDates).sort()) {
      timeSeries.push({
        date: dateKey,
        shareOfVoice: typeof sovMap[dateKey] === "number" ? sovMap[dateKey] : 0,
        averagePosition: typeof posMap[dateKey] === "number" ? posMap[dateKey] : 0,
      });
    }
  } else if (Array.isArray(data.timeSeries || data.history || data.data)) {
    for (const entry of (data.timeSeries || data.history || data.data)) {
      timeSeries.push({
        date: entry.date || entry.reportDate || "",
        shareOfVoice: entry.shareOfVoice ?? entry.sov ?? 0,
        averagePosition: entry.averagePosition ?? entry.avgPosition ?? entry.avgRank ?? 0,
      });
    }
  }

  const latestSov = timeSeries.length > 0 ? timeSeries[timeSeries.length - 1].shareOfVoice : null;
  const latestPos = timeSeries.length > 0 ? timeSeries[timeSeries.length - 1].averagePosition : null;

  const shareOfVoice = (typeof sovMap === "number" ? sovMap : null) ?? latestSov;
  const averagePosition = (typeof posMap === "number" ? posMap : null) ?? latestPos;

  console.log(`[Semrush] getCampaignMetrics for campaign=${campaignId}, keyword=${keywordId}: sov=${shareOfVoice}, avgPos=${averagePosition}, timeSeriesLen=${timeSeries.length}`);

  return { shareOfVoice, averagePosition, timeSeries };
}

export async function getTopCompetitors(
  campaignId: string,
  keywordId: string,
  reportDate?: string,
  options?: { cid?: string; placeIds?: string[] },
  signal?: AbortSignal
): Promise<Array<{
  name: string;
  shareOfVoice: number;
  averageRank?: number;
  reviewCount?: number;
  reviewRating?: number;
  gbpUrl?: string;
  address?: string;
  isSubjectBusiness: boolean;
}>> {
  const params: Record<string, string> = { keywordId };
  if (reportDate) params.reportDate = reportDate;
  if (options?.cid) params.cid = options.cid;
  if (options?.placeIds?.length) params.placeIds = options.placeIds.join(",");
  let subjectBusiness: any = null;
  let subjectBusinessCid: string | undefined;
  let subjectBusinessPlaceIds: string[] | undefined;

  params.page = "0";
  params.sortField = "shareOfVoice";
  params.sortDirection = "DESC";
  const result = await apiGet(`/campaigns/${campaignId}/top-competitors`, params, signal);
  const data = result?.data || result;

  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (data.business && typeof data.business === "object") {
      subjectBusiness = data.business;
      const biz = subjectBusiness.business || subjectBusiness;
      subjectBusinessCid = biz?.cid;
      subjectBusinessPlaceIds = biz?.placeIds;
      console.log(`[Semrush] Subject business: name=${biz?.name}, cid=${subjectBusinessCid}, SoV=${subjectBusiness.shareOfVoice}`);
    }
  }

  let competitorsList: any[];
  if (Array.isArray(data)) {
    competitorsList = data;
  } else {
    const raw = data?.competitors || data?.items || data?.content || [];
    if (Array.isArray(raw)) {
      competitorsList = raw;
    } else if (raw && typeof raw === "object") {
      competitorsList = raw.content || raw.items || raw.competitors || [];
      if (!Array.isArray(competitorsList)) competitorsList = [];
    } else {
      competitorsList = [];
    }
  }

  if (competitorsList.length === 0) {
    console.warn(`[Semrush] getTopCompetitors returned empty for campaign=${campaignId}, keyword=${keywordId}, date=${reportDate}. Raw response keys: ${JSON.stringify(Object.keys(data || {}))}, isArray=${Array.isArray(data)}, type=${typeof data}, competitorsType=${typeof (data?.competitors)}`);
  }

  if (competitorsList.length > 0 && competitorsList[0] && typeof competitorsList[0] === "object") {
    const first = competitorsList[0];
    console.log(`[Semrush] First competitor object keys: ${JSON.stringify(Object.keys(first))}, business keys: ${JSON.stringify(Object.keys(first?.business || {}))}`);
  }

  const seenKeys = new Set<string>();
  const dedupedCompetitors: any[] = [];
  for (const c of competitorsList) {
    const name = c.name || c.business?.name || c.business?.business?.name || c.businessName || c.competitorName || "";
    const dedupKey = name || c.id || c.cid || c.business?.cid || "";
    if (dedupKey && seenKeys.has(dedupKey)) continue;
    if (dedupKey) seenKeys.add(dedupKey);
    dedupedCompetitors.push(c);
  }

  const competitors = dedupedCompetitors;
  console.log(`[Semrush] getTopCompetitors found ${competitors.length} competitors for campaign=${campaignId}, keyword=${keywordId}`);

  const subjectCid = subjectBusinessCid || options?.cid;
  const subjectPlaces = subjectBusinessPlaceIds || options?.placeIds;

  function isSubject(c: any): boolean {
    const cCid = c.business?.business?.cid || c.business?.cid || c.cid;
    const cPlaceIds: string[] = c.business?.business?.placeIds || c.business?.placeIds || c.placeIds || [];

    if (subjectCid && cCid && subjectCid === cCid) return true;

    if (subjectPlaces?.length && cPlaceIds.length) {
      for (const pid of cPlaceIds) {
        if (subjectPlaces.includes(pid)) return true;
      }
    }

    return false;
  }

  const results = competitors.map((c: any) => {
    const biz = c.business;
    const nestedBiz = biz?.business;
    const resolvedName =
      (c.name && c.name.trim()) ||
      (biz?.name && biz.name.trim()) ||
      (nestedBiz?.name && nestedBiz.name.trim()) ||
      (c.businessName && c.businessName.trim()) ||
      (c.competitorName && c.competitorName.trim()) ||
      (c.title && c.title.trim()) ||
      (biz?.title && biz.title.trim()) ||
      (nestedBiz?.title && nestedBiz.title.trim()) ||
      (c.address && c.address.trim()) ||
      "Unknown";

    if (resolvedName === "Unknown") {
      console.warn(`[Semrush] Unknown competitor name. Object keys: ${JSON.stringify(Object.keys(c))}, business keys: ${JSON.stringify(Object.keys(c.business || {}))}, raw (truncated): ${JSON.stringify(c).substring(0, 300)}`);
    }

    return {
      name: resolvedName,
      shareOfVoice: Math.round((c.shareOfVoice ?? c.sov ?? 0) * 100) / 100,
      averageRank: c.averagePosition ?? c.averageRank ?? c.avgPosition ?? c.avgRank ?? undefined,
      reviewCount: nestedBiz?.reviewNumber ?? biz?.reviewNumber ?? c.reviewNumber ?? nestedBiz?.reviewCount ?? biz?.reviewCount ?? c.reviewCount ?? c.reviews ?? undefined,
      reviewRating: nestedBiz?.rating ?? biz?.rating ?? c.rating ?? nestedBiz?.reviewRating ?? biz?.reviewRating ?? c.reviewRating ?? undefined,
      gbpUrl: c.gbpUrl ?? c.url ?? c.googleBusinessUrl ?? undefined,
      // Task #2020 — SEMrush returns a single free-text `address` on the
      // (possibly nested) business object; persist it so the leaderboard
      // can parse out structured locality/street disambiguators.
      address:
        (nestedBiz?.address && String(nestedBiz.address).trim()) ||
        (biz?.address && String(biz.address).trim()) ||
        (c.address && String(c.address).trim()) ||
        undefined,
      isSubjectBusiness: isSubject(c),
    };
  });

  if (subjectBusiness) {
    const biz = subjectBusiness.business || subjectBusiness;
    const subjectAlreadyIncluded = results.some(r => r.isSubjectBusiness);

    if (!subjectAlreadyIncluded && biz) {
      const subjectName = biz.name || "Unknown";
      const alreadyByName = results.some(r => r.name === subjectName);
      if (!alreadyByName) {
        results.push({
          name: subjectName,
          shareOfVoice: Math.round((subjectBusiness.shareOfVoice ?? 0) * 100) / 100,
          averageRank: subjectBusiness.averagePosition ?? undefined,
          reviewCount: biz.reviewNumber ?? biz.reviewCount ?? undefined,
          reviewRating: biz.rating ?? biz.reviewRating ?? undefined,
          gbpUrl: undefined,
          address: (biz.address && String(biz.address).trim()) || undefined,
          isSubjectBusiness: true,
        });
        console.log(`[Semrush] Added subject business "${subjectName}" to competitor list (SoV=${subjectBusiness.shareOfVoice})`);
      } else {
        const existing = results.find(r => r.name === subjectName);
        if (existing) {
          existing.isSubjectBusiness = true;
        }
      }
    }
  }

  return results;
}

export async function isConfigured(): Promise<boolean> {
  // Task #3670 — key mode: the API key IS the configuration.
  if (isSemrushKeyMode()) return true;
  const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  return !!tokenSetting?.value;
}
