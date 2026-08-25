// @periodic-request-pool-exception: boot-seeded ONE-SHOT startup profile sync (staggered setTimeout in schedulerInits, not recurring); the module is otherwise request-path Slack notify/webhook helpers — same one-shot precedent as postDeployVerification.
import { storage } from "../storage";

const SLACK_API_BASE = "https://slack.com/api";

const SETTINGS_KEY_BOT_TOKEN = "slack_bot_token";
const SETTINGS_KEY_LAST_SYNC = "slack_last_sync_at";

// In-process "last good" bot token. Task #2115 (follows the Task #2099
// Stripe / Task #2101 PandaDoc+Drive fixes): the token is read from
// `system_settings` through a read-through cache that falls back to a DB
// query. Under production DB-pool saturation that read can THROW
// (timeout / dropped connection). A read that *couldn't complete* must
// never be mistaken for "the operator removed the token" — that
// mis-resolution is what flapped the Integrations-Hub Slack card to
// "Not Connected" while a valid token sat in the DB. We only overwrite
// this on a *definitive* read (a real value, or a confirmed-empty/absent
// row); a thrown read falls back to the last value we positively saw in
// this process.
let cachedBotToken: string | null = null;

// Discriminated lookup result so callers can tell "confirmed no token"
// apart from "couldn't determine". Only `empty` may surface as
// `no_token_stored`; `unknown` must never downgrade the badge.
type SlackTokenResolution =
  | { status: "found"; token: string }
  | { status: "empty" }
  | { status: "unknown"; error: string };

async function resolveSlackBotToken(): Promise<SlackTokenResolution> {
  try {
    const setting = await storage.getSystemSetting(SETTINGS_KEY_BOT_TOKEN);
    const value = setting?.value?.trim() || "";
    if (value) {
      cachedBotToken = value;
      return { status: "found", token: value };
    }
    // Cached read returned empty — this may be a negative-cache sentinel
    // ({kind:"miss"}) written during a transient DB-pool saturation miss
    // (Task #2733). Before committing to "disconnected", confirm against the
    // authoritative cache-bypassing read. `getSystemSettingFresh` also
    // re-primes the cache so subsequent reads converge on truth.
    let fresh: Awaited<ReturnType<typeof storage.getSystemSettingFresh>>;
    try {
      fresh = await storage.getSystemSettingFresh(SETTINGS_KEY_BOT_TOKEN);
    } catch (freshErr: any) {
      // Authoritative read also failed — can't confirm absence. Fall through
      // to the existing throw-handler below by re-throwing with a clear label.
      throw new Error(
        `settings_fresh_read_failed: ${freshErr?.message ?? "unknown"}`,
      );
    }
    const freshValue = fresh?.value?.trim() || "";
    if (freshValue) {
      cachedBotToken = freshValue;
      return { status: "found", token: freshValue };
    }
    // Authoritative DB read also returned empty — real disconnect.
    cachedBotToken = null;
    return { status: "empty" };
  } catch (err: any) {
    // The settings read couldn't complete (DB timeout / dropped conn).
    // Prefer the last value we positively saw in this process; never
    // downgrade to "no token" off a failed read.
    if (cachedBotToken) return { status: "found", token: cachedBotToken };
    return { status: "unknown", error: err?.message ?? "settings_read_failed" };
  }
}

// Test seam (Task #2115): clear the in-process last-good so a test can
// exercise the "no last-good + read throws" path deterministically.
// Production code never calls this.
export function __resetSlackTokenCacheForTest(): void {
  cachedBotToken = null;
}

async function getBotToken(): Promise<string> {
  const resolution = await resolveSlackBotToken();
  if (resolution.status === "found") return resolution.token;
  if (resolution.status === "unknown") {
    throw new Error(`Slack credential lookup failed: ${resolution.error}`);
  }
  throw new Error("Slack not connected. Please add your Slack Bot Token in Settings → Integrations.");
}

export async function setToken(token: string, updatedBy?: string): Promise<void> {
  await storage.setSystemSetting(SETTINGS_KEY_BOT_TOKEN, token, updatedBy ?? "system");
  cachedBotToken = token;
  // Task #1968: record the connect event so audit history shows who
  // re-paste'd the token and when (companion to the clear-event audit
  // that's the primary goal of the task).
  try {
    await storage.recordAdminSettingChange({
      settingKey: SETTINGS_KEY_BOT_TOKEN,
      scope: "connect",
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: { event: "connect" },
    });
  } catch (err: any) {
    console.error("[Slack] connect audit insert failed:", err?.message);
  }
}

export async function isConnected(): Promise<boolean> {
  // Task #1602: while the auth breaker is open, report "not connected" so
  // alert dispatchers record `not_configured` (no destination to retry
  // against) instead of `failed` (transient delivery problem). This matches
  // operator intent — Slack effectively *is* unavailable until they re-auth.
  if (authBreakerActive()) return false;
  const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_BOT_TOKEN);
  if (tokenSetting?.value) return true;
  // Cached read returned empty — confirm against authoritative source before
  // reporting "not connected" (Task #2733: poisoned negative-cache miss guard).
  // If the fresh read throws, we can't confirm absence → treat as connected.
  try {
    const fresh = await storage.getSystemSettingFresh(SETTINGS_KEY_BOT_TOKEN);
    return !!fresh?.value;
  } catch {
    return true;
  }
}

/**
 * Task #1968 — every reason we ever clear the slack_bot_token. Recorded in
 * `admin_setting_audit` under `setting_key = "slack_bot_token"` with
 * `scope = trigger` so an admin can answer "who/what cleared the token?".
 */
export type SlackTokenClearTrigger =
  | "manual_disconnect"
  | "connect_terminal_auth_error";

export async function disconnect(
  updatedBy?: string,
  options?: { trigger?: SlackTokenClearTrigger; slackErrorCode?: string | null; notes?: string | null },
): Promise<void> {
  const trigger: SlackTokenClearTrigger = options?.trigger ?? "manual_disconnect";
  await storage.setSystemSetting(SETTINGS_KEY_BOT_TOKEN, "", updatedBy ?? "system");
  cachedBotToken = null;
  // Task #1968: persist a breadcrumb for every clear so we can tell apart
  // a stray "Disconnect" click from a self-wipe by the connect handler.
  try {
    await storage.recordAdminSettingChange({
      settingKey: SETTINGS_KEY_BOT_TOKEN,
      scope: trigger,
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: {
        event: "disconnect",
        trigger,
        slackErrorCode: options?.slackErrorCode ?? null,
        notes: options?.notes ?? null,
      },
    });
  } catch (err: any) {
    console.error("[Slack] disconnect audit insert failed:", err?.message);
  }

  // Task #1978: when the token was *auto*-cleared by a terminal Slack auth
  // error (not a manual "Disconnect" click), proactively ping the
  // integrations owners so they re-connect before downstream features fail.
  // Best-effort + persisted cooldown; never blocks the clear.
  if (trigger === "connect_terminal_auth_error") {
    try {
      const { notifyIntegrationTokenCleared } = await import(
        "./integrationTokenClearedAlerts"
      );
      await notifyIntegrationTokenCleared({
        provider: "slack",
        providerLabel: "Slack",
        errorCode: options?.slackErrorCode ?? null,
        trigger,
      });
    } catch (err: any) {
      console.warn(
        "[Slack] auto-clear notification failed:",
        err?.message ?? err,
      );
    }
  }
}

export const SLACK_BOT_TOKEN_SETTING_KEY = SETTINGS_KEY_BOT_TOKEN;

const SLACK_MAX_429_RETRIES = 5;

// Task #1602 — Slack auth circuit breaker.
//
// Background: on May 18 2026 the `slack_bot_token` setting was populated but
// the token had been revoked, so every alert dispatch threw
// `Slack API error: invalid_auth`. The `background_ingestion_saturation_window`
// metric fired ~once/minute and produced **163 failed dispatches in 2 hours**,
// each one a wasted Slack API round-trip and a "failed" row in
// `manual_reserve_alert_dispatches`. The token cannot self-heal — only an
// operator re-auth fixes it — so retrying at full speed is pure noise.
//
// This breaker trips on terminal auth errors (`invalid_auth`, `not_authed`,
// `account_inactive`, `token_revoked`, `token_expired`, `invalid_token`,
// `missing_scope`) and short-circuits subsequent calls for `AUTH_BREAKER_MS`
// (default 5 min). During the cooldown:
//   - `slackApi*` throws immediately without hitting the network.
//   - `isConnected()` returns false, so alert pipelines record
//     `not_configured` ("Slack integration not connected") instead of `failed`
//     and stop spamming the dispatch table.
//   - One throttled `console.error` is emitted per cooldown window so the
//     operator sees a single loud line, not 163 stack traces.
// Successful auth calls (`auth.test`) immediately reset the breaker, so
// re-auth via `POST /api/integrations/slack/test` recovers without a restart.
const AUTH_BREAKER_MS = 5 * 60 * 1000;
const TERMINAL_AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "invalid_token",
  "missing_scope",
  "no_permission",
]);
let authBrokenUntilMs = 0;
let lastAuthErrorCode: string | null = null;
let lastAuthBreakerLogAt = 0;
// Task #1610 — minimal breaker introspection for the sustained-breaker
// watcher (`slackAuthBreakerStuckAlerts.ts`). These counters/timestamps
// are read-only side effects of the existing breaker control flow:
// — `lastTrippedAtMs` updates each time a terminal auth error trips.
// — `lastTrippedCodeSticky` is the last terminal code (stays set across
//   the auto-close so the watcher can name the failure mode).
// — `lastSuccessAtMs` updates on every successful Slack call (including
//   `auth.test`), so the watcher can compute minutes-since-last-success.
// — `tripCount` is a monotonic counter; never decremented, only reset
//   in tests via `__resetSlackAuthBreakerForTest`.
let lastTrippedAtMs: number | null = null;
let lastTrippedCodeSticky: string | null = null;
let lastSuccessAtMs: number | null = null;
let tripCount = 0;

function authBreakerActive(): boolean {
  return Date.now() < authBrokenUntilMs;
}

function tripAuthBreaker(errorCode: string): void {
  const now = Date.now();
  authBrokenUntilMs = now + AUTH_BREAKER_MS;
  lastAuthErrorCode = errorCode;
  lastTrippedAtMs = now;
  lastTrippedCodeSticky = errorCode;
  tripCount += 1;
  if (now - lastAuthBreakerLogAt > AUTH_BREAKER_MS) {
    lastAuthBreakerLogAt = now;
    console.error(
      `[Slack] Auth breaker tripped (${errorCode}). Suppressing Slack API calls for ${Math.round(AUTH_BREAKER_MS / 60000)} min. Operator action required: re-auth Slack in Settings → Integrations.`,
    );
  }
}

function recordSlackCallSuccess(): void {
  lastSuccessAtMs = Date.now();
}

function resetAuthBreaker(): void {
  authBrokenUntilMs = 0;
  lastAuthErrorCode = null;
}

function authBreakerError(): Error {
  const remainingMs = Math.max(0, authBrokenUntilMs - Date.now());
  return new Error(
    `Slack API error: ${lastAuthErrorCode || "invalid_auth"} (auth breaker open, retry in ${Math.ceil(remainingMs / 1000)}s)`,
  );
}

/**
 * Inspect the in-memory Slack auth-breaker state. Used by callers
 * (notification dispatcher, admin diagnostics) that need to distinguish
 * "Slack hasn't been configured yet" from "Slack token is revoked and we're
 * sitting in cooldown".
 */
export function getSlackAuthState(): {
  authBroken: boolean;
  errorCode: string | null;
  cooldownRemainingMs: number;
  // Task #1610 — fields consumed by the sustained-breaker watcher.
  breakerOpen: boolean;
  openedUntil: string | null;
  lastTrippedAt: string | null;
  lastTrippedCode: string | null;
  lastSuccessAt: string | null;
  tripCount: number;
} {
  const remaining = Math.max(0, authBrokenUntilMs - Date.now());
  const breakerOpen = remaining > 0;
  return {
    authBroken: breakerOpen,
    errorCode: breakerOpen ? lastAuthErrorCode : null,
    cooldownRemainingMs: remaining,
    breakerOpen,
    openedUntil: authBrokenUntilMs > 0 ? new Date(authBrokenUntilMs).toISOString() : null,
    lastTrippedAt: lastTrippedAtMs ? new Date(lastTrippedAtMs).toISOString() : null,
    lastTrippedCode: lastTrippedCodeSticky,
    lastSuccessAt: lastSuccessAtMs ? new Date(lastSuccessAtMs).toISOString() : null,
    tripCount,
  };
}

/** Test-only: clear the breaker between cases. Production never calls this. */
export function __resetSlackAuthBreakerForTest(): void {
  resetAuthBreaker();
  lastAuthBreakerLogAt = 0;
  lastTrippedAtMs = null;
  lastTrippedCodeSticky = null;
  lastSuccessAtMs = null;
  tripCount = 0;
}

/**
 * Test-only: directly set the breaker's introspection fields. Used by
 * the Task #1610 sustained-breaker watcher tests to synthesize a
 * "Slack recovered N minutes after the stuck alert" state without
 * having to schedule real wall-clock waits. Production never calls
 * this.
 */
export function __setSlackAuthStateForTest(args: {
  lastTrippedAtMs?: number | null;
  lastTrippedCode?: string | null;
  lastSuccessAtMs?: number | null;
  breakerOpenUntilMs?: number;
  tripCount?: number;
}): void {
  if (args.lastTrippedAtMs !== undefined) lastTrippedAtMs = args.lastTrippedAtMs;
  if (args.lastTrippedCode !== undefined) lastTrippedCodeSticky = args.lastTrippedCode;
  if (args.lastSuccessAtMs !== undefined) lastSuccessAtMs = args.lastSuccessAtMs;
  if (args.breakerOpenUntilMs !== undefined) authBrokenUntilMs = args.breakerOpenUntilMs;
  if (args.tripCount !== undefined) tripCount = args.tripCount;
}

async function slackApiRequest(method: string, params: Record<string, string> = {}, attempt = 0): Promise<any> {
  // auth.test bypasses the breaker — it's the recovery path. Every other
  // method short-circuits while the breaker is open.
  if (method !== "auth.test" && authBreakerActive()) {
    throw authBreakerError();
  }
  const token = await getBotToken();

  const url = new URL(`${SLACK_API_BASE}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (res.status === 429) {
    // Audit Track B (Task #1572): cap recursion. Slack's tiered rate
    // limits can return long Retry-After windows; unbounded recursion
    // would hold a worker for hours and risk stack growth on bursty
    // 429s. Cap and surface a clear error so the caller can re-enqueue.
    if (attempt >= SLACK_MAX_429_RETRIES) {
      throw new Error(`Slack API ${method} rate-limited after ${SLACK_MAX_429_RETRIES} retries`);
    }
    const retryAfter = Number(res.headers.get("Retry-After") || 5);
    console.log(`[Slack] Rate limited on ${method} (attempt ${attempt + 1}/${SLACK_MAX_429_RETRIES}), retrying in ${retryAfter}s`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return slackApiRequest(method, params, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (!data.ok) {
    const code = String(data.error || "unknown error");
    if (TERMINAL_AUTH_ERRORS.has(code)) tripAuthBreaker(code);
    throw new Error(`Slack API error: ${code}`);
  }

  // A successful call (especially auth.test) means the token is healthy —
  // clear any prior breaker state so the next failure starts a fresh window.
  if (method === "auth.test" && authBrokenUntilMs > 0) resetAuthBreaker();
  recordSlackCallSuccess();

  return data;
}

interface SlackApiPostOptions {
  signal?: AbortSignal;
  max429Retries?: number;
}

async function waitForSlackRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function slackApiPost(
  method: string,
  body: Record<string, any>,
  options: SlackApiPostOptions = {},
  attempt = 0,
): Promise<any> {
  if (authBreakerActive()) {
    throw authBreakerError();
  }
  const token = await getBotToken();
  const res = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (res.status === 429) {
    const max429Retries = options.max429Retries ?? SLACK_MAX_429_RETRIES;
    if (max429Retries === 0) {
      throw new Error("Slack API error: rate_limited");
    }
    // Audit Track B (Task #1572): cap recursion (see slackApiRequest).
    if (attempt >= max429Retries) {
      throw new Error(`Slack API ${method} rate-limited after ${max429Retries} retries`);
    }
    const retryAfter = Number(res.headers.get("Retry-After") || 5);
    console.log(`[Slack] Rate limited on ${method} POST (attempt ${attempt + 1}/${max429Retries}), retrying in ${retryAfter}s`);
    await waitForSlackRetry(retryAfter * 1000, options.signal);
    return slackApiPost(method, body, options, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (!data.ok) {
    const code = String(data.error || "unknown error");
    if (TERMINAL_AUTH_ERRORS.has(code)) tripAuthBreaker(code);
    throw new Error(`Slack API error: ${code}`);
  }
  recordSlackCallSuccess();
  return data;
}

export async function postMessage(channel: string, text: string, blocks?: any[]): Promise<void> {
  const body: Record<string, any> = { channel, text };
  if (blocks) body.blocks = blocks;
  await slackApiPost("chat.postMessage", body);
}

/**
 * One network attempt with abort support. This is intentionally separate from
 * postMessage(): callers with an at-most-once delivery contract must not
 * inherit the shared 429 retry loop after an uncertain post outcome.
 */
export async function postMessageOnce(
  channel: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  await slackApiPost(
    "chat.postMessage",
    { channel, text },
    { signal, max429Retries: 0 },
  );
}

/**
 * Task #1687 — open a DM channel with a Slack user id and return the
 * channel id. Bot scope required: `im:write`. Exported as a thin
 * wrapper so the per-user DM sender doesn't depend on the private
 * `slackApiPost` symbol.
 */
export async function openDmChannel(slackUserId: string): Promise<string> {
  const data = await slackApiPost("conversations.open", { users: slackUserId });
  const id = data?.channel?.id;
  if (!id) throw new Error("Slack API error: conversations.open returned no channel");
  return id;
}

/** Task #1687 — return the workspace team id (used to stamp
 *  `user_slack_identities.slack_team_id`). Best-effort; returns null
 *  rather than throwing so identity linking never fails on this. */
export async function getCurrentTeamId(): Promise<string | null> {
  try {
    const data = await slackApiRequest("auth.test");
    return data?.team_id ?? null;
  } catch {
    return null;
  }
}

export async function lookupUserByEmail(email: string): Promise<string | null> {
  try {
    const data = await slackApiRequest("users.lookupByEmail", { email });
    return data.user?.id || null;
  } catch {
    return null;
  }
}

export async function testConnection(): Promise<{ ok: boolean; team?: string; user?: string; error?: string }> {
  try {
    // Task #1842: wrap the outbound probe with the external-call audit
    // so /api/integrations/all-status volume is observable in
    // `/admin/db-attribution/trends` alongside Front/Zoom/SEMrush.
    // No-op overhead when `external_call_audit_enabled` is off.
    const { auditOutboundCall } = await import("./externalCallAudit");
    const data = await auditOutboundCall(
      { integration: "slack", endpoint: "auth.test", method: "GET", callerLabel: "slack:testConnection" },
      () => slackApiRequest("auth.test"),
    );
    return { ok: true, team: data.team, user: data.user };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// Task #1876 — Slack probe outcome classification (mirrors the Front
// pattern from Task #1861). The Integrations-Hub status loader uses
// this instead of the older `isConnected() + testConnection()` pair so
// that:
//   - A transient probe failure (network, 5xx, 429, HTML body, partial
//     JSON, breaker-already-open with another transient on top) returns
//     `probe_failed` → the cache `preserve`s the last-known-good badge
//     instead of flipping to Not Connected.
//   - Only a confirmed missing token OR a terminal Slack auth code from
//     `auth.test` returns `unauthorized` → the badge legitimately flips.
//   - `auth.test` already bypasses the open breaker
//     (`slackApiRequest`), so a successful probe immediately recovers the
//     breaker and the UI without waiting out the 5-minute window.
export type SlackProbeOutcome = "connected" | "unauthorized" | "probe_failed";

export interface SlackProbeResult {
  outcome: SlackProbeOutcome;
  reason?: string;
  team?: string | null;
  /** True iff the breaker is currently in its cooldown window. */
  breakerOpen?: boolean;
  /** Cooldown remaining in ms when `breakerOpen` is true. */
  cooldownRemainingMs?: number;
}

/**
 * Codes that mean "Slack rejected this token for a reason an operator
 * has to fix." Subset of `TERMINAL_AUTH_ERRORS` — scope-related codes
 * (`missing_scope`, `no_permission`) are deliberately NOT here for the
 * badge: a token can be authenticated but missing a scope, and we
 * don't want the Integrations-Hub badge to lie about auth on that.
 * Those still trip the breaker via `TERMINAL_AUTH_ERRORS` so we stop
 * hammering Slack, but they're treated as transient for the badge.
 */
const TERMINAL_PROBE_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "invalid_token",
]);

/**
 * Task #1968: the connect handler imports this to decide whether a
 * probe `unauthorized` outcome warrants clearing the saved bot token.
 * Only terminal Slack auth codes qualify — `no_token_stored` (a
 * stale-read / missed-read after `setToken`) and anything else does
 * not, and the token must be preserved.
 */
export function isTerminalSlackAuthCode(code: string | null | undefined): boolean {
  return !!code && TERMINAL_PROBE_ERRORS.has(code);
}

/**
 * Task #2064 — plain-English explanations for the Slack error codes an
 * operator can actually act on. Used to record human-readable reasons on
 * feedback rows (and to surface a non-alarming notice to the submitter)
 * instead of leaking raw `Slack API error: token_revoked` strings.
 *
 * Verified against the current Slack Web API docs for `auth.test`
 * (https://docs.slack.dev/reference/methods/auth.test/) and
 * `chat.postMessage` error fields (channel_not_found / not_in_channel /
 * is_archived) — May 2026.
 */
const SLACK_REASON_TEXT: Record<string, string> = {
  // Terminal auth — operator must re-connect Slack.
  invalid_auth: "Slack rejected the saved token (invalid). Reconnect Slack.",
  not_authed: "No Slack token was sent. Reconnect Slack.",
  account_inactive: "The Slack account or bot is deactivated. Reconnect Slack.",
  token_revoked: "The Slack token was revoked. Reconnect Slack.",
  token_expired: "The Slack token has expired. Reconnect Slack.",
  invalid_token: "The Slack token is not valid. Reconnect Slack.",
  no_token_stored: "Slack is not connected. Reconnect Slack.",
  // Scope / membership / channel problems — reconnect or re-invite the bot.
  missing_scope: "The Slack token is missing a required permission scope.",
  no_permission: "The Slack token lacks permission for this action.",
  channel_not_found: "The target Slack channel could not be found.",
  not_in_channel: "The Slack bot is not a member of the target channel.",
  is_archived: "The target Slack channel is archived.",
  rate_limited: "Slack is rate-limiting requests right now. Try again shortly.",
};

/**
 * Map a Slack error code (or `null`) to operator-readable text. Falls
 * back to a generic message that still names the raw code so unmapped
 * failures remain debuggable.
 */
export function plainEnglishSlackReason(code: string | null | undefined): string {
  if (!code) return "Slack is not connected. Reconnect Slack.";
  return SLACK_REASON_TEXT[code] ?? `Slack rejected the request (${code}).`;
}

/**
 * Extract the Slack error code from an Error thrown by `postMessage` /
 * `slackApiRequest`. Those throw `Slack API error: <code>` for ok:false
 * responses and `Slack API error: <status> <body>` for HTTP failures.
 * Returns the bare code when present (e.g. `channel_not_found`), else null.
 */
export function parseSlackErrorCode(message: string | null | undefined): string | null {
  if (!message) return null;
  const m = /^Slack API error: ([a-z_]+)$/i.exec(String(message).trim());
  return m ? m[1] : null;
}

export async function probeConnection(): Promise<SlackProbeResult> {
  const remaining = Math.max(0, authBrokenUntilMs - Date.now());
  const breakerOpen = remaining > 0;

  // Task #2115: distinguish "confirmed no token" from "couldn't read the
  // token". A degraded-DB read that THREW must surface `probe_failed` so
  // the cache preserves the last-known badge — never `no_token_stored`,
  // which would commit the Slack card to Not Connected. The resolver also
  // recovers from the in-process last-good when one exists.
  const resolution = await resolveSlackBotToken();
  if (resolution.status === "unknown") {
    return {
      outcome: "probe_failed",
      reason: `token_lookup_failed: ${resolution.error}`.slice(0, 120),
      breakerOpen,
      cooldownRemainingMs: remaining,
    };
  }
  if (resolution.status === "empty") {
    return { outcome: "unauthorized", reason: "no_token_stored" };
  }

  try {
    // `auth.test` bypasses an open breaker (see slackApiRequest). If it
    // succeeds, the breaker auto-clears. If it fails terminally, the
    // breaker re-trips. If it fails transiently, the breaker stays
    // whatever it was — and we report `probe_failed` so the cache
    // preserves the last-known-good badge.
    const { auditOutboundCall } = await import("./externalCallAudit");
    const data = await auditOutboundCall(
      { integration: "slack", endpoint: "auth.test", method: "GET", callerLabel: "slack:probeConnection" },
      () => slackApiRequest("auth.test"),
    );
    return {
      outcome: "connected",
      team: data?.team ?? null,
      breakerOpen: false,
      cooldownRemainingMs: 0,
    };
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    // Slack-shaped error: "Slack API error: <code>" or "Slack API error: <status> <body>"
    // The breaker-open synthetic error also matches the prefix but ends with
    // "(auth breaker open, retry in Ns)" — treat as transient.
    if (/auth breaker open/i.test(msg)) {
      return {
        outcome: "probe_failed",
        reason: "breaker_open_recovering",
        breakerOpen: true,
        cooldownRemainingMs: Math.max(0, authBrokenUntilMs - Date.now()),
      };
    }
    const codeMatch = /^Slack API error: ([a-z_]+)$/i.exec(msg);
    const code = codeMatch?.[1];
    if (code && TERMINAL_PROBE_ERRORS.has(code)) {
      return { outcome: "unauthorized", reason: code, breakerOpen, cooldownRemainingMs: remaining };
    }
    // Anything else (HTTP 5xx, 429, network error, HTML body, partial
    // JSON, rate_limited body, missing_scope, no_permission, unknown
    // ok:false) is transient.
    const shortReason = code ?? (msg ? msg.slice(0, 120) : "probe_threw");
    return { outcome: "probe_failed", reason: shortReason, breakerOpen, cooldownRemainingMs: remaining };
  }
}

export interface SlackChannel {
  id: string;
  name: string;
  is_member: boolean;
  is_private: boolean;
  num_members: number;
  topic?: string;
  purpose?: string;
}

export async function listChannels(): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor = "";

  do {
    const params: Record<string, string> = {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    };
    if (cursor) params.cursor = cursor;

    const data = await slackApiRequest("conversations.list", params);
    for (const ch of (data.channels || [])) {
      channels.push({
        id: ch.id,
        name: ch.name,
        is_member: ch.is_member || false,
        is_private: ch.is_private || false,
        num_members: ch.num_members || 0,
        topic: ch.topic?.value,
        purpose: ch.purpose?.value,
      });
    }
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);

  return channels;
}

export interface SlackChannelInfo {
  id: string;
  name: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isMember: boolean;
  numMembers: number | null;
  topic: string | null;
  purpose: string | null;
  teamId: string | null;
}

export async function getChannelInfo(channelId: string): Promise<SlackChannelInfo | null> {
  try {
    const data = await slackApiRequest("conversations.info", {
      channel: channelId,
      include_num_members: "true",
    });
    const ch = data.channel;
    if (!ch) return null;
    return {
      id: ch.id,
      name: ch.name ?? null,
      isPrivate: !!ch.is_private,
      isArchived: !!ch.is_archived,
      isMember: !!ch.is_member,
      numMembers: typeof ch.num_members === "number" ? ch.num_members : null,
      topic: ch.topic?.value ?? null,
      purpose: ch.purpose?.value ?? null,
      teamId: ch.shared_team_ids?.[0] || ch.context_team_id || ch.team || null,
    };
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (/channel_not_found|missing_scope|not_in_channel|account_inactive|is_archived/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

export interface SlackWorkspaceInfo {
  teamId: string | null;
  teamName: string | null;
  url: string | null;
}

export async function getWorkspaceInfo(): Promise<SlackWorkspaceInfo> {
  const data = await slackApiRequest("auth.test");
  return {
    teamId: data.team_id ?? null,
    teamName: data.team ?? null,
    url: data.url ?? null,
  };
}

export interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  type: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  channel: string;
  channelName: string;
  username?: string;
  bot_id?: string;
}

export async function fetchChannelMessages(
  channelId: string,
  channelName: string,
  oldest?: string,
  limit = 200
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor = "";

  do {
    const params: Record<string, string> = {
      channel: channelId,
      limit: String(Math.min(limit - messages.length, 200)),
    };
    if (oldest) params.oldest = oldest;
    if (cursor) params.cursor = cursor;

    const data = await slackApiRequest("conversations.history", params);
    for (const msg of (data.messages || [])) {
      if (msg.subtype === "channel_join" || msg.subtype === "channel_leave") continue;
      messages.push({
        ...msg,
        channel: channelId,
        channelName,
      });
    }
    cursor = data.response_metadata?.next_cursor || "";
    if (messages.length >= limit) break;
  } while (cursor);

  return messages;
}

export async function fetchThreadReplies(
  channelId: string,
  channelName: string,
  threadTs: string
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor = "";

  do {
    const params: Record<string, string> = {
      channel: channelId,
      ts: threadTs,
      limit: "200",
    };
    if (cursor) params.cursor = cursor;

    const data = await slackApiRequest("conversations.replies", params);
    for (const msg of (data.messages || [])) {
      if (msg.ts === threadTs) continue;
      messages.push({
        ...msg,
        channel: channelId,
        channelName,
      });
    }
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);

  return messages;
}

async function getUserInfo(userId: string): Promise<{ name: string; email?: string }> {
  try {
    const data = await slackApiRequest("users.info", { user: userId });
    const profile = data.user?.profile || {};
    return {
      name: profile.display_name || profile.real_name || data.user?.name || userId,
      email: profile.email,
    };
  } catch {
    return { name: userId };
  }
}

// Task #2897 (Reserved VM memory audit) — keyed by Slack user id, an
// unbounded key space over a weeks-long uptime, so capped with
// oldest-insertion eviction. An evicted user simply re-fetches on next use.
const USER_CACHE_CAP = 2000;
const userCache = new Map<string, { name: string; email?: string }>();

async function getCachedUserInfo(userId: string): Promise<{ name: string; email?: string }> {
  if (userCache.has(userId)) return userCache.get(userId)!;
  const info = await getUserInfo(userId);
  userCache.set(userId, info);
  while (userCache.size > USER_CACHE_CAP) {
    const oldest = userCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    userCache.delete(oldest);
  }
  return info;
}

function buildExternalSourceId(channelId: string, messageTs: string): string {
  return `slack:${channelId}:${messageTs}`;
}

export interface SlackSyncResult {
  channelsProcessed: number;
  messagesCreated: number;
  messagesSkipped: number;
  errors: string[];
}

export async function syncAllChannels(userId: string): Promise<SlackSyncResult> {
  const { startSyncProgress, updateSyncProgress, completeSyncCycle } = await import("./syncProgressTracker");
  const result: SlackSyncResult = {
    channelsProcessed: 0,
    messagesCreated: 0,
    messagesSkipped: 0,
    errors: [],
  };

  const syncRecord = await storage.createSlackSyncHistory({
    triggeredBy: userId,
    status: "running",
    channelsProcessed: 0,
    messagesCreated: 0,
    messagesSkipped: 0,
    errors: [],
  });

  startSyncProgress("slack");
  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalDismissed = 0;

  try {
    const allChannels = await listChannels();
    const memberChannels = allChannels.filter(ch => ch.is_member);
    if (memberChannels.length === 0) {
      await storage.updateSlackSyncHistory(syncRecord.id, {
        status: "completed",
        completedAt: new Date(),
      });
      completeSyncCycle("slack", { matched: 0, unmatched: 0, skipped: 0, total: 0 });
      return result;
    }

    const allClients = await storage.getClients();
    const lastSyncSetting = await storage.getSystemSetting(SETTINGS_KEY_LAST_SYNC);
    const oldest = lastSyncSetting?.value || undefined;

    for (const channel of memberChannels) {
      try {
        const channelResult = await syncChannel(
          channel.id,
          channel.name,
          null,
          userId,
          allClients,
          oldest
        );
        result.channelsProcessed++;
        result.messagesCreated += channelResult.created;
        result.messagesSkipped += channelResult.skipped;
        totalMatched += channelResult.matched;
        totalUnmatched += channelResult.unmatched;
        totalDismissed += channelResult.dismissed;
        if (channelResult.errors.length > 0) {
          result.errors.push(...channelResult.errors);
        }
        updateSyncProgress("slack", {
          currentPage: result.channelsProcessed,
          conversationsScanned: result.messagesCreated + result.messagesSkipped,
          conversationsKept: result.messagesCreated,
          conversationsFiltered: result.messagesSkipped,
        });
      } catch (err: any) {
        result.errors.push(`Channel ${channel.name}: ${err.message}`);
      }
    }

    await storage.setSystemSetting(SETTINGS_KEY_LAST_SYNC, String(Math.floor(Date.now() / 1000)), "system");
    await storage.updateSlackSyncHistory(syncRecord.id, {
      status: result.errors.length > 0 ? "completed_with_errors" : "completed",
      channelsProcessed: result.channelsProcessed,
      messagesCreated: result.messagesCreated,
      messagesSkipped: result.messagesSkipped,
      errors: result.errors.length > 0 ? result.errors : null,
      completedAt: new Date(),
    });

    completeSyncCycle("slack", {
      matched: totalMatched,
      unmatched: totalUnmatched,
      skipped: result.messagesSkipped + totalDismissed,
      total: result.messagesCreated + result.messagesSkipped,
    });
  } catch (err: any) {
    await storage.updateSlackSyncHistory(syncRecord.id, {
      status: "failed",
      errors: [err.message],
      completedAt: new Date(),
    });
    completeSyncCycle("slack", { matched: 0, unmatched: 0, skipped: 0, total: 0 });
    throw err;
  }

  return result;
}

async function syncChannel(
  channelId: string,
  channelName: string,
  mappedClientId: string | null,
  userId: string,
  allClients: any[],
  oldest?: string
): Promise<{ created: number; skipped: number; matched: number; unmatched: number; dismissed: number; errors: string[] }> {
  const channelResult = { created: 0, skipped: 0, matched: 0, unmatched: 0, dismissed: 0, errors: [] as string[] };

  const messages = await fetchChannelMessages(channelId, channelName, oldest);

  for (const msg of messages) {
    try {
      if (!msg.ts) {
        channelResult.skipped++;
        continue;
      }

      const externalSourceId = buildExternalSourceId(channelId, msg.ts);
      const existing = await storage.findRawCommunicationByExternalSourceId(externalSourceId);
      if (existing) {
        channelResult.skipped++;
        continue;
      }

      let clientId = mappedClientId || attemptClientMatch(channelName, msg.text, allClients);
      let matchMethod: string | null = null;
      let matchConfidence: number | null = null;

      if (mappedClientId) {
        matchMethod = "channel_mapping";
        matchConfidence = 1.0;
      } else if (clientId) {
        matchMethod = "name_match";
        matchConfidence = 0.8;
      }

      // Task #2637 — Slack matching is deterministic only: channel→client
      // mapping or channel-name match. No operational classifier, no AI
      // agent matcher, no fuzzy content matching.
      if (!clientId) {
        matchMethod = null;
        matchConfidence = null;
        console.log(`[Slack] No client match for message in #${channelName} (ts: ${msg.ts}), saving as unmatched`);
      }

      const userInfo = msg.user
        ? await getCachedUserInfo(msg.user)
        : { name: msg.username || msg.bot_id || "System", email: undefined };
      const isThreadParent = msg.reply_count && msg.reply_count > 0;
      const sourceSubtype = msg.thread_ts && msg.thread_ts !== msg.ts ? "slack_thread" : "slack_channel";

      const record = await storage.createRawCommunication({
        clientId: clientId,
        sourceType: "slack",
        sourceSubtype,
        title: `#${channelName}: ${msg.text?.substring(0, 80) || "(no text)"}`,
        timestamp: new Date(parseFloat(msg.ts) * 1000),
        direction: "internal",
        participantsJson: [{ name: userInfo.name, email: userInfo.email, role: "team" }],
        externalSourceId,
        externalThreadId: msg.thread_ts ? buildExternalSourceId(channelId, msg.thread_ts) : undefined,
        externalUrl: `https://slack.com/archives/${channelId}/p${msg.ts.replace(".", "")}`,
        contentText: msg.text || "",
        contentPreview: (msg.text || "").substring(0, 200),
        rawPayloadJson: { channelId, channelName, user: msg.user, ts: msg.ts, thread_ts: msg.thread_ts },
        processingStatus: "pending",
        reviewStatus: "unreviewed",
        matchMethod: matchMethod,
        matchConfidence: matchConfidence,
        matchStatus: clientId ? "matched" : "unmatched",
        operationalClassificationReason: null,
        createdBy: userId,
      });

      channelResult.created++;
      if (clientId) {
        channelResult.matched++;
      } else {
        channelResult.unmatched++;
      }

      if (isThreadParent) {
        try {
          const replies = await fetchThreadReplies(channelId, channelName, msg.ts);
          for (const reply of replies) {
            const replyExternalId = buildExternalSourceId(channelId, reply.ts);
            const existingReply = await storage.findRawCommunicationByExternalSourceId(replyExternalId);
            if (existingReply) {
              channelResult.skipped++;
              continue;
            }

            const replyUserInfo = reply.user
              ? await getCachedUserInfo(reply.user)
              : { name: reply.username || reply.bot_id || "System", email: undefined };

            await storage.createRawCommunication({
              clientId: clientId,
              sourceType: "slack",
              sourceSubtype: "slack_thread",
              title: `#${channelName} (thread): ${reply.text?.substring(0, 80) || "(no text)"}`,
              timestamp: new Date(parseFloat(reply.ts) * 1000),
              direction: "internal",
              participantsJson: [{ name: replyUserInfo.name, email: replyUserInfo.email, role: "team" }],
              externalSourceId: replyExternalId,
              externalThreadId: buildExternalSourceId(channelId, msg.ts),
              externalUrl: `https://slack.com/archives/${channelId}/p${reply.ts.replace(".", "")}`,
              contentText: reply.text || "",
              contentPreview: (reply.text || "").substring(0, 200),
              rawPayloadJson: { channelId, channelName, user: reply.user, ts: reply.ts, thread_ts: msg.ts },
              processingStatus: "pending",
              reviewStatus: "unreviewed",
              matchMethod: matchMethod,
              matchConfidence: matchConfidence,
              matchStatus: clientId ? "matched" : "unmatched",
              operationalClassificationReason: null,
              createdBy: userId,
            });
            channelResult.created++;
            if (clientId) {
              channelResult.matched++;
            } else {
              channelResult.unmatched++;
            }
          }
        } catch (err: any) {
          channelResult.errors.push(`Thread ${msg.ts}: ${err.message}`);
        }
      }

      // fire-and-forget: background analysis, rejections handled inside the IIFE
      void (async () => {
        try {
          const { analyzeCommunication } = await import("./communicationAnalysis");
          await analyzeCommunication(record.id);
        } catch (err) {
          console.error("[Slack] Background analysis failed for", record.id, err);
        }
      })();
    } catch (err: any) {
      channelResult.errors.push(`Message ${msg.ts}: ${err.message}`);
    }
  }

  return channelResult;
}

function attemptClientMatch(channelName: string, messageText: string, clients: any[]): string | null {
  const channelLower = channelName.toLowerCase().replace(/[_-]/g, " ");

  for (const client of clients) {
    const firmName = (client.firmName || "").toLowerCase();
    const clientCode = (client.clientCode || "").toLowerCase();
    if (firmName && channelLower.includes(firmName)) return client.id;
    if (clientCode && channelLower.includes(clientCode)) return client.id;
  }

  if (messageText) {
    const textLower = messageText.toLowerCase();
    for (const client of clients) {
      const firmName = (client.firmName || "").toLowerCase();
      if (firmName && firmName.length > 3 && textLower.includes(firmName)) return client.id;
      const contactName = (client.contactName || "").toLowerCase();
      if (contactName && contactName.length > 3) {
        const parts = contactName.split(/\s+/);
        const lastName = parts[parts.length - 1];
        if (lastName.length > 2 && textLower.includes(lastName)) {
          if (textLower.includes(firmName) || parts.length >= 2 && textLower.includes(parts[0])) {
            return client.id;
          }
        }
      }
    }
  }

  return null;
}

export async function syncSlackProfiles(): Promise<{ updated: number; total: number }> {
  const { db } = await import("../db");
  const { users } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");

  let allMembers: any[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { limit: "200" };
    if (cursor) params.cursor = cursor;
    const data = await slackApiRequest("users.list", params);
    const members = data.members || [];
    allMembers.push(...members);
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const activeMembers = allMembers.filter(m => !m.deleted && !m.is_bot && m.id !== "USLACKBOT");

  const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
  const emailToUser = new Map<string, string>();
  for (const u of allUsers) {
    if (u.email) emailToUser.set(u.email.toLowerCase(), u.id);
  }

  let updated = 0;
  for (const member of activeMembers) {
    const profile = member.profile || {};
    const email = (profile.email || "").toLowerCase();
    if (!email) continue;

    const userId = emailToUser.get(email);
    if (!userId) continue;

    const firstName = profile.first_name || profile.real_name?.split(" ")[0] || "";
    const lastName = profile.last_name || profile.real_name?.split(" ").slice(1).join(" ") || "";
    const avatar = profile.image_192 || profile.image_72 || profile.image_48 || "";

    if (!firstName && !avatar) continue;

    const updateData: Record<string, string> = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (avatar) updateData.profileImageUrl = avatar;

    await db.update(users).set(updateData).where(eq(users.id, userId));
    updated++;
  }

  console.log(`[Slack] Profile sync: updated ${updated}/${activeMembers.length} Slack users matched to ${allUsers.length} app users`);
  return { updated, total: activeMembers.length };
}
