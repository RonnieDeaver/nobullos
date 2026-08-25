import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { storage } from "../storage";
import { withDbAttribution } from "../db";
import { encryptToken, decryptToken } from "../utils/tokenCrypto";
import {
  isAuthoritativeRefreshPurpose,
  withSingleFlightOAuthRefresh,
  OAuthRefreshError,
} from "./oauthRefresh";
import { getDefaultOAuthRefreshLease } from "./oauthRefreshLease";
import { resolveOsCanonicalHostname } from "./publicUrl";
import type { GoogleCalendarCredential } from "@shared/schema";

/**
 * Per-user Google Calendar OAuth integration (Task #840).
 *
 * Each Account Manager connects their own Google Calendar so the booking
 * tool can:
 *   - read free/busy windows when computing availability
 *   - insert + delete events when a client books or cancels
 *
 * This is INTENTIONALLY SEPARATE from the existing Drive service-account
 * integration: that one acts as the firm itself, this one acts as the AM.
 *
 * Tokens are encrypted at rest with AES-256-GCM (`tokenCrypto`).
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_API_BASE = "https://www.googleapis.com";

// Per task #840 spec: read access (calendar.readonly — covers freebusy
// reads + reading the AM's own events for context) and write access for
// the booking event itself (calendar.events). The OIDC scopes are kept
// so we can resolve the AM's email/profile during the OAuth callback.
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
  "profile",
];

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SETTINGS_KEY_OAUTH_NONCE_PREFIX = "google_calendar_oauth_nonce:";

/** HMAC signing key derived from the configured client secret so that we don't
 * need yet another env var. The client secret is already a server-side secret,
 * never sent to the browser, and rotating it correctly invalidates pending
 * OAuth handshakes — exactly the security property we want. */
function getStateSigningKey(): Buffer {
  return crypto
    .createHash("sha256")
    .update(`google-calendar-oauth-state:${getClientSecret()}`)
    .digest();
}

function signStatePayload(payload: string): string {
  return crypto
    .createHmac("sha256", getStateSigningKey())
    .update(payload)
    .digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getClientId(): string {
  const id = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  if (!id) {
    throw new Error(
      "GOOGLE_CALENDAR_CLIENT_ID not configured. Add it via Settings → Secrets to enable the booking tool's Calendar integration.",
    );
  }
  return id;
}

function getClientSecret(): string {
  const s = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!s) {
    throw new Error(
      "GOOGLE_CALENDAR_CLIENT_SECRET not configured. Add it via Settings → Secrets to enable the booking tool's Calendar integration.",
    );
  }
  return s;
}

export function getRedirectUri(): string {
  if (process.env.GOOGLE_CALENDAR_REDIRECT_URI) {
    return process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  }
  // Task #3740: canonical OS host (reports.*) — never the marketing apex,
  // regardless of the order domains appear in the deployment's domain list.
  const domain = resolveOsCanonicalHostname();
  if (!domain) {
    throw new Error(
      "REPLIT_DOMAINS not set — cannot build Google Calendar OAuth redirect URI",
    );
  }
  return `https://${domain}/api/integrations/google-calendar/callback`;
}

export function isGoogleCalendarConfigured(): boolean {
  return !!process.env.GOOGLE_CALENDAR_CLIENT_ID && !!process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
}

function makeOAuthClient(): OAuth2Client {
  return new OAuth2Client(getClientId(), getClientSecret(), getRedirectUri());
}

// ---------------------------------------------------------------------------
// State / authorization
// ---------------------------------------------------------------------------

/**
 * Build an OAuth authorization URL bound to the given user. The state token
 * is `<random>:<userId>` so the callback can recover which AM is connecting
 * even though Google doesn't echo arbitrary state metadata. The random half
 * is verified against system_settings to defeat CSRF.
 */
export async function getAuthorizationUrl(userId: string): Promise<string> {
  if (!userId) throw new Error("userId is required to start Google Calendar OAuth");

  // Per-user nonce stored server-side. Mint a fresh one for every authorize
  // call so concurrent OAuth starts by the same user don't race, and so that
  // a single nonce can only be redeemed once.
  const nonce = crypto.randomBytes(24).toString("hex");
  const issuedAt = Date.now();

  // The state we send to Google is `<base64url(payload)>.<base64url(hmac)>`,
  // where payload is JSON({u,n,t}) signed with our server-side key. We
  // verify the full payload integrity (not just the random portion) on the
  // callback so an attacker can't substitute a different `userId`.
  const payloadJson = JSON.stringify({ u: userId, n: nonce, t: issuedAt });
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const sig = signStatePayload(payloadB64);
  const state = `${payloadB64}.${sig}`;

  // Bind the nonce to this specific user. The callback can only succeed if
  // the user identified by the *signed* payload still has this nonce armed.
  await storage.setSystemSetting(
    `${SETTINGS_KEY_OAUTH_NONCE_PREFIX}${userId}`,
    JSON.stringify({ nonce, issuedAt }),
    userId,
  );

  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: REQUIRED_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // force refresh_token even on re-connect
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function validateOAuthState(
  state: string,
): Promise<{ valid: boolean; userId?: string }> {
  if (!state) return { valid: false };

  // 1. Split & verify HMAC integrity over the full payload before trusting
  //    anything inside it (including the userId).
  const dot = state.lastIndexOf(".");
  if (dot <= 0 || dot === state.length - 1) return { valid: false };
  const payloadB64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expectedSig = signStatePayload(payloadB64);
  if (!constantTimeEquals(sig, expectedSig)) return { valid: false };

  // 2. Decode the now-trusted payload.
  let parsed: { u?: string; n?: string; t?: number };
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false };
  }
  const userId = parsed?.u;
  const nonce = parsed?.n;
  const issuedAt = typeof parsed?.t === "number" ? parsed.t : 0;
  if (!userId || !nonce) return { valid: false };

  // 3. Reject expired handshakes even if the signature is still valid.
  if (Date.now() - issuedAt > OAUTH_STATE_TTL_MS) return { valid: false };

  // 4. Confirm the per-user nonce we stored at authorize-time still matches,
  //    then atomically clear it so the same code can't be redeemed twice.
  return withDbAttribution("oauth_callback:read_state", async () => {
    const key = `${SETTINGS_KEY_OAUTH_NONCE_PREFIX}${userId}`;
    const stored = await storage.getSystemSetting(key);
    if (!stored?.value) return { valid: false };
    let storedNonce = "";
    try {
      storedNonce = (JSON.parse(stored.value) as { nonce?: string }).nonce || "";
    } catch {
      return { valid: false };
    }
    if (!storedNonce || !constantTimeEquals(storedNonce, nonce)) {
      return { valid: false };
    }
    await storage.setSystemSetting(key, "", userId);
    return { valid: true, userId };
  });
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

interface GoogleIdTokenPayload {
  email?: string;
}

function decodeIdTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as GoogleIdTokenPayload;
    return payload.email || null;
  } catch {
    return null;
  }
}

/**
 * Exchange the auth-code for tokens AND persist the credential row encrypted.
 * Returns the upserted credential (without secret material).
 */
export async function exchangeCodeForToken(
  userId: string,
  code: string,
): Promise<GoogleCalendarCredential> {
  // Task #1849: external token exchange runs OUTSIDE any DB attribution
  // scope so a stuck provider can never hold an api-pool connection
  // across the network round-trip.
  const oauth = makeOAuthClient();
  const { tokens } = await oauth.getToken(code);

  if (!tokens.access_token) {
    throw new Error("Google did not return an access_token");
  }
  const accessToken = tokens.access_token;

  return withDbAttribution("oauth_callback:persist_tokens", async () => {
    // refresh_token is only returned on the first consent OR when prompt=consent
    // is forced. We always ask for consent above so this should be present, but
    // we tolerate its absence on a re-connect by preserving any existing one.
    const existing = await storage.getGoogleCalendarCredential(userId);
    const refreshToken =
      tokens.refresh_token ||
      (existing?.refreshTokenEncrypted
        ? decryptToken(existing.refreshTokenEncrypted)
        : "");

    if (!refreshToken) {
      throw new Error(
        "Google did not return a refresh_token. Ask the user to revoke access at https://myaccount.google.com/permissions and try again.",
      );
    }

    const email =
      decodeIdTokenEmail(tokens.id_token ?? undefined) ||
      existing?.googleAccountEmail ||
      null;

    const expiry =
      tokens.expiry_date != null ? new Date(tokens.expiry_date) : null;

    const scopes = (tokens.scope || "").split(/\s+/).filter(Boolean).join(" ");

    return storage.upsertGoogleCalendarCredential({
      userId,
      googleAccountEmail: email,
      calendarId: "primary",
      accessTokenEncrypted: encryptToken(accessToken),
      refreshTokenEncrypted: encryptToken(refreshToken),
      tokenExpiry: expiry,
      scopes,
      status: "connected",
      lastRefreshAt: new Date(),
      lastError: null,
    });
  });
}

/**
 * Task #2428 — error thrown when a user's Google Calendar credential state is
 * genuinely UNKNOWN: the authoritative per-user credential read on the hot path
 * itself failed (DB / pool saturation), so absence is NOT confirmed. Distinct
 * from the terminal "not connected for this user" path so callers / classifiers
 * treat it as transient and retryable — it must never masquerade as a
 * deterministic disconnect that surfaces a "Reconnect Google" prompt. Mirrors
 * the SEMrush / Front / Zoom confirm-before-trip guarantee (and the same
 * Task #2416 unknown-vs-confirmed distinction the retired Google Ads
 * connection probe pioneered).
 */
export class GoogleCalendarAuthUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleCalendarAuthUnknownError";
  }
}

/**
 * Returns a fresh access token for the given user, refreshing if necessary.
 * Persists the rotated access token. Throws if disconnected/invalid.
 */
export async function getValidAccessToken(
  userId: string,
  opts?: { purpose?: string },
): Promise<string> {
  // Task #2428 — confirm-before-trip. `getGoogleCalendarCredential` is an
  // authoritative, cache-bypassing read straight from the per-user
  // `google_calendar_credentials` row (no in-memory cache layer to go stale),
  // so a returned `undefined` IS a confirmed absence and throws the terminal
  // "not connected" below. But a read that THROWS (DB / pool saturation) is
  // UNKNOWN, not absent — absence is NOT confirmed, so surface a
  // transient/retryable `GoogleCalendarAuthUnknownError` and do NOT declare a
  // disconnect. A failed read must never masquerade as a deterministic
  // "not connected" that surfaces a Reconnect prompt. Mirrors Google Ads
  // (Task #2416) / SEMrush (Task #2412).
  let cred: Awaited<ReturnType<typeof storage.getGoogleCalendarCredential>>;
  try {
    cred = await storage.getGoogleCalendarCredential(userId);
  } catch (err: any) {
    throw new GoogleCalendarAuthUnknownError(
      `Google Calendar connection state unknown for user ${userId} — read failed, will retry (no disconnect declared): ${err?.message ?? err}`,
    );
  }
  // Task #2433 — these terminal disconnect throws are REGISTERED in
  // scripts/lint-probe-swallow-into-unauthorized.ts (DISCONNECT_THROW_ACCESSORS)
  // and must keep matching its DISCONNECT_THROW_MESSAGE_PATTERNS. Rewording them
  // away from the shared phrases ("not connected" / "credential status is" /
  // "missing refresh token") fails that lint loudly — update the pattern list in
  // lockstep rather than letting the swallow guard silently stop covering this
  // accessor.
  if (!cred) {
    throw new Error("Google Calendar not connected for this user");
  }
  if (cred.status !== "connected") {
    throw new Error(`Google Calendar credential status is "${cred.status}"`);
  }
  if (!cred.refreshTokenEncrypted) {
    throw new Error("Stored Google Calendar credential is missing refresh token");
  }

  const now = Date.now();
  const expiresAtMs = cred.tokenExpiry ? cred.tokenExpiry.getTime() : 0;

  // If still valid for >2 minutes, reuse the stored access token.
  if (cred.accessTokenEncrypted && expiresAtMs - now > 2 * 60 * 1000) {
    return decryptToken(cred.accessTokenEncrypted);
  }

  // Task #2377 — route the refresh POST through the shared single-flight +
  // cross-process lease helper, keyed PER USER. Google Calendar OAuth is
  // per-user (each AM holds their own rotating refresh token), so a
  // system-wide lease would needlessly serialize unrelated users. Passing
  // `subjectKey: userId` gives one in-flight slot + one lease per user
  // (lease key `oauth_refresh_lease:google_calendar:<userId>`): two
  // refreshes for the SAME user serialize across every autoscale instance,
  // while different users still refresh concurrently. Google rotates the
  // refresh token periodically and returns `invalid_grant` (HTTP 400,
  // terminal) when a captured-but-already-consumed token is POSTed, so
  // without this a loser would falsely disconnect a healthy user. Mirrors
  // the system-scoped wiring on Front/Zoom/Google Ads/SEMrush.
  return withSingleFlightOAuthRefresh<string>({
    integration: "google_calendar",
    subjectKey: userId,
    purpose: opts?.purpose,
    // Task #2437 — bounded wait-and-re-read before a terminal refresh is
    // declared a permanent death (extends the Task #2435 Front defense). The
    // per-user cross-process lease serializes a single user's refreshers, but
    // a loser can still re-read the stored refresh token in the instant
    // BEFORE the winning sibling persists the freshly-rotated one (Google
    // rotates periodically and silently), see the still-consumed token, and
    // surface a false `invalid_grant` (HTTP 400) that flips THIS user's
    // credential to a sticky disconnected status on a connection a sibling
    // just rotated healthy. Polling a few extra times lets the winner's
    // updateGoogleCalendarCredential land so the retry picks up the rotated
    // token. Tuned to the 2-min pre-expiry skew this accessor /
    // onLeaseAcquiredRecheck use — ample headroom for a sub-second poll, so
    // 3×150ms (≈450ms). A true revocation never rotates, exhausts the window,
    // and is still declared terminal exactly once.
    terminalRotationRecheck: { attempts: 3, delayMs: 150 },
    crossProcessLease: getDefaultOAuthRefreshLease(),
    onLeaseAcquiredRecheck: async () => {
      // If a sibling instance refreshed this user while we waited for the
      // lease, the freshly-stored access token is already valid — reuse it
      // and skip a wasteful (and, mid-rotation, risky) second POST.
      const fresh = await storage.getGoogleCalendarCredential(userId).catch(() => null);
      if (!fresh || fresh.status !== "connected" || !fresh.accessTokenEncrypted) {
        return null;
      }
      const freshExpiresAtMs = fresh.tokenExpiry ? fresh.tokenExpiry.getTime() : 0;
      if (freshExpiresAtMs - Date.now() > 2 * 60 * 1000) {
        return decryptToken(fresh.accessTokenEncrypted);
      }
      return null;
    },
    readRefreshToken: async () => {
      // Re-read from authoritative storage so a loser picks up whatever
      // refresh token the winner just rotated (the whole point of the lease).
      //
      // Task #2428 — confirm-before-trip on THIS read too. The single-flight
      // helper treats a falsy `readRefreshToken()` as a TERMINAL "refresh
      // token is missing — reconnect required" and (after the retry path)
      // commits a durable disconnect via `onTerminalAfterRetry`. So a read
      // that THROWS (DB / pool saturation) must NOT collapse to `null` —
      // that would turn a transient blip into a false reconnect-required
      // trip. Surface a transient `GoogleCalendarAuthUnknownError` instead:
      // it is not an `OAuthRefreshError`, so the helper classifies it
      // transient and propagates it WITHOUT calling `onTerminalAfterRetry`
      // (no disconnect). Only a successful read returning no refresh token is
      // a genuine absence → `null` → the helper's terminal-missing path.
      let fresh: Awaited<ReturnType<typeof storage.getGoogleCalendarCredential>>;
      try {
        fresh = await storage.getGoogleCalendarCredential(userId);
      } catch (err: any) {
        throw new GoogleCalendarAuthUnknownError(
          `Google Calendar connection state unknown for user ${userId} — refresh-token re-read failed, will retry (no disconnect declared): ${err?.message ?? err}`,
        );
      }
      return fresh?.refreshTokenEncrypted
        ? decryptToken(fresh.refreshTokenEncrypted)
        : null;
    },
    refreshOnce: async ({ refreshToken }) => {
      const params = new URLSearchParams({
        client_id: getClientId(),
        client_secret: getClientSecret(),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });

      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      const body = (await res.json()) as GoogleTokenResponse & {
        error?: string;
        error_description?: string;
      };
      if (!res.ok || !body.access_token) {
        const reason = body.error_description || body.error || `${res.status}`;
        // 4xx (except 429) is a terminal auth outcome — invalid_grant,
        // invalid_scope, etc.; the loser of a rotation race hits this. 5xx /
        // 429 / network failures are transient and must NOT commit a
        // disconnect. The helper only invokes `onTerminalAfterRetry` (the
        // credential-status flip) for the terminal classification, and only
        // after the re-read-and-retry path has been exhausted.
        const isTerminal = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw new OAuthRefreshError(
          "google_calendar",
          isTerminal ? "terminal" : "transient",
          `Google Calendar token refresh failed: ${reason}`,
          { status: res.status },
        );
      }

      const newAccess = body.access_token;
      const expiry =
        body.expires_in != null ? new Date(Date.now() + body.expires_in * 1000) : null;

      await storage.updateGoogleCalendarCredential(userId, {
        accessTokenEncrypted: encryptToken(newAccess),
        // Persist the rotated refresh token when Google sends one (it does
        // periodically). Omitting it preserves the stored token for cycles
        // where Google does not rotate.
        refreshTokenEncrypted: body.refresh_token
          ? encryptToken(body.refresh_token)
          : undefined,
        tokenExpiry: expiry,
        lastRefreshAt: new Date(),
        lastError: null,
        status: "connected",
      });

      return newAccess;
    },
    onTerminalAfterRetry: async (err) => {
      const reason = (
        err instanceof OAuthRefreshError
          ? err.message
          : String((err as any)?.message ?? err)
      ).replace(/^Google Calendar token refresh failed:\s*/, "");
      // Task #2286 — only an authoritative, on-demand refresh (a real
      // free/busy read for a booking, an event write, a 401 recovery —
      // the default purpose) may commit a durable credential-status flip.
      // A NON-authoritative probe/proactive refresh (availability preview,
      // timezone backfill) that loses a refresh-token rotation race 4xx's
      // on a captured-but-already-consumed token; writing the terminal
      // status there would falsely disconnect a still-valid credential.
      // Mirrors Front/Zoom/Google Ads/SEMrush (Task #2267).
      if (!isAuthoritativeRefreshPurpose(opts?.purpose)) {
        console.warn(
          `[GoogleCalendar] non-authoritative refresh (purpose=${opts?.purpose ?? "unknown"}) hit terminal "${reason}" for user ${userId}; NOT committing disconnect (rotation-race safe)`,
        );
        return;
      }
      // Map Google's error reasons onto the canonical credential states
      // declared in shared/models/booking.ts. We never write ad-hoc statuses
      // ("revoked", "error") that the rest of the app doesn't understand.
      const credentialStatus: "disconnected" | "missing_scope" | "expired" | "refresh_failed" =
        /invalid_grant|unauthorized/i.test(reason)
          ? "disconnected"
          : /invalid_scope|insufficient_scope/i.test(reason)
            ? "missing_scope"
            : /expired/i.test(reason)
              ? "expired"
              : "refresh_failed";
      await storage.updateGoogleCalendarCredential(userId, {
        status: credentialStatus,
        lastError: reason,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Calendar API helpers
// ---------------------------------------------------------------------------

/**
 * Thrown when a Google Calendar API call fails because the stored
 * credential is no longer usable (revoked grant, missing scope,
 * permanently expired refresh token). Callers MUST treat this as
 * non-retriable — the AM has to reconnect their calendar before any
 * subsequent free/busy or insertEvent call will succeed. The slots
 * routes translate this to a 409 + `calendar_reauth_required` so the
 * booking UI can render a Reconnect banner instead of a generic
 * "calendar unreachable" retry message.
 */
/**
 * Thrown when a Google API call returns a non-JSON / non-auth error
 * response — typically Google's generic HTML 404 landing page when the
 * request URL doesn't resolve to a Calendar API handler (malformed
 * path, wrong slug casing, proxy interception, etc.). Distinct from
 * `CalendarReauthRequiredError` because the credential is fine and
 * from a generic transient outage because the request shape itself is
 * wrong — re-issuing the same request will fail the same way.
 *
 * `classification` is the structured tag that 929E surfaces in the
 * admin diagnostics UI (e.g. `endpoint_misrouted` for HTML 404,
 * `non_json_response` for any other unparseable body).
 */
export class CalendarTransportError extends Error {
  readonly httpStatus: number;
  readonly requestUrl: string;
  readonly classification: "endpoint_misrouted" | "non_json_response";
  readonly bodySnippet: string;
  constructor(
    httpStatus: number,
    requestUrl: string,
    classification: "endpoint_misrouted" | "non_json_response",
    bodySnippet: string,
  ) {
    super(
      `Google Calendar transport error: ${httpStatus} ${classification} at ${requestUrl}`,
    );
    this.name = "CalendarTransportError";
    this.httpStatus = httpStatus;
    this.requestUrl = requestUrl;
    this.classification = classification;
    this.bodySnippet = bodySnippet;
  }
}

export class CalendarReauthRequiredError extends Error {
  readonly userId: string;
  readonly reason: string;
  readonly httpStatus: number;
  readonly credentialStatus: "disconnected" | "missing_scope" | "expired" | "refresh_failed";
  constructor(
    userId: string,
    httpStatus: number,
    reason: string,
    credentialStatus: "disconnected" | "missing_scope" | "expired" | "refresh_failed",
  ) {
    super(`Google Calendar reauth required for user ${userId}: ${reason} (HTTP ${httpStatus})`);
    this.name = "CalendarReauthRequiredError";
    this.userId = userId;
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.credentialStatus = credentialStatus;
  }
}

/**
 * Parse a Google API error body and pull out the canonical
 * `error.errors[*].reason` (or top-level `error.status`) so we can
 * map it onto our credential states. Returns a short, log-safe
 * reason string and never throws.
 */
function parseGoogleErrorBody(text: string): { reason: string; redacted: string } {
  let reason = "";
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — keep reason empty, fall through to the redacted body.
  }
  if (parsed && typeof parsed === "object") {
    const e = parsed.error || parsed;
    if (Array.isArray(e?.errors) && e.errors.length > 0) {
      reason = String(e.errors[0]?.reason || e.errors[0]?.message || "");
    }
    if (!reason) {
      reason = String(e?.status || e?.message || "");
    }
  }
  // Cap the body we surface in logs to keep stack traces / payloads
  // from blowing up disk usage. Tokens are never echoed by Google in
  // these bodies, but trim defensively anyway.
  const redacted = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  return { reason: reason || "unknown_error", redacted };
}

async function calendarRequest(
  userId: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
  retryOn401 = true,
  opts?: { purpose?: string },
): Promise<any> {
  const token = await getValidAccessToken(userId, { purpose: opts?.purpose });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let body: BodyInit | undefined = init.body as BodyInit | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const requestUrl = `${GOOGLE_API_BASE}${path}`;
  const res = await fetch(requestUrl, {
    method: init.method || "GET",
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    body,
  });

  if (res.status === 401 && retryOn401) {
    // Force a refresh on next call by zeroing the expiry.
    await storage.updateGoogleCalendarCredential(userId, { tokenExpiry: new Date(0) });
    return calendarRequest(userId, path, init, false, opts);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    // Detect Google's generic HTML 404 / 5xx landing pages. When the
    // body isn't JSON, the request never reached the Calendar API
    // JSON handler — that means the URL itself is wrong (malformed
    // path, wrong slug casing, proxy interception). Surface this as a
    // structured `CalendarTransportError` with a single-line warning
    // (status + URL + short snippet) so 929E's admin diagnostics can
    // render `endpoint_misrouted` instead of mislabelling it as a
    // generic "calendar unreachable" outage that the user should
    // retry. Skip this branch for 401/403 — those are handled below
    // by the credential-state mapping even when the body is HTML.
    if (res.status !== 401 && res.status !== 403) {
      const trimmed = text.trim();
      const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
      if (!looksJson && trimmed.length > 0) {
        const snippet = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
        const oneLineSnippet = snippet.replace(/\s+/g, " ");
        const classification: "endpoint_misrouted" | "non_json_response" =
          res.status === 404 ? "endpoint_misrouted" : "non_json_response";
        console.warn(
          `[GoogleCalendar] non-JSON response: status=${res.status} url=${requestUrl} classification=${classification} snippet=${oneLineSnippet}`,
        );
        throw new CalendarTransportError(
          res.status,
          requestUrl,
          classification,
          oneLineSnippet,
        );
      }
    }
    // Auth / scope errors must flip the stored credential status so
    // the rest of the app (booking UI, status endpoint, scheduler
    // saga) sees the credential as no-longer-usable WITHOUT waiting
    // for the next refresh attempt to fail. This mirrors the mapping
    // in `getValidAccessToken` so both the refresh path and the live
    // API path produce the same canonical state.
    if (res.status === 401 || res.status === 403) {
      const { reason, redacted } = parseGoogleErrorBody(text);
      const credentialStatus: "disconnected" | "missing_scope" | "expired" | "refresh_failed" =
        /insufficient_scope|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|forbidden/i.test(
          reason,
        )
          ? "missing_scope"
          : /invalid_grant|invalid_token|unauthorized|authError|invalidCredentials|invalid_credentials/i.test(
                reason,
              )
            ? "disconnected"
            : res.status === 403
              ? "missing_scope"
              : "refresh_failed";
      // Task #2286 — gate the durable credential-status flip on an
      // authoritative caller. A non-authoritative read (availability
      // preview, timezone backfill) must NOT poison a still-valid
      // credential on a transient auth blip / rotation race. It still
      // throws the same CalendarReauthRequiredError so the caller stays
      // fail-closed; only the persisted disconnect is withheld.
      if (isAuthoritativeRefreshPurpose(opts?.purpose)) {
        await storage
          .updateGoogleCalendarCredential(userId, {
            status: credentialStatus,
            lastError: `${res.status} ${reason}`,
          })
          .catch(() => {
            // Best-effort: never let a logging-side DB failure mask the
            // original API error.
          });
      } else {
        console.warn(
          `[GoogleCalendar] non-authoritative request (purpose=${opts?.purpose ?? "unknown"}) hit ${res.status} ${reason} for user ${userId}; NOT committing disconnect (rotation-race safe)`,
        );
      }
      console.warn(
        `[GoogleCalendar] reauth-required: userId=${userId} status=${res.status} reason=${reason} credentialStatus=${credentialStatus} body=${redacted}`,
      );
      throw new CalendarReauthRequiredError(userId, res.status, reason, credentialStatus);
    }
    throw new Error(`Google Calendar API error: ${res.status} ${text}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface BusyInterval {
  startUtc: Date;
  endUtc: Date;
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

/**
 * Returns the connected user's Google Calendar list so an account
 * manager can pick which calendar to write events to (and read
 * free/busy from). The list always begins with the entry whose
 * `primary` flag is set so the UI can default to it. We only surface
 * calendars where `accessRole` permits writing events
 * (`owner` / `writer`); read-only calendars are filtered out so the
 * AM cannot select a target the saga can't actually insert into.
 *
 * Spec: Done line 33 — "An account manager can connect Google
 * Calendar via per-user OAuth, choose the target calendar (defaults
 * to primary), and disconnect it later."
 */
export async function listCalendars(userId: string): Promise<CalendarListEntry[]> {
  const data = await calendarRequest(
    userId,
    "/calendar/v3/users/me/calendarList?minAccessRole=writer&showHidden=false",
    { method: "GET" },
  );
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const out: CalendarListEntry[] = items
    .filter(
      (c) =>
        typeof c?.id === "string" &&
        (c.accessRole === "owner" || c.accessRole === "writer"),
    )
    .map((c) => ({
      id: String(c.id),
      summary: String(c.summary || c.summaryOverride || c.id),
      primary: Boolean(c.primary),
      accessRole: String(c.accessRole),
    }));
  out.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.summary.localeCompare(b.summary);
  });
  return out;
}

/**
 * Fetch busy intervals across one or more calendars in `[fromUtc, toUtc)`.
 * Defaults to the user's primary calendar.
 */
export async function getFreeBusy(
  userId: string,
  fromUtc: Date,
  toUtc: Date,
  calendarIds: string[] = ["primary"],
  opts?: { purpose?: string },
): Promise<BusyInterval[]> {
  // Google's freebusy endpoint is camelCase `freeBusy` per
  // https://developers.google.com/calendar/api/v3/reference/freebusy/query
  // (the URL slug is `freeBusy`, not `freebusy`). Hitting the
  // lowercase variant returns Google's generic HTML 404 landing page
  // ("<title>Error 404 (Not Found)!!1</title>") because the request
  // never reaches the Calendar JSON handler — that's the bug 929D
  // is fixing. Keep the casing exactly as Google documents it.
  const data = await calendarRequest(
    userId,
    "/calendar/v3/freeBusy",
    {
      method: "POST",
      json: {
        timeMin: fromUtc.toISOString(),
        timeMax: toUtc.toISOString(),
        items: calendarIds.map((id) => ({ id })),
      },
    },
    true,
    { purpose: opts?.purpose },
  );

  const out: BusyInterval[] = [];
  const calendars = data?.calendars || {};
  for (const id of calendarIds) {
    const busy: Array<{ start: string; end: string }> = calendars[id]?.busy || [];
    for (const b of busy) {
      out.push({ startUtc: new Date(b.start), endUtc: new Date(b.end) });
    }
  }
  return out;
}

export interface InsertEventInput {
  summary: string;
  description?: string;
  startUtc: Date;
  endUtc: Date;
  timezone?: string;
  attendees?: Array<{ email: string; displayName?: string }>;
  location?: string;
  /** When set, do NOT have Google attach a Meet link (we use Zoom). */
  conferenceData?: null;
  /** Optional client-supplied id for idempotency. Google requires 5–1024 lowercase a-v0-9. */
  iCalUID?: string;
  /**
   * Optional explicit reminder overrides. When provided, the event uses
   * these instead of the calendar's default reminders. Each override is
   * `{ method: "email" | "popup", minutes: 0..40320 }` and Google
   * accepts up to 5 entries.
   */
  reminderOverrides?: Array<{ method: "email" | "popup"; minutes: number }>;
  /**
   * Recurring-event support (Task #1032B). When provided, the event is
   * created as a recurring master series whose RRULE/EXDATE/RDATE
   * lines come from this array (already-validated by
   * `validateRecurrencePayload` upstream — Phase 1 / #1032A). Absent
   * recurrence preserves the original single-event behavior.
   */
  recurrence?: string[];
}

export interface InsertedEvent {
  id: string;
  htmlLink: string | null;
  iCalUID: string | null;
  raw: any;
}

export type CalendarSendUpdates = "all" | "externalOnly" | "none";

/**
 * Structured error raised by the recurrence-aware Google Calendar
 * wrappers. `code` matches the epic's documented codes so the saga
 * (#1032D) and admin observability dashboards can branch on a stable
 * machine-readable tag instead of a free-form message.
 */
export class CalendarRecurrenceError extends Error {
  readonly code:
    | "google_recurring_create_failed"
    | "google_instance_update_failed"
    | "google_series_split_failed";
  readonly cause?: unknown;
  constructor(
    code:
      | "google_recurring_create_failed"
      | "google_instance_update_failed"
      | "google_series_split_failed",
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "CalendarRecurrenceError";
    this.code = code;
    this.cause = cause;
  }
}

export interface CalendarEventChanges {
  summary?: string;
  description?: string;
  startUtc?: Date;
  endUtc?: Date;
  timezone?: string;
  attendees?: Array<{ email: string; displayName?: string }>;
  location?: string;
  recurrence?: string[];
  reminderOverrides?: Array<{ method: "email" | "popup"; minutes: number }>;
  status?: "confirmed" | "tentative" | "cancelled";
}

function buildEventBody(
  changes: CalendarEventChanges,
  fallbackTimezone?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (changes.summary !== undefined) {
    body.summary = changes.summary.slice(0, 200);
  }
  if (changes.description !== undefined) {
    body.description = (changes.description || "").slice(0, 8000);
  }
  const tz = changes.timezone || fallbackTimezone;
  if (changes.startUtc) {
    body.start = { dateTime: changes.startUtc.toISOString(), timeZone: tz || "UTC" };
  }
  if (changes.endUtc) {
    body.end = { dateTime: changes.endUtc.toISOString(), timeZone: tz || "UTC" };
  }
  if (changes.attendees) {
    body.attendees = changes.attendees.map((a) => ({
      email: a.email,
      displayName: a.displayName,
    }));
  }
  if (changes.location !== undefined) {
    body.location = changes.location;
  }
  if (changes.recurrence !== undefined) {
    body.recurrence = changes.recurrence;
  }
  if (changes.reminderOverrides) {
    body.reminders = {
      useDefault: false,
      overrides: changes.reminderOverrides.slice(0, 5),
    };
  }
  if (changes.status) {
    body.status = changes.status;
  }
  return body;
}

/**
 * Format a `Date` as the Google Calendar "basic" UTC instance id
 * suffix (`YYYYMMDDTHHMMSSZ`). Used to construct synthetic instance
 * ids and `UNTIL=` clauses in RRULEs.
 */
function formatGoogleBasicUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d{3}/, "")
    .replace(/[-:]/g, "");
}

/**
 * Replace (or append) an `UNTIL=` clause on a single `RRULE:` line.
 * Drops any existing `COUNT=` because `COUNT` and `UNTIL` are mutually
 * exclusive per RFC 5545. Other RRULE parts are preserved.
 */
function setRruleUntil(rruleLine: string, untilUtc: Date): string {
  if (!/^RRULE:/i.test(rruleLine)) return rruleLine;
  const value = rruleLine.replace(/^RRULE:/i, "");
  const parts = value.split(";").filter(Boolean);
  const kept: string[] = [];
  for (const p of parts) {
    const [k] = p.split("=");
    if (!k) continue;
    const upper = k.toUpperCase();
    if (upper === "UNTIL" || upper === "COUNT") continue;
    kept.push(p);
  }
  kept.push(`UNTIL=${formatGoogleBasicUtc(untilUtc)}`);
  return `RRULE:${kept.join(";")}`;
}

export async function insertEvent(
  userId: string,
  calendarId: string,
  input: InsertEventInput,
): Promise<InsertedEvent> {
  const tz = input.timezone || "UTC";
  const body: Record<string, unknown> = {
    summary: input.summary.slice(0, 200),
    description: (input.description || "").slice(0, 8000),
    start: { dateTime: input.startUtc.toISOString(), timeZone: tz },
    end: { dateTime: input.endUtc.toISOString(), timeZone: tz },
    attendees: (input.attendees || []).map((a) => ({
      email: a.email,
      displayName: a.displayName,
    })),
    location: input.location,
    reminders:
      input.reminderOverrides && input.reminderOverrides.length > 0
        ? { useDefault: false, overrides: input.reminderOverrides.slice(0, 5) }
        : { useDefault: true },
  };
  if (input.iCalUID) {
    body.iCalUID = input.iCalUID;
  }
  if (input.recurrence && input.recurrence.length > 0) {
    body.recurrence = input.recurrence;
  }

  let data: any;
  try {
    data = await calendarRequest(
      userId,
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`,
      { method: "POST", json: body },
    );
  } catch (err) {
    if (input.recurrence && input.recurrence.length > 0) {
      console.warn(
        `[GoogleCalendar] google_recurring_create_failed userId=${userId} calendarId=${calendarId} reason=${(err as Error)?.message || err}`,
      );
      throw new CalendarRecurrenceError(
        "google_recurring_create_failed",
        `Failed to create recurring Google Calendar event: ${(err as Error)?.message || err}`,
        err,
      );
    }
    throw err;
  }
  if (!data?.id) {
    throw new Error("Google Calendar insert returned no event id");
  }
  if (input.recurrence && input.recurrence.length > 0) {
    console.info(
      `[GoogleCalendar] google_recurring_event_created userId=${userId} calendarId=${calendarId} eventId=${data.id} rruleCount=${input.recurrence.length}`,
    );
  }
  return {
    id: String(data.id),
    htmlLink: data.htmlLink || null,
    iCalUID: data.iCalUID || null,
    raw: data,
  };
}

/**
 * Patch the master series (or a one-off event). Used by the
 * recurrence saga to rewrite the RRULE (e.g. shorten via UNTIL),
 * change summary/description, or update attendees on every future
 * occurrence. `sendUpdates` defaults to `"all"` per the epic spec.
 */
export async function updateEvent(opts: {
  userId: string;
  calendarId: string;
  eventId: string;
  changes: CalendarEventChanges;
  sendUpdates?: CalendarSendUpdates;
}): Promise<any> {
  const sendUpdates = opts.sendUpdates || "all";
  const body = buildEventBody(opts.changes);
  return calendarRequest(
    opts.userId,
    `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}?sendUpdates=${sendUpdates}`,
    { method: "PATCH", json: body },
  );
}

/**
 * Locate the Google instance override for a single occurrence of a
 * recurring event and patch only that occurrence. If no override
 * exists yet, Google auto-creates one when we PATCH the synthetic
 * instance id (`{recurringEventId}_{YYYYMMDDTHHMMSSZ}`); we still
 * call `events.instances` first because the spec asks us to resolve
 * the canonical id and because the basic-UTC suffix is only valid
 * when the master's DTSTART carries a time component (which is true
 * for every recurring booking the saga creates).
 */
export async function updateInstance(opts: {
  userId: string;
  calendarId: string;
  recurringEventId: string;
  originalStartTime: Date;
  changes: CalendarEventChanges;
  sendUpdates?: CalendarSendUpdates;
}): Promise<any> {
  const sendUpdates = opts.sendUpdates || "all";
  let instanceId: string;
  try {
    const list = await calendarRequest(
      opts.userId,
      `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.recurringEventId)}/instances?originalStart=${encodeURIComponent(opts.originalStartTime.toISOString())}&maxResults=2&showDeleted=true`,
      { method: "GET" },
    );
    const items: any[] = Array.isArray(list?.items) ? list.items : [];
    const wantMs = opts.originalStartTime.getTime();
    // Verify the returned instance's originalStartTime actually
    // matches the requested occurrence before patching it. Google
    // honors `originalStart`, but defensively matching guards against
    // an edge-case where `events.instances` returns a neighboring
    // occurrence (e.g. a per-tz DST boundary) and we'd otherwise
    // silently overwrite the wrong instance.
    const found = items.find((i) => {
      if (typeof i?.id !== "string") return false;
      const origIso =
        i.originalStartTime?.dateTime || i.originalStartTime?.date || "";
      if (!origIso) return false;
      const t = new Date(origIso).getTime();
      return Number.isFinite(t) && t === wantMs;
    });
    instanceId = found?.id
      ? String(found.id)
      : `${opts.recurringEventId}_${formatGoogleBasicUtc(opts.originalStartTime)}`;
  } catch (err) {
    console.warn(
      `[GoogleCalendar] google_instance_update_failed (resolve) userId=${opts.userId} eventId=${opts.recurringEventId} reason=${(err as Error)?.message || err}`,
    );
    throw new CalendarRecurrenceError(
      "google_instance_update_failed",
      `Failed to resolve Google Calendar instance: ${(err as Error)?.message || err}`,
      err,
    );
  }

  try {
    const patched = await calendarRequest(
      opts.userId,
      `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(instanceId)}?sendUpdates=${sendUpdates}`,
      { method: "PATCH", json: buildEventBody(opts.changes) },
    );
    console.info(
      `[GoogleCalendar] google_instance_override_created userId=${opts.userId} calendarId=${opts.calendarId} recurringEventId=${opts.recurringEventId} instanceId=${instanceId}`,
    );
    return patched;
  } catch (err) {
    console.warn(
      `[GoogleCalendar] google_instance_update_failed (patch) userId=${opts.userId} instanceId=${instanceId} reason=${(err as Error)?.message || err}`,
    );
    throw new CalendarRecurrenceError(
      "google_instance_update_failed",
      `Failed to patch Google Calendar instance: ${(err as Error)?.message || err}`,
      err,
    );
  }
}

/**
 * Split a recurring series at a chosen occurrence: truncate the
 * original master with `UNTIL=<instanceStart - 1s>` and insert a new
 * sibling recurring event starting at the selected occurrence with
 * the requested overrides applied. Returns both event ids so the
 * saga can persist the previous/next sibling relationship.
 *
 * Carefully preserves attendees, conferencing data, description,
 * location, reminders, and any custom Google extended properties on
 * the new sibling unless `changes` overrides them.
 */
export async function updateThisAndFollowing(opts: {
  userId: string;
  calendarId: string;
  seriesEventId: string;
  instanceOriginalStartTime: Date;
  changes: CalendarEventChanges;
  sendUpdates?: CalendarSendUpdates;
}): Promise<{ truncatedMasterId: string; newSeriesEventId: string; newSeriesRaw: any }> {
  const sendUpdates = opts.sendUpdates || "all";

  // 1) Read the existing master so we can preserve fields the caller
  //    didn't explicitly override on the sibling insert.
  let master: any;
  try {
    master = await calendarRequest(
      opts.userId,
      `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.seriesEventId)}`,
      { method: "GET" },
    );
  } catch (err) {
    throw new CalendarRecurrenceError(
      "google_series_split_failed",
      `Failed to read master event for split: ${(err as Error)?.message || err}`,
      err,
    );
  }

  const masterRecurrence: string[] = Array.isArray(master?.recurrence)
    ? master.recurrence.map((s: unknown) => String(s))
    : [];
  const rruleLine = masterRecurrence.find((l) => /^RRULE:/i.test(l));
  if (!rruleLine) {
    throw new CalendarRecurrenceError(
      "google_series_split_failed",
      `Master event ${opts.seriesEventId} has no RRULE — nothing to split`,
    );
  }

  // 2) Truncate the original master one second before the chosen
  //    instance so the previous occurrences remain and the chosen
  //    occurrence (and everything after) is removed from the series.
  const untilDate = new Date(opts.instanceOriginalStartTime.getTime() - 1000);
  const truncatedRrule = setRruleUntil(rruleLine, untilDate);
  const truncatedRecurrence = masterRecurrence.map((l) =>
    /^RRULE:/i.test(l) ? truncatedRrule : l,
  );

  try {
    await updateEvent({
      userId: opts.userId,
      calendarId: opts.calendarId,
      eventId: opts.seriesEventId,
      changes: { recurrence: truncatedRecurrence },
      sendUpdates,
    });
  } catch (err) {
    throw new CalendarRecurrenceError(
      "google_series_split_failed",
      `Failed to truncate master series ${opts.seriesEventId}: ${(err as Error)?.message || err}`,
      err,
    );
  }

  // 3) Build the sibling. Start from the master's payload so
  //    attendees / conferencing / description / extendedProperties
  //    survive, then layer the caller's `changes` on top.
  const masterTz: string | undefined =
    master?.start?.timeZone || master?.end?.timeZone || undefined;
  const masterStartIso: string =
    master?.start?.dateTime || master?.start?.date || master?.start || "";
  const masterEndIso: string =
    master?.end?.dateTime || master?.end?.date || master?.end || "";
  const masterStart = masterStartIso ? new Date(masterStartIso) : null;
  const masterEnd = masterEndIso ? new Date(masterEndIso) : null;
  const occurrenceDuration =
    masterStart && masterEnd
      ? masterEnd.getTime() - masterStart.getTime()
      : 0;

  const siblingStart =
    opts.changes.startUtc || opts.instanceOriginalStartTime;
  const siblingEnd =
    opts.changes.endUtc ||
    new Date(siblingStart.getTime() + occurrenceDuration);
  const siblingTz = opts.changes.timezone || masterTz || "UTC";

  const siblingBody: Record<string, unknown> = {
    summary:
      opts.changes.summary !== undefined
        ? opts.changes.summary.slice(0, 200)
        : master?.summary,
    description:
      opts.changes.description !== undefined
        ? opts.changes.description.slice(0, 8000)
        : master?.description,
    location:
      opts.changes.location !== undefined ? opts.changes.location : master?.location,
    start: { dateTime: siblingStart.toISOString(), timeZone: siblingTz },
    end: { dateTime: siblingEnd.toISOString(), timeZone: siblingTz },
    attendees:
      opts.changes.attendees !== undefined
        ? opts.changes.attendees.map((a) => ({
            email: a.email,
            displayName: a.displayName,
          }))
        : master?.attendees,
    recurrence:
      opts.changes.recurrence !== undefined
        ? opts.changes.recurrence
        : masterRecurrence,
    reminders: opts.changes.reminderOverrides
      ? {
          useDefault: false,
          overrides: opts.changes.reminderOverrides.slice(0, 5),
        }
      : master?.reminders || { useDefault: true },
  };
  if (master?.conferenceData) {
    siblingBody.conferenceData = master.conferenceData;
  }
  if (master?.extendedProperties) {
    siblingBody.extendedProperties = master.extendedProperties;
  }

  let newEvent: any;
  try {
    newEvent = await calendarRequest(
      opts.userId,
      `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events?sendUpdates=${sendUpdates}${master?.conferenceData ? "&conferenceDataVersion=1" : ""}`,
      { method: "POST", json: siblingBody },
    );
  } catch (err) {
    throw new CalendarRecurrenceError(
      "google_series_split_failed",
      `Failed to insert sibling series after truncating ${opts.seriesEventId}: ${(err as Error)?.message || err}`,
      err,
    );
  }
  if (!newEvent?.id) {
    throw new CalendarRecurrenceError(
      "google_series_split_failed",
      `Sibling insert for ${opts.seriesEventId} returned no event id`,
    );
  }

  console.info(
    `[GoogleCalendar] google_series_split userId=${opts.userId} calendarId=${opts.calendarId} truncatedMasterId=${opts.seriesEventId} newSeriesEventId=${newEvent.id} splitAt=${opts.instanceOriginalStartTime.toISOString()}`,
  );

  return {
    truncatedMasterId: opts.seriesEventId,
    newSeriesEventId: String(newEvent.id),
    newSeriesRaw: newEvent,
  };
}

/**
 * Expand a recurring event into concrete instances within a window.
 * Thin wrapper around `events.instances.list` for previews and
 * reconciliation. Includes deleted (cancelled) overrides so the
 * caller can detect per-instance cancellations.
 */
export async function listInstances(opts: {
  userId: string;
  calendarId: string;
  recurringEventId: string;
  timeMin: Date;
  timeMax: Date;
  maxResults?: number;
}): Promise<any[]> {
  const params = new URLSearchParams({
    timeMin: opts.timeMin.toISOString(),
    timeMax: opts.timeMax.toISOString(),
    showDeleted: "true",
    maxResults: String(opts.maxResults || 250),
  });
  const data = await calendarRequest(
    opts.userId,
    `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.recurringEventId)}/instances?${params.toString()}`,
    { method: "GET" },
  );
  return Array.isArray(data?.items) ? data.items : [];
}

export type DeleteEventScope = "this_event" | "this_and_following" | "entire_series";

export interface DeleteEventOptions {
  calendarId: string;
  eventId: string;
  scope?: DeleteEventScope;
  originalStartTime?: Date;
  sendUpdates?: CalendarSendUpdates;
}

/**
 * Delete or cancel an event. Backward-compatible with the legacy
 * positional form `deleteEvent(userId, calendarId, eventId)` (used
 * by the booking saga today; #1032D will migrate it to the options
 * form). When called with options, `scope` controls which slice of
 * a recurring series is removed:
 *   - `this_event`           → cancel only the named instance via
 *                              instance PATCH `status="cancelled"`.
 *   - `this_and_following`   → rewrite the master RRULE with
 *                              `UNTIL=<originalStart - 1s>` so
 *                              the named instance and everything
 *                              after it disappears from the series.
 *   - `entire_series`        → DELETE the master event.
 */
export async function deleteEvent(
  userId: string,
  calendarId: string,
  eventId: string,
): Promise<void>;
export async function deleteEvent(
  userId: string,
  options: DeleteEventOptions,
): Promise<void>;
export async function deleteEvent(
  userId: string,
  calendarIdOrOptions: string | DeleteEventOptions,
  legacyEventId?: string,
): Promise<void> {
  const opts: DeleteEventOptions =
    typeof calendarIdOrOptions === "string"
      ? {
          calendarId: calendarIdOrOptions,
          eventId: legacyEventId || "",
          scope: "entire_series",
        }
      : calendarIdOrOptions;
  const scope: DeleteEventScope = opts.scope || "entire_series";
  const sendUpdates = opts.sendUpdates || "all";

  if (scope === "this_event") {
    if (!opts.originalStartTime) {
      throw new Error(
        "deleteEvent: originalStartTime is required when scope=this_event",
      );
    }
    try {
      await updateInstance({
        userId,
        calendarId: opts.calendarId,
        recurringEventId: opts.eventId,
        originalStartTime: opts.originalStartTime,
        changes: { status: "cancelled" },
        sendUpdates,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (/\b(404|410)\b/.test(msg)) return;
      throw err;
    }
    return;
  }

  if (scope === "this_and_following") {
    if (!opts.originalStartTime) {
      throw new Error(
        "deleteEvent: originalStartTime is required when scope=this_and_following",
      );
    }
    let master: any;
    try {
      master = await calendarRequest(
        userId,
        `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}`,
        { method: "GET" },
      );
    } catch (err) {
      throw new CalendarRecurrenceError(
        "google_series_split_failed",
        `Failed to read master ${opts.eventId} for this_and_following delete: ${(err as Error)?.message || err}`,
        err,
      );
    }
    const recurrence: string[] = Array.isArray(master?.recurrence)
      ? master.recurrence.map((s: unknown) => String(s))
      : [];
    const rruleLine = recurrence.find((l) => /^RRULE:/i.test(l));
    if (!rruleLine) {
      // No recurrence — fall back to deleting the single event.
      try {
        await calendarRequest(
          userId,
          `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}?sendUpdates=${sendUpdates}`,
          { method: "DELETE" },
        );
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (/\b(404|410)\b/.test(msg)) return;
        throw err;
      }
      return;
    }
    const untilDate = new Date(opts.originalStartTime.getTime() - 1000);
    const truncated = recurrence.map((l) =>
      /^RRULE:/i.test(l) ? setRruleUntil(l, untilDate) : l,
    );
    try {
      await updateEvent({
        userId,
        calendarId: opts.calendarId,
        eventId: opts.eventId,
        changes: { recurrence: truncated },
        sendUpdates,
      });
      console.info(
        `[GoogleCalendar] google_series_truncated userId=${userId} calendarId=${opts.calendarId} eventId=${opts.eventId} until=${untilDate.toISOString()}`,
      );
    } catch (err) {
      throw new CalendarRecurrenceError(
        "google_series_split_failed",
        `Failed to truncate master ${opts.eventId} for this_and_following delete: ${(err as Error)?.message || err}`,
        err,
      );
    }
    return;
  }

  // scope === "entire_series" (also the legacy positional path)
  try {
    await calendarRequest(
      userId,
      `/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}?sendUpdates=${sendUpdates}`,
      { method: "DELETE" },
    );
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/\b(404|410)\b/.test(msg)) return; // already gone
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Status / disconnect
// ---------------------------------------------------------------------------

export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  status: string | null;
  lastRefreshAt: Date | null;
  lastError: string | null;
  scopes: string[] | null;
  missingScopes: string[];
}

export async function getStatus(userId: string): Promise<CalendarStatus> {
  const configured = isGoogleCalendarConfigured();
  const cred = await storage.getGoogleCalendarCredential(userId);
  if (!cred) {
    return {
      configured,
      connected: false,
      email: null,
      status: null,
      lastRefreshAt: null,
      lastError: null,
      scopes: null,
      missingScopes: [],
    };
  }
  const grantedList = (cred.scopes || "").split(/\s+/).filter(Boolean);
  const granted = new Set(grantedList);
  const missing = REQUIRED_SCOPES.filter(
    (s) => s !== "openid" && s !== "email" && s !== "profile" && !granted.has(s),
  );
  return {
    configured,
    connected: cred.status === "connected",
    email: cred.googleAccountEmail,
    status: cred.status,
    lastRefreshAt: cred.lastRefreshAt,
    lastError: cred.lastError,
    scopes: grantedList.length ? grantedList : null,
    missingScopes: missing,
  };
}

// ---------------------------------------------------------------------------
// Display timezone seeding (Task #1033)
//
// `users.timezone` controls how scheduling times are rendered for the
// logged-in user. We default it to whatever the user's connected Google
// Calendar account reports (settings.get('timezone')) so an AM doesn't
// have to hand-pick CST/EST/etc the moment they connect a calendar.
// `users.displayTimezoneSource` records WHO set the value:
//   - 'user'             → explicit pick in Profile (never overwrite)
//   - 'google_calendar'  → seeded by this helper (safe to refresh)
//   - NULL               → never set (safe to seed)
// ---------------------------------------------------------------------------

/**
 * Read the IANA timezone configured on the connected Google Calendar
 * account. Returns null on any error (no credential, transient outage,
 * scope issue) — the caller treats this as "leave the user's timezone
 * alone" rather than failing the connect flow.
 *
 * Endpoint: https://developers.google.com/calendar/api/v3/reference/settings/get
 */
export async function getGoogleCalendarTimezone(
  userId: string,
  opts?: { purpose?: string },
): Promise<string | null> {
  try {
    // Task #2286 / #2358 — best-effort timezone backfill is a
    // NON-authoritative read; default to a `proactive` purpose so a
    // transient auth blip / refresh-token rotation race here can never
    // durably disconnect a still-valid per-user calendar. The bare
    // `purpose: "proactive"` literal below is the file's own probe/health
    // refresh tag that scripts/lint-probe-refresh-purpose.ts verifies (it
    // must stay non-authoritative).
    const data = await calendarRequest(
      userId,
      "/calendar/v3/users/me/settings/timezone",
      {},
      true,
      opts?.purpose != null ? { purpose: opts.purpose } : { purpose: "proactive" },
    );
    const value = typeof data?.value === "string" ? data.value.trim() : "";
    if (!value) return null;
    // Sanity-check: must be a valid IANA identifier.
    try {
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat(undefined, { timeZone: value });
    } catch {
      return null;
    }
    return value;
  } catch (err) {
    console.warn(
      `[GoogleCalendar] Could not fetch settings timezone for user ${userId}: ${(err as any)?.message || err}`,
    );
    return null;
  }
}

/**
 * If the user has no explicit display-timezone preference, seed it from
 * their Google Calendar account's timezone setting. Idempotent and
 * safe to call from both the OAuth callback (first connect) and the
 * `/status` endpoint (one-time backfill for users connected before
 * this shipped). Never overwrites a 'user' source; will refresh a
 * stale 'google_calendar' source value.
 */
export async function seedDisplayTimezoneFromGoogleCalendar(
  userId: string,
): Promise<{ updated: boolean; timezone: string | null }> {
  const user = await storage.getUser(userId).catch(() => null);
  if (!user) return { updated: false, timezone: null };
  // Don't touch a value the user explicitly picked. Migration 0050
  // backfilled `display_timezone_source = 'user'` for every legacy
  // row that already carried a timezone value, so an unset
  // (`NULL`) source here truly means "the user has no preference
  // yet" and the seeder is safe to write.
  if (user.displayTimezoneSource === "user") {
    return { updated: false, timezone: user.timezone || null };
  }
  const tz = await getGoogleCalendarTimezone(userId);
  if (!tz) return { updated: false, timezone: user.timezone || null };
  if (
    user.timezone === tz &&
    user.displayTimezoneSource === "google_calendar"
  ) {
    return { updated: false, timezone: tz };
  }
  try {
    await storage.updateUserDisplayTimezone(userId, tz, "google_calendar");
    return { updated: true, timezone: tz };
  } catch (err) {
    console.warn(
      `[GoogleCalendar] Failed to seed display timezone for user ${userId}: ${(err as any)?.message || err}`,
    );
    return { updated: false, timezone: user.timezone || null };
  }
}

/**
 * Revoke at Google AND remove the stored credential. Best-effort: even if
 * Google rejects (already revoked), we still drop the local row.
 */
export async function disconnect(userId: string): Promise<void> {
  const cred = await storage.getGoogleCalendarCredential(userId);
  if (cred?.refreshTokenEncrypted) {
    try {
      const refreshToken = decryptToken(cred.refreshTokenEncrypted);
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
    } catch {
      // ignore — proceed to local cleanup regardless
    }
  }
  await storage.deleteGoogleCalendarCredential(userId);
}

export const GOOGLE_CALENDAR_REQUIRED_SCOPES = REQUIRED_SCOPES;
