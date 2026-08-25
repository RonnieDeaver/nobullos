// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
import { storage } from "../storage";
import { workerDb as db, runWithWorkerDb, withDbAttribution } from "../db";
import {
  OAuthRefreshError,
  withSingleFlightOAuthRefresh,
  isAuthoritativeRefreshPurpose,
} from "./oauthRefresh";
import { getDefaultOAuthRefreshLease } from "./oauthRefreshLease";
import { isKillSwitchEnabled } from "./killSwitches";
import { getBookingFeatureFlags } from "./bookingFeatureFlags";
import { eq, and, sql, isNull } from "drizzle-orm";
import crypto from "crypto";
import { PERF } from "../perfConfig";
import { resolveOsCanonicalHostname } from "./publicUrl";
import { ZOOM_SYNC_CRON_HOUR, ZOOM_RECORDING_LOOKBACK_HOURS, ZOOM_TRANSCRIPT_BACKFILL_HOURS, ZOOM_RECONCILIATION_CRON_HOUR, ZOOM_RECONCILIATION_LOOKBACK_HOURS } from "./workerConfig";
import { rawCommunicationRecords, clients, workQueue } from "@shared/schema";
import type { ZoomTranscriptUnavailableInfo, ZoomTranscriptUnavailableReason, ZoomRevAiTranscriptionMarker } from "@shared/zoomTranscript";
import { ZOOM_TRANSCRIPT_SOURCE_REVAI } from "@shared/zoomTranscript";

async function enqueueAnalysis(recordId: string): Promise<void> {
  try {
    const { enqueueJob } = await import("./workScheduler");
    await enqueueJob({
      queueName: "analyze_communication",
      workloadClass: "ingestion",
      priority: 200,
      payload: { recordId },
      dedupeKey: `analyze_${recordId}`,
    });
  } catch (err) {
    console.error(`[Zoom] Failed to enqueue analysis for ${recordId}:`, err);
  }
}

let zoomValidationFailures = 0;
let zoomValidationBackoffUntil = 0;
let zoomLastValidationError = "";

function isZoomValidationInBackoff(): boolean {
  if (zoomValidationBackoffUntil === 0) return false;
  if (Date.now() >= zoomValidationBackoffUntil) {
    console.log("[Zoom] Validation backoff expired — resuming validation attempts");
    zoomValidationBackoffUntil = 0;
    zoomValidationFailures = 0;
    return false;
  }
  return true;
}

function isPersistentAuthError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("invalid") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("token") ||
    lower.includes("expired") ||
    lower.includes("revoked");
}

function recordZoomValidationFailure(errorMsg: string): void {
  if (!isPersistentAuthError(errorMsg)) {
    return;
  }
  zoomValidationFailures++;
  if (zoomValidationFailures >= PERF.ZOOM_VALIDATION_FAILURE_LIMIT) {
    zoomValidationBackoffUntil = Date.now() + PERF.ZOOM_VALIDATION_BACKOFF_MS;
    if (errorMsg !== zoomLastValidationError) {
      console.warn(`[Zoom] Circuit breaker: ${zoomValidationFailures} consecutive auth failures — backing off for ${Math.round(PERF.ZOOM_VALIDATION_BACKOFF_MS / 60000)}min (error: ${errorMsg})`);
      zoomLastValidationError = errorMsg;
    }
  }
}

function resetZoomValidationBreaker(): void {
  if (zoomValidationFailures > 0) {
    console.log(`[Zoom] Validation succeeded — resetting circuit breaker (was at ${zoomValidationFailures} failures)`);
  }
  zoomValidationFailures = 0;
  zoomValidationBackoffUntil = 0;
  zoomLastValidationError = "";
}

export function clearZoomValidationBreaker(): void {
  zoomValidationFailures = 0;
  zoomValidationBackoffUntil = 0;
  zoomLastValidationError = "";
  clearZoomPermanentFailure("token_refreshed");
}

// ---------------------------------------------------------------------------
// Task #954 (945C): permanent-failure classification + scoped gates.
//
// The validation circuit breaker above only guards `validateConnection()`. The
// actual ingestion path (recordings list, participant fetch, transcript
// backfill, reconciliation) had no equivalent: every failed Zoom API call
// would bubble up, the worker would treat it as transient, the next iteration
// would re-acquire a `zoom_sync` workload-class slot and burn the 30s timeout.
// Two failure modes are NOT transient and should fail-fast — but with
// different blast radii:
//
//   - 401 / code 124 ("Invalid access token") → **auth** — every Zoom call
//     will fail until the operator reconnects. Engages a *global* fail-fast
//     gate.
//
//   - 400 "does not contain scopes:[...]" / 4711 → **scope** — only the
//     endpoint family that requires the missing scope is broken. Engages a
//     *per-endpoint-family* fail-fast (so missing
//     `meeting:read:list_past_participants*` does not block recordings list,
//     transcript backfill, or booking writes that have valid scopes).
//
// Both gates clear on the next successful token store (reconnect / consent
// flow) via `clearZoomValidationBreaker`.
// ---------------------------------------------------------------------------

export type ZoomPermanentFailureKind = "auth" | "scope";

export class ZoomPermanentError extends Error {
  readonly kind: ZoomPermanentFailureKind;
  readonly status: number;
  readonly responseBody: string;
  /** Endpoint family that triggered a `scope` failure; undefined for `auth`. */
  readonly scopeKey?: string;
  constructor(
    kind: ZoomPermanentFailureKind,
    status: number,
    body: string,
    opts?: { message?: string; scopeKey?: string },
  ) {
    super(opts?.message ?? `Zoom API permanent ${kind} failure: ${status} ${body}`);
    this.name = "ZoomPermanentError";
    this.kind = kind;
    this.status = status;
    this.responseBody = body;
    this.scopeKey = opts?.scopeKey;
  }
}

interface ZoomGateEntry {
  status: number;
  reason: string;
  since: number;
}

// Global auth gate — set when the token is structurally bad. Every Zoom
// API call bails until reconnect.
let zoomAuthGate: ZoomGateEntry | null = null;

// Task #2122 — durable auth-gate signal (mirrors the Front breaker, Task
// #2103). The `zoomAuthGate` above is per-process and resets on restart,
// so on autoscale the fail-fast suppression could silently lift after a
// deploy / restart (until the next dead refresh re-engaged it) and be
// inconsistent across instances. Unlike the Front / Google Ads / SEMrush
// breakers, the Zoom gate is sticky (no cooldown expiry) — it stays
// engaged until a successful refresh or operator reconnect clears it — so
// the persisted payload is the gate snapshot plus the terminal-refresh
// latch (so a fresh process knows whether self-heal is still worth
// scheduling). The hot path (`getZoomAuthGate`) stays purely in-memory;
// boot hydration restores the gate after a restart and the badge read
// reconciles cross-instance trips / clears.
const ZOOM_AUTH_GATE_STATE_KEY = "zoom_auth_gate_state";

// Protect a brand-new local gate from being cleared by a store read that
// raced ahead of its own (fire-and-forget) persist write. Mirrors the
// Front breaker's LOCAL_TRIP_PERSIST_GRACE_MS.
const ZOOM_AUTH_GATE_PERSIST_GRACE_MS = 15 * 1000;
let zoomAuthGateLocalSetAtMs = 0;

let zoomAuthGatePersistErrorLogAt = 0;
function shouldLogZoomGatePersistError(): boolean {
  const now = Date.now();
  if (now - zoomAuthGatePersistErrorLogAt > 5 * 60 * 1000) {
    zoomAuthGatePersistErrorLogAt = now;
    return true;
  }
  return false;
}

// Per-endpoint-family scope gates — set when Zoom rejects a specific call
// for missing granular scopes. Other endpoint families continue normally.
const zoomScopeGates = new Map<string, ZoomGateEntry>();

export function getZoomAuthGate(): ZoomGateEntry | null {
  return zoomAuthGate;
}

export function getZoomScopeGate(scopeKey: string): ZoomGateEntry | null {
  return zoomScopeGates.get(scopeKey) ?? null;
}

/** Returns a snapshot of every active scope gate. For diagnostics/logging. */
export function getZoomScopeGates(): Array<{ scopeKey: string } & ZoomGateEntry> {
  return Array.from(zoomScopeGates.entries()).map(([scopeKey, e]) => ({ scopeKey, ...e }));
}

export function clearZoomPermanentFailure(why: string = "manual_clear"): void {
  if (zoomAuthGate) {
    console.log(
      `[Zoom] Clearing auth gate (status=${zoomAuthGate.status} since=${new Date(zoomAuthGate.since).toISOString()}) — reason=${why}`,
    );
    zoomAuthGate = null;
  }
  if (zoomScopeGates.size > 0) {
    const keys = Array.from(zoomScopeGates.keys()).join(",");
    console.log(`[Zoom] Clearing ${zoomScopeGates.size} scope gate(s) [${keys}] — reason=${why}`);
    zoomScopeGates.clear();
  }
  // Task #1843: any clear (operator reconnect, token rotation, manual)
  // also resets the self-heal counters + terminal latch so a future
  // engagement starts fresh.
  if (typeof resetZoomAuthSelfHeal === "function") {
    resetZoomAuthSelfHeal();
  }
  // Task #2122 — clear the durable signal so a reconnect / successful
  // refresh on ANY instance lifts every instance's gate on the next
  // reconcile. Fire-and-forget — a clear must never throw.
  void clearPersistedZoomAuthGateState();
}

function setZoomAuthGate(status: number, reason: string): void {
  const isNew = !zoomAuthGate || zoomAuthGate.reason !== reason;
  zoomAuthGate = { status, reason, since: zoomAuthGate?.since ?? Date.now() };
  zoomAuthGateLocalSetAtMs = Date.now();
  if (isNew) {
    console.warn(
      `[Zoom] Auth gate engaged: status=${status} reason="${reason}" — fail-fast on every Zoom call until self-heal succeeds or operator reconnects`,
    );
  }
  // Task #2122 — persist the gate so the fail-fast survives a restart and
  // is consistent across autoscale instances. Fire-and-forget.
  void persistZoomAuthGateState();
  // Task #1843: kick the self-heal loop so a transient 401 storm clears
  // on its own without waiting for the next operator action.
  scheduleZoomAuthSelfHeal();
}

// ── Task #2122 — durable Zoom auth-gate persistence (mirror frontAuthBreaker) ──

async function persistZoomAuthGateState(): Promise<void> {
  if (!zoomAuthGate) {
    await clearPersistedZoomAuthGateState();
    return;
  }
  try {
    await storage.setSystemSetting(
      ZOOM_AUTH_GATE_STATE_KEY,
      JSON.stringify({
        status: zoomAuthGate.status,
        reason: zoomAuthGate.reason,
        since: zoomAuthGate.since,
        terminal: zoomAuthRefreshTerminal,
      }),
      "system",
    );
  } catch (err: any) {
    if (shouldLogZoomGatePersistError()) {
      console.error("[Zoom] Auth gate persist failed:", err?.message ?? err);
    }
  }
}

async function clearPersistedZoomAuthGateState(): Promise<void> {
  try {
    await storage.setSystemSetting(ZOOM_AUTH_GATE_STATE_KEY, "", "system");
  } catch (err: any) {
    if (shouldLogZoomGatePersistError()) {
      console.error("[Zoom] Auth gate clear failed:", err?.message ?? err);
    }
  }
}

/**
 * Task #2122 — reconcile the in-memory Zoom auth gate against the durable
 * `system_settings` signal. Called once at boot (re-hydrate after a
 * restart) and on every Integrations-Hub status poll (so the gate reflects
 * a trip / reconnect that happened on another instance). Mirrors
 * `reconcileFrontAuthBreakerFromStore`, adapted for the sticky gate shape.
 *
 * Rules:
 *  - Store read fails → no-op; the in-memory gate stays authoritative.
 *  - Store has a gate and we have none → adopt it (cross-instance trip
 *    propagation + post-restart restore). Restore the terminal latch when
 *    present so a fresh process doesn't keep self-healing a dead token;
 *    otherwise resume self-heal.
 *  - Store is empty (cleared by a reconnect / refresh on another instance,
 *    or never set) → clear locally — UNLESS we just engaged the gate and
 *    our own persist write may not have landed yet (grace window).
 */
export async function reconcileZoomAuthGateFromStore(): Promise<void> {
  let raw: string | undefined;
  try {
    raw = (await storage.getSystemSetting(ZOOM_AUTH_GATE_STATE_KEY))?.value ?? undefined;
  } catch {
    return;
  }

  let persisted:
    | { status: number; reason: string; since: number; terminal: { oauthError: string | null; body: string } | null }
    | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.reason === "string") {
        persisted = {
          status: Number(parsed.status) || 0,
          reason: parsed.reason,
          since: Number(parsed.since) || Date.now(),
          terminal:
            parsed.terminal && typeof parsed.terminal === "object"
              ? {
                  oauthError:
                    typeof parsed.terminal.oauthError === "string" ? parsed.terminal.oauthError : null,
                  body: typeof parsed.terminal.body === "string" ? parsed.terminal.body : "",
                }
              : null,
        };
      }
    } catch {
      // malformed row — treat as "no persisted gate"
    }
  }

  if (persisted) {
    if (!zoomAuthGate) {
      zoomAuthGate = { status: persisted.status, reason: persisted.reason, since: persisted.since };
      if (persisted.terminal) {
        // Refresh is dead — restore the terminal latch so self-heal stays
        // parked until the stored refresh token changes (operator reconnect).
        zoomAuthRefreshTerminal = persisted.terminal;
      } else {
        scheduleZoomAuthSelfHeal();
      }
    }
    return;
  }

  // Store is empty. Clear the local gate so it converges across instances,
  // but never wipe a brand-new local engagement whose persist may still be
  // in flight.
  if (zoomAuthGate) {
    if (zoomAuthGateLocalSetAtMs && Date.now() - zoomAuthGateLocalSetAtMs < ZOOM_AUTH_GATE_PERSIST_GRACE_MS) {
      return;
    }
    // Clear in-memory only — the store is already empty, so re-persisting
    // an empty value is unnecessary; reuse the gate-clear bookkeeping.
    console.log(
      `[Zoom] Reconcile: durable gate cleared elsewhere — clearing local auth gate (status=${zoomAuthGate.status} reason="${zoomAuthGate.reason}")`,
    );
    zoomAuthGate = null;
    if (zoomScopeGates.size > 0) zoomScopeGates.clear();
    if (typeof resetZoomAuthSelfHeal === "function") resetZoomAuthSelfHeal();
  }
}

/**
 * Task #2122 — boot hydration. Re-hydrates the in-memory Zoom auth gate
 * from the durable signal so the fail-fast suppression survives a restart.
 * Thin wrapper over the reconcile so there is a single source of truth for
 * the merge rules; returns the resulting gate state for the startup log.
 */
export async function hydrateZoomAuthGateFromStore(): Promise<{ gateOpen: boolean }> {
  await reconcileZoomAuthGateFromStore();
  return { gateOpen: zoomAuthGate !== null };
}

/** Test-only: read the raw durable gate value. Production never calls this. */
export async function __readPersistedZoomAuthGateForTest(): Promise<string | null> {
  const row = await storage.getSystemSetting(ZOOM_AUTH_GATE_STATE_KEY).catch(() => null);
  return row ? row.value ?? null : null;
}

/** Test-only: clear the durable gate signal. Production never calls this. */
export async function __clearPersistedZoomAuthGateForTest(): Promise<void> {
  await clearPersistedZoomAuthGateState();
}

/** Test-only: force the local "gate set at" marker (drive the grace window). */
export function __setZoomAuthGateLocalSetAtForTest(ms: number): void {
  zoomAuthGateLocalSetAtMs = ms;
}

// ---------------------------------------------------------------------------
// Task #1843: auth-gate self-heal loop.
//
// While `zoomAuthGate` is engaged, periodically attempt
// `refreshAccessToken()` on an exponential backoff (1m → 5m → 15m → 60m,
// capped at 60m, ±10% jitter). On success the refreshed `storeTokens()` →
// `clearZoomValidationBreaker()` chain clears the gate and the loop stops
// scheduling further attempts. On a terminal refresh error (`invalid_grant`
// etc.) the loop stops and waits for an operator reconnect — refreshing
// again will just keep failing with the same `invalid_grant`.
//
// `disconnect()` and a fresh `exchangeCodeForToken()` (via `storeTokens` →
// `clearZoomValidationBreaker` → `clearZoomPermanentFailure`) both clear
// the terminal flag so a new connection isn't blocked.
// ---------------------------------------------------------------------------

const ZOOM_AUTH_SELFHEAL_BACKOFF_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  15 * 60_000, // 15m
  60 * 60_000, // 60m
];
let zoomAuthSelfHealTimer: ReturnType<typeof setTimeout> | null = null;
let zoomAuthSelfHealAttempt = 0;
// Task #2254 — wall-clock time the next scheduled self-heal attempt will fire,
// so the Zoom console can show operators "Auto-retry at {time}" the same way
// Front / Slack already do. Null whenever nothing is scheduled.
let zoomAuthSelfHealNextAttemptMs: number | null = null;
let zoomAuthRefreshTerminal: { oauthError: string | null; body: string } | null = null;
let zoomAuthSelfHealDisabled = false;

export function getZoomAuthSelfHealState(): {
  scheduled: boolean;
  attempt: number;
  nextAttemptAt: string | null;
  parked: boolean;
  terminal: { oauthError: string | null; body: string } | null;
} {
  return {
    scheduled: zoomAuthSelfHealTimer !== null,
    attempt: zoomAuthSelfHealAttempt,
    // Task #2254 — next self-heal attempt time (ISO) while one is scheduled.
    nextAttemptAt:
      zoomAuthSelfHealTimer !== null && zoomAuthSelfHealNextAttemptMs
        ? new Date(zoomAuthSelfHealNextAttemptMs).toISOString()
        : null,
    // Task #2254 — terminal latch = self-heal is parked awaiting an operator
    // reconnect (refreshing again would just keep failing with invalid_grant).
    parked: zoomAuthRefreshTerminal !== null,
    terminal: zoomAuthRefreshTerminal,
  };
}

/**
 * Test-only: stop scheduling self-heal attempts so a unit test that fires a
 * 401 doesn't leave a `setTimeout` ticking in the background after the
 * assertion completes.
 */
export function __disableZoomAuthSelfHealForTest(disable: boolean): void {
  zoomAuthSelfHealDisabled = disable;
  if (disable && zoomAuthSelfHealTimer) {
    clearTimeout(zoomAuthSelfHealTimer);
    zoomAuthSelfHealTimer = null;
  }
}

function resetZoomAuthSelfHeal(): void {
  if (zoomAuthSelfHealTimer) {
    clearTimeout(zoomAuthSelfHealTimer);
    zoomAuthSelfHealTimer = null;
  }
  zoomAuthSelfHealAttempt = 0;
  zoomAuthSelfHealNextAttemptMs = null;
  zoomAuthRefreshTerminal = null;
}

function scheduleZoomAuthSelfHeal(): void {
  if (zoomAuthSelfHealDisabled) return;
  if (!zoomAuthGate) return; // nothing to heal
  if (zoomAuthRefreshTerminal) return; // operator reconnect required
  if (zoomAuthSelfHealTimer) return; // already scheduled
  const idx = Math.min(zoomAuthSelfHealAttempt, ZOOM_AUTH_SELFHEAL_BACKOFF_MS.length - 1);
  const base = ZOOM_AUTH_SELFHEAL_BACKOFF_MS[idx];
  const jitter = Math.floor(base * 0.1 * (Math.random() * 2 - 1));
  const delay = Math.max(1_000, base + jitter);
  // Task #2254 — record the wall-clock fire time so the console can show
  // operators when the next self-heal attempt will run.
  zoomAuthSelfHealNextAttemptMs = Date.now() + delay;
  zoomAuthSelfHealTimer = setTimeout(() => {
    zoomAuthSelfHealTimer = null;
    zoomAuthSelfHealNextAttemptMs = null;
    void runZoomAuthSelfHealTick();
  }, delay);
  // Don't keep the event loop alive just for this timer — if the process
  // is otherwise idle it should still be allowed to exit.
  if (typeof (zoomAuthSelfHealTimer as any)?.unref === "function") {
    (zoomAuthSelfHealTimer as any).unref();
  }
  console.log(
    `[Zoom] Auth-gate self-heal scheduled in ${Math.round(delay / 1000)}s (attempt ${zoomAuthSelfHealAttempt + 1})`,
  );
}

async function runZoomAuthSelfHealTick(): Promise<void> {
  if (!zoomAuthGate) {
    // Some other path (operator reconnect, successful refresh elsewhere)
    // already cleared the gate. Reset counters and stand down.
    resetZoomAuthSelfHeal();
    return;
  }
  zoomAuthSelfHealAttempt++;
  try {
    await refreshAccessToken();
    // storeTokens() → clearZoomValidationBreaker() →
    // clearZoomPermanentFailure() already nulled zoomAuthGate. Reset
    // counters so a future engagement starts fresh at attempt 1.
    if (!zoomAuthGate) {
      console.log("[Zoom] Auth-gate self-heal: refresh succeeded — gate cleared");
      resetZoomAuthSelfHeal();
      return;
    }
    // Refresh succeeded but the gate is still engaged (shouldn't normally
    // happen). Force a clear so callers stop short-circuiting.
    clearZoomPermanentFailure("self_heal_refresh_succeeded");
    resetZoomAuthSelfHeal();
  } catch (err) {
    if (err instanceof ZoomRefreshError && err.terminal) {
      zoomAuthRefreshTerminal = {
        oauthError: err.oauthError,
        body: err.responseBody.slice(0, 500),
      };
      console.error(
        `[Zoom] Auth-gate self-heal: refresh returned terminal "${err.oauthError ?? err.status}" — ` +
          `operator must reconnect; self-heal will stop retrying until the stored refresh token changes`,
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Zoom] Auth-gate self-heal: transient refresh failure (${msg}) — will retry on backoff`);
    scheduleZoomAuthSelfHeal();
  }
}

function setZoomScopeGate(scopeKey: string, status: number, reason: string): void {
  const existing = zoomScopeGates.get(scopeKey);
  const isNew = !existing || existing.reason !== reason;
  zoomScopeGates.set(scopeKey, { status, reason, since: existing?.since ?? Date.now() });
  if (isNew) {
    console.warn(
      `[Zoom] Scope gate engaged for endpoint family "${scopeKey}": status=${status} reason="${reason}" — only this endpoint family is fail-fast; other Zoom calls continue`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task #1843: refresh-failure classification + auth-gate self-heal.
//
// Zoom's OAuth refresh endpoint can fail in three meaningfully different ways:
//
//   - **Terminal** — the stored refresh token is dead. Operator must
//     reconnect via the consent flow. Identified by an OAuth error code of
//     `invalid_grant`, `invalid_request`, or `unauthorized_client` (per
//     RFC 6749 §5.2 / Zoom's OAuth docs), or a 400/401 body that includes
//     `"reason":"Invalid Token!"`.
//
//   - **Transient** — refresh failed but the refresh token may still be
//     valid (network blip, 5xx, brief Zoom-side hiccup, or a 429 the
//     callers are responsible for honoring via Retry-After). Caller should
//     keep trying on its normal cadence (or its own backoff). The auth
//     gate must NOT be engaged for transient failures.
//
//   - **Rate-limited (429)** — explicitly NOT terminal. Honored by
//     refreshAccessToken() internally via Retry-After.
//
// `ZoomRefreshError` carries the verdict so call sites can decide whether
// to engage the global auth gate (terminal) or simply propagate the error
// up the stack (transient).
// ---------------------------------------------------------------------------

export class ZoomRefreshError extends Error {
  readonly terminal: boolean;
  readonly status: number;
  readonly responseBody: string;
  readonly oauthError: string | null;
  constructor(
    terminal: boolean,
    status: number,
    body: string,
    opts?: { message?: string; oauthError?: string | null },
  ) {
    super(
      opts?.message ??
        `Zoom token refresh failed (${terminal ? "terminal" : "transient"}): ${status} ${body.slice(0, 200)}`,
    );
    this.name = "ZoomRefreshError";
    this.terminal = terminal;
    this.status = status;
    this.responseBody = body;
    this.oauthError = opts?.oauthError ?? null;
  }
}

/**
 * Classify a Zoom `/oauth/token` refresh failure. Returns `{ terminal: true }`
 * for failures the operator can only fix by reconnecting (the stored refresh
 * token is dead). Returns `{ terminal: false }` for transient failures we can
 * keep retrying on backoff.
 *
 * NOTE: 429 is intentionally not handled here — refreshAccessToken() honors
 * Retry-After before classification is reached.
 */
export function classifyZoomRefreshError(
  status: number,
  body: string,
): { terminal: boolean; oauthError: string | null } {
  let oauthError: string | null = null;
  // Try to pull the OAuth standard `error` field out of the JSON body.
  try {
    const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown };
    if (typeof parsed.error === "string") {
      oauthError = parsed.error.toLowerCase();
    }
  } catch {
    // Fall through to regex matching below.
  }
  if (!oauthError) {
    const m = /"error"\s*:\s*"([a-z_]+)"/i.exec(body);
    if (m) oauthError = m[1].toLowerCase();
  }
  const terminalOauthErrors = new Set([
    "invalid_grant",
    "invalid_request",
    "unauthorized_client",
    "invalid_client",
  ]);
  if (oauthError && terminalOauthErrors.has(oauthError)) {
    return { terminal: true, oauthError };
  }
  // Zoom occasionally surfaces a refresh-token failure as a 400/401 body
  // containing `"reason":"Invalid Token!"`. Treat as terminal — the stored
  // refresh token is no longer accepted.
  if ((status === 400 || status === 401) && /"reason"\s*:\s*"Invalid Token!?"/i.test(body)) {
    return { terminal: true, oauthError: oauthError ?? "invalid_token" };
  }
  // Any other 4xx is unexpected but conservative: treat as terminal so we
  // don't burn cycles re-issuing requests Zoom will keep rejecting. 5xx and
  // network failures stay transient.
  if (status >= 400 && status < 500 && status !== 429) {
    return { terminal: true, oauthError };
  }
  return { terminal: false, oauthError };
}

/**
 * Classify a Zoom API error response. Returns null when the failure is
 * transient (rate limit, 5xx, network blip) and should be retried normally.
 */
export function classifyZoomApiError(status: number, body: string): ZoomPermanentFailureKind | null {
  // 401 always means auth — token invalid/expired/revoked.
  if (status === 401) return "auth";
  // Granular-scope rejection MUST be checked before the auth check below.
  // Zoom's scope-rejection body is literally
  //   "Invalid access token, does not contain scopes:[...]"
  // so it would match the auth regex (`/invalid access token/i`) too.
  // Misclassifying a scope failure as auth engages the *global* auth gate,
  // which fail-fasts every Zoom call (including the host-mapping save) until
  // the operator reconnects — even though only one endpoint family is
  // actually broken. Zoom returns either 400 with `does not contain
  // scopes:[...]` or 403 with code 4711.
  if (
    (status === 400 || status === 403) &&
    (/does not contain scopes/i.test(body) || /\b"code"\s*:\s*4711\b/.test(body))
  ) {
    return "scope";
  }
  // Some Zoom auth failures surface as 400 with code 124 ("Invalid access
  // token") rather than 401. The scope check above already absorbed the
  // scope-rejection bodies that also contain "Invalid access token", so this
  // only matches real auth failures (typically code 124).
  if (status === 400 && /\b"code"\s*:\s*124\b|invalid access token/i.test(body)) {
    return "auth";
  }
  return null;
}

/**
 * Map a Zoom API path to a stable endpoint-family key for scope-gating.
 * Replaces id-like path segments so e.g.
 *   `/past_meetings/abc123/participants?page_size=100`
 * normalizes to `past_meetings/:id/participants`. The key is intentionally
 * coarse — it groups calls that all require the same granular scope.
 */
export function zoomScopeKeyForPath(path: string): string {
  const noQuery = path.split("?")[0].replace(/^\/+/, "");
  const segments = noQuery.split("/").map((seg, idx) => {
    if (idx === 0) return seg; // first segment is always the resource family
    // Heuristic: any non-empty segment after the resource that doesn't look
    // like a known sub-resource verb is treated as an id.
    if (/^[A-Za-z][A-Za-z_]*$/.test(seg) && seg.length <= 30) return seg;
    return ":id";
  });
  return segments.join("/");
}

const ZOOM_API_BASE = "https://api.zoom.us/v2";
const ZOOM_AUTH_URL = "https://zoom.us/oauth/authorize";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

const SETTINGS_KEY_ACCESS = "zoom_access_token";
const SETTINGS_KEY_REFRESH = "zoom_refresh_token";
const SETTINGS_KEY_EXPIRES = "zoom_token_expires_at";
const SETTINGS_KEY_OAUTH_STATE = "zoom_oauth_state";
// Task #840: persist the granted scopes returned by Zoom's token endpoint so
// `checkBookingScopeReadiness()` can definitively answer "does the connected
// app actually have meeting:write/meeting:delete?" — Zoom's granular-scopes
// regime treats read/write/delete as DISTINCT scopes, so a read-probe alone
// can't prove the saga's create/cancel calls will succeed.
const SETTINGS_KEY_GRANTED_SCOPES = "zoom_granted_scopes";

// ---------------------------------------------------------------------------
// Task #3973 — Zoom Server-to-Server (S2S) OAuth mode.
//
// The legacy user-level OAuth app rotates its refresh token on EVERY refresh
// (and, while the app stays in Draft, Zoom invalidates the refresh token ~1h
// after issue). That model is one bad refresh away from stranding the whole
// integration — the keep-alive / cross-process-lease / rotation-race
// machinery in this file exists to defend it. Zoom's Server-to-Server OAuth
// issues account-level tokens with NO refresh token at all: each process
// mints a fresh access token on demand (`grant_type=account_credentials`),
// tokens live 3600s, and Zoom explicitly supports multiple concurrently
// valid tokens (Marketplace changelog: new mints no longer invalidate
// previous ones — the old `token_index` workaround is obsolete), so
// per-process in-memory caching is autoscale-safe with zero cross-process
// coordination.
//
// Mode selection is the hot-toggleable `zoom_auth_mode` system setting
// ("oauth" = legacy user-level app, DEFAULT; "s2s" = Server-to-Server).
// Staged cutover: configure the ZOOM_S2S_* secrets → run the
// `/api/integrations/zoom/s2s/preflight` admin route (mints a token,
// verifies scope parity + API reachability, touches NO live auth state) →
// POST the mode flip. Rollback = flip back to "oauth" (s2s mode never wipes
// the legacy token store; if the Draft app's refresh chain lapsed while s2s
// carried traffic, rollback needs one operator reconnect). See ZOOM.md
// § Server-to-Server OAuth.
//
// In s2s mode there is NO user-level refresh-token rotation in the hot path:
//   - `getAccessToken` serves the per-process cached token or mints.
//   - `refreshAccessToken` (401 retry + self-heal callers) force-mints.
//   - The keep-alive tick skips — nothing to keep alive.
//   - Terminal mint failures (bad client/account id) flow through the SAME
//     `ZoomRefreshError` classification, so auth-gate / self-heal / probe
//     authority semantics are identical across modes.
export const ZOOM_AUTH_MODE_SETTING = "zoom_auth_mode";
export type ZoomAuthMode = "oauth" | "s2s";

/**
 * Task #4019 — ISO timestamp of the most recent flip INTO s2s mode, stamped
 * by `setZoomAuthMode` on every oauth→s2s transition (a rollback keeps the
 * stamp; a re-cutover refreshes it, restarting the clock). The
 * `retire_legacy_zoom_oauth_tokens` prod action uses it as the soak-window
 * gate, so it works no matter which surface performed the flip (prod action,
 * team-lead route, or script).
 */
export const ZOOM_S2S_CUTOVER_AT_SETTING = "zoom_s2s_cutover_at";
/**
 * Resolve the active auth mode. THROWS on a settings-read failure instead of
 * guessing: silently falling back to "oauth" mid-blip would re-drive the
 * legacy refresh path against a chain that may be intentionally parked
 * (post-cutover), and a terminal `invalid_grant` from that would engage the
 * global auth gate on a perfectly healthy s2s connection. Callers treat the
 * throw exactly like their existing "settings read failed" transient paths.
 */
export async function getZoomAuthMode(): Promise<ZoomAuthMode> {
  const row = await storage.getSystemSetting(ZOOM_AUTH_MODE_SETTING);
  return row?.value?.trim().toLowerCase() === "s2s" ? "s2s" : "oauth";
}

export async function setZoomAuthMode(mode: ZoomAuthMode, updatedBy?: string): Promise<void> {
  if (mode !== "oauth" && mode !== "s2s") {
    throw new Error(`Invalid Zoom auth mode: ${String(mode)} (expected "oauth" or "s2s")`);
  }
  if (mode === "s2s" && !hasZoomS2sCredentials()) {
    console.warn(
      "[Zoom] Auth mode set to s2s WITHOUT ZOOM_S2S_* credentials configured — every Zoom call will fail terminally until they are set or the mode is reverted",
    );
  }
  const previous = await getZoomAuthMode();
  await storage.setSystemSetting(ZOOM_AUTH_MODE_SETTING, mode, updatedBy ?? "system");
  if (mode === "s2s" && previous !== "s2s") {
    // Task #4019 — start (or restart) the retirement soak clock. Best-effort:
    // a failed stamp must not fail the flip; the retirement action simply
    // stays gated until a later flip (or manual stamp) succeeds.
    try {
      await storage.setSystemSetting(
        ZOOM_S2S_CUTOVER_AT_SETTING,
        new Date().toISOString(),
        updatedBy ?? "system",
      );
    } catch (err: any) {
      console.error("[Zoom] failed to stamp zoom_s2s_cutover_at:", err?.message ?? err);
    }
  }
  try {
    await storage.recordAdminSettingChange({
      settingKey: ZOOM_AUTH_MODE_SETTING,
      scope: "auth_mode_change",
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: { mode: previous },
      newValues: { mode },
    });
  } catch (err: any) {
    console.error("[Zoom] auth-mode audit insert failed:", err?.message);
  }
  // Start the new mode from a clean slate: a gate engaged by the OLD mode's
  // credential path must not fail-fast the new one, and a token minted under
  // old s2s credentials must not be served after a flip away and back.
  zoomS2sTokenCache = null;
  zoomS2sMintInFlight = null;
  clearZoomValidationBreaker();
  console.log(`[Zoom] Auth mode changed: ${previous} → ${mode}`);
}

export type ZoomAuthModeChangeResult =
  | { kind: "unchanged"; mode: ZoomAuthMode }
  | { kind: "not_ready"; preflight: ZoomS2sPreflightResult }
  | { kind: "changed"; mode: ZoomAuthMode; previous: ZoomAuthMode };
function getZoomS2sCredentials(): { accountId: string; clientId: string; clientSecret: string } | null {
  const accountId = process.env.ZOOM_S2S_ACCOUNT_ID;
  const clientId = process.env.ZOOM_S2S_CLIENT_ID;
  const clientSecret = process.env.ZOOM_S2S_CLIENT_SECRET;
  if (!accountId || !clientId || !clientSecret) return null;
  return { accountId, clientId, clientSecret };
}

export function hasZoomS2sCredentials(): boolean {
  return getZoomS2sCredentials() !== null;
}

// Same 300s pre-expiry skew the legacy path uses (getAccessToken /
// onLeaseAcquiredRecheck) so both modes re-credential at the same distance
// from expiry.
const ZOOM_S2S_EXPIRY_SKEW_SECONDS = 300;

let zoomS2sTokenCache: { accessToken: string; expiresAtMs: number } | null = null;
let zoomS2sMintInFlight: Promise<string> | null = null;

function getCachedZoomS2sToken(): string | null {
  if (!zoomS2sTokenCache) return null;
  if (Date.now() >= zoomS2sTokenCache.expiresAtMs - ZOOM_S2S_EXPIRY_SKEW_SECONDS * 1000) {
    return null;
  }
  return zoomS2sTokenCache.accessToken;
}

export function __clearZoomS2sTokenCacheForTest(): void {
  zoomS2sTokenCache = null;
  zoomS2sMintInFlight = null;
}

/**
 * Raw S2S token mint (`grant_type=account_credentials`). Pure of shared auth
 * state — no cache writes, no breaker/gate mutation, no scope persistence —
 * so the cutover preflight can exercise it without disturbing the live mode.
 * Throws `ZoomRefreshError` with the same terminal/transient classification
 * the legacy refresh uses (429 honored internally via Retry-After, capped
 * like `performZoomTokenRefresh`). Missing credentials classify TERMINAL:
 * unlike the legacy path (where missing env creds predate any connection),
 * an s2s-mode process without ZOOM_S2S_* secrets is a deployment
 * misconfiguration that only an operator can fix — fail fast via the gate
 * instead of letting every worker re-drive a doomed mint.
 */
async function performZoomS2sTokenMint(
  retries = 0,
): Promise<{ accessToken: string; expiresAtMs: number; scope: string | null }> {
  const creds = getZoomS2sCredentials();
  if (!creds) {
    throw new ZoomRefreshError(
      true,
      0,
      "Zoom S2S credentials not configured (ZOOM_S2S_ACCOUNT_ID / ZOOM_S2S_CLIENT_ID / ZOOM_S2S_CLIENT_SECRET)",
      { oauthError: "s2s_not_configured" },
    );
  }
  const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  // External token mint runs OUTSIDE any DB attribution scope (same rule as
  // exchangeCodeForToken, Task #1849) — a stuck provider must never hold a
  // pool connection.
  const res = await fetch(ZOOM_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: creds.accountId,
    }).toString(),
  });

  if (res.status === 429) {
    if (retries >= 3) {
      throw new ZoomRefreshError(false, 429, "Zoom token endpoint rate limit exceeded after retries", {
        oauthError: "rate_limited",
      });
    }
    const retryAfter = Math.min(Number(res.headers.get("Retry-After") || 5), 60);
    console.warn(
      `[Zoom] /oauth/token (s2s) rate limited, retrying in ${retryAfter}s (attempt ${retries + 1}/3)`,
    );
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return performZoomS2sTokenMint(retries + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    const { terminal, oauthError } = classifyZoomRefreshError(res.status, text);
    throw new ZoomRefreshError(terminal, res.status, text, {
      oauthError,
      message: `Zoom S2S token mint failed (${terminal ? "terminal" : "transient"}): ${res.status} ${text.slice(0, 200)}`,
    });
  }

  const data = (await res.json()) as any;
  if (typeof data?.access_token !== "string" || data.access_token.length === 0) {
    throw new ZoomRefreshError(false, res.status, "Zoom S2S token response missing access_token");
  }
  const expiresInSec = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  return {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + expiresInSec * 1000,
    scope: typeof data.scope === "string" && data.scope.length > 0 ? data.scope : null,
  };
}

/**
 * Persist the granted scopes returned by an s2s mint so
 * `checkBookingScopeReadiness` / `getGrantedZoomScopes` keep working across
 * modes. Written only when the value actually changed — mints happen hourly
 * per process and must not churn settings/audit rows. Best-effort: a
 * persistence failure never fails the mint (the token itself is valid).
 */
async function persistZoomS2sGrantedScopes(scope: string | null): Promise<void> {
  if (!scope) return;
  try {
    const existing = await storage.getSystemSetting(SETTINGS_KEY_GRANTED_SCOPES);
    if (existing?.value === scope) return;
    await storage.setSystemSetting(SETTINGS_KEY_GRANTED_SCOPES, scope, "system");
    try {
      await storage.recordAdminSettingChange({
        settingKey: SETTINGS_KEY_GRANTED_SCOPES,
        scope: "s2s_mint",
        changedBy: null,
        oldValues: null,
        newValues: { grantedScopes: scope },
      });
    } catch (auditErr: any) {
      console.error("[Zoom] s2s granted-scope audit insert failed:", auditErr?.message);
    }
  } catch (err: any) {
    console.error("[Zoom] Failed to persist s2s granted scopes (mint still valid):", err?.message);
  }
}

/**
 * Mode-"s2s" credential accessor: per-process cached token, single-flighted
 * mint. `forceMint` (the 401 refresh-and-retry + self-heal path) drops the
 * cached token first — it just failed auth — but still joins an in-flight
 * mint (its result is fresh by definition). Concurrent mints across
 * processes are harmless: Zoom keeps previous s2s tokens valid.
 */
async function getZoomS2sAccessToken(opts?: { forceMint?: boolean }): Promise<string> {
  if (opts?.forceMint) {
    zoomS2sTokenCache = null;
  } else {
    const cached = getCachedZoomS2sToken();
    if (cached) return cached;
  }
  if (!zoomS2sMintInFlight) {
    zoomS2sMintInFlight = (async () => {
      try {
        const minted = await performZoomS2sTokenMint();
        zoomS2sTokenCache = { accessToken: minted.accessToken, expiresAtMs: minted.expiresAtMs };
        await persistZoomS2sGrantedScopes(minted.scope);
        // Mirror storeTokens: a successful (re-)credential proves the
        // connection is healthy → clear the validation breaker and any
        // engaged gate (the RECOVERY direction is always safe; only the
        // DISCONNECT direction needs an authoritative caller).
        clearZoomValidationBreaker();
        return minted.accessToken;
      } finally {
        zoomS2sMintInFlight = null;
      }
    })();
  }
  return zoomS2sMintInFlight;
}

/**
 * The required-scope list expressed as an S2S (account-level) app grants it.
 * S2S apps only carry account-level (`:admin`) granular scopes — there is no
 * per-user consent context — so the sole non-admin entry in
 * `getRequiredZoomScopes()` (`meeting:read:list_past_participants`, kept for
 * the legacy user-level app) collapses into its `:admin` variant here.
 */
/**
 * Task #3982 — scope names Zoom renamed for apps created in the S2S era. The
 * legacy user-level app carries `recording:read:recording:admin`, but the S2S
 * scope picker only offers (and grants) `cloud_recording:read:recording:admin`
 * — same rename family as the two `cloud_recording:read:list_*` scopes that
 * replaced their `recording:read:list_*` predecessors (see the note under
 * § Granular scopes in ZOOM.md). Verified empirically at cutover: with the
 * cloud_recording-named grant and WITHOUT the legacy name, both recording
 * endpoints the pipeline calls (`/users/{id}/recordings`,
 * `/meetings/{uuid}/recordings`) answer 200 with no missing-scope rejection.
 */
const ZOOM_S2S_SCOPE_RENAMES: Record<string, string> = {
  "recording:read:recording:admin": "cloud_recording:read:recording:admin",
};

export function getRequiredZoomS2sScopes(): string[] {
  const closure = new Set<string>();
  for (const scope of getRequiredZoomScopes()) {
    const admin = scope.endsWith(":admin") ? scope : `${scope}:admin`;
    closure.add(ZOOM_S2S_SCOPE_RENAMES[admin] ?? admin);
  }
  return [...closure];
}

export interface ZoomS2sPreflightResult {
  credentialsPresent: boolean;
  mintOk: boolean;
  apiOk: boolean;
  /** mint succeeded + no missing scopes + API probe answered. */
  ready: boolean;
  grantedScopes: string[];
  missingScopes: string[];
  error?: string;
}

/**
 * Cutover preflight (Task #3973): prove the S2S app can mint, that its
 * granted scopes cover everything the pipelines need, and that the minted
 * token is accepted by the API — WITHOUT touching live auth state (no cache
 * writes, no gates, no breaker, no persisted scopes). Safe to run while the
 * legacy mode is serving traffic. The API probe uses the users LIST — S2S
 * tokens are account-level and Zoom rejects the `me` context for
 * Server-to-Server apps.
 */
export async function runZoomS2sPreflight(): Promise<ZoomS2sPreflightResult> {
  const base: ZoomS2sPreflightResult = {
    credentialsPresent: false,
    mintOk: false,
    apiOk: false,
    ready: false,
    grantedScopes: [],
    missingScopes: [],
  };
  if (!hasZoomS2sCredentials()) {
    return {
      ...base,
      error: "ZOOM_S2S_ACCOUNT_ID / ZOOM_S2S_CLIENT_ID / ZOOM_S2S_CLIENT_SECRET not configured",
    };
  }
  let minted: Awaited<ReturnType<typeof performZoomS2sTokenMint>>;
  try {
    minted = await performZoomS2sTokenMint();
  } catch (err: any) {
    return {
      ...base,
      credentialsPresent: true,
      error: `mint_failed: ${String(err?.message ?? err)}`.slice(0, 300),
    };
  }
  const granted = new Set((minted.scope ?? "").split(/\s+/).filter(Boolean));
  const missingScopes = getRequiredZoomS2sScopes().filter((s) => !granted.has(s));
  let apiOk = false;
  let error: string | undefined;
  try {
    const res = await fetch(`${ZOOM_API_BASE}/users?page_size=1`, {
      headers: { Authorization: `Bearer ${minted.accessToken}`, Accept: "application/json" },
    });
    if (res.ok) {
      apiOk = true;
    } else {
      error = `users_probe_${res.status}: ${(await res.text()).slice(0, 200)}`;
    }
  } catch (err: any) {
    error = `users_probe_failed: ${String(err?.message ?? err)}`.slice(0, 300);
  }
  return {
    credentialsPresent: true,
    mintOk: true,
    apiOk,
    ready: apiOk && missingScopes.length === 0,
    grantedScopes: [...granted].sort(),
    missingScopes,
    error,
  };
}

function getRedirectUri(): string {
  if (process.env.ZOOM_REDIRECT_URI) return process.env.ZOOM_REDIRECT_URI;
  // Task #3740: canonical OS host (reports.*) — never the marketing apex,
  // regardless of the order domains appear in the deployment's domain list.
  const domain = resolveOsCanonicalHostname();
  if (!domain) throw new Error("REPLIT_DOMAINS not set — cannot build OAuth redirect URI");
  return `https://${domain}/api/integrations/zoom/callback`;
}

export async function getAuthorizationUrl(): Promise<string> {
  const clientId = process.env.ZOOM_CLIENT_ID;
  if (!clientId) throw new Error("ZOOM_CLIENT_ID not configured");

  const state = crypto.randomBytes(32).toString("hex");
  await storage.setSystemSetting(SETTINGS_KEY_OAUTH_STATE, state, "system");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    state,
  });
  // Granular scopes (Task #840). Zoom's authorization server treats
  // missing `scope` as "all scopes the app requests in the marketplace
  // listing", so we keep things explicit here. The `meeting:write:admin`
  // and `delete_meeting:admin` scopes are required to create/delete
  // scheduled meetings on behalf of any account user; `user:read:admin`
  // is needed to resolve a host email → Zoom user id.
  const scopes = getRequiredZoomScopes();
  if (scopes.length) {
    params.set("scope", scopes.join(" "));
  }
  return `${ZOOM_AUTH_URL}?${params.toString()}`;
}

/**
 * Zoom scopes required for the Task #840 booking tool plus the existing
 * recording / transcript ingestion. Anything granted is fine, but missing
 * any of these prevents either booking or ingestion.
 */
export function getRequiredZoomScopes(): string[] {
  // Zoom granular scopes (the only kind accepted on apps published after
  // 2024). Coarse scopes like `meeting:write:admin` are silently rejected on
  // newer apps which is exactly the failure mode we want to avoid for the
  // booking tool — see Zoom's "Granular Scopes" migration guide.
  //
  // The list below maps to four surfaces:
  //   1. Recording / transcript ingestion (cloud_recording:* + user reads).
  //   2. Past-meeting participant lookup (call-analysis attribution).
  //   3. Booking CRUD (create/update/delete scheduled meetings).
  //   4. Booking-readiness list-meetings probe — `GET /users/me/meetings`
  //      requires `meeting:read:list_meetings:admin`. Without it the scope
  //      gate engages immediately on a fresh OAuth reconnect with
  //      "Missing Zoom scopes for: users/me/meetings". See ZOOM.md
  //      § OAuth app rebuild.
  return [
    // User reads (recording ingestion + admin user lookup)
    "user:read:user:admin",
    "user:read:list_users:admin",
    // Recording / transcript ingestion
    "recording:read:recording:admin",
    "report:read:list_meeting_participants:admin",
    "cloud_recording:read:list_user_recordings:admin",
    "cloud_recording:read:list_recording_files:admin",
    // Past-meeting participant lookups (used by the call-analysis
    // ingestion path to attribute recordings to attendees).
    // Task #954 (945C): the `/past_meetings/{id}/participants` endpoint
    // requires its own granular scopes — production logged repeated 400
    // "does not contain scopes:[meeting:read:list_past_participants,
    // meeting:read:list_past_participants:admin]" (see also epic #929
    // step F / task #935 for the original log evidence). Without these
    // the participant fetch fails on every meeting and the ingestion
    // path burns the zoom_sync class budget retrying. Including both
    // the user-context and admin variants matches what Zoom's granular
    // regime actually checks against.
    "meeting:read:list_past_participants",
    "meeting:read:list_past_participants:admin",
    // Booking-readiness list-meetings probe (`GET /users/me/meetings`).
    "meeting:read:list_meetings:admin",
    // Booking tool (create/update/delete scheduled meetings on behalf of any
    // account user)
    "meeting:read:meeting:admin",
    "meeting:write:meeting:admin",
    "meeting:update:meeting:admin",
    "meeting:delete:meeting:admin",
  ];
}

export async function validateOAuthState(state: string): Promise<boolean> {
  return withDbAttribution("oauth_callback:read_state", async () => {
    const stored = await storage.getSystemSetting(SETTINGS_KEY_OAUTH_STATE);
    if (!stored?.value || stored.value !== state) return false;
    await storage.setSystemSetting(SETTINGS_KEY_OAUTH_STATE, "", "system");
    return true;
  });
}

export async function exchangeCodeForToken(code: string, updatedBy?: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Zoom OAuth credentials not configured");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  // Task #1849: external token exchange runs OUTSIDE any DB attribution
  // scope so a stuck provider can never hold an api-pool connection.
  const res = await fetch(ZOOM_TOKEN_URL, {
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
    throw new Error(`Zoom token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json() as any;
  const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
  await withDbAttribution("oauth_callback:persist_tokens", async () => {
    await storeTokens(
      data.access_token,
      data.refresh_token,
      expiresAt,
      typeof data.scope === "string" ? data.scope : undefined,
      updatedBy,
      "connect",
    );
  });
  // NB: gate clearing happens inside storeTokens →
  // clearZoomValidationBreaker → clearZoomPermanentFailure("token_refreshed").
  // The reconnect path is therefore already on a gate-clearing path; do not
  // add a second explicit call here without first confirming the chain
  // changed (see tests/zoom-reconnect-clears-scope-gates.test.ts which
  // pins the chain).
  return data;
}

async function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
  grantedScopes?: string,
  updatedBy?: string,
  event: "connect" | "refresh" = "refresh",
): Promise<void> {
  const actor = updatedBy ?? "system";
  await storage.setSystemSetting(SETTINGS_KEY_ACCESS, accessToken, actor);
  await storage.setSystemSetting(SETTINGS_KEY_REFRESH, refreshToken, actor);
  await storage.setSystemSetting(SETTINGS_KEY_EXPIRES, String(expiresAt), actor);
  try {
    await storage.recordAdminSettingChange({
      settingKey: SETTINGS_KEY_ACCESS,
      scope: event,
      changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
      oldValues: null,
      newValues: { event, expiresAt, grantedScopes: grantedScopes ?? null },
    });
  } catch (err: any) {
    console.error("[Zoom] credential audit insert failed:", err?.message);
  }
  // The Zoom OAuth/token endpoint returns the granted scopes as a
  // space-separated string. We persist that verbatim so the booking
  // readiness probe can definitively confirm meeting:write/meeting:delete
  // were granted (Zoom's granular regime treats them as distinct from
  // meeting:read). Only overwrite if the caller actually has scope info —
  // a refresh that omits `scope` should not erase the previously granted
  // scope set.
  if (typeof grantedScopes === "string" && grantedScopes.length > 0) {
    await storage.setSystemSetting(
      SETTINGS_KEY_GRANTED_SCOPES,
      grantedScopes,
      actor,
    );
  }
  clearZoomValidationBreaker();
}

/**
 * Returns the set of scopes the connected Zoom app actually granted, parsed
 * from the most recent OAuth token response. Returns null if we have no
 * record yet (e.g. the connection predates Task #840 and hasn't refreshed).
 */
export async function getGrantedZoomScopes(): Promise<Set<string> | null> {
  const setting = await storage.getSystemSetting(SETTINGS_KEY_GRANTED_SCOPES);
  if (!setting?.value) return null;
  const parts = setting.value.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return new Set(parts);
}

export async function getAccessToken(opts?: { purpose?: string }): Promise<string> {
  // Task #2102 — respect the global auth gate on the proactive-expiry
  // refresh path too. `zoomApiRequestImpl` short-circuits on the gate
  // before it calls here, but the expiry-driven refresh below (and any
  // other direct caller) must also back off so a revoked refresh token
  // can't be re-driven by every Zoom surface and flood /oauth/token.
  if (zoomAuthGate) {
    throw new ZoomPermanentError("auth", zoomAuthGate.status, zoomAuthGate.reason, {
      message: `Zoom auth gate engaged — operator must reconnect (${zoomAuthGate.reason})`,
    });
  }

  // Shared "refresh, and engage the gate only on a TERMINAL outcome from an
  // authoritative caller" helper for the two paths that reach a refresh: the
  // stored access token is expired, or it is absent but a refresh token IS
  // present (Task #2416 confirm-before-trip routes that case here instead of
  // declaring the integration dead).
  const refreshWithGateHandling = async (): Promise<string> => {
    try {
      return await refreshAccessToken();
    } catch (err) {
      // Task #2102 — a terminal refresh on the proactive-expiry path means
      // the stored refresh token is revoked. Engage the global auth gate +
      // terminal latch (mirrors `zoomApiRequestRefreshAndRetry`) so every
      // other Zoom surface short-circuits on the gate instead of each one
      // re-driving the doomed refresh POST. Transient refresh errors
      // (5xx / network / 429 exhaustion) propagate WITHOUT engaging the
      // gate so the next tick retries on its own cadence.
      //
      // Task #2267 — only an authoritative caller (a real Zoom operation)
      // may commit that disconnect. The `zoom_probe` health check and any
      // proactive top-up are non-authoritative: when one loses a
      // refresh-token rotation race it gets a terminal `invalid_grant` on
      // an already-consumed token. Engaging the gate from that would back
      // off every healthy Zoom surface on a transient blip. Non-authoritative
      // callers re-throw so the probe surfaces `unauthorized`, but leave the
      // gate (and stored tokens) untouched; a real surface still commits the
      // gate when IT hits the same terminal failure.
      if (
        err instanceof ZoomRefreshError &&
        err.terminal &&
        !zoomAuthGate &&
        isAuthoritativeRefreshPurpose(opts?.purpose)
      ) {
        const reason = `refresh ${err.oauthError ?? err.status}: ${err.responseBody.slice(0, 200)}`;
        zoomAuthRefreshTerminal = {
          oauthError: err.oauthError,
          body: err.responseBody.slice(0, 500),
        };
        setZoomAuthGate(err.status || 401, reason);
      } else if (err instanceof ZoomRefreshError && err.terminal && !zoomAuthGate) {
        console.warn(
          `[Zoom] Terminal refresh on non-authoritative '${opts?.purpose}' attempt — NOT engaging auth gate (rotation-race safe); surfacing to caller.`,
        );
      }
      throw err;
    }
  };

  // Task #3973 — Server-to-Server mode: per-process cached account-level
  // token; no stored tokens, no refresh-token rotation. A cache miss (or a
  // stale token) routes through refreshWithGateHandling → refreshAccessToken
  // → s2s mint, so terminal-mint gate engagement keeps the exact
  // authoritative-vs-probe semantics of the legacy path.
  if ((await getZoomAuthMode()) === "s2s") {
    const cached = getCachedZoomS2sToken();
    if (cached) return cached;
    return await refreshWithGateHandling();
  }

  let tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  let expiresSetting = await storage.getSystemSetting(SETTINGS_KEY_EXPIRES);

  // Task #2416 — confirm-before-declaring-disconnected. A falsy cached access
  // read here is NOT proof the operator disconnected: it can be a stale
  // negative cache sentinel or a transient empty read under the DB/worker-pool
  // saturation that produced the false "Reconnect Required" badges. Before
  // throwing "Zoom not connected", re-read access + refresh authoritatively
  // (cache-bypassing) and only declare the disconnect on a CONFIRMED absence
  // (no access AND no refresh). A refresh token present but access absent
  // routes to a refresh instead of failing. A re-read that itself throws is
  // UNKNOWN, not absent → surface a transient error (no gate engaged, retried
  // next tick). Mirrors the SEMrush guarantee (Task #2412).
  if (!tokenSetting?.value) {
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
      // NOT confirmed — surface a transient/retryable error WITHOUT engaging
      // the gate so the next tick retries instead of declaring Zoom dead.
      throw new Error(
        `Zoom connection state unknown — token read failed, will retry (no disconnect declared): ${err?.message ?? err}`,
      );
    }
    if (freshAccess?.value) {
      // Stale cache: the access token is actually present. Use the freshly
      // read value (and expiry) and continue.
      tokenSetting = freshAccess;
      expiresSetting = freshExpires ?? expiresSetting;
    } else if (freshRefresh?.value) {
      // Access absent but a refresh token IS present → refresh instead of
      // declaring the integration dead.
      return await refreshWithGateHandling();
    } else {
      // State 2 (CONFIRMED empty): no access AND no refresh via a
      // cache-bypassing re-read. A genuine disconnect.
      console.error(
        "[Zoom] Not connected — confirmed absence after cache-bypassing re-read: accessPresent=false refreshPresent=false",
      );
      throw new Error("Zoom not connected. Please authorize via Settings → Integrations.");
    }
  }

  // After the confirm block a non-empty access token is guaranteed (cached
  // happy path, or the fresh re-read above). Re-narrow for the type checker;
  // this branch is defensive and should not be reachable in practice.
  const accessToken = tokenSetting?.value;
  if (!accessToken) {
    throw new Error("Zoom not connected. Please authorize via Settings → Integrations.");
  }

  const expiresAt = Number(expiresSetting?.value || 0);
  const now = Math.floor(Date.now() / 1000);

  if (expiresAt > 0 && now >= expiresAt - 300) {
    return await refreshWithGateHandling();
  }

  return accessToken;
}

/**
 * Refresh the Zoom access token. Throws `ZoomRefreshError` (with a
 * `terminal` verdict) on any non-2xx response other than 429, which is
 * honored internally via Retry-After. Task #1843.
 *
 * Exported so the auth-gate self-heal loop and the 401 refresh-and-retry
 * path in zoomApiRequest can share one implementation.
 */
async function performZoomTokenRefresh(
  refreshToken: string,
  retries = 0,
): Promise<string> {
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Zoom OAuth credentials not configured");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(ZOOM_TOKEN_URL, {
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

  // Task #1843: /oauth/token rate-limit. Honor Retry-After (capped at 60s,
  // 3 retries) so a 429 storm doesn't bubble up as a terminal failure.
  // This loop runs INSIDE the Task #1975 single-flight scope so concurrent
  // callers still collapse onto one in-flight refresh during the backoff.
  if (res.status === 429) {
    if (retries >= 3) {
      const err = new ZoomRefreshError(false, 429, "Zoom token endpoint rate limit exceeded after retries", {
        oauthError: "rate_limited",
      });
      throw new OAuthRefreshError("zoom", "transient", err.message, { status: 429, cause: err });
    }
    const retryAfter = Math.min(Number(res.headers.get("Retry-After") || 5), 60);
    console.warn(`[Zoom] /oauth/token rate limited, retrying in ${retryAfter}s (attempt ${retries + 1}/3)`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return performZoomTokenRefresh(refreshToken, retries + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    const { terminal, oauthError } = classifyZoomRefreshError(res.status, text);
    const zoomErr = new ZoomRefreshError(terminal, res.status, text, { oauthError });
    throw new OAuthRefreshError(
      "zoom",
      terminal ? "terminal" : "transient",
      zoomErr.message,
      { status: res.status, cause: zoomErr },
    );
  }

  const data = await res.json() as any;
  const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
  // Task #1843: Zoom rotates the refresh token on every refresh. The old
  // refresh token is invalid the moment the new one is issued. The previous
  // `data.refresh_token || refreshSetting.value` fallback silently re-stored
  // the dead token, which guaranteed the next refresh failed with
  // invalid_grant. Surface the bug loudly instead.
  const newRefreshToken: string | undefined =
    typeof data.refresh_token === "string" && data.refresh_token.length > 0
      ? data.refresh_token
      : undefined;
  if (!newRefreshToken) {
    console.error(
      "[Zoom] Refresh response missing refresh_token — Zoom should always return a rotated refresh token. " +
        "Re-using the previously stored value will fail on the next refresh with invalid_grant.",
    );
  }
  await storeTokens(
    data.access_token,
    newRefreshToken ?? refreshToken,
    expiresAt,
    typeof data.scope === "string" ? data.scope : undefined,
    undefined,
    "refresh",
  );
  return data.access_token;
}

/**
 * Refresh the Zoom access token. Throws `ZoomRefreshError` (with a
 * `terminal` verdict) on any non-2xx response other than 429, which is
 * honored internally via Retry-After. Task #1843.
 *
 * Task #1975: wrapped in `withSingleFlightOAuthRefresh` so concurrent
 * callers (auth-gate self-heal + the 401 refresh-and-retry path inside
 * `zoomApiRequest`) collapse onto one in-flight POST. Zoom rotates the
 * refresh token on every refresh, so two concurrent POSTs guarantee one
 * loser gets `invalid_grant` against an already-consumed token; the
 * helper's re-read-and-retry covers that race before declaring auth dead.
 */
export async function refreshAccessToken(opts?: {
  // Task #2740 — the cross-process lease's "did a sibling already refresh?"
  // recheck normally short-circuits the POST when the stored access token is
  // still > 300s from expiry (the same skew getAccessToken uses). The
  // proactive keep-alive (zoomTokenKeepAliveScheduler) needs to ROTATE the
  // refresh token well before the access token itself nears expiry — a Draft
  // Zoom app invalidates the *refresh* token ~1h after issue regardless of
  // the access token's remaining life — so it widens this skew to force the
  // rotation while still skipping a wasteful POST when a sibling JUST
  // rotated (leaving more than `recheckSkewSeconds` of life).
  recheckSkewSeconds?: number;
}): Promise<string> {
  // Task #3973 — s2s mode: "refresh" = force-mint a fresh account-level
  // token (callers reach here when the current token failed auth or the
  // self-heal loop is re-proving credentials). No refresh token exists in
  // this mode, so the single-flight + cross-process-lease rotation
  // machinery below (built for the rotating user-level chain) is bypassed:
  // concurrent s2s mints are explicitly safe (Zoom keeps previous tokens
  // valid) and in-process dedupe happens inside getZoomS2sAccessToken.
  if ((await getZoomAuthMode()) === "s2s") {
    return getZoomS2sAccessToken({ forceMint: true });
  }
  const recheckSkewSeconds = opts?.recheckSkewSeconds ?? 300;
  try {
    return await withSingleFlightOAuthRefresh<string>({
      integration: "zoom",
      purpose: "expiry_or_401",
      // Task #2437 — bounded wait-and-re-read before a terminal refresh is
      // declared a permanent death (extends the Task #2435 Front defense).
      // The cross-process lease serializes refreshers, but a loser can still
      // re-read the stored refresh token in the instant BEFORE the winning
      // sibling persists the freshly-rotated one (Zoom rotates on EVERY
      // refresh, so the race window is every cycle, not just pre-expiry),
      // see the still-consumed token, and surface a false `invalid_grant`
      // (HTTP 400) that engages the auth gate on a connection a sibling just
      // rotated healthy. Polling a few extra times lets the winner's
      // `storeTokens` land so the retry picks up the rotated token. Tuned to
      // Zoom's 300s pre-expiry skew (the same skew getAccessToken /
      // onLeaseAcquiredRecheck use) — ample headroom for a sub-second poll,
      // so 4×150ms (≈600ms). A true revocation never rotates, exhausts the
      // window, and is still declared terminal exactly once.
      terminalRotationRecheck: { attempts: 4, delayMs: 150 },
      // Task #2289/#2361 — cross-process refresh lease. Zoom rotates the
      // refresh token on EVERY refresh (verified against zoom.us OAuth
      // docs: the previous refresh token is invalidated the moment the new
      // one is issued), so two autoscale instances refreshing at once
      // guarantee the loser POSTs an already-consumed token and gets
      // `invalid_grant` (HTTP 400) — which would engage the auth gate on a
      // connection a sibling just rotated healthy. Zoom's docs explicitly
      // recommend a distributed lock. The lease serializes every process to
      // one refresher at a time; the recheck below skips a wasteful second
      // POST when a sibling refreshed while we waited for the lease.
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
        // Same pre-expiry skew getAccessToken uses by default (300s); the
        // proactive keep-alive widens it (Task #2740). If a sibling refreshed
        // while we waited and left more than the skew of life, the stored
        // access token is already valid → skip a wasteful POST.
        if (expiresAt > 0 && now < expiresAt - recheckSkewSeconds) return access;
        return null;
      },
      readRefreshToken: async () =>
        (await storage.getSystemSetting(SETTINGS_KEY_REFRESH))?.value ?? null,
      refreshOnce: async ({ refreshToken }) => performZoomTokenRefresh(refreshToken),
    });
  } catch (err) {
    if (err instanceof OAuthRefreshError) {
      // Unwrap to preserve the legacy `ZoomRefreshError` shape for the
      // auth-gate engager and the historical 401 handler.
      if (err.cause instanceof ZoomRefreshError) throw err.cause;
      if (err.outcome === "terminal" && !err.cause) {
        throw new Error("No Zoom refresh token available");
      }
      throw new ZoomRefreshError(
        err.outcome === "terminal",
        err.status ?? 0,
        err.message,
        { oauthError: undefined },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Task #2740 — proactive Zoom token keep-alive.
//
// Why this exists: the Zoom OAuth app is currently UNPUBLISHED (Draft). Per
// Zoom's OAuth docs (https://developers.zoom.us/docs/integrations/oauth/ and
// https://developers.zoom.us/docs/integrations/oauth/#refreshing-an-access-token),
// a Draft app's refresh token is short-lived: Zoom invalidates it ~1 hour
// after issue. Zoom also ROTATES the refresh token on every refresh — each
// successful refresh returns a brand-new refresh_token with a fresh ~1h life
// and invalidates the previous one. So as long as we refresh inside each ~1h
// window the chain stays alive; the danger is a QUIET period (no recordings,
// no operator action) where nothing triggers a refresh, the ~1h elapses, and
// the next real call hits `invalid_grant` and forces an operator reconnect.
//
// This keep-alive tick proactively rotates the token before that cutoff. It
// runs through the SAME single-flight + cross-process-lease refresh path as
// every other Zoom refresh (`refreshAccessToken`), so it can't race a real
// refresh into a poisoned-token state. Crucially it is NON-authoritative:
// `refreshAccessToken()` throws `ZoomRefreshError` on a terminal failure but
// does NOT engage the sticky global auth gate or set the terminal self-heal
// latch (only the authoritative on-demand path in `getAccessToken` /
// `refreshWithGateHandling` may do that — see Tasks #2267 / #2277). A
// keep-alive that loses a rotation race, or hits a genuinely dead token, just
// surfaces the error to the scheduler and is retried next tick — it never
// trips the gate on its own during a quiet period.

// Hot-toggleable kill switch (default ON). Off tokens mirror the other
// default-ON background schedulers (semrushGhostCleanup).
export const ZOOM_KEEPALIVE_ENABLED_SETTING = "zoom_token_keepalive_enabled";
const ZOOM_KEEPALIVE_OFF_TOKENS = new Set(["false", "0", "off", "no"]);

// Rotate once the stored access token is within this many seconds of its
// expiry. Zoom issues access tokens with a 3600s life, so 20 min before
// expiry == ~40 min after issue — comfortably inside the ~1h Draft-app
// refresh-token cutoff while leaving ~20 min of headroom for a missed tick.
export const ZOOM_KEEPALIVE_REFRESH_BEFORE_EXPIRY_SECONDS = 20 * 60;

export type ZoomKeepAliveTickResult =
  | {
      action: "skipped";
      reason: "disabled" | "gate_engaged" | "terminal_latched" | "no_tokens" | "fresh" | "s2s_mode";
    }
  | { action: "refreshed" }
  | { action: "transient_error"; message: string }
  | { action: "terminal_error"; oauthError: string | null };

/**
 * Read the default-ON keep-alive kill switch. Fail-safe: any read error
 * leaves the feature ENABLED (a config blip must not silently stop the
 * proactive rotation and let the token quietly expire).
 */
export async function isZoomTokenKeepAliveEnabled(): Promise<boolean> {
  try {
    const row = await storage.getSystemSetting(ZOOM_KEEPALIVE_ENABLED_SETTING);
    const raw = row?.value?.trim().toLowerCase();
    if (!raw) return true;
    return !ZOOM_KEEPALIVE_OFF_TOKENS.has(raw);
  } catch (err: any) {
    console.error(
      "[ZoomKeepAlive] Failed to read enabled flag, defaulting to enabled:",
      err?.message ?? err,
    );
    return true;
  }
}

/**
 * One proactive keep-alive pass. Decides whether the stored Zoom token needs
 * a pre-emptive rotation and, if so, drives it through the shared
 * single-flight + cross-process-lease refresh path. Pure of any scheduling /
 * locking concerns so it is directly unit-testable.
 */
export async function runZoomTokenKeepAliveTick(): Promise<ZoomKeepAliveTickResult> {
  if (!(await isZoomTokenKeepAliveEnabled())) {
    return { action: "skipped", reason: "disabled" };
  }
  // Task #3973 — s2s mode has no refresh-token chain to keep alive (tokens
  // are minted on demand and Zoom keeps multiple valid concurrently). The
  // legacy chain is intentionally left un-rotated while s2s carries traffic;
  // if it lapses, rollback to oauth needs one operator reconnect (documented
  // in ZOOM.md § Server-to-Server OAuth).
  let keepAliveAuthMode: ZoomAuthMode;
  try {
    keepAliveAuthMode = await getZoomAuthMode();
  } catch (err: any) {
    return { action: "transient_error", message: `auth mode read failed: ${err?.message ?? err}` };
  }
  if (keepAliveAuthMode === "s2s") {
    return { action: "skipped", reason: "s2s_mode" };
  }
  // Auth gate already engaged → an operator reconnect is required; a
  // proactive refresh can't clear it and would just churn a known-bad token.
  if (getZoomAuthGate()) {
    return { action: "skipped", reason: "gate_engaged" };
  }
  // Terminal self-heal latch set → the stored refresh token is dead and the
  // self-heal loop has parked awaiting a reconnect. Don't re-drive it.
  if (getZoomAuthSelfHealState().terminal) {
    return { action: "skipped", reason: "terminal_latched" };
  }

  let refreshSetting: Awaited<ReturnType<typeof storage.getSystemSetting>>;
  let accessSetting: Awaited<ReturnType<typeof storage.getSystemSetting>>;
  let expiresSetting: Awaited<ReturnType<typeof storage.getSystemSetting>>;
  try {
    [accessSetting, refreshSetting, expiresSetting] = await Promise.all([
      storage.getSystemSetting(SETTINGS_KEY_ACCESS),
      storage.getSystemSetting(SETTINGS_KEY_REFRESH),
      storage.getSystemSetting(SETTINGS_KEY_EXPIRES),
    ]);
  } catch (err: any) {
    // UNKNOWN state — the read itself failed. Surface a transient error so
    // the next tick retries; never declare a disconnect.
    return { action: "transient_error", message: `token read failed: ${err?.message ?? err}` };
  }

  // No stored refresh token → Zoom was never connected (or was reset). There
  // is nothing to keep alive; a reconnect is the only path forward.
  if (!refreshSetting?.value) {
    return { action: "skipped", reason: "no_tokens" };
  }

  const expiresAt = Number(expiresSetting?.value || 0);
  const now = Math.floor(Date.now() / 1000);
  // Still well clear of the rotation window AND we have a current access
  // token → nothing to do this tick.
  if (
    accessSetting?.value &&
    expiresAt > 0 &&
    now < expiresAt - ZOOM_KEEPALIVE_REFRESH_BEFORE_EXPIRY_SECONDS
  ) {
    return { action: "skipped", reason: "fresh" };
  }

  // Within the rotation window (or expiry/access unknown) → rotate now. The
  // widened recheck skew forces the POST through the lease unless a sibling
  // ALREADY rotated leaving more than the window of life (then it skips a
  // wasteful POST). Terminal failures do NOT engage the gate here.
  try {
    await refreshAccessToken({
      recheckSkewSeconds: ZOOM_KEEPALIVE_REFRESH_BEFORE_EXPIRY_SECONDS,
    });
    return { action: "refreshed" };
  } catch (err: any) {
    if (err instanceof ZoomRefreshError) {
      if (err.terminal) {
        console.warn(
          `[ZoomKeepAlive] Proactive refresh hit a terminal error (auth gate NOT engaged — keep-alive is non-authoritative): oauthError=${err.oauthError ?? "?"} status=${err.status}`,
        );
        return { action: "terminal_error", oauthError: err.oauthError };
      }
      return { action: "transient_error", message: err.message };
    }
    return { action: "transient_error", message: err?.message ?? String(err) };
  }
}

async function zoomApiRequest(path: string, retries = 0, opts?: { purpose?: string }): Promise<any> {
  if (retries === 0) {
    const { auditOutboundCall } = await import("./externalCallAudit");
    const { createHash } = await import("node:crypto");
    return auditOutboundCall(
      { integration: "zoom", endpoint: path, method: "GET" },
      async () => {
        const data = await zoomApiRequestImpl(path, retries, false, opts);
        const payload = data === undefined || data === null ? "" : JSON.stringify(data);
        const bytes = Buffer.byteLength(payload, "utf8");
        const hash = bytes > 0
          ? createHash("sha256").update(payload).digest("hex").slice(0, 64)
          : undefined;
        return { value: data, statusCode: 200, responseSizeBytes: bytes, responseHash: hash };
      },
    );
  }
  return zoomApiRequestImpl(path, retries, false, opts);
}

async function zoomApiRequestImpl(path: string, retries = 0, authRetried = false, opts?: { purpose?: string }): Promise<any> {
  // Task #954 (945C): scoped fail-fast.
  //   - Global auth gate → every Zoom call short-circuits.
  //   - Per-endpoint scope gate → only calls in the same endpoint family
  //     short-circuit; unrelated endpoints with valid scopes still run.
  // Either branch releases the workload-class slot promptly instead of
  // waiting 30s for `awaitClassSlot("zoom_sync")` to time out.
  if (zoomAuthGate) {
    throw new ZoomPermanentError("auth", zoomAuthGate.status, zoomAuthGate.reason, {
      message: `Zoom auth gate engaged — operator must reconnect (${zoomAuthGate.reason})`,
    });
  }
  const scopeKey = zoomScopeKeyForPath(path);
  const scopeGate = zoomScopeGates.get(scopeKey);
  if (scopeGate) {
    throw new ZoomPermanentError("scope", scopeGate.status, scopeGate.reason, {
      message: `Zoom scope gate engaged for "${scopeKey}" — operator must grant missing scopes (${scopeGate.reason})`,
      scopeKey,
    });
  }

  const token = await getAccessToken(opts);
  const res = await fetch(`${ZOOM_API_BASE}${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });

  if (res.status === 429) {
    if (retries >= 3) throw new Error("Zoom API rate limit exceeded after retries");
    const retryAfter = Number(res.headers.get("Retry-After") || 5);
    console.log(`[Zoom] Rate limited, retrying in ${retryAfter}s`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return zoomApiRequestImpl(path, retries + 1, authRetried, opts);
  }

  if (!res.ok) {
    const text = await res.text();
    const kind = classifyZoomApiError(res.status, text);
    if (kind === "auth") {
      // Task #1843: don't slam the global auth gate on the first 401 — try a
      // forced refresh-and-retry once. A clock-skew / 5-min lookahead race /
      // brief Zoom-side revocation will return a 401 that a refresh fixes,
      // and that should be invisible to operators. Only if the retried call
      // ALSO returns auth-failure, or the refresh itself returns a terminal
      // error (`invalid_grant` etc.), engage the gate.
      if (!authRetried) {
        return zoomApiRequestRefreshAndRetry(text, () =>
          zoomApiRequestImpl(path, retries, true, opts),
          opts,
        );
      }
      // Task #2267 — only an authoritative caller commits the disconnect.
      // A `zoom_probe` whose retried call still 401s surfaces `unauthorized`
      // but must NOT engage the global auth gate (that would back off every
      // healthy Zoom surface on a probe-only blip). A real surface still
      // engages the gate when IT exhausts its refresh-and-retry.
      if (isAuthoritativeRefreshPurpose(opts?.purpose)) {
        setZoomAuthGate(res.status, text.slice(0, 500));
      } else {
        console.warn(
          `[Zoom] Retried 401 on non-authoritative '${opts?.purpose}' attempt — NOT engaging auth gate (probe-safe); surfacing to caller.`,
        );
      }
      throw new ZoomPermanentError("auth", res.status, text);
    }
    if (kind === "scope") {
      setZoomScopeGate(scopeKey, res.status, text.slice(0, 500));
      throw new ZoomPermanentError("scope", res.status, text, { scopeKey });
    }
    throw new Error(`Zoom API error: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * Task #1843: shared refresh-and-retry helper used by both API impls when
 * Zoom returns 401. Forces a token refresh and re-issues the request via
 * `retry()`. If refresh itself returns a terminal error, engages the auth
 * gate with that reason; transient refresh errors propagate without
 * engaging the gate so the next API attempt tries again.
 */
async function zoomApiRequestRefreshAndRetry<T>(
  initialBody: string,
  retry: () => Promise<T>,
  opts?: { purpose?: string },
): Promise<T> {
  try {
    await refreshAccessToken();
  } catch (refreshErr) {
    if (refreshErr instanceof ZoomRefreshError && refreshErr.terminal) {
      const reason = `refresh ${refreshErr.oauthError ?? refreshErr.status}: ${refreshErr.responseBody.slice(0, 200)}`;
      // Task #2267 — only an authoritative caller commits the disconnect.
      // The `zoom_probe` (and any non-authoritative top-up) re-throws a
      // permanent error so the probe surfaces `unauthorized`, but must NOT
      // engage the global auth gate or latch the terminal verdict: a
      // rotation-race `invalid_grant` from a background health check would
      // otherwise back off every healthy Zoom surface. A real surface
      // still latches + engages the gate when IT hits the same failure.
      if (isAuthoritativeRefreshPurpose(opts?.purpose)) {
        // Latch terminal BEFORE engaging the gate so the self-heal scheduler
        // (kicked from setZoomAuthGate) sees the latch and immediately
        // stands down instead of pointlessly retrying a refresh we already
        // know will keep failing with the same OAuth error.
        zoomAuthRefreshTerminal = {
          oauthError: refreshErr.oauthError,
          body: refreshErr.responseBody.slice(0, 500),
        };
        setZoomAuthGate(401, reason);
      } else {
        console.warn(
          `[Zoom] Terminal refresh-and-retry on non-authoritative '${opts?.purpose}' attempt — NOT engaging auth gate (probe-safe); surfacing to caller.`,
        );
      }
      throw new ZoomPermanentError("auth", 401, reason, {
        message: `Zoom auth gate engaged — refresh terminal (${refreshErr.oauthError ?? refreshErr.status}); operator must reconnect`,
      });
    }
    // Transient refresh failure (network blip, 5xx, 429 exhaustion) — do
    // NOT engage the gate. Throw a non-permanent error so the worker
    // retries on its own cadence.
    const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
    throw new Error(`Zoom API error: 401 (refresh-and-retry transient: ${msg}); initial body: ${initialBody.slice(0, 200)}`);
  }
  return retry();
}

export async function isConnected(): Promise<boolean> {
  // Task #3973 — s2s mode stores no tokens; "connected" = account-level
  // credentials configured (liveness is the probe's job, as in oauth mode).
  if ((await getZoomAuthMode()) === "s2s") {
    return hasZoomS2sCredentials();
  }
  const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
  return !!tokenSetting?.value;
}

// Task #1888 — outcome-aware probe contract (matches Slack/Front).
//   "connected"    — Zoom answered a /users/me probe successfully.
//   "unauthorized" — stored credentials are structurally bad OR Zoom
//                    rejected with a persistent auth error (401/403/etc),
//                    OR the global auth gate is already engaged. Cache
//                    commits Not-Connected with this reason.
//   "probe_failed" — transient (5xx / network / validation backoff).
//                    Cache preserves the previous value.
export type ZoomProbeOutcome = "connected" | "unauthorized" | "probe_failed";
export interface ZoomProbeResult {
  outcome: ZoomProbeOutcome;
  reason?: string;
}

export async function probeConnection(): Promise<ZoomProbeResult> {
  // Task #3973 — an unreadable mode flag is UNKNOWN, not disconnected:
  // surface probe_failed so the status cache preserves the previous value.
  let probeAuthMode: ZoomAuthMode;
  try {
    probeAuthMode = await getZoomAuthMode();
  } catch (err: any) {
    return {
      outcome: "probe_failed",
      reason: `auth_mode_read_failed: ${String(err?.message ?? err)}`.slice(0, 200),
    };
  }
  if (probeAuthMode === "s2s") {
    // s2s stores no tokens — structural readiness = env credentials present.
    if (!hasZoomS2sCredentials()) {
      return { outcome: "unauthorized", reason: "s2s_credentials_missing" };
    }
  } else {
    const [accessSetting, refreshSetting] = await Promise.all([
      storage.getSystemSetting(SETTINGS_KEY_ACCESS),
      storage.getSystemSetting(SETTINGS_KEY_REFRESH),
    ]);
    if (!accessSetting?.value && !refreshSetting?.value) {
      return { outcome: "unauthorized", reason: "no_tokens_stored" };
    }
  }
  if (zoomAuthGate) {
    return { outcome: "unauthorized", reason: `auth_gate:${zoomAuthGate.reason}` };
  }
  if (isZoomValidationInBackoff()) {
    return { outcome: "probe_failed", reason: "validation_backoff" };
  }
  const result = await validateConnection();
  if (result.valid) return { outcome: "connected" };
  const errMsg = (result.error || "validation_failed").slice(0, 200);
  if (isPersistentAuthError(errMsg)) {
    return { outcome: "unauthorized", reason: errMsg };
  }
  return { outcome: "probe_failed", reason: errMsg };
}

// Task #1977 — match the Slack trigger taxonomy so the credential history
// can tell a manual disconnect apart from any future terminal-auth wipe.
export type ZoomTokenClearTrigger =
  | "manual_disconnect"
  | "connect_terminal_auth_error";

// Task #2240 — in-memory credential override (test-only).
//
// Zoom stores its OAuth credential in the shared `system_settings` table,
// which the always-on "Start application" workers keep re-writing in the
// `public` schema as they refresh the real token. The
// `zoom-disconnect-audit` suite seeds a *fake* token and asserts
// disconnect clears it; against the shared dev DB that refresh races the
// assertion and re-seeds a real token. When this override is installed
// (only by that suite) the disconnect path's credential clears go to the
// in-memory map instead of `system_settings`, so the suite owns the
// credential state outright and never touches a row the dev server also
// writes. Production never installs it. Mirrors the
// `setStateOverrideForTests` pattern in frontAutoClosureRegressionAlerts.ts.
let credentialStoreOverride: Map<string, string> | null = null;

export function __setZoomCredentialStoreOverrideForTests(
  store: Map<string, string> | null,
): void {
  credentialStoreOverride = store;
}

// Task #3128 — named counter for wipe/disconnect audit-write failures
// (mirrors semrushApi.ts, Task #3126). The disconnect breadcrumb is the ONLY
// durable record of a Zoom credential wipe; if its INSERT throws (e.g. DB
// pool exhausted), the failure must not vanish into autoscale console logs
// that expire with the deployment window. The paired low-severity operator
// alert (dedupeKey "wipe_audit_write_failed") is the durable signal; this
// counter gives tests and any in-process health surface a deterministic hook.
export const ZOOM_WIPE_AUDIT_WRITE_FAILED_COUNTER = "zoom.wipe_audit_write_failed";
let __wipeAuditWriteFailedCount = 0;

/** Current value of the zoom.wipe_audit_write_failed counter (per-process). */
export function getZoomWipeAuditWriteFailedCount(): number {
  return __wipeAuditWriteFailedCount;
}

/** Test-only: reset the wipe-audit-write-failed counter. */
export function __resetZoomWipeAuditWriteFailedCountForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetZoomWipeAuditWriteFailedCountForTest is test-only");
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

export function __setZoomWipeAuditNotifyOverrideForTest(
  fn: ((id: string, payload: any, opts: any) => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setZoomWipeAuditNotifyOverrideForTest is test-only");
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
  options?: { trigger?: ZoomTokenClearTrigger; reason?: string | null; notes?: string | null },
): Promise<void> {
  const actor = updatedBy ?? "system";
  const trigger: ZoomTokenClearTrigger = options?.trigger ?? "manual_disconnect";
  await clearCredentialSetting(SETTINGS_KEY_ACCESS, actor);
  await clearCredentialSetting(SETTINGS_KEY_REFRESH, actor);
  await clearCredentialSetting(SETTINGS_KEY_EXPIRES, actor);
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
      `[Zoom] ${ZOOM_WIPE_AUDIT_WRITE_FAILED_COUNTER} count=${__wipeAuditWriteFailedCount} — disconnect audit insert failed:`,
      err?.message,
    );
    try {
      const auditAlertPayload = {
        text:
          `*Zoom credential-wipe audit breadcrumb FAILED to persist* — the token clear itself succeeded, ` +
          `but the durable audit record could not be written (counter: \`${ZOOM_WIPE_AUDIT_WRITE_FAILED_COUNTER}\`).\n` +
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
          "integration.zoom.auth_failed",
          auditAlertPayload,
          auditAlertOpts,
        );
      } else {
        const { notifyByType } = await import("./notifications/dispatcher");
        await notifyByType(
          "integration.zoom.auth_failed",
          auditAlertPayload,
          auditAlertOpts,
        );
      }
    } catch (metaErr: any) {
      console.warn(
        "[Zoom] wipe-audit-failure alert failed (non-fatal):",
        metaErr?.message ?? metaErr,
      );
    }
  }
}

export async function validateConnection(): Promise<{ valid: boolean; error?: string }> {
  if (isZoomValidationInBackoff()) {
    return { valid: false, error: "Validation in backoff — too many consecutive failures" };
  }

  try {
    // Task #3973 — mode-aware validation. In s2s mode there is no stored
    // token (mints happen on demand inside zoomApiRequest), and Zoom
    // rejects the `me` context for Server-to-Server apps — so s2s skips
    // both the stored-token precheck and the /users/me primary probe and
    // validates via the users LIST directly.
    const validateAuthMode = await getZoomAuthMode();
    if (validateAuthMode === "oauth") {
      const tokenSetting = await storage.getSystemSetting(SETTINGS_KEY_ACCESS);
      if (!tokenSetting?.value) {
        return { valid: false, error: "No access token stored" };
      }
    }

    let primaryError: string | null = null;

    if (validateAuthMode === "oauth") {
      try {
        // Task #2267 — `validateConnection` is only reached from the badge
        // probe (`probeConnection`) and the read-only health route, both of
        // which are non-authoritative. Tag the calls `zoom_probe` so a
        // terminal refresh here surfaces `unauthorized` WITHOUT engaging the
        // global auth gate or wiping tokens on a rotation-race blip.
        const data = await zoomApiRequest("/users/me", 0, { purpose: "zoom_probe" });
        if (data?.id) {
          resetZoomValidationBreaker();
          return { valid: true };
        }
        primaryError = "Invalid /users/me response (no id)";
      } catch (primaryErr: any) {
        primaryError = primaryErr.message;
      }
    } else {
      primaryError = "s2s mode — /users/me context unavailable, probing users list";
    }

    try {
      const fallbackData = await zoomApiRequest("/users?page_size=1", 0, { purpose: "zoom_probe" });
      if (Array.isArray(fallbackData?.users)) {
        resetZoomValidationBreaker();
        return { valid: true };
      }
      const errorMsg = `Primary: ${primaryError}; Fallback: invalid response`;
      recordZoomValidationFailure(errorMsg);
      return { valid: false, error: errorMsg };
    } catch (fallbackErr: any) {
      const errorMsg = `Primary: ${primaryError}; Fallback: ${fallbackErr.message}`;
      recordZoomValidationFailure(errorMsg);
      return { valid: false, error: errorMsg };
    }
  } catch (err: any) {
    const errorMsg = err.message || "Token validation failed";
    recordZoomValidationFailure(errorMsg);
    return { valid: false, error: errorMsg };
  }
}

export async function listAllAccountUsers(): Promise<Array<{ id: string; email: string; name?: string }>> {
  const users: Array<{ id: string; email: string; name?: string }> = [];
  let nextPageToken = "";
  do {
    const params = `status=active&page_size=100${nextPageToken ? `&next_page_token=${nextPageToken}` : ""}`;
    const data = await zoomApiRequest(`/users?${params}`);
    for (const u of data.users || []) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || undefined;
      users.push({ id: u.id, email: u.email, name });
    }
    nextPageToken = data.next_page_token || "";
  } while (nextPageToken);
  return users;
}

export async function listRecentRecordings(fromDate?: string, toDate?: string, lookbackHours?: number): Promise<any[]> {
  // Task #954 (945C): fail-fast under the global auth gate so iterating
  // schedulers (recent-meetings ingest, reconciliation, discoverUnmatched)
  // skip the per-user fan-out instead of logging "Failed to fetch recordings"
  // for every user on every run while the operator hasn't reconnected.
  // Scope gates are intentionally NOT consulted here — a missing
  // participant scope must not block recordings enumeration.
  if (zoomAuthGate) {
    console.log(
      `[Zoom] Skipping listRecentRecordings — auth gate engaged (operator reconnect required)`,
    );
    return [];
  }
  const defaultLookbackMs = (lookbackHours ?? 30 * 24) * 60 * 60 * 1000;
  const from = fromDate || new Date(Date.now() - defaultLookbackMs).toISOString().split("T")[0];
  const to = toDate || new Date().toISOString().split("T")[0];

  let users: Array<{ id: string; email: string; name?: string }>;
  try {
    users = await listAllAccountUsers();
    console.log(`[Zoom] Fetching recordings for ${users.length} account users`);
  } catch (err: any) {
    console.log(`[Zoom] Could not list account users (${err.message}), falling back to /users/me`);
    users = [{ id: "me", email: "" }];
  }

  const allMeetings: any[] = [];
  for (const user of users) {
    try {
      const data = await zoomApiRequest(`/users/${user.id}/recordings?from=${from}&to=${to}&page_size=100`);
      const meetings = data.meetings || [];
      if (meetings.length > 0) {
        console.log(`[Zoom] Found ${meetings.length} recordings for ${user.email || user.id}`);
      }
      for (const m of meetings) {
        if (!m.host_email && user.email) m.host_email = user.email;
        if (!m.host_name) m.host_name = user.name || (user.email ? user.email.split("@")[0] : undefined);
      }
      allMeetings.push(...meetings);
    } catch (err: any) {
      console.log(`[Zoom] Failed to fetch recordings for ${user.email || user.id}: ${err.message}`);
    }
  }
  return allMeetings;
}

// Task #4057 — year-back Transcript Match Assistant sweep listing.
//
// Differs from `listRecentRecordings` in two deliberate ways:
//   1. It paginates each user's recordings via `next_page_token` —
//     `listRecentRecordings` reads only the first 100 per user, which is fine
//     for a 30-day lookback but silently truncates a 30-day *historical*
//     window on busy hosts.
//   2. It THROWS `ZoomPermanentError` when the auth gate is engaged instead of
//     returning [] — the sweep must fail loudly ("reconnect Zoom") rather
//     than report an honest-looking "0 meetings found". The same applies
//     MID-listing: a permanent auth/scope error from any user's request
//     propagates instead of being swallowed as a per-user skip.
export async function listRecordingsWindowPaginated(
  fromDate: string,
  toDate: string,
  // Injectable seam for tests only — production callers pass nothing. Lets
  // the suite prove per-user error semantics (permanent errors propagate,
  // transient errors skip one user) without live Zoom credentials.
  deps: {
    apiRequest?: (path: string) => Promise<any>;
    listUsers?: () => Promise<Array<{ id: string; email: string; name?: string }>>;
  } = {},
): Promise<any[]> {
  const apiRequest = deps.apiRequest ?? zoomApiRequest;
  const listUsers = deps.listUsers ?? listAllAccountUsers;
  if (zoomAuthGate) {
    throw new ZoomPermanentError("auth", zoomAuthGate.status, zoomAuthGate.reason, {
      message: `Zoom auth gate engaged — operator must reconnect (${zoomAuthGate.reason})`,
    });
  }

  let users: Array<{ id: string; email: string; name?: string }>;
  try {
    users = await listUsers();
  } catch (err: any) {
    console.log(
      `[ZoomMatchSweep] Could not list account users (${err.message}), falling back to /users/me`,
    );
    users = [{ id: "me", email: "" }];
  }

  const allMeetings: any[] = [];
  for (const user of users) {
    let nextPageToken = "";
    do {
      const tokenParam = nextPageToken
        ? `&next_page_token=${encodeURIComponent(nextPageToken)}`
        : "";
      let data: any;
      try {
        data = await apiRequest(
          `/users/${user.id}/recordings?from=${fromDate}&to=${toDate}&page_size=100${tokenParam}`,
        );
      } catch (err: any) {
        // A permanent auth/scope failure mid-listing must sink the whole
        // window: swallowed, it would let the sweep mark this window "done"
        // while meetings were silently never listed. The gate check at the
        // top of this function only covers gates raised BEFORE this call —
        // a mid-window trip surfaces right here.
        if (err instanceof ZoomPermanentError) {
          throw err;
        }
        // Transient per-user failures (deactivated hosts, retry-exhausted
        // 5xx) skip just that user rather than sinking the whole window —
        // same stance as listRecentRecordings.
        console.log(
          `[ZoomMatchSweep] Failed to fetch recordings for ${user.email || user.id}: ${err.message}`,
        );
        break;
      }
      const meetings = data.meetings || [];
      for (const m of meetings) {
        if (!m.host_email && user.email) m.host_email = user.email;
        if (!m.host_name) m.host_name = user.name || (user.email ? user.email.split("@")[0] : undefined);
      }
      allMeetings.push(...meetings);
      nextPageToken = data.next_page_token || "";
    } while (nextPageToken);
  }
  return allMeetings;
}
export async function getMeetingDetails(meetingId: string): Promise<any> {
  return zoomApiRequest(`/meetings/${meetingId}`);
}

// ---------------------------------------------------------------------------
// Task #840 — Scheduled meeting helpers (booking tool)
// ---------------------------------------------------------------------------

async function zoomApiRequestWithBody(
  path: string,
  init: { method: string; body?: unknown },
  retries = 0,
): Promise<any> {
  if (retries === 0) {
    const { auditOutboundCall } = await import("./externalCallAudit");
    const { createHash } = await import("node:crypto");
    return auditOutboundCall(
      { integration: "zoom", endpoint: path, method: init.method },
      async () => {
        const data = await zoomApiRequestWithBodyImpl(path, init, retries);
        const payload = data === undefined || data === null ? "" : JSON.stringify(data);
        const bytes = Buffer.byteLength(payload, "utf8");
        const hash = bytes > 0
          ? createHash("sha256").update(payload).digest("hex").slice(0, 64)
          : undefined;
        return { value: data, statusCode: 200, responseSizeBytes: bytes, responseHash: hash };
      },
    );
  }
  return zoomApiRequestWithBodyImpl(path, init, retries);
}

async function zoomApiRequestWithBodyImpl(
  path: string,
  init: { method: string; body?: unknown },
  retries = 0,
  authRetried = false,
): Promise<any> {
  // Task #954 (945C): same scoped fail-fast as zoomApiRequest — booking
  // writes only short-circuit on the global auth gate or on a scope gate
  // for their own endpoint family.
  if (zoomAuthGate) {
    throw new ZoomPermanentError("auth", zoomAuthGate.status, zoomAuthGate.reason, {
      message: `Zoom auth gate engaged — operator must reconnect (${zoomAuthGate.reason})`,
    });
  }
  const scopeKey = zoomScopeKeyForPath(path);
  const scopeGate = zoomScopeGates.get(scopeKey);
  if (scopeGate) {
    throw new ZoomPermanentError("scope", scopeGate.status, scopeGate.reason, {
      message: `Zoom scope gate engaged for "${scopeKey}" — operator must grant missing scopes (${scopeGate.reason})`,
      scopeKey,
    });
  }

  const token = await getAccessToken();
  const res = await fetch(`${ZOOM_API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 429) {
    if (retries >= 3) throw new Error("Zoom API rate limit exceeded after retries");
    const retryAfter = Number(res.headers.get("Retry-After") || 5);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return zoomApiRequestWithBodyImpl(path, init, retries + 1, authRetried);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  if (!res.ok) {
    const kind = classifyZoomApiError(res.status, text);
    if (kind === "auth") {
      // Task #1843: refresh-and-retry once before engaging the auth gate.
      // See zoomApiRequestImpl for rationale.
      if (!authRetried) {
        return zoomApiRequestRefreshAndRetry(text, () =>
          zoomApiRequestWithBodyImpl(path, init, retries, true),
        );
      }
      setZoomAuthGate(res.status, text.slice(0, 500));
      throw new ZoomPermanentError("auth", res.status, text);
    }
    if (kind === "scope") {
      setZoomScopeGate(scopeKey, res.status, text.slice(0, 500));
      throw new ZoomPermanentError("scope", res.status, text, { scopeKey });
    }
    throw new Error(`Zoom API error: ${res.status} ${text}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface ZoomUserSummary {
  id: string;
  email: string;
  name?: string;
}

const zoomUserCache = new Map<string, { user: ZoomUserSummary | null; expiresAt: number }>();
const ZOOM_USER_CACHE_TTL_MS = 10 * 60 * 1000;

// Task #2897 (Reserved VM memory audit) — expiry was only checked on
// access, so entries for emails/ids never looked up again lingered
// forever. Every write now sweeps expired entries (and enforces a hard
// cap as a belt-and-braces bound on a weeks-long uptime).
const ZOOM_USER_CACHE_CAP = 2000;
function setZoomUserCache(key: string, value: { user: ZoomUserSummary | null; expiresAt: number }): void {
  const now = Date.now();
  for (const [k, v] of zoomUserCache) {
    if (v.expiresAt <= now) zoomUserCache.delete(k);
  }
  zoomUserCache.set(key, value);
  while (zoomUserCache.size > ZOOM_USER_CACHE_CAP) {
    const oldest = zoomUserCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    zoomUserCache.delete(oldest);
  }
}

/**
 * Resolve a Zoom user (id) by email. Cached for 10 minutes. Returns null if
 * the user does not exist on the Zoom account (caller decides whether to
 * fall back to "me" or fail the booking).
 */
export async function resolveZoomUserByEmail(email: string): Promise<ZoomUserSummary | null> {
  const key = email.trim().toLowerCase();
  if (!key) return null;
  const cached = zoomUserCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }
  try {
    const data = await zoomApiRequest(`/users/${encodeURIComponent(key)}`);
    if (data?.id) {
      const user: ZoomUserSummary = {
        id: data.id,
        email: data.email || key,
        name: [data.first_name, data.last_name].filter(Boolean).join(" ") || undefined,
      };
      setZoomUserCache(key, { user, expiresAt: Date.now() + ZOOM_USER_CACHE_TTL_MS });
      return user;
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/\b404\b/.test(msg) || /1001/.test(msg)) {
      // User not found on the account — cache the negative for a short time
      // so a typo in a booking page email doesn't hammer the Zoom API.
      setZoomUserCache(key, { user: null, expiresAt: Date.now() + 60_000 });
      return null;
    }
    throw err;
  }
  return null;
}

export function clearZoomUserCache(): void {
  zoomUserCache.clear();
}

/**
 * Test-only helper: prime the Zoom user cache so unit tests can
 * exercise resolution without hitting the network. Pass `null` to
 * cache a negative result (Zoom would 404).
 */
export function __primeZoomUserCacheForTest(
  key: { email?: string; zoomUserId?: string },
  user: ZoomUserSummary | null,
): void {
  if (key.email) {
    zoomUserCache.set(key.email.trim().toLowerCase(), {
      user,
      expiresAt: Date.now() + ZOOM_USER_CACHE_TTL_MS,
    });
  }
  if (key.zoomUserId) {
    zoomUserCache.set(`id:${key.zoomUserId.trim()}`, {
      user,
      expiresAt: Date.now() + ZOOM_USER_CACHE_TTL_MS,
    });
  }
}

/**
 * Resolve a Zoom user by Zoom user id. Zoom's `/users/{userId}` endpoint
 * accepts either an email or a user id, but we keep two named helpers so
 * call sites read clearly. The id-based cache key is namespaced so it
 * cannot collide with the email-keyed cache.
 */
export async function resolveZoomUserById(
  zoomUserId: string,
): Promise<ZoomUserSummary | null> {
  const id = (zoomUserId || "").trim();
  if (!id) return null;
  const key = `id:${id}`;
  const cached = zoomUserCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }
  try {
    const data = await zoomApiRequest(`/users/${encodeURIComponent(id)}`);
    if (data?.id) {
      const user: ZoomUserSummary = {
        id: data.id,
        email: data.email || "",
        name: [data.first_name, data.last_name].filter(Boolean).join(" ") || undefined,
      };
      setZoomUserCache(key, { user, expiresAt: Date.now() + ZOOM_USER_CACHE_TTL_MS });
      return user;
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/\b404\b/.test(msg) || /1001/.test(msg)) {
      setZoomUserCache(key, { user: null, expiresAt: Date.now() + 60_000 });
      return null;
    }
    throw err;
  }
  return null;
}

/**
 * Task #931 (929B) — validate a candidate Zoom host override before we
 * persist it on the user row. Returns a typed discriminated-union
 * result so callers (the booking route, future readiness checks) can
 * map each failure mode to a stable error code without inspecting
 * thrown messages or null sentinels.
 */
export interface ZoomHostOverrideValidationInput {
  email?: string | null;
  zoomUserId?: string | null;
}
export type ZoomHostOverrideValidationError =
  // Neither an email nor a Zoom user id was provided.
  | { ok: false; code: "empty_input"; message: string }
  // Zoom returned no user for the supplied email/id.
  | { ok: false; code: "zoom_host_override_invalid"; message: string }
  // The id resolved to a Zoom user whose email does not match the
  // supplied email — likely a typo or a copy-paste from the wrong
  // account. Persisting would leave a contradictory pair on the row.
  | { ok: false; code: "zoom_host_override_mismatch"; message: string }
  // Zoom rejected the lookup with a non-404 error (auth/rate-limit).
  // The caller should map this to a 502 so the AM can retry.
  | { ok: false; code: "zoom_unreachable"; message: string };
export type ZoomHostOverrideValidationResult =
  | {
      ok: true;
      zoomUserId: string;
      zoomEmail: string;
      displayName?: string;
    }
  | ZoomHostOverrideValidationError;
export async function validateZoomHostOverride(
  input: ZoomHostOverrideValidationInput,
): Promise<ZoomHostOverrideValidationResult> {
  const email = (input.email || "").trim();
  const zoomUserId = (input.zoomUserId || "").trim();
  if (!email && !zoomUserId) {
    return {
      ok: false,
      code: "empty_input",
      message: "Provide a Zoom email and/or Zoom user id to validate.",
    };
  }

  // When the explicit Zoom user id is supplied it is the source of
  // truth — it must resolve, and (if an email is also supplied) the
  // resolved user's email must match. We do NOT silently fall back to
  // an email lookup when the id fails to resolve: doing so would let
  // the route persist the caller's invalid id alongside a different,
  // unrelated user resolved by email. When only an email is supplied
  // we resolve by email.
  let resolved: ZoomUserSummary | null = null;
  try {
    if (zoomUserId) {
      resolved = await resolveZoomUserById(zoomUserId);
    } else if (email) {
      resolved = await resolveZoomUserByEmail(email);
    }
  } catch (err: any) {
    return {
      ok: false,
      code: "zoom_unreachable",
      message: err?.message || "Zoom user lookup failed",
    };
  }
  if (!resolved?.id) {
    return {
      ok: false,
      code: "zoom_host_override_invalid",
      message: "No Zoom user found for the provided email or user id.",
    };
  }

  if (zoomUserId && email && resolved.email) {
    if (resolved.email.trim().toLowerCase() !== email.toLowerCase()) {
      return {
        ok: false,
        code: "zoom_host_override_mismatch",
        message:
          "The Zoom user id resolves to a different email than the one provided.",
      };
    }
  }

  return {
    ok: true,
    zoomUserId: resolved.id,
    zoomEmail: resolved.email || email,
    displayName: resolved.name,
  };
}

/**
 * Task #932 (929C) — Canonical effective Zoom host resolver.
 *
 * Single source of truth used by every host-resolution call site
 * (readiness check + booking saga + diagnostics) so the readiness UI
 * and the booking saga can never disagree about which Zoom user is the
 * effective host for a given OS user.
 *
 * Resolution order:
 *   1. Per-user override (from 929B). When `zoomHostOverrideEmail` or
 *      `zoomHostOverrideUserId` is set we trust the validated metadata
 *      captured on the last successful PUT — we do NOT round-trip Zoom
 *      on the hot path. The validator already proved the override
 *      maps to a real Zoom user; if a Zoom admin later deletes that
 *      user, the actual Zoom API call (createScheduledMeeting) will
 *      surface the failure with a clear message.
 *   2. Auto-resolve fallback by `users.email` (existing behavior).
 *   3. `source: "none"` with a structured `error` so callers can map
 *      to a clear, actionable failure.
 */
export interface EffectiveZoomHostUser {
  id?: string;
  email?: string | null;
  zoomHostOverrideEmail?: string | null;
  zoomHostOverrideUserId?: string | null;
  zoomHostOverrideValidatedEmail?: string | null;
  zoomHostOverrideValidatedAt?: Date | null;
  zoomHostOverrideDisplayName?: string | null;
}

export interface EffectiveZoomHost {
  source: "override" | "app_email" | "none";
  zoomUserId?: string;
  zoomEmail?: string;
  displayName?: string;
  validatedAt?: Date;
  error?: string;
}

export async function resolveEffectiveZoomHostForUser(
  user: EffectiveZoomHostUser | null | undefined,
): Promise<EffectiveZoomHost> {
  if (!user) {
    return { source: "none", error: "User not found." };
  }

  const overrideUserId = (user.zoomHostOverrideUserId || "").trim() || null;
  const overrideEmail = (user.zoomHostOverrideEmail || "").trim() || null;
  if (overrideUserId || overrideEmail) {
    const validatedEmail =
      (user.zoomHostOverrideValidatedEmail || "").trim() || overrideEmail;
    return {
      source: "override",
      zoomUserId: overrideUserId || undefined,
      zoomEmail: validatedEmail || undefined,
      displayName: user.zoomHostOverrideDisplayName || undefined,
      validatedAt: user.zoomHostOverrideValidatedAt || undefined,
    };
  }

  const appEmail = (user.email || "").trim();
  if (!appEmail) {
    return { source: "none", error: "Account has no email." };
  }

  try {
    const zoomUser = await resolveZoomUserByEmail(appEmail);
    if (zoomUser?.id) {
      return {
        source: "app_email",
        zoomUserId: zoomUser.id,
        zoomEmail: zoomUser.email || appEmail,
        displayName: zoomUser.name,
      };
    }
    return {
      source: "none",
      error: "No Zoom user found for this email.",
    };
  } catch (err: any) {
    return {
      source: "none",
      error: err?.message || "Zoom user lookup failed",
    };
  }
}

export interface CreateScheduledMeetingInput {
  hostEmail: string;
  topic: string;
  startTimeUtc: Date;
  durationMinutes: number;
  timezone: string;
  agenda?: string;
  password?: string;
  inviteeEmail?: string;
  inviteeName?: string;
}

export interface CreatedZoomMeeting {
  id: string;
  uuid: string;
  joinUrl: string;
  startUrl: string;
  password: string | null;
  raw: any;
}

/**
 * Create a Zoom scheduled meeting (type 2 — never PMI). Recording is set to
 * cloud so the existing ingestion path picks it up; auto-recording is the
 * single most important setting for the deterministic-match guarantee.
 */
export async function createScheduledMeeting(
  input: CreateScheduledMeetingInput,
): Promise<CreatedZoomMeeting> {
  const host = await resolveZoomUserByEmail(input.hostEmail);
  if (!host) {
    throw new Error(
      `Zoom host not found for email "${input.hostEmail}". The account manager must exist as a Zoom user on the connected account.`,
    );
  }

  // Zoom accepts a UTC `start_time` (ending in Z) alongside a `timezone`
  // string used purely for display in the host's Zoom panel and in
  // notification emails. We pass the booking page's configured timezone
  // through so the AM and the invitee see the meeting in the AM's local
  // time. We retain the explicit Z on the timestamp so the moment is
  // unambiguous regardless of what `timezone` is set to. Fallback to
  // "UTC" if the caller didn't supply one (defensive — the booking
  // saga always passes `req.page.timezone`).
  const startTimeIso = input.startTimeUtc.toISOString().replace(/\.\d{3}Z$/, "Z");
  const displayTimezone =
    typeof input.timezone === "string" && input.timezone.trim().length > 0
      ? input.timezone
      : "UTC";

  const body: Record<string, unknown> = {
    topic: input.topic.slice(0, 200),
    type: 2, // scheduled meeting (never PMI)
    start_time: startTimeIso,
    duration: Math.max(15, Math.round(input.durationMinutes)),
    timezone: displayTimezone,
    agenda: (input.agenda || "").slice(0, 2000),
    settings: {
      host_video: true,
      participant_video: true,
      join_before_host: false,
      jbh_time: 0,
      mute_upon_entry: true,
      auto_recording: "cloud",
      waiting_room: false,
      use_pmi: false,
      approval_type: 2, // no registration
      audio: "both",
      registrants_email_notification: false,
      meeting_authentication: false,
    },
  };
  if (input.password) {
    body.password = input.password.slice(0, 10);
  }

  const data = await zoomApiRequestWithBody(
    `/users/${encodeURIComponent(host.id)}/meetings`,
    { method: "POST", body },
  );

  if (!data?.id) {
    throw new Error("Zoom create-meeting response missing id");
  }

  return {
    id: String(data.id),
    uuid: String(data.uuid || ""),
    joinUrl: String(data.join_url || ""),
    startUrl: String(data.start_url || ""),
    password: data.password ?? null,
    raw: data,
  };
}

/**
 * Delete (cancel) a Zoom scheduled meeting. Idempotent — a 404 is treated as
 * success because the booking saga may retry the cancel step.
 */
export async function deleteScheduledMeeting(
  meetingId: string,
  opts?: { notifyHost?: boolean; cancelMeetingReminder?: boolean },
): Promise<void> {
  const params = new URLSearchParams();
  if (opts?.notifyHost) params.set("schedule_for_reminder", "true");
  if (opts?.cancelMeetingReminder) params.set("cancel_meeting_reminder", "true");
  const qs = params.toString();
  const path = `/meetings/${encodeURIComponent(meetingId)}${qs ? `?${qs}` : ""}`;
  try {
    await zoomApiRequestWithBody(path, { method: "DELETE" });
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/\b404\b/.test(msg) || /3001/.test(msg)) {
      // Already gone — idempotent success.
      return;
    }
    throw err;
  }
}

/**
 * Returns the set of granted scopes for diagnostic display. The booking saga
 * calls Zoom's create + delete + (occasionally) update meeting endpoints on
 * top of the existing recording-ingestion endpoints, so the readiness check
 * MUST validate all of those — not just user-list — otherwise the admin
 * panel can report "ready" while bookings still fail at runtime.
 *
 * Two-phase validation:
 *
 *   Phase 1 — Read probes (proves the token is alive and scope family X
 *   is grant-able / endpoint-reachable):
 *     - user:read       → GET /users?page_size=1
 *     - meeting:read    → GET /users/me/meetings?type=scheduled&page_size=1
 *     - recording:read  → GET /users/me/recordings (small window)
 *
 *   Phase 2 — Granted-scope introspection (proves the booking-specific
 *   write/delete scopes are present, since Zoom's granular regime treats
 *   read/write/delete as DISTINCT scopes; a read probe cannot prove
 *   write/delete are exercisable):
 *     - meeting:write:meeting:admin   (saga create call)
 *     - meeting:delete:meeting:admin  (saga rollback / cancel call)
 *
 *   We use the `scope` field returned by Zoom's OAuth/token endpoint
 *   (persisted by `storeTokens`) rather than actually creating a probe
 *   meeting — creating a throwaway scheduled meeting to verify
 *   create-scope would pollute the host calendar.
 *
 * Each missing booking-write/delete scope is reported distinctly in
 * `missing` so the admin UI can prompt the operator to reauthorize. If
 * we have no granted-scope record yet (token issued before Task #840 and
 * not yet refreshed), Phase 2 reports the inability to introspect rather
 * than falsely claiming the scopes are missing.
 */
export async function checkBookingScopeReadiness(): Promise<{
  ready: boolean;
  missing: string[];
  errors: Record<string, string>;
}> {
  const errors: Record<string, string> = {};
  const missing: string[] = [];
  // Set when we can't introspect granted scopes at all. We treat that as
  // NOT-ready so the admin UI never shows a false-green "Valid" while the
  // booking write/delete scope status is actually unknown.
  let scopeIntrospectionFailed = false;

  // Task #3973 — S2S tokens are account-level: Zoom rejects the `me`
  // context for Server-to-Server apps, so in s2s mode the per-user read
  // probes resolve a concrete user id first (any active account user
  // proves the scope). When no user can be resolved the two per-user
  // probes are skipped with an explanatory error entry — scope
  // introspection (phase 2 below) still decides readiness.
  let probeUserContext: string | null = "me";
  try {
    if ((await getZoomAuthMode()) === "s2s") {
      probeUserContext = null;
      const list = await zoomApiRequest("/users?page_size=1");
      const firstId = list?.users?.[0]?.id;
      if (typeof firstId === "string" && firstId.length > 0) {
        probeUserContext = firstId;
      } else {
        errors["__s2s_probe_user__"] =
          "No account users returned — skipped per-user meeting/recording read probes";
      }
    }
  } catch (err: any) {
    probeUserContext = null;
    errors["__s2s_probe_user__"] = `Could not resolve a probe user: ${err?.message || String(err)}`;
  }

  const probes: Array<{ scope: string; path: string }> = [
    { scope: "user:read:user:admin", path: "/users?page_size=1" },
  ];
  if (probeUserContext) {
    probes.push({
      scope: "meeting:read:meeting:admin",
      path: `/users/${probeUserContext}/meetings?type=scheduled&page_size=1`,
    });
    probes.push({
      scope: "recording:read:list_user_recordings:admin",
      // Last-7-day window keeps the response tiny on accounts with lots of recordings.
      path: (() => {
        const to = new Date();
        const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
        const fmt = (d: Date) => d.toISOString().slice(0, 10);
        return `/users/${probeUserContext}/recordings?from=${fmt(from)}&to=${fmt(to)}&page_size=1`;
      })(),
    });
  }

  for (const { scope, path } of probes) {
    try {
      await zoomApiRequest(path);
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Only treat 401/403/4700 (scope errors) as missing-scope. Network
      // errors / 5xx are reported as errors so the admin can distinguish
      // "Zoom is down" from "Zoom rejected our scope".
      const isScopeError = /\b(401|403|4700|invalid.*scope|insufficient.*scope)\b/i.test(msg);
      if (isScopeError) {
        missing.push(scope);
      }
      errors[scope] = msg;
    }
  }

  // Phase 2 — verify booking write/delete scopes from the granted-scope set.
  // We never probe these via destructive API calls (creating a meeting just
  // to test scope would leak rows + Zoom-side state).
  const BOOKING_REQUIRED_SCOPES = [
    "meeting:write:meeting:admin",
    "meeting:delete:meeting:admin",
  ] as const;

  // Force a token refresh first if the persisted scope set is empty AND
  // we have a refresh token; the refresh response carries the `scope`
  // field which we then persist. This handles tokens that were minted
  // before the Task #840 scope-persistence patch landed.
  let granted = await getGrantedZoomScopes();
  if (!granted) {
    try {
      // Calling getAccessToken touches the cached token; if it's near
      // expiry it auto-refreshes (which persists `scope`). For tokens
      // that aren't near expiry we don't force a refresh — we just
      // report the introspection limitation.
      await getAccessToken();
      granted = await getGrantedZoomScopes();
    } catch {
      // ignored — if we can't even fetch a token, the read probes above
      // will already have surfaced that as a scope/auth error.
    }
  }

  if (!granted) {
    // We can't prove the scopes are missing without introspection data;
    // surface the limitation as an error keyed by a synthetic scope, AND
    // mark the readiness as not-ready so the admin UI never shows a
    // false-green "Valid" while booking write/delete is unverified.
    errors["__booking_scope_introspection__"] =
      "No granted-scope record yet — reconnect Zoom (or wait for the next token refresh) so booking write/delete scopes can be verified. Until then, treat readiness as unknown.";
    scopeIntrospectionFailed = true;
  } else {
    for (const scope of BOOKING_REQUIRED_SCOPES) {
      if (!granted.has(scope)) {
        missing.push(scope);
        errors[scope] =
          "Granted by Zoom OAuth response: no. Reauthorize the Zoom app and grant the booking write/delete scopes.";
      }
    }
  }

  return {
    ready: missing.length === 0 && !scopeIntrospectionFailed,
    missing,
    errors,
  };
}

export async function getMeetingParticipants(meetingId: string): Promise<any[]> {
  // Task #954 (945C): if a relevant gate is already engaged (auth gate
  // globally, or the participant-endpoint scope gate), don't even attempt
  // the call — return [] so callers can continue with host-only participants
  // without spamming the log once per meeting.
  if (zoomAuthGate || zoomScopeGates.has(zoomScopeKeyForPath(`/past_meetings/${meetingId}/participants`))) {
    return [];
  }
  try {
    const data = await zoomApiRequest(`/past_meetings/${encodeURIComponent(meetingId)}/participants?page_size=100`);
    return data.participants || [];
  } catch (err: any) {
    if (err instanceof ZoomPermanentError) {
      // The first hit logs once via setZoomPermanentFailure; downstream
      // calls fall into the gate short-circuit above.
      return [];
    }
    const msg = err?.message || String(err);
    const isExpected = /\b(404|3001)\b/.test(msg);
    if (!isExpected) {
      console.error(`[Zoom] Failed to fetch participants for ${meetingId}: ${msg}`);
    }
    return [];
  }
}

/**
 * Task #3702 — live recording-set lookup for a meeting. `rawPayloadJson`
 * deliberately stores only a summary at ingest (no recording_files array /
 * download URLs — those expire), so any consumer that needs the actual file
 * set (e.g. the face-sentiment analyzer looking for the MP4) must re-fetch
 * it here. Errors propagate exactly like other zoomApiRequest callers:
 * ZoomPermanentError on auth/scope gates, "Zoom API error: 404 …" when the
 * recording is gone.
 */
export async function fetchMeetingRecordingSet(meetingUuid: string): Promise<any> {
  return zoomApiRequest(`/meetings/${encodeURIComponent(meetingUuid)}/recordings`);
}
async function fetchTranscriptContent(downloadUrl: string): Promise<string | null> {
  try {
    const token = await getAccessToken();
    const res = await fetch(downloadUrl, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return parseVttTranscript(text);
  } catch {
    return null;
  }
}

function parseVttTranscript(vtt: string): string {
  const lines = vtt.split("\n");
  const segments: string[] = [];
  let currentSpeaker = "";
  let currentText = "";
  let segmentTimestamp = "";
  let pendingTimestamp = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "WEBVTT") continue;

    const timestampMatch = trimmed.match(/^(\d{2}:\d{2}:\d{2})[.,]\d{3}\s*-->/);
    if (timestampMatch) {
      pendingTimestamp = timestampMatch[1];
      continue;
    }

    if (trimmed.includes("-->")) continue;

    const speakerMatch = trimmed.match(/^(.+?):\s*(.*)/);
    if (speakerMatch) {
      if (currentText && currentSpeaker) {
        const prefix = segmentTimestamp ? `[${segmentTimestamp}] ` : "";
        segments.push(`${prefix}${currentSpeaker}: ${currentText.trim()}`);
      }
      segmentTimestamp = pendingTimestamp;
      currentSpeaker = speakerMatch[1];
      currentText = speakerMatch[2] || "";
    } else if (currentSpeaker) {
      currentText += " " + trimmed;
    } else {
      if (!segmentTimestamp) segmentTimestamp = pendingTimestamp;
      currentText += " " + trimmed;
    }
  }
  if (currentText) {
    const prefix = segmentTimestamp ? `[${segmentTimestamp}] ` : "";
    segments.push(currentSpeaker ? `${prefix}${currentSpeaker}: ${currentText.trim()}` : currentText.trim());
  }

  return segments.join("\n") || vtt;
}

export interface ZoomIngestResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  records: Array<{ recordId: string; meetingTopic: string; meeting?: any }>;
}

export async function matchClientByParticipants(
  participantEmails: string[],
  participantNames: string[] = [],
  opts?: { source?: import("./matchPolicy").MatchSource }
): Promise<{ clientId: string; matchedOn: string } | null> {
  const { getSourcePolicy, filterParticipantSeedsForPolicy, isWeakContactNameValue } =
    await import("./matchPolicy");
  const policy = getSourcePolicy(opts?.source ?? "zoom");

  const { seedEmails, droppedInternal } = filterParticipantSeedsForPolicy(policy, participantEmails);
  if (droppedInternal.length > 0) {
    console.log(
      `[Zoom MatchPolicy] Dropped ${droppedInternal.length} internal participant email(s) from match seeds: ${droppedInternal.join(", ")}`,
    );
  }

  if (seedEmails.length === 0 && participantNames.length === 0) return null;

  const allClients = await storage.getClients();

  for (const client of allClients) {
    if (client.contactEmail) {
      const contactEmails = client.contactEmail.split(",").map(e => e.trim().toLowerCase());
      for (const pe of seedEmails) {
        if (contactEmails.includes(pe.toLowerCase())) {
          return { clientId: client.id, matchedOn: pe };
        }
      }
    }
  }

  // Task #818 Phase 3: previously this loop did one
  // `getClientContacts(client.id)` per client — N+1 against the worker pool
  // (a single matching pass could mean dozens of round-trips). One batched
  // SELECT now hydrates the whole map; the inner-loop semantics are
  // unchanged so per-contact short-circuit returns still win as before.
  const contactsByClient = await storage.getClientContactsForClients(
    allClients.map((c) => c.id),
  );

  for (const client of allClients) {
    try {
      const contacts = contactsByClient.get(client.id) ?? [];
      for (const contact of contacts) {
        if (contact.emails && contact.emails.length > 0) {
          for (const contactEmail of contact.emails) {
            if (contactEmail) {
              for (const pe of seedEmails) {
                if (pe.toLowerCase() === contactEmail.toLowerCase()) {
                  return { clientId: client.id, matchedOn: `contact_email:${pe}` };
                }
              }
            }
          }
        }

        if (contact.name && participantNames.length > 0) {
          const contactNameLower = contact.name.toLowerCase().trim();
          const contactTokens = contactNameLower.split(/\s+/).filter(t => t.length > 0);
          for (const pn of participantNames) {
            const pnLower = pn.toLowerCase().trim();
            const pnTokens = pnLower.split(/\s+/).filter(t => t.length > 0);
            if (pnTokens.length < 1 || contactTokens.length < 1) continue;
            if (pnLower === contactNameLower) {
              if (policy.routeContactNameOnlyToReview && isWeakContactNameValue(pnLower)) {
                continue;
              }
              return { clientId: client.id, matchedOn: `contact_name:${pn}` };
            }
            if (pnTokens.length >= 2 && contactTokens.length >= 2) {
              const pnLastName = pnTokens[pnTokens.length - 1];
              const contactLastName = contactTokens[contactTokens.length - 1];
              const lastNameMatch = pnLastName === contactLastName && pnLastName.length > 2;
              const firstNameOverlap = pnTokens.slice(0, -1).some(pt =>
                contactTokens.slice(0, -1).some(ct => ct === pt && pt.length > 1)
              );
              if (lastNameMatch && firstNameOverlap) {
                return { clientId: client.id, matchedOn: `contact_name:${pn}` };
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Zoom] Error checking contacts for client ${client.id}:`, err);
    }
  }

  const allUsers = await storage.getAllUsers();
  const userEmailToId = new Map<string, string>();
  for (const user of allUsers) {
    if (user.email) userEmailToId.set(user.email.toLowerCase(), user.id);
  }

  const participantUserIds: string[] = [];
  for (const pe of participantEmails) {
    const userId = userEmailToId.get(pe.toLowerCase());
    if (userId) participantUserIds.push(userId);
  }

  const { hasOnlyInternalParticipants: policyAllInternal } = await import("./matchPolicy");
  // Owner fallback requires a non-internal participant. We compute this from
  // both the directory (getAllUsers) AND the company-domain policy so an
  // imperfect user directory cannot be exploited to attribute an all-internal
  // call via the owner shortcut.
  const hasNonInternalParticipant =
    !policyAllInternal(participantEmails) &&
    participantEmails.some(pe => !userEmailToId.has(pe.toLowerCase()));

  if (participantUserIds.length > 0 && hasNonInternalParticipant) {
    for (const client of allClients) {
      if (client.ownerId && participantUserIds.includes(client.ownerId)) {
        return { clientId: client.id, matchedOn: `owner:${client.ownerId}` };
      }
    }
  }

  return null;
}

export async function ingestMeeting(
  meeting: any,
  clientId: string,
  userId: string,
  forceUpdate = false,
  matchInfo?: { matchMethod: string; matchStatus?: string },
  instrumentation?: import("./workerLogger").SyncInstrumentation,
  options?: { origin?: import("./workloadManager").WorkOrigin },
): Promise<{ recordId: string; action: "created" | "updated" | "skipped" }> {
  const slotOpts = { origin: options?.origin ?? "scheduled_background" as const };
  const meetingUuid = meeting.uuid || meeting.id?.toString();
  const externalSourceId = `zoom_meeting_${meetingUuid}`;

  const existingRecords = await findByExternalSourceId(externalSourceId);

  let transcriptContent: string | null = null;
  let recordingUrl: string | null = null;

  const recordingFiles = meeting.recording_files || [];
  for (const file of recordingFiles) {
    if (file.file_type === "TRANSCRIPT" && file.download_url) {
      transcriptContent = await fetchTranscriptContent(file.download_url);
    }
    if ((file.file_type === "MP4" || file.file_type === "SHARED_SCREEN_WITH_SPEAKER_VIEW") && file.play_url) {
      recordingUrl = file.play_url;
    }
    if (!recordingUrl && file.play_url) {
      recordingUrl = file.play_url;
    }
  }

  let participants: any[] = [];
  try {
    const apiParticipants = await getMeetingParticipants(meetingUuid);
    participants = apiParticipants.map((p: any) => ({
      name: p.name || p.user_name,
      email: p.user_email || p.email,
      role: p.user_email ? "participant" : "external",
    }));
  } catch (participantErr) {
    console.error(`[Zoom] Failed to fetch participants for meeting ${meetingUuid} during ingest:`, participantErr);
  }

  if (participants.length === 0 && meeting.host_email) {
    participants = [{ name: meeting.host_name || "Host", email: meeting.host_email, role: "host" }];
  } else if (meeting.host_email) {
    const hostExists = participants.some((p: any) => p.email?.toLowerCase() === meeting.host_email?.toLowerCase());
    if (!hostExists) {
      participants.push({ name: meeting.host_name || "Host", email: meeting.host_email, role: "host" });
    }
  }

  const duration = meeting.duration || 0;
  const startTime = meeting.start_time ? new Date(meeting.start_time) : new Date();
  const topic = meeting.topic || "Untitled Zoom Meeting";

  const sourceSubtype = transcriptContent ? "zoom_transcript" : (recordingFiles.length > 0 ? "zoom_recording" : "zoom_meeting");
  const transcriptReady = !!transcriptContent;

  const contentPreview = transcriptContent
    ? transcriptContent.substring(0, 200)
    : `Zoom meeting: ${topic} (${duration} min)${participants.length > 0 ? ` — ${participants.map(p => p.name || p.email).join(", ")}` : ""}`;

  const { awaitClassSlot: awaitIngestSlot, releaseClassSlot: relIngestSlot } = await import("./workloadManager");

  if (existingRecords.length > 0) {
    const existing = existingRecords[0];

    if (existing.clientId !== clientId) {
      throw new Error("This meeting has already been ingested for a different client");
    }

    const hadNoTranscript = !existing.contentText || existing.sourceSubtype === "zoom_meeting" || existing.sourceSubtype === "zoom_recording";
    if (transcriptContent && hadNoTranscript) {
      const { classifyTouchpoint } = await import("@shared/touchpointClassifier");
      const isTouchpoint = classifyTouchpoint({
        sourceType: "zoom",
        hasTranscript: true,
        participantCount: (existing.participantsJson as any[])?.length || participants.length,
      });
      await awaitIngestSlot("zoom_sync", slotOpts);
      instrumentation?.slotAcquire();
      try {
        await storage.updateRawCommunication(existing.id, {
          sourceSubtype,
          contentText: transcriptContent,
          contentPreview,
          rawPayloadJson: {
            ...(existing.rawPayloadJson as any || {}),
            hasTranscript: true,
            transcriptUpdatedAt: new Date().toISOString(),
          },
          processingStatus: "pending",
          updatedAt: new Date(),
        });
        await db.update(rawCommunicationRecords)
          .set({ transcriptStatus: "ready" })
          .where(eq(rawCommunicationRecords.id, existing.id));
        const { finalizeTouchpointClassification } = await import("../storage/communicationStorage");
        if (existing.externalSourceId) {
          await finalizeTouchpointClassification(existing.externalSourceId, isTouchpoint);
        }
      } finally {
        relIngestSlot("zoom_sync");
        instrumentation?.slotRelease();
      }
      return { recordId: existing.id, action: "updated" };
    }

    if (forceUpdate) {
      await awaitIngestSlot("zoom_sync", slotOpts);
      instrumentation?.slotAcquire();
      try {
        await storage.updateRawCommunication(existing.id, {
          title: topic,
          participantsJson: participants.length > 0 ? participants : existing.participantsJson,
          externalUrl: recordingUrl || existing.externalUrl,
          contentText: transcriptContent || existing.contentText,
          contentPreview,
          updatedAt: new Date(),
        });
        if (transcriptReady && existing.transcriptStatus !== "ready") {
          await db.update(rawCommunicationRecords)
            .set({ transcriptStatus: "ready" })
            .where(eq(rawCommunicationRecords.id, existing.id));
        }
      } finally {
        relIngestSlot("zoom_sync");
        instrumentation?.slotRelease();
      }
      return { recordId: existing.id, action: "updated" };
    }

    return { recordId: existing.id, action: "skipped" };
  }

  const { getCutoverDecision, logShadowComparison } = await import("./cutoverGuard");
  const decision = getCutoverDecision("zoom");

  const { classifyTouchpoint } = await import("@shared/touchpointClassifier");
  const isTouchpoint = classifyTouchpoint({
    sourceType: "zoom",
    hasTranscript: !!transcriptContent,
    participantCount: participants.length,
  });

  let legacyRecordId: string | undefined;
  let legacyError: string | undefined;
  let legacyDurationMs = 0;

  if (decision.runLegacy) {
    const legacyStart = Date.now();
    try {
      await awaitIngestSlot("zoom_sync", slotOpts);
      instrumentation?.slotAcquire();
      try {
        const record = await storage.createRawCommunication({
          clientId,
          sourceType: "zoom",
          sourceSubtype,
          title: topic,
          timestamp: startTime,
          direction: "internal",
          participantsJson: participants,
          externalSourceId,
          externalUrl: recordingUrl || undefined,
          contentText: transcriptContent || undefined,
          contentPreview,
          rawPayloadJson: {
            meetingId: meeting.id,
            meetingUuid: meetingUuid,
            hostEmail: meeting.host_email,
            hostName: meeting.host_name,
            duration,
            totalSize: meeting.total_size,
            recordingCount: recordingFiles.length,
            hasTranscript: transcriptReady,
          },
          processingStatus: "pending",
          reviewStatus: "unreviewed",
          createdBy: userId === "system_zoom_sync" ? undefined : userId,
          matchMethod: matchInfo?.matchMethod || undefined,
          matchStatus: clientId ? (matchInfo?.matchStatus || "matched") : "unmatched",
        }, { isTouchpoint });

        await db.update(rawCommunicationRecords)
          .set({ transcriptStatus: transcriptReady ? "ready" : "pending" })
          .where(eq(rawCommunicationRecords.id, record.id));

        legacyRecordId = record.id;
      } finally {
        relIngestSlot("zoom_sync");
        instrumentation?.slotRelease();
      }
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
      const { ingestEvent } = await import("./pipelineProcessor");
      const dedupeKey = `zoom:meeting:${meetingUuid}`;
      const eventResult = await ingestEvent({
        sourceSystem: "zoom",
        sourceEventType: "meeting_ingested",
        sourceObjectId: externalSourceId,
        dedupeKey,
        payloadJson: {
          externalSourceId,
          clientId,
          sourceType: "zoom",
          sourceSubtype,
          title: topic,
          timestamp: startTime.toISOString(),
          direction: "internal",
          participants,
          contentText: transcriptContent || undefined,
          contentPreview,
          recordingUrl: recordingUrl || undefined,
          meetingId: meeting.id,
          meetingUuid,
          hostEmail: meeting.host_email,
          hostName: meeting.host_name,
          duration,
          hasTranscript: transcriptReady,
          isTouchpoint,
          matchMethod: matchInfo?.matchMethod || undefined,
          matchStatus: clientId ? (matchInfo?.matchStatus || "matched") : "unmatched",
          createdBy: userId === "system_zoom_sync" ? undefined : userId,
        },
      });
      durableRecordId = eventResult.id;
      durableDurationMs = Date.now() - durableStart;
    } catch (err: any) {
      durableError = err.message;
      durableDurationMs = Date.now() - durableStart;
      console.error("[Zoom] Durable ingest failed for meeting", meetingUuid, err.message);
    }
  }

  if (decision.shadowMode) {
    const legacyOutcome = legacyError ? "error" as const : (legacyRecordId ? "success" as const : "skipped" as const);
    const durableOutcome = durableError ? "error" as const : (durableRecordId ? "success" as const : "skipped" as const);
    logShadowComparison({
      source: "zoom",
      operation: "ingestMeeting",
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

  try {
    const { pipelineLog } = await import("./pipelineLogger");
    pipelineLog({
      event: "event_received",
      sourceSystem: "zoom",
      sourceEventType: "meeting_ingested",
      dedupeKey: `zoom:meeting:${meetingUuid}`,
      sourceEventId: legacyRecordId || durableRecordId || "unknown",
    });
  } catch (logErr) {
    console.warn("[Zoom] Pipeline log emission failed:", logErr);
  }

  const recordId = legacyRecordId || durableRecordId;
  if (!recordId) {
    throw new Error("Zoom ingestMeeting: no record created by either legacy or durable path");
  }

  return { recordId, action: "created" };
}

async function findByExternalSourceId(externalSourceId: string): Promise<any[]> {
  const results = await db
    .select()
    .from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.externalSourceId, externalSourceId));
  return results;
}

export async function ingestRecentMeetings(
  clientId: string,
  userId: string,
  options?: { fromDate?: string; toDate?: string; origin?: import("./workloadManager").WorkOrigin }
): Promise<ZoomIngestResult> {
  const { withDbHoldLabel } = await import("../db");
  // Task #818 Phase 0: tag the Zoom recent-meetings ingest path so the
  // pool wrapper can attribute long client holds to this surface.
  return withDbHoldLabel("zoom_ingest_recent_meetings", async () => {
    const meetings = await listRecentRecordings(options?.fromDate, options?.toDate);
    const result: ZoomIngestResult = { created: 0, updated: 0, skipped: 0, errors: [], records: [] };

    for (const meeting of meetings) {
      try {
        const { recordId, action } = await ingestMeeting(meeting, clientId, userId, false, undefined, undefined, { origin: options?.origin });
        if (action === "created") result.created++;
        else if (action === "updated") result.updated++;
        else result.skipped++;
        if (action !== "skipped") {
          result.records.push({ recordId, meetingTopic: meeting.topic || "Untitled", meeting });
        }
      } catch (err: any) {
        result.errors.push(`${meeting.topic || meeting.id}: ${err.message}`);
      }
    }

    return result;
  });
}

export interface UnmatchedRecording {
  meeting: any;
  participantEmails: string[];
  participantObjects: Array<{ name?: string; email?: string; role: string }>;
  suggestedClient: { clientId: string; matchedOn: string; confidence?: number } | null;
  allContentMatches: Array<{ clientId: string; firmName: string; matchedOn: string; confidence: number; relevantSegments: string[]; mentions?: any[] }>;
  relevantSegments: string[];
  transcriptText: string | null;
  aiSummary: string | null;
}

export async function discoverUnmatchedRecordings(
  options?: { fromDate?: string; toDate?: string; origin?: import("./workloadManager").WorkOrigin }
): Promise<UnmatchedRecording[]> {
  const meetings = await listRecentRecordings(options?.fromDate, options?.toDate);
  const results: UnmatchedRecording[] = [];
  // Task #993: discSlotOpts previously gated the operational-classifier write
  // path; that path is now removed and the variable is intentionally retained
  // as a no-op anchor for future workload-managed sync writes.
  void (options?.origin ?? "scheduled_background");

  for (const meeting of meetings) {
    const meetingUuid = meeting.uuid || meeting.id?.toString();
    const externalSourceId = `zoom_meeting_${meetingUuid}`;
    const existing = await findByExternalSourceId(externalSourceId);
    if (existing.length > 0) continue;

    let participantObjects: Array<{ name?: string; email?: string; role: string }> = [];
    try {
      const apiParticipants = await getMeetingParticipants(meetingUuid);
      participantObjects = apiParticipants.map((p: any) => ({
        name: p.name || p.user_name || undefined,
        email: (p.user_email || p.email || "").toLowerCase() || undefined,
        role: "participant",
      }));
      if (apiParticipants.length === 0) {
        console.log(`[Zoom] No participants returned for meeting ${meetingUuid} ("${meeting.topic || "Untitled"}")`);
      }
    } catch (participantErr) {
      console.error(`[Zoom] Failed to fetch participants for meeting ${meetingUuid}:`, participantErr);
    }

    if (meeting.host_email) {
      const hostExists = participantObjects.some(p => p.email === meeting.host_email.toLowerCase());
      if (!hostExists) {
        participantObjects.push({
          name: meeting.host_name || undefined,
          email: meeting.host_email.toLowerCase(),
          role: "host",
        });
      } else {
        participantObjects = participantObjects.map(p =>
          p.email === meeting.host_email.toLowerCase() ? { ...p, role: "host", name: p.name || meeting.host_name || undefined } : p
        );
      }
    }

    let participantEmails = participantObjects.map(p => p.email).filter(Boolean) as string[];
    participantEmails = [...new Set(participantEmails)];
    let participantNames = participantObjects.map(p => p.name).filter(Boolean) as string[];
    participantNames = [...new Set(participantNames)];

    let suggestedClient: { clientId: string; matchedOn: string; confidence?: number } | null = null;
    let allContentMatches: Array<{ clientId: string; firmName: string; matchedOn: string; confidence: number; relevantSegments: string[]; mentions?: any[] }> = [];
    let relevantSegments: string[] = [];
    let transcriptText: string | null = null;

    const hasTranscript = (meeting.recording_files || []).some((f: any) => f.file_type === "TRANSCRIPT");
    if (hasTranscript) {
      for (const file of meeting.recording_files || []) {
        if (file.file_type === "TRANSCRIPT" && file.download_url) {
          try {
            const transcript = await fetchTranscriptContent(file.download_url);
            if (transcript) {
              transcriptText = transcript;
            }
          } catch (transcriptErr) {
            console.error(`[Zoom] Failed to fetch transcript for meeting ${meetingUuid}:`, transcriptErr);
          }
          break;
        }
      }
    }

    // Task #2637: content/transcript fuzzy matching removed. Recordings now
    // match only via the deterministic participant matcher below; transcript
    // text no longer produces client suggestions or content-mention metadata.
    allContentMatches = [];
    relevantSegments = [];

    const GENERIC_TITLE_RE = /personal meeting room|zoom meeting|quick meeting|scheduled meeting|instant meeting/i;
    const hasRealTranscript = !!(transcriptText && transcriptText.trim().length > 50);
    const hasGenericTitle = !meeting.topic || GENERIC_TITLE_RE.test(meeting.topic);
    const isNoTranscriptGeneric = !hasRealTranscript && hasGenericTitle;

    const { hasOnlyInternalParticipants } = await import("./matchPolicy");
    const allParticipantsInternal = hasOnlyInternalParticipants(participantEmails);
    const isSoloInternalMeeting = isNoTranscriptGeneric && allParticipantsInternal;

    // Task #2637 deterministic Zoom auto-claim policy: a participant match
    // auto-claims a client ONLY when (a) a match was found, (b) participants
    // are NOT all-internal, and (c) the match is a STRONG signal (its
    // matchedOn does not start with "contact_name:" or "owner:"). Otherwise
    // suggestedClient stays null and the recording falls through to the
    // unmatched / review-queue path.
    if (!isSoloInternalMeeting) {
      // Task #4050: shared deterministic resolution (participant strong
      // signals + trusted-domain + topic↔firm-name). Auto outcomes become the
      // suggested client for ingest; review outcomes surface their stored
      // suggestion (when unambiguous) so the discover preview mirrors what
      // apply would do. The topic tier fires even for all-internal calls —
      // transcript-first records carry host-only participant lists.
      const { resolveZoomClientMatch } = await import("./zoomClientMatching");
      const participantNamesForMatch = isNoTranscriptGeneric ? [] : participantNames;
      const resolution = await resolveZoomClientMatch(
        {
          participantEmails,
          participantNames: participantNamesForMatch,
          topic: meeting.topic ?? null,
          source: "zoom",
        },
        { matchParticipants: matchClientByParticipants },
      );
      if (resolution.kind === "auto") {
        suggestedClient = { clientId: resolution.clientId, matchedOn: resolution.matchedOn };
      } else if (resolution.kind === "review") {
        console.log(
          `[Zoom MatchPolicy] Demoted signal for "${meeting.topic || meetingUuid}" (${resolution.matchedOn}, ${resolution.reviewReason}) — routing to review`,
        );
        if (resolution.suggestedClientId) {
          suggestedClient = {
            clientId: resolution.suggestedClientId,
            matchedOn: resolution.matchedOn,
            confidence: 0.5,
          };
        }
      }
    } else {
      console.log(`[Zoom] Skipping matching for solo internal no-transcript meeting: "${meeting.topic}" (${meetingUuid})`);
    }

    // Task #993: Zoom no longer routes unmatched recordings through the AI
    // operational classifier. Recordings without a deterministic or content
    // match fall through to the unmatched-discovery results below so the
    // caller (agent retroactive reprocess + admin discover endpoint) can
    // surface them for manual review instead of silently dismissing them.

    results.push({
      meeting: {
        id: meeting.id,
        uuid: meeting.uuid,
        topic: meeting.topic,
        start_time: meeting.start_time,
        duration: meeting.duration,
        host_email: meeting.host_email,
        host_name: meeting.host_name,
        recording_count: (meeting.recording_files || []).length,
        has_transcript: (meeting.recording_files || []).some((f: any) => f.file_type === "TRANSCRIPT"),
      },
      participantEmails,
      participantObjects,
      suggestedClient,
      allContentMatches,
      relevantSegments,
      transcriptText,
      aiSummary: null,
    });
  }

  return results;
}

export async function enqueueTranscriptBackfillBatch(): Promise<string[]> {
  const { asc } = await import("drizzle-orm");

  // Task #3689: deliberately NO createdAt cutoff here. Rows older than the
  // backfill window used to fall outside the old `createdAt >= cutoff` filter
  // and sat 'pending' forever, invisible to every sweep. They are now
  // enumerated too so processTranscriptBackfillRecord can give each one a
  // final live-API check — pulling a late transcript if Zoom has one, or
  // parking the record in the terminal 'unavailable' state (which this WHERE
  // excludes, so terminal rows never re-enter a batch).
  const pendingRecords = await db
    .select({ id: rawCommunicationRecords.id })
    .from(rawCommunicationRecords)
    .where(
      and(
        eq(rawCommunicationRecords.sourceType, "zoom"),
        sql`(${rawCommunicationRecords.transcriptStatus} = 'pending' OR ${rawCommunicationRecords.transcriptStatus} IS NULL)`,
        sql`(${rawCommunicationRecords.contentText} IS NULL OR ${rawCommunicationRecords.contentText} = '')`
      )
    )
    .orderBy(asc(rawCommunicationRecords.createdAt));

  return pendingRecords.map(r => r.id);
}

// Task #3689: terminal no-transcript transition. Idempotent — the early-skip
// in processTranscriptBackfillRecord returns before this can re-stamp — and
// excluded from future sweeps by the enumeration's pending/NULL filter. NOT a
// dead end: the transcript_completed apply path still upgrades any non-'ready'
// record to 'ready' if Zoom belatedly produces a transcript.
async function markZoomTranscriptUnavailable(
  record: { id: string; title: string; rawPayloadJson: unknown },
  reason: ZoomTranscriptUnavailableReason,
  fileTypes?: string[],
  // Task #3701: `failureDetail` feeds the transcription_failed badge copy;
  // `revAiMarker` lets the terminal transition and the pipeline marker land
  // in ONE update so they can never diverge.
  extra?: { failureDetail?: string; revAiMarker?: ZoomRevAiTranscriptionMarker },
): Promise<void> {
  const payload = (record.rawPayloadJson as any) || {};
  const info: ZoomTranscriptUnavailableInfo = {
    reason,
    windowHours: ZOOM_TRANSCRIPT_BACKFILL_HOURS,
    at: new Date().toISOString(),
    ...(fileTypes && fileTypes.length > 0 ? { fileTypes } : {}),
    ...(extra?.failureDetail ? { failureDetail: extra.failureDetail.slice(0, 300) } : {}),
  };
  await db.update(rawCommunicationRecords)
    .set({
      transcriptStatus: "unavailable",
      rawPayloadJson: {
        ...payload,
        zoomTranscriptUnavailable: info,
        ...(extra?.revAiMarker ? { zoomRevAiTranscription: extra.revAiMarker } : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(rawCommunicationRecords.id, record.id));
  console.log(
    `[ZoomBackfill] Transcript terminally unavailable (${reason}) for "${record.title}" (${record.id})`,
  );
}

export async function processTranscriptBackfillRecord(
  recordId: string,
  opts?: {
    /**
     * Task #4057 — the year-back match-assistant sweep ingests meetings that
     * happened months ago, so their records are freshly created (createdAt ≈
     * now) yet the meetings are far older than the backfill window. Without
     * this override those records would sit in the "recent — keep waiting"
     * branch forever ("skipped" on every pass). The sweep sets this flag only
     * when the MEETING timestamp is older than the window, which preserves
     * the normal grace period for genuinely recent meetings.
     */
    pastWindowOverride?: boolean;
  },
): Promise<"backfilled" | "skipped" | "failed" | "unavailable" | "revai_enqueued"> {
  const [record] = await db
    .select()
    .from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.id, recordId))
    .limit(1);

  if (!record) {
    console.log(`[ZoomBackfill] Record ${recordId} not found, skipping`);
    return "skipped";
  }

  // 'unavailable' is terminal (Task #3689) — early-skip keeps the transition
  // idempotent even if a stale batch re-delivers the record id.
  if (
    record.transcriptStatus === "ready" ||
    record.transcriptStatus === "failed" ||
    record.transcriptStatus === "unavailable"
  ) {
    return "skipped";
  }

  if (record.contentText && record.contentText.length > 0) {
    return "skipped";
  }

  // Task #3701: a record already claimed by the Rev AI generation pipeline is
  // in flight — skip it before spending a live API call. (Terminal marker
  // states imply `ready`/`unavailable`, both early-skipped above, so a live
  // claim is the only long-lived in-between; stale claims fall through to the
  // reclaim path below.)
  const earlyRevAiMarker = getZoomRevAiMarker(record.rawPayloadJson);
  if (earlyRevAiMarker && zoomRevAiMarkerBlocksEnqueue(earlyRevAiMarker)) {
    return "skipped";
  }

  const payload = record.rawPayloadJson as any;
  const meetingUuid = payload?.meetingUuid || payload?.meetingId?.toString();
  if (!meetingUuid) {
    console.log(`[ZoomBackfill] No meetingUuid for record ${recordId}, marking failed`);
    await db.update(rawCommunicationRecords)
      .set({ transcriptStatus: "failed" })
      .where(eq(rawCommunicationRecords.id, recordId));
    return "failed";
  }

  // Task #3689: a record older than the backfill window gets ONE final live
  // API check below. If Zoom still has no TRANSCRIPT file — or no longer has
  // the recording at all — it's parked in the terminal 'unavailable' state
  // instead of being reconsidered forever. The check-then-mark order matters:
  // a late transcript that IS present gets backfilled normally even past the
  // window (that also recovers older records whose transcript apply wedged
  // mid-flight). Transient API errors still rethrow and leave 'pending'.
  const createdAtMs = record.createdAt
    ? new Date(record.createdAt as any).getTime()
    : Date.now();
  const pastWindow =
    opts?.pastWindowOverride === true ||
    Date.now() - createdAtMs > ZOOM_TRANSCRIPT_BACKFILL_HOURS * 60 * 60 * 1000;

  let recordings: any;
  try {
    recordings = await zoomApiRequest(`/meetings/${encodeURIComponent(meetingUuid)}/recordings`);
  } catch (err: any) {
    if (err instanceof ZoomPermanentError) {
      // Task #954 (945C): permanent auth/scope failure — mark the record as
      // failed with a clear reason in the payload so the cadence picker
      // (transcriptStatus IN ('pending', NULL)) skips it on subsequent
      // backfill batches. Operator must reconnect to recover; replay of
      // these records is handled by 945F.
      const payload = (record.rawPayloadJson as any) || {};
      await db.update(rawCommunicationRecords)
        .set({
          transcriptStatus: "failed",
          rawPayloadJson: {
            ...payload,
            zoomBackfillFailure: {
              kind: err.kind,
              status: err.status,
              reason: "permanent_auth_or_scope:operator_reconnect_required",
              message: err.message.slice(0, 500),
              at: new Date().toISOString(),
            },
          },
        })
        .where(eq(rawCommunicationRecords.id, recordId));
      console.warn(`[ZoomBackfill] Permanent ${err.kind} failure for ${meetingUuid} — marked record ${recordId} failed (operator reconnect required)`);
      return "failed";
    }
    if (/404|3001/.test(err.message)) {
      if (pastWindow) {
        // Recording trashed/permanently deleted in Zoom (404, code 3301) —
        // a transcript is never coming. Terminal.
        await markZoomTranscriptUnavailable(record, "recording_not_found");
        return "unavailable";
      }
      console.log(`[ZoomBackfill] Recording not found for ${meetingUuid}, skipping`);
      return "skipped";
    }
    throw err;
  }

  const transcriptFile = (recordings?.recording_files || []).find(
    (f: any) => f.file_type === "TRANSCRIPT" && f.download_url
  );

  if (!transcriptFile) {
    if (pastWindow) {
      // The live API just confirmed the final recording set has no TRANSCRIPT
      // file (e.g. MP4+M4A+TIMELINE only — Zoom never generated one). Store
      // the observed file types so the modal can show exactly what Zoom did
      // deliver.
      const recordingFiles = (recordings?.recording_files || []) as any[];
      const fileTypes = Array.from(
        new Set(
          recordingFiles
            .map((f: any) => (typeof f?.file_type === "string" ? f.file_type : null))
            .filter((t: string | null): t is string => !!t),
        ),
      );

      // Task #3701: Zoom delivered audio without a transcript — generate one
      // ourselves via Rev AI instead of parking the record. The durable job
      // is enqueued here; the record stays 'pending' while the pipeline runs
      // (the marker gate above keeps later sweeps cheap).
      const audioFile = recordingFiles.find(
        (f: any) => f?.file_type === "M4A" && f?.download_url,
      );
      if (!audioFile) {
        // No transcript AND no audio — nothing to generate from. Terminal.
        await markZoomTranscriptUnavailable(record, "no_audio_file", fileTypes);
        return "unavailable";
      }

      const fallback = await maybeEnqueueZoomRevAiFallback(record, {
        revival: false,
        fileTypes,
      });
      if (fallback === "enqueued") return "revai_enqueued";
      if (fallback === "attempts_exhausted") return "unavailable";
      if (fallback === "in_flight" || fallback === "capped") {
        // Stays 'pending': an in-flight claim converges via its own job; a
        // cap-skipped record is retried by the next sweep.
        return "skipped";
      }
      // fallback === "kill_switch" → park terminal exactly like Task #3689.
      // Stored fileTypes include M4A, so the revival pass picks the record
      // back up if the switch is later released.
      await markZoomTranscriptUnavailable(record, "no_transcript_after_window", fileTypes);
      return "unavailable";
    }
    console.log(`[ZoomBackfill] No transcript yet for meeting ${meetingUuid} ("${record.title}")`);
    return "skipped";
  }

  const transcriptContent = await fetchTranscriptContent(transcriptFile.download_url);
  if (!transcriptContent) {
    console.log(`[ZoomBackfill] Transcript download failed for ${meetingUuid}`);
    return "failed";
  }

  const applied = await applyZoomTranscriptToRecord(record.id, transcriptContent);
  if (!applied) {
    return "skipped";
  }

  console.log(`[ZoomBackfill] Transcript backfilled for "${record.title}" (${record.id})`);
  return "backfilled";
}

/**
 * Task #3701 (extracted from processTranscriptBackfillRecord so the Rev AI
 * fallback shares the exact same post-transcript path): the one true
 * "transcript landed via backfill" transition — content + preview +
 * hasTranscript + processingStatus 'pending' (which feeds the normal AI
 * summary/study pipeline), transcriptStatus 'ready', touchpoint
 * re-classification, and the analyze_communication enqueue.
 *
 * Re-reads the record and returns false when a fresher write already
 * delivered a transcript (idempotent under races — Zoom's own transcript
 * apply path always wins if it lands first).
 *
 * `opts.transcriptSource`/`opts.revAiMarker` stamp provenance for generated
 * transcripts; a terminal-unavailable info blob from a revived record is
 * cleared since the record now HAS a transcript.
 */
async function applyZoomTranscriptToRecord(
  recordId: string,
  transcriptContent: string,
  opts?: {
    transcriptSource?: typeof ZOOM_TRANSCRIPT_SOURCE_REVAI;
    revAiMarker?: ZoomRevAiTranscriptionMarker;
  },
): Promise<boolean> {
  const [record] = await db
    .select()
    .from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.id, recordId))
    .limit(1);
  if (!record) return false;
  if (
    record.transcriptStatus === "ready" ||
    (record.contentText && record.contentText.length > 0)
  ) {
    return false;
  }

  const payload = (record.rawPayloadJson as any) || {};
  const { classifyTouchpoint } = await import("@shared/touchpointClassifier");
  const isTouchpoint = classifyTouchpoint({
    sourceType: "zoom",
    hasTranscript: true,
    participantCount: (record.participantsJson as any[])?.length || 0,
  });

  // A revived record was terminal `unavailable` — that info blob is now
  // stale (the transcript exists), so drop it rather than let the modal
  // ever pair an "unavailable" reason with a present transcript.
  const { zoomTranscriptUnavailable: _clearedUnavailableInfo, ...restPayload } = payload;

  await storage.updateRawCommunication(record.id, {
    sourceSubtype: "zoom_transcript",
    contentText: transcriptContent,
    contentPreview: transcriptContent.substring(0, 200),
    rawPayloadJson: {
      ...restPayload,
      hasTranscript: true,
      transcriptUpdatedAt: new Date().toISOString(),
      ...(opts?.transcriptSource ? { transcriptSource: opts.transcriptSource } : {}),
      ...(opts?.revAiMarker ? { zoomRevAiTranscription: opts.revAiMarker } : {}),
    },
    processingStatus: "pending",
    updatedAt: new Date(),
  });

  await db.update(rawCommunicationRecords)
    .set({ transcriptStatus: "ready" })
    .where(eq(rawCommunicationRecords.id, record.id));

  const { finalizeTouchpointClassification } = await import("../storage/communicationStorage");
  if (record.externalSourceId) {
    await finalizeTouchpointClassification(record.externalSourceId, isTouchpoint);
  }

  // fire-and-forget: analysis enqueue must not block the backfill walk; caught + logged inside.
  void (async () => {
    try {
      await enqueueAnalysis(record.id);
    } catch (err) {
      console.error(`[ZoomBackfill] Analysis failed for ${record.id}:`, err);
    }
  })();

  return true;
}
let transcriptBackfillIntervalId: ReturnType<typeof setInterval> | null = null;

export function startPeriodicTranscriptBackfill(): void {
  if (transcriptBackfillIntervalId) return;
  const intervalMs = 30 * 60 * 1000;
  console.log(`[Zoom] Starting periodic transcript backfill via queue (every ${Math.round(intervalMs / 60_000)} minutes)`);
  transcriptBackfillIntervalId = setInterval(() => {
    void withDbAttribution("maintenance:zoom-transcript-backfill-enqueue", async () => {
    // Task #836 Phase 2: skip the periodic transcript-backfill enqueue
    // when the large-backfills kill switch is engaged.
    if (isKillSwitchEnabled("large_backfills")) return;
    try {
      const { submitRepairJob } = await import("./workQueueHandlers");
      await submitRepairJob({
        queueName: "zoom_transcript_backfill",
        workloadClass: "repair",
        priority: 100,
        maxAttempts: 2,
        dedupeKey: "periodic:zoom_transcript_backfill",
      });
      console.log("[Zoom] Enqueued periodic transcript backfill job");
    } catch (err) {
      console.error("[Zoom] Failed to enqueue periodic transcript backfill:", err);
    }
    });
  }, intervalMs);
}

const ZOOM_REVAI_QUEUE_NAME = "zoom_revai_transcription";
export async function initZoomAutoSync(): Promise<void> {
    try {
      const connected = await isConnected();
      if (connected) {
        console.log("[Zoom] Starting durable pipeline (reconciliation + transcript backfill)");
        startPeriodicTranscriptBackfill();
        await startZoomReconciliation();
      } else {
        console.log("[Zoom] Zoom not connected — skipping auto-start");
      }
    } catch (err) {
      console.error("[Zoom] Init failed:", err);
    }
  }

/**
 * Task #3982 — the S2S cutover runs BOTH Marketplace apps side by side for a
 * while (legacy user-level app + new Server-to-Server app), and each Zoom app
 * signs webhooks with its own Secret Token. The receiver accepts either
 * configured token so the new app's event subscription can be validated and
 * delivering before the legacy app is deactivated — no flag-day secret swap.
 * Order matters: the legacy token stays primary (index 0) and is the CRC
 * fallback for unsigned/unmatched challenges. After legacy retirement the
 * operator moves the S2S token into ZOOM_WEBHOOK_SECRET_TOKEN and unsets
 * ZOOM_S2S_WEBHOOK_SECRET_TOKEN (single-secret steady state).
 */
export type ZoomWebhookSecretSource = "legacy" | "s2s";
function getZoomWebhookSecrets(): string[] {
  return getZoomWebhookSecretsLabeled().map((e) => e.token);
}

function zoomSignatureMatchesSecret(secret: string, timestamp: string, body: string, signature: string): boolean {
  const message = `v0:${timestamp}:${body}`;
  const hashForVerify = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");
  const expectedSignature = `v0=${hashForVerify}`;
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Task #4019 — signature verification that also reports WHICH configured
 * secret matched. `matchedSource === "s2s"` is the receiver's cue to stamp
 * durable "the S2S app's event subscription really delivers" evidence
 * (`recordZoomS2sWebhookVerified`), which gates the legacy-retirement prod
 * action. Verification semantics are identical to the boolean form.
 */
export function verifyZoomWebhookSignatureDetailed(
  body: string,
  timestamp: string,
  signature: string,
): { valid: boolean; matchedSource: ZoomWebhookSecretSource | null } {
  const secrets = getZoomWebhookSecretsLabeled();
  if (secrets.length === 0) {
    console.error("[Zoom Webhook] ZOOM_WEBHOOK_SECRET_TOKEN not configured");
    return { valid: false, matchedSource: null };
  }
  const matched = secrets.find(({ token }) =>
    zoomSignatureMatchesSecret(token, timestamp, body, signature),
  );
  return { valid: matched !== undefined, matchedSource: matched?.source ?? null };
}
export function verifyZoomWebhookSignature(
  body: string,
  timestamp: string,
  signature: string,
): boolean {
  return verifyZoomWebhookSignatureDetailed(body, timestamp, signature).valid;
}

/**
 * Task #4019 — durable evidence that a live (non-CRC, replay-window-passing)
 * webhook delivery verified via the S2S app's Secret Token. ZOOM.md
 * § Retirement requires exactly this proof before the legacy token rows are
 * cleared / the legacy app is deactivated, and the
 * `retire_legacy_zoom_oauth_tokens` prod action reads the stamp as its gate.
 * Hot-path safe: throttled to one settings write per interval per process,
 * never throws (a stamp failure must not affect webhook handling), and the
 * throttle marker is only advanced on a successful write so transient
 * failures retry on the next delivery.
 */
export const ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING = "zoom_s2s_webhook_last_verified_at";
/**
 * Audit A-004 — bounded replay window for Zoom webhooks. Zoom's
 * `x-zm-request-timestamp` header (Unix seconds) is HMAC-bound inside the
 * signed message (`v0:${timestamp}:${body}`), so once the signature checks
 * out the timestamp is cryptographically trustworthy. Deliveries whose
 * signed timestamp drifts more than this many milliseconds into the past
 * OR the future are rejected. 5 minutes matches the tolerance used by the
 * Stripe SDK elsewhere in this codebase and standard webhook practice.
 */
export const ZOOM_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Deterministic boundary semantics: a timestamp whose absolute drift from
 * `nowMs` is EXACTLY `ZOOM_WEBHOOK_REPLAY_WINDOW_MS` is still accepted
 * (inclusive window); one millisecond beyond is rejected. Non-numeric or
 * malformed timestamps are rejected.
 */
export function isZoomWebhookTimestampWithinWindow(
  timestamp: string,
  nowMs: number = Date.now(),
): boolean {
  if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp.trim())) {
    return false;
  }
  const tsMs = Number(timestamp.trim()) * 1000;
  if (!Number.isFinite(tsMs)) return false;
  return Math.abs(nowMs - tsMs) <= ZOOM_WEBHOOK_REPLAY_WINDOW_MS;
}

/**
 * CRC (`endpoint.url_validation`) response. Zoom expects `encryptedToken` to
 * be HMAC'd with the Secret Token of the SPECIFIC app performing the
 * validation, and the CRC request itself is signed with that same token
 * (`x-zm-signature` over `v0:{ts}:{body}`). With two apps configured (Task
 * #3982 overlap) we pick the token whose HMAC matches the request's own
 * signature; when no request context is supplied or nothing matches, fall
 * back to the primary (legacy) token — the pre-#3982 behavior.
 */
export function handleZoomCrcChallenge(
  plainToken: string,
  requestContext?: { rawBody: string; timestamp?: string; signature?: string },
): {
  plainToken: string;
  encryptedToken: string;
} {
  const secrets = getZoomWebhookSecrets();
  if (secrets.length === 0) {
    throw new Error("ZOOM_WEBHOOK_SECRET_TOKEN not configured");
  }
  let secret = secrets[0];
  if (requestContext?.timestamp && requestContext?.signature) {
    const matched = secrets.find((s) =>
      zoomSignatureMatchesSecret(s, requestContext.timestamp!, requestContext.rawBody, requestContext.signature!),
    );
    if (matched) secret = matched;
  }
  const encryptedToken = crypto
    .createHmac("sha256", secret)
    .update(plainToken)
    .digest("hex");
  return { plainToken, encryptedToken };
}

export type ZoomWebhookEventType = "recording_completed" | "transcript_completed";

interface ZoomWebhookResult {
  accepted: boolean;
  eventType: ZoomWebhookEventType | null;
  sourceEventId: string | null;
  deduplicated: boolean;
  reason?: string;
}

export async function handleZoomWebhookEvent(
  eventType: string,
  payload: Record<string, any>,
): Promise<ZoomWebhookResult> {
  if (!PERF.ZOOM_EVENT_INGEST_ENABLED) {
    return {
      accepted: false,
      eventType: null,
      sourceEventId: null,
      deduplicated: false,
      reason: "zoom_event_ingest_enabled is off",
    };
  }

  let normalizedType: ZoomWebhookEventType;
  if (eventType === "recording.completed") {
    normalizedType = "recording_completed";
  } else if (eventType === "recording.transcript_completed") {
    normalizedType = "transcript_completed";
  } else {
    return {
      accepted: false,
      eventType: null,
      sourceEventId: null,
      deduplicated: false,
      reason: `unsupported event type: ${eventType}`,
    };
  }

  const objectPayload = payload?.object || payload;
  const meetingId = objectPayload?.id?.toString() || objectPayload?.uuid || "";
  const meetingUuid = objectPayload?.uuid || meetingId;

  const recordingFiles = objectPayload?.recording_files || [];
  const recordingId =
    recordingFiles.length > 0
      ? recordingFiles[0]?.id?.toString() || ""
      : meetingUuid;

  if (!meetingId && !meetingUuid) {
    return {
      accepted: false,
      eventType: normalizedType,
      sourceEventId: null,
      deduplicated: false,
      reason: "missing meeting_id and uuid in payload",
    };
  }

  const dedupeKey = `zoom:${normalizedType}:${meetingUuid}:${recordingId}`;
  const sourceObjectId = meetingUuid || meetingId;

  try {
    const { ingestEvent } = await import("./pipelineProcessor");
    const result = await ingestEvent({
      sourceSystem: "zoom",
      sourceEventType: normalizedType,
      sourceObjectId,
      dedupeKey,
      payloadJson: payload,
      status: "received",
      replayable: true,
    });

    if (result.deduplicated) {
      console.log(
        `[Zoom Webhook] Deduplicated ${normalizedType} for meeting ${meetingUuid}`,
      );
      return {
        accepted: true,
        eventType: normalizedType,
        sourceEventId: null,
        deduplicated: true,
      };
    }

    console.log(
      `[Zoom Webhook] Ingested ${normalizedType} for meeting ${meetingUuid} → sourceEventId=${result.id}`,
    );

    try {
      const { enqueueJob } = await import("./workScheduler");
      const applyQueue =
        normalizedType === "recording_completed"
          ? "zoom_meeting_apply"
          : "zoom_transcript_apply";

      await enqueueJob({
        queueName: applyQueue,
        workloadClass: "ingestion",
        priority: 150,
        payload: {
          sourceEventId: result.id,
          meetingUuid,
          meetingId,
          eventType: normalizedType,
        },
        dedupeKey: `${applyQueue}:${result.id}`,
      });
    } catch (enqueueErr) {
      console.error(
        `[Zoom Webhook] Failed to enqueue apply job for ${result.id}:`,
        enqueueErr,
      );
    }

    return {
      accepted: true,
      eventType: normalizedType,
      sourceEventId: result.id,
      deduplicated: false,
    };
  } catch (err: any) {
    console.error(
      `[Zoom Webhook] Failed to ingest ${normalizedType} for meeting ${meetingUuid}:`,
      err.message,
    );
    return {
      accepted: false,
      eventType: normalizedType,
      sourceEventId: null,
      deduplicated: false,
      reason: err.message,
    };
  }
}

// ============================================
// ZOOM NIGHTLY RECONCILIATION
// ============================================

let zoomReconciliationTimerId: ReturnType<typeof setTimeout> | null = null;

export async function runZoomReconciliation(): Promise<{
  totalChecked: number;
  newEventsIngested: number;
  errors: string[];
}> {
  const { withDbHoldLabel } = await import("../db");
  // Task #818 Phase 0: tag the Zoom periodic reconciliation entry point.
  return withDbHoldLabel("zoom_reconciliation", () => runZoomReconciliationInner());
}

async function runZoomReconciliationInner(): Promise<{
  totalChecked: number;
  newEventsIngested: number;
  errors: string[];
}> {
  const startMs = Date.now();
  const errors: string[] = [];
  let totalChecked = 0;
  let newEventsIngested = 0;

  if (!PERF.ZOOM_RECONCILIATION_ENABLED) {
    console.log("[Zoom Reconciliation] Skipped — zoom_reconciliation_enabled is off");
    return { totalChecked: 0, newEventsIngested: 0, errors: [] };
  }

  console.log(
    `[Zoom Reconciliation] Starting with ${ZOOM_RECONCILIATION_LOOKBACK_HOURS}h lookback`,
  );

  try {
    const connected = await isConnected();
    if (!connected) {
      console.log("[Zoom Reconciliation] Zoom not connected, skipping");
      return { totalChecked: 0, newEventsIngested: 0, errors: [] };
    }

    const lookbackFrom = new Date(
      Date.now() - ZOOM_RECONCILIATION_LOOKBACK_HOURS * 60 * 60 * 1000,
    )
      .toISOString()
      .split("T")[0];
    const meetings = await listRecentRecordings(lookbackFrom);
    totalChecked = meetings.length;

    console.log(
      `[Zoom Reconciliation] Found ${meetings.length} recordings in lookback window`,
    );

    const { ingestEvent } = await import("./pipelineProcessor");

    for (const meeting of meetings) {
      const meetingUuid = meeting.uuid || meeting.id?.toString();
      if (!meetingUuid) continue;

      const recordingFiles = meeting.recording_files || [];
      const recordingId =
        recordingFiles.length > 0
          ? recordingFiles[0]?.id?.toString() || ""
          : meetingUuid;

      try {
        const recordingDedupeKey = `zoom:recording_completed:${meetingUuid}:${recordingId}`;
        const recordingResult = await ingestEvent({
          sourceSystem: "zoom",
          sourceEventType: "recording_completed",
          sourceObjectId: meetingUuid,
          dedupeKey: recordingDedupeKey,
          payloadJson: { object: meeting, source: "reconciliation" },
          status: "received",
          replayable: true,
        });

        if (!recordingResult.deduplicated) {
          newEventsIngested++;
          console.log(
            `[Zoom Reconciliation] Recovered missed recording_completed for meeting ${meetingUuid}: "${meeting.topic || "Untitled"}"`,
          );

          try {
            const { enqueueJob } = await import("./workScheduler");
            await enqueueJob({
              queueName: "zoom_meeting_apply",
              workloadClass: "ingestion",
              priority: 200,
              payload: {
                sourceEventId: recordingResult.id,
                meetingUuid,
                meetingId: meeting.id?.toString() || meetingUuid,
                eventType: "recording_completed",
                source: "reconciliation",
              },
              dedupeKey: `zoom_meeting_apply:${recordingResult.id}`,
            });
          } catch (enqueueErr) {
            console.error(
              `[Zoom Reconciliation] Failed to enqueue meeting apply:`,
              enqueueErr,
            );
          }
        }
      } catch (err: any) {
        errors.push(
          `recording_completed for ${meetingUuid}: ${err.message}`,
        );
      }

      const hasTranscript = recordingFiles.some(
        (f: any) => f.file_type === "TRANSCRIPT",
      );
      if (hasTranscript) {
        try {
          const transcriptDedupeKey = `zoom:transcript_completed:${meetingUuid}:${recordingId}`;
          const transcriptResult = await ingestEvent({
            sourceSystem: "zoom",
            sourceEventType: "transcript_completed",
            sourceObjectId: meetingUuid,
            dedupeKey: transcriptDedupeKey,
            payloadJson: { object: meeting, source: "reconciliation" },
            status: "received",
            replayable: true,
          });

          if (!transcriptResult.deduplicated) {
            newEventsIngested++;
            console.log(
              `[Zoom Reconciliation] Recovered missed transcript_completed for meeting ${meetingUuid}`,
            );

            try {
              const { enqueueJob } = await import("./workScheduler");
              await enqueueJob({
                queueName: "zoom_transcript_apply",
                workloadClass: "ingestion",
                priority: 200,
                payload: {
                  sourceEventId: transcriptResult.id,
                  meetingUuid,
                  meetingId: meeting.id?.toString() || meetingUuid,
                  eventType: "transcript_completed",
                  source: "reconciliation",
                },
                dedupeKey: `zoom_transcript_apply:${transcriptResult.id}`,
              });
            } catch (enqueueErr) {
              console.error(
                `[Zoom Reconciliation] Failed to enqueue transcript apply:`,
                enqueueErr,
              );
            }
          }
        } catch (err: any) {
          errors.push(
            `transcript_completed for ${meetingUuid}: ${err.message}`,
          );
        }
      }
    }

    try {
      const { reconcileSource } = await import("./pipelineProcessor");
      await reconcileSource("zoom", totalChecked, newEventsIngested);
    } catch {}

    // Task #3699 — event-level retry for crashed/interrupted Zoom applies.
    // Re-drives zoom recording/transcript events stuck pre-apply (bounded by
    // attempt_count), terminally closes exhausted ones with a reason, and
    // alerts once per streak so a recurrence can't hide for months.
    try {
      const { sweepStaleZoomApplyEvents } = await import("./zoomStaleApplyEventSweep");
      const sweep = await sweepStaleZoomApplyEvents();
      if (sweep.scanned > 0) {
        console.log(
          `[Zoom Reconciliation] Stale-apply sweep: scanned=${sweep.scanned} requeued=${sweep.requeued} terminal=${sweep.terminal}`,
        );
      }
    } catch (err: any) {
      console.error("[Zoom Reconciliation] Stale-apply sweep failed:", err?.message ?? err);
      errors.push(`stale_apply_sweep: ${err?.message ?? err}`);
    }
  } catch (err: any) {
    console.error("[Zoom Reconciliation] Fatal error:", err.message);
    errors.push(`fatal: ${err.message}`);
  }

  const durationMs = Date.now() - startMs;
  console.log(
    `[Zoom Reconciliation] Complete in ${Math.round(durationMs / 1000)}s: checked=${totalChecked}, newEvents=${newEventsIngested}, errors=${errors.length}`,
  );

  return { totalChecked, newEventsIngested, errors };
}

function msUntilNextReconciliationHour(): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(ZOOM_RECONCILIATION_CRON_HOUR, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function scheduleNextReconciliation(): void {
  const delayMs = msUntilNextReconciliationHour();
  const delayHours = (delayMs / 3_600_000).toFixed(1);
  const nextRun = new Date(Date.now() + delayMs);
  console.log(
    `[Zoom Reconciliation] Next run scheduled in ${delayHours}h at ${nextRun.toISOString()}`,
  );

  zoomReconciliationTimerId = setTimeout(async () => {
    try {
      await runZoomReconciliation();
    } catch (err) {
      console.error("[Zoom Reconciliation] Scheduled run error:", err);
    }
    scheduleNextReconciliation();
  }, delayMs);
}

export async function startZoomReconciliation(): Promise<void> {
  if (!PERF.ZOOM_RECONCILIATION_ENABLED) {
    console.log(
      "[Zoom Reconciliation] Not starting — zoom_reconciliation_enabled is off",
    );
    return;
  }

  if (zoomReconciliationTimerId) {
    return;
  }

  const connected = await isConnected();
  if (!connected) {
    console.log(
      "[Zoom Reconciliation] Not starting — Zoom not connected",
    );
    return;
  }

  console.log(
    `[Zoom Reconciliation] Starting nightly reconciliation (runs at ${ZOOM_RECONCILIATION_CRON_HOUR}:00 AM, ${ZOOM_RECONCILIATION_LOOKBACK_HOURS}h lookback)`,
  );
  scheduleNextReconciliation();
}

export function stopZoomReconciliation(): void {
  if (zoomReconciliationTimerId) {
    clearTimeout(zoomReconciliationTimerId);
    zoomReconciliationTimerId = null;
    console.log("[Zoom Reconciliation] Stopped");
  }
}

export function isZoomReconciliationRunning(): boolean {
  return zoomReconciliationTimerId !== null;
}

export function getNextZoomReconciliationAt(): string | null {
  if (!zoomReconciliationTimerId) return null;
  const ms = msUntilNextReconciliationHour();
  return new Date(Date.now() + ms).toISOString();
}

// ============================================
// ZOOM MEETING / TRANSCRIPT APPLY HANDLERS
// ============================================

export async function handleZoomMeetingApply(
  sourceEventId: string,
  meetingUuid: string,
): Promise<void> {
  const { workerDb } = await import("../db");
  const { sourceEventLog } = await import("@shared/models/durablePipeline");
  const { eq } = await import("drizzle-orm");

  const [event] = await workerDb
    .select()
    .from(sourceEventLog)
    .where(eq(sourceEventLog.id, sourceEventId))
    .limit(1);

  if (!event) {
    console.error(
      `[Zoom MeetingApply] Source event ${sourceEventId} not found`,
    );
    return;
  }

  const payload = event.payloadJson as any;
  const meetingData = payload?.object || payload;

  const { markNormalized } = await import("./pipelineProcessor");
  await markNormalized(sourceEventId, "zoom", "recording_completed", {
    meetingUuid,
    meetingId: meetingData?.id?.toString(),
    hostEmail: meetingData?.host_email,
    topic: meetingData?.topic,
  });

  const existingRecords = await findByExternalSourceId(
    `zoom_meeting_${meetingUuid}`,
  );

  const { workResultLog } = await import("@shared/models/durablePipeline");
  const { recordApplyOutcome, markReadyToApply } = await import(
    "./pipelineProcessor"
  );

  await markReadyToApply(sourceEventId, "zoom", "recording_completed");

  if (existingRecords.length > 0) {
    const existing = existingRecords[0];
    const [workResult] = await workerDb
      .insert(workResultLog)
      .values({
        sourceEventId,
        sourceSystem: "zoom",
        resultType: "meeting_metadata",
        resultJson: {
          action: "already_exists",
          recordId: existing.id,
          meetingUuid,
        },
        status: "completed",
      })
      .returning({ id: workResultLog.id });

    await recordApplyOutcome({
      sourceEventId,
      workResultId: workResult.id,
      sourceSystem: "zoom",
      sourceEventType: "recording_completed",
      applyTarget: "raw_communication_records",
      outcome: "skipped",
      responseJson: { recordId: existing.id, reason: "already_exists" },
    });

    console.log(
      `[Zoom MeetingApply] Meeting ${meetingUuid} already exists as record ${existing.id}, skipped`,
    );
    return;
  }

  const participants: any[] = [];
  if (meetingData?.host_email) {
    participants.push({
      name: meetingData.host_name || "Host",
      email: meetingData.host_email,
      role: "host",
    });
  }

  try {
    const apiParticipants = await getMeetingParticipants(meetingUuid);
    for (const p of apiParticipants) {
      const email = p.user_email || p.email;
      const existsAlready = participants.some(
        (ep: any) => ep.email?.toLowerCase() === email?.toLowerCase(),
      );
      if (!existsAlready) {
        participants.push({
          name: p.name || p.user_name,
          email,
          role: "participant",
        });
      }
    }
  } catch {}

  let clientId: string | null = null;
  let matchMethod: string | null = null;
  let demotedSuggestion: {
    clientId: string | null;
    matchedOn: string;
    reviewReason: string;
    candidates: Array<{ clientId: string; matchedOn: string }>;
  } | null = null;
  // Hoisted so the post-insert audit-write can persist a synthetic
  // agent_match_decisions row when the deterministic booked_in_app
  // match fired. Spec: "Match audit on the client profile and on the
  // recording's match-decision view shows `Booked In-App` distinctly,
  // including the scheduled meeting id, Zoom meeting id, account
  // manager, and ingestion timestamp."
  let bookedAudit: {
    scheduledMeetingId: string;
    zoomMeetingId: string | null;
    zoomMeetingUuid: string | null;
    accountManagerUserId: string | null;
    clientId: string;
  } | null = null;
  const participantEmails = participants
    .map((p: any) => p.email)
    .filter(Boolean);
  const participantNames = participants
    .map((p: any) => p.name)
    .filter(Boolean);

  // Task #840: Deterministic match by Zoom meeting id/uuid for OS-booked
  // meetings. This runs BEFORE the participant-based matcher and skips it
  // entirely on a hit, so a booked meeting can never be ambiguously matched.
  try {
    const booked = await storage.findScheduledMeetingByZoomIds(
      meetingData?.id ?? null,
      meetingUuid,
    );
    if (booked && booked.clientId && booked.id) {
      clientId = booked.clientId;
      matchMethod = "booked_in_app";
      bookedAudit = {
        scheduledMeetingId: booked.id,
        zoomMeetingId: booked.zoomMeetingId ?? (meetingData?.id != null ? String(meetingData.id) : null),
        zoomMeetingUuid: booked.zoomMeetingUuid ?? meetingUuid ?? null,
        accountManagerUserId: booked.accountManagerUserId,
        clientId: booked.clientId,
      };
      console.log(
        `[Zoom MeetingApply] Deterministic match: booked_in_app meeting ${meetingUuid} → client ${booked.clientId} (scheduled_meeting ${booked.id})`,
      );
    }
  } catch (err: any) {
    console.warn(
      `[Zoom MeetingApply] Deterministic booking lookup failed (continuing with fuzzy matchers): ${err.message || err}`,
    );
  }

  if (!clientId) {
    try {
      // Task #4050: shared deterministic resolution — participant strong
      // signals, trusted-domain, and topic↔firm-name tiers, with ambiguity
      // demoted to review carrying the stored suggestion/shortlist.
      const { resolveZoomClientMatch } = await import("./zoomClientMatching");
      const resolution = await resolveZoomClientMatch(
        {
          participantEmails,
          participantNames,
          topic: meetingData?.topic ?? null,
          source: "zoom",
        },
        { matchParticipants: matchClientByParticipants },
      );
      if (resolution.kind === "auto") {
        clientId = resolution.clientId;
        matchMethod = resolution.matchedOn;
      } else if (resolution.kind === "review") {
        matchMethod = `review_required:${resolution.reviewReason}:${resolution.matchedOn}`;
        demotedSuggestion = {
          clientId: resolution.suggestedClientId,
          matchedOn: resolution.matchedOn,
          reviewReason: resolution.reviewReason,
          candidates: resolution.candidates,
        };
        console.log(
          `[Zoom MeetingApply MatchPolicy] Demoted deterministic match for ${meetingUuid} → ${resolution.matchedOn} (${resolution.reviewReason}); persisting unmatched with reason`,
        );
      }
    } catch {}
  }

  const topic = meetingData?.topic || "Untitled Zoom Meeting";
  const duration = meetingData?.duration || 0;
  const startTime = meetingData?.start_time
    ? new Date(meetingData.start_time)
    : new Date();
  const recordingFiles = meetingData?.recording_files || [];
  let recordingUrl: string | null = null;
  for (const file of recordingFiles) {
    if (
      (file.file_type === "MP4" ||
        file.file_type === "SHARED_SCREEN_WITH_SPEAKER_VIEW") &&
      file.play_url
    ) {
      recordingUrl = file.play_url;
      break;
    }
    if (!recordingUrl && file.play_url) {
      recordingUrl = file.play_url;
    }
  }

  const externalSourceId = `zoom_meeting_${meetingUuid}`;
  const contentPreview = `Zoom meeting: ${topic} (${duration} min)${participants.length > 0 ? ` — ${participants.map((p: any) => p.name || p.email).join(", ")}` : ""}`;

  const { classifyTouchpoint } = await import("@shared/touchpointClassifier");
  const isTouchpoint = classifyTouchpoint({
    sourceType: "zoom",
    hasTranscript: false,
    participantCount: participants.length,
  });

  const record = await storage.createRawCommunication(
    {
      clientId,
      sourceType: "zoom",
      sourceSubtype: "zoom_recording",
      title: topic,
      timestamp: startTime,
      direction: "internal",
      participantsJson: participants,
      externalSourceId,
      externalUrl: recordingUrl || undefined,
      contentPreview,
      rawPayloadJson: {
        meetingId: meetingData?.id,
        meetingUuid,
        hostEmail: meetingData?.host_email,
        hostName: meetingData?.host_name,
        duration,
        recordingCount: recordingFiles.length,
        hasTranscript: false,
        webhookIngested: true,
      },
      processingStatus: "pending",
      reviewStatus: "unreviewed",
      matchMethod: matchMethod || undefined,
      matchStatus: clientId ? "matched" : "unmatched",
    },
    { isTouchpoint },
  );

  if (demotedSuggestion) {
    try {
      const { recordZoomReviewDecision } = await import("./zoomReviewQueue");
      await recordZoomReviewDecision({
        communicationId: record.id,
        communicationType: "zoom",
        suggestedClientId: demotedSuggestion.clientId,
        confidenceScore: demotedSuggestion.clientId ? 0.5 : 0,
        explanationSummary: `Deterministic Zoom match demoted: ${demotedSuggestion.matchedOn}`,
        reviewReason: demotedSuggestion.reviewReason,
        candidateShortlist: demotedSuggestion.candidates.map((c) => ({
          clientId: c.clientId,
          confidenceScore: 0.5,
          matchedOn: c.matchedOn,
        })),
        supportingSignals: [],
        evidenceType: "structured",
      });
    } catch (err) {
      console.error("[Zoom MeetingApply] recordZoomReviewDecision failed:", err);
    }
  } else if (!clientId && !bookedAudit) {
    // Task #995: no deterministic candidate at all → enqueue for operator
    // triage so the recording surfaces in the Review Queue with a client
    // picker instead of being silently left in the unmatched bucket.
    try {
      const { recordZoomReviewDecision, NO_CANDIDATE_REVIEW_REASON } = await import("./zoomReviewQueue");
      await recordZoomReviewDecision({
        communicationId: record.id,
        communicationType: "zoom",
        suggestedClientId: null,
        confidenceScore: 0,
        explanationSummary: `No deterministic booking, participant, or content match for Zoom meeting "${topic}"`,
        reviewReason: NO_CANDIDATE_REVIEW_REASON,
        candidateShortlist: [],
        evidenceType: "structured",
      });
    } catch (err) {
      console.error("[Zoom MeetingApply] no-candidate recordZoomReviewDecision failed:", err);
    }
  }

  // Spec line 51 — when the recording matched deterministically via
  // booked_in_app, persist a structured audit row in
  // `agent_match_decisions` so the existing `MatchDecisionAudit` view
  // (client profile + recording match-decision page) can render
  // "Booked In-App" with the four required audit fields: scheduled
  // meeting id, Zoom meeting id, account manager, ingestion timestamp.
  // We deliberately mirror the shape used elsewhere (status='claimed',
  // evidenceType='structured', confidence=1.0) so the same UI doesn't
  // need a special render path — the audit fields ride in
  // `supportingSignalsJson` which the existing component already
  // renders.
  if (bookedAudit) {
    try {
      const ingestionTimestamp = new Date().toISOString();
      await storage.createAgentMatchDecision({
        communicationId: record.id,
        communicationType: "zoom",
        sourceType: "zoom",
        clientId: bookedAudit.clientId,
        confidenceScore: 1.0,
        status: "claimed",
        explanationSummary:
          "Deterministic match via Booked In-App — Zoom meeting was created by the OS booking tool and matched by Zoom meeting id/uuid.",
        supportingSignalsJson: [
          {
            type: "scheduled_meeting_id",
            value: bookedAudit.scheduledMeetingId,
            weight: 1,
          },
          {
            type: "zoom_meeting_id",
            value: bookedAudit.zoomMeetingId || "",
            weight: 1,
          },
          {
            type: "zoom_meeting_uuid",
            value: bookedAudit.zoomMeetingUuid || "",
            weight: 1,
          },
          {
            type: "account_manager_user_id",
            value: bookedAudit.accountManagerUserId,
            weight: 1,
          },
          { type: "ingested_at", value: ingestionTimestamp, weight: 1 },
        ],
        evidenceType: "structured",
      });
    } catch (err) {
      console.error(
        "[Zoom MeetingApply] booked_in_app audit decision write failed (recording is still claimed):",
        err,
      );
    }
  }

  await db
    .update(rawCommunicationRecords)
    .set({ transcriptStatus: "pending" })
    .where(eq(rawCommunicationRecords.id, record.id));

  const [workResult] = await workerDb
    .insert(workResultLog)
    .values({
      sourceEventId,
      sourceSystem: "zoom",
      resultType: "meeting_metadata",
      resultJson: {
        action: "created",
        recordId: record.id,
        meetingUuid,
        clientId,
        matchMethod,
      },
      status: "completed",
    })
    .returning({ id: workResultLog.id });

  await recordApplyOutcome({
    sourceEventId,
    workResultId: workResult.id,
    sourceSystem: "zoom",
    sourceEventType: "recording_completed",
    applyTarget: "raw_communication_records",
    outcome: "success",
    responseJson: { recordId: record.id, clientId },
  });

  if (clientId) {
    // Task #4025: deliver the recording to the matched client's in-app
    // files (the sole sink since the Task #4084 Drive retirement).
    // Historically only operator reassignment/manual ingest uploaded
    // recordings; the automated apply path now delivers too so new matched
    // recordings land without operator action. Fire-and-forget — delivery failures never block the apply
    // outcome (the recording stays fetchable from Zoom and operators can
    // re-trigger via reassignment).
    void (async () => {
      try {
        const { deliverZoomRecording } = await import("./clientFileDelivery");
        await deliverZoomRecording(record.id, meetingData, clientId);
      } catch (err) {
        console.error(
          `[Zoom MeetingApply] Recording delivery failed for record ${record.id}:`,
          err,
        );
      }
    })();
  }

  console.log(
    `[Zoom MeetingApply] Created record ${record.id} for meeting ${meetingUuid} (client: ${clientId || "unmatched"})`,
  );
}

export async function handleZoomTranscriptApply(
  sourceEventId: string,
  meetingUuid: string,
): Promise<void> {
  const { workerDb } = await import("../db");
  const { sourceEventLog, workResultLog } = await import(
    "@shared/models/durablePipeline"
  );
  const { eq } = await import("drizzle-orm");

  const [event] = await workerDb
    .select()
    .from(sourceEventLog)
    .where(eq(sourceEventLog.id, sourceEventId))
    .limit(1);

  if (!event) {
    console.error(
      `[Zoom TranscriptApply] Source event ${sourceEventId} not found`,
    );
    return;
  }

  const payload = event.payloadJson as any;
  const meetingData = payload?.object || payload;

  const { markNormalized, markReadyToApply, recordApplyOutcome } =
    await import("./pipelineProcessor");

  await markNormalized(sourceEventId, "zoom", "transcript_completed", {
    meetingUuid,
    meetingId: meetingData?.id?.toString(),
  });

  await markReadyToApply(sourceEventId, "zoom", "transcript_completed");

  const externalSourceId = `zoom_meeting_${meetingUuid}`;
  const existingRecords = await findByExternalSourceId(externalSourceId);

  let transcriptContent: string | null = null;
  const recordingFiles = meetingData?.recording_files || [];
  for (const file of recordingFiles) {
    if (file.file_type === "TRANSCRIPT" && file.download_url) {
      transcriptContent = await fetchTranscriptContent(file.download_url);
      break;
    }
  }

  // Task #3699: when the live recordings API says the recording no longer
  // exists (404 / Zoom code 3301 — trashed or retention-deleted), the
  // transcript is never coming; retrying is pointless, so the event gets a
  // terminal close with a stored reason instead of another silent retry.
  let recordingGone = false;
  if (!transcriptContent) {
    try {
      const recordings = await zoomApiRequest(
        `/meetings/${encodeURIComponent(meetingUuid)}/recordings`,
      );
      const transcriptFile = (recordings?.recording_files || []).find(
        (f: any) => f.file_type === "TRANSCRIPT" && f.download_url,
      );
      if (transcriptFile) {
        transcriptContent = await fetchTranscriptContent(
          transcriptFile.download_url,
        );
      }
    } catch (err: any) {
      if (/404|3301/.test(String(err?.message ?? ""))) {
        recordingGone = true;
      }
      console.warn(
        `[Zoom TranscriptApply] Failed to fetch recordings API for ${meetingUuid}: ${err.message}`,
      );
    }
  }

  if (!transcriptContent) {
    const [workResult] = await workerDb
      .insert(workResultLog)
      .values({
        sourceEventId,
        sourceSystem: "zoom",
        resultType: "transcript_content",
        resultJson: {
          action: "no_transcript_available",
          meetingUuid,
        },
        status: "failed",
        errorMessage: "Transcript content could not be fetched",
      })
      .returning({ id: workResultLog.id });

    await recordApplyOutcome({
      sourceEventId,
      workResultId: workResult.id,
      sourceSystem: "zoom",
      sourceEventType: "transcript_completed",
      applyTarget: "raw_communication_records",
      outcome: "failed",
      errorMessage: recordingGone
        ? "Recording deleted in Zoom (404/3301) — transcript permanently unavailable"
        : "Transcript content unavailable",
    });

    // Task #3699: terminal event closure — never leave the event silently
    // pre-apply forever. Two terminal conditions:
    //  - the recording is gone from Zoom (the transcript can never arrive)
    //  - the event-level retry budget is exhausted (stale-apply sweep
    //    re-drives bump attempt_count each pass)
    const { markEventTerminalFailed } = await import("./pipelineProcessor");
    if (recordingGone) {
      await markEventTerminalFailed(
        sourceEventId,
        "zoom",
        "transcript_completed",
        "recording_not_found",
        `Zoom recording for meeting ${meetingUuid} was deleted (404/3301); transcript permanently unavailable.`,
      );
    } else if (event.attemptCount >= event.maxAttempts) {
      await markEventTerminalFailed(
        sourceEventId,
        "zoom",
        "transcript_completed",
        "transcript_unavailable_retries_exhausted",
        `Transcript content for meeting ${meetingUuid} still unavailable after ${event.attemptCount} event-level retries.`,
      );
    }

    console.warn(
      `[Zoom TranscriptApply] No transcript content available for meeting ${meetingUuid}${recordingGone ? " (recording deleted in Zoom — terminally closed)" : ""}`,
    );
    return;
  }

  if (existingRecords.length > 0) {
    const existing = existingRecords[0];
    const hadNoTranscript =
      !existing.contentText ||
      existing.sourceSubtype === "zoom_meeting" ||
      existing.sourceSubtype === "zoom_recording";

    if (hadNoTranscript) {
      await storage.updateRawCommunication(existing.id, {
        sourceSubtype: "zoom_transcript",
        contentText: transcriptContent,
        contentPreview: transcriptContent.substring(0, 200),
        rawPayloadJson: {
          ...((existing.rawPayloadJson as any) || {}),
          hasTranscript: true,
          transcriptUpdatedAt: new Date().toISOString(),
        },
        processingStatus: "pending",
        updatedAt: new Date(),
      });

      await db
        .update(rawCommunicationRecords)
        .set({ transcriptStatus: "ready" })
        .where(eq(rawCommunicationRecords.id, existing.id));

      const { classifyTouchpoint } = await import(
        "@shared/touchpointClassifier"
      );
      const isTouchpoint = classifyTouchpoint({
        sourceType: "zoom",
        hasTranscript: true,
        participantCount:
          (existing.participantsJson as any[])?.length || 0,
      });
      const { finalizeTouchpointClassification } = await import(
        "../storage/communicationStorage"
      );
      if (existing.externalSourceId) {
        await finalizeTouchpointClassification(
          existing.externalSourceId,
          isTouchpoint,
        );
      }

      await enqueueAnalysis(existing.id);
    }

    const [workResult] = await workerDb
      .insert(workResultLog)
      .values({
        sourceEventId,
        sourceSystem: "zoom",
        resultType: "transcript_content",
        resultJson: {
          action: hadNoTranscript ? "updated" : "already_has_transcript",
          recordId: existing.id,
          meetingUuid,
          transcriptLength: transcriptContent.length,
        },
        status: "completed",
      })
      .returning({ id: workResultLog.id });

    await recordApplyOutcome({
      sourceEventId,
      workResultId: workResult.id,
      sourceSystem: "zoom",
      sourceEventType: "transcript_completed",
      applyTarget: "raw_communication_records",
      outcome: hadNoTranscript ? "success" : "skipped",
      responseJson: {
        recordId: existing.id,
        action: hadNoTranscript ? "transcript_applied" : "already_present",
      },
    });

    console.log(
      `[Zoom TranscriptApply] ${hadNoTranscript ? "Applied transcript to" : "Skipped (already has transcript)"} record ${existing.id} for meeting ${meetingUuid}`,
    );
    return;
  }

  const participants: any[] = [];
  if (meetingData?.host_email) {
    participants.push({
      name: meetingData.host_name || "Host",
      email: meetingData.host_email,
      role: "host",
    });
  }

  let clientId: string | null = null;
  let matchMethod: string | null = null;
  let demotedSuggestion: {
    clientId: string | null;
    matchedOn: string;
    reviewReason: string;
    candidates: Array<{ clientId: string; matchedOn: string }>;
  } | null = null;
  // See MeetingApply for rationale. Hoisted so the post-insert audit
  // write can persist a synthetic agent_match_decisions row carrying
  // the booked_in_app audit fields required by spec line 51.
  let bookedAudit: {
    scheduledMeetingId: string;
    zoomMeetingId: string | null;
    zoomMeetingUuid: string | null;
    accountManagerUserId: string | null;
    clientId: string;
  } | null = null;
  const participantEmails = participants
    .map((p: any) => p.email)
    .filter(Boolean);
  const participantNames = participants
    .map((p: any) => p.name)
    .filter(Boolean);

  // Task #840: Deterministic match by Zoom meeting id/uuid for OS-booked
  // meetings. Runs BEFORE the participant matcher and short-circuits it.
  try {
    const booked = await storage.findScheduledMeetingByZoomIds(
      meetingData?.id ?? null,
      meetingUuid,
    );
    if (booked && booked.clientId && booked.id) {
      clientId = booked.clientId;
      matchMethod = "booked_in_app";
      bookedAudit = {
        scheduledMeetingId: booked.id,
        zoomMeetingId: booked.zoomMeetingId ?? (meetingData?.id != null ? String(meetingData.id) : null),
        zoomMeetingUuid: booked.zoomMeetingUuid ?? meetingUuid ?? null,
        accountManagerUserId: booked.accountManagerUserId,
        clientId: booked.clientId,
      };
      console.log(
        `[Zoom TranscriptApply] Deterministic match: booked_in_app meeting ${meetingUuid} → client ${booked.clientId} (scheduled_meeting ${booked.id})`,
      );
    }
  } catch (err: any) {
    console.warn(
      `[Zoom TranscriptApply] Deterministic booking lookup failed (continuing with fuzzy matchers): ${err.message || err}`,
    );
  }

  if (!clientId) {
    try {
      // Task #4050: shared deterministic resolution — participant strong
      // signals, trusted-domain, and topic↔firm-name tiers, with ambiguity
      // demoted to review carrying the stored suggestion/shortlist.
      const { resolveZoomClientMatch } = await import("./zoomClientMatching");
      const resolution = await resolveZoomClientMatch(
        {
          participantEmails,
          participantNames,
          topic: meetingData?.topic ?? null,
          source: "zoom",
        },
        { matchParticipants: matchClientByParticipants },
      );
      if (resolution.kind === "auto") {
        clientId = resolution.clientId;
        matchMethod = resolution.matchedOn;
      } else if (resolution.kind === "review") {
        matchMethod = `review_required:${resolution.reviewReason}:${resolution.matchedOn}`;
        demotedSuggestion = {
          clientId: resolution.suggestedClientId,
          matchedOn: resolution.matchedOn,
          reviewReason: resolution.reviewReason,
          candidates: resolution.candidates,
        };
        console.log(
          `[Zoom TranscriptApply MatchPolicy] Demoted deterministic match for ${meetingUuid} → ${resolution.matchedOn} (${resolution.reviewReason}); persisting unmatched with reason`,
        );
      }
    } catch {}
  }

  const topic = meetingData?.topic || "Untitled Zoom Meeting";
  const startTime = meetingData?.start_time
    ? new Date(meetingData.start_time)
    : new Date();

  const { classifyTouchpoint } = await import("@shared/touchpointClassifier");
  const isTouchpoint = classifyTouchpoint({
    sourceType: "zoom",
    hasTranscript: true,
    participantCount: participants.length,
  });

  const record = await storage.createRawCommunication(
    {
      clientId,
      sourceType: "zoom",
      sourceSubtype: "zoom_transcript",
      title: topic,
      timestamp: startTime,
      direction: "internal",
      participantsJson: participants,
      externalSourceId: `zoom_meeting_${meetingUuid}`,
      contentText: transcriptContent,
      contentPreview: transcriptContent.substring(0, 200),
      rawPayloadJson: {
        meetingId: meetingData?.id,
        meetingUuid,
        hostEmail: meetingData?.host_email,
        hostName: meetingData?.host_name,
        duration: meetingData?.duration,
        hasTranscript: true,
        webhookIngested: true,
      },
      processingStatus: "pending",
      reviewStatus: "unreviewed",
      matchMethod: matchMethod || undefined,
      matchStatus: clientId ? "matched" : "unmatched",
    },
    { isTouchpoint },
  );

  if (demotedSuggestion) {
    try {
      const { recordZoomReviewDecision } = await import("./zoomReviewQueue");
      await recordZoomReviewDecision({
        communicationId: record.id,
        communicationType: "zoom",
        suggestedClientId: demotedSuggestion.clientId,
        confidenceScore: demotedSuggestion.clientId ? 0.5 : 0,
        explanationSummary: `Deterministic Zoom transcript match demoted: ${demotedSuggestion.matchedOn}`,
        reviewReason: demotedSuggestion.reviewReason,
        candidateShortlist: demotedSuggestion.candidates.map((c) => ({
          clientId: c.clientId,
          confidenceScore: 0.5,
          matchedOn: c.matchedOn,
        })),
        supportingSignals: [],
        evidenceType: "structured",
      });
    } catch (err) {
      console.error("[Zoom TranscriptApply] recordZoomReviewDecision failed:", err);
    }
  } else if (!clientId && !bookedAudit) {
    // Task #995: no deterministic candidate → enqueue for operator triage
    // (mirrors the MeetingApply branch so a transcript-first arrival also
    // surfaces in the Review Queue with a client picker).
    try {
      const { recordZoomReviewDecision, NO_CANDIDATE_REVIEW_REASON } = await import("./zoomReviewQueue");
      await recordZoomReviewDecision({
        communicationId: record.id,
        communicationType: "zoom",
        suggestedClientId: null,
        confidenceScore: 0,
        explanationSummary: `No deterministic booking, participant, or content match for Zoom transcript "${topic}"`,
        reviewReason: NO_CANDIDATE_REVIEW_REASON,
        candidateShortlist: [],
        evidenceType: "structured",
      });
    } catch (err) {
      console.error("[Zoom TranscriptApply] no-candidate recordZoomReviewDecision failed:", err);
    }
  }

  // Spec line 51 — booked_in_app audit row (transcript path). Mirrors
  // the MeetingApply branch so a recording that arrives transcript-first
  // still surfaces the four required audit fields (scheduled meeting
  // id, Zoom meeting id, account manager, ingestion timestamp) on the
  // existing match-decision view.
  if (bookedAudit) {
    try {
      const ingestionTimestamp = new Date().toISOString();
      await storage.createAgentMatchDecision({
        communicationId: record.id,
        communicationType: "zoom",
        sourceType: "zoom",
        clientId: bookedAudit.clientId,
        confidenceScore: 1.0,
        status: "claimed",
        explanationSummary:
          "Deterministic match via Booked In-App — Zoom transcript belongs to a meeting created by the OS booking tool.",
        supportingSignalsJson: [
          {
            type: "scheduled_meeting_id",
            value: bookedAudit.scheduledMeetingId,
            weight: 1,
          },
          {
            type: "zoom_meeting_id",
            value: bookedAudit.zoomMeetingId || "",
            weight: 1,
          },
          {
            type: "zoom_meeting_uuid",
            value: bookedAudit.zoomMeetingUuid || "",
            weight: 1,
          },
          {
            type: "account_manager_user_id",
            value: bookedAudit.accountManagerUserId,
            weight: 1,
          },
          { type: "ingested_at", value: ingestionTimestamp, weight: 1 },
        ],
        evidenceType: "structured",
      });
    } catch (err) {
      console.error(
        "[Zoom TranscriptApply] booked_in_app audit decision write failed (transcript still claimed):",
        err,
      );
    }
  }

  await db
    .update(rawCommunicationRecords)
    .set({ transcriptStatus: "ready" })
    .where(eq(rawCommunicationRecords.id, record.id));

  await enqueueAnalysis(record.id);

  const [workResult] = await workerDb
    .insert(workResultLog)
    .values({
      sourceEventId,
      sourceSystem: "zoom",
      resultType: "transcript_content",
      resultJson: {
        action: "created_with_transcript",
        recordId: record.id,
        meetingUuid,
        clientId,
        transcriptLength: transcriptContent.length,
      },
      status: "completed",
    })
    .returning({ id: workResultLog.id });

  await recordApplyOutcome({
    sourceEventId,
    workResultId: workResult.id,
    sourceSystem: "zoom",
    sourceEventType: "transcript_completed",
    applyTarget: "raw_communication_records",
    outcome: "success",
    responseJson: { recordId: record.id, clientId },
  });

  console.log(
    `[Zoom TranscriptApply] Created record ${record.id} with transcript for meeting ${meetingUuid}`,
  );
}

// ===========================================================================
// Task #1032C — Zoom RRULE translator + recurring-meeting wrapper
//
// Zoom's recurrence model is a strict subset of iCal RRULE. This module
// decides whether a given (RRULE, EXDATEs, timezone) tuple can be expressed
// as a Zoom type-8 recurring meeting and emits the corresponding
// `meeting.recurrence` payload, or returns a structured fallback reason so
// the caller can fall back to a single Zoom meeting whose join URL is
// reused for every occurrence ("static link" mode).
//
// The translator is pure — no I/O, no DB. The wrapper is the thin layer
// that calls Zoom: when representable it POSTs a type-8 meeting with the
// translated recurrence object; otherwise it reuses the existing one-off
// `createScheduledMeeting` path so we don't introduce a second create
// code path.
// ===========================================================================

import rrulePkgZoom from "rrule";
const { rrulestr: rrulestrZoom } = rrulePkgZoom as unknown as {
  rrulestr: typeof import("rrule").rrulestr;
  RRule: typeof import("rrule").RRule;
};
import type {
  ZoomRecurrenceObject,
  ZoomRecurrenceFallbackReason,
  ZoomRecurrenceTranslationResult,
  ZoomRecurrenceMode,
} from "@shared/schema";

// rrule frequency constants. Spelled out rather than imported so the
// subset relevant here is obvious in this file.
const RRULE_FREQ_YEARLY = 0;
const RRULE_FREQ_MONTHLY = 1;
const RRULE_FREQ_WEEKLY = 2;
const RRULE_FREQ_DAILY = 3;
// rrule weekday numbers: 0=MO, 1=TU, 2=WE, 3=TH, 4=FR, 5=SA, 6=SU.
// Zoom weekly_days / monthly_week_day numbers: 1=Sun, 2=Mon … 7=Sat.
function rruleWeekdayToZoomDay(rruleWd: number): number | null {
  if (rruleWd === 6) return 1; // SU
  if (rruleWd >= 0 && rruleWd <= 5) return rruleWd + 2;
  return null;
}

const ZOOM_DAILY_INTERVAL_MAX = 90;
const ZOOM_WEEKLY_INTERVAL_MAX = 12;
const ZOOM_MONTHLY_INTERVAL_MAX = 3;
const ZOOM_END_TIMES_MAX = 50;

function notRepresentable(
  reason: ZoomRecurrenceFallbackReason,
  message: string,
): ZoomRecurrenceTranslationResult {
  return { fullyRepresentable: false, reason, message };
}

/**
 * Translate an RRULE (+ optional EXDATEs) into a Zoom recurrence object.
 *
 * Representable cases (per Task #1032C / epic #1032 spec):
 *   - DAILY with INTERVAL ≤ 90, COUNT or UNTIL
 *   - WEEKLY with single BYDAY, INTERVAL ≤ 12
 *   - WEEKLY with multi-BYDAY when INTERVAL = 1 (Zoom rejects multi-day weekly with INTERVAL>1)
 *   - MONTHLY with BYMONTHDAY (single positive day-of-month), INTERVAL ≤ 3
 *   - MONTHLY with BYDAY+BYSETPOS where BYSETPOS ∈ {1,2,3,4,-1}, INTERVAL ≤ 3
 *   - MONTHLY with BYDAY=±NWeekday (positional encoding) where N ∈ {1,2,3,4,-1}
 *   - Either COUNT (≤ 50) → end_times, or UNTIL → end_date_time
 *
 * Anything else (YEARLY, EXDATE present, BYSETPOS outside the supported
 * set, multi-month BYMONTHDAY, BYWEEKNO/BYYEARDAY/BYMONTH/WKST/BYHOUR/
 * BYMINUTE, COUNT > 50, etc.) returns a structured `reason`.
 */
export function translateRRuleToZoomRecurrence(input: {
  rrule: string;
  exdates?: Date[];
  timezone: string;
}): ZoomRecurrenceTranslationResult {
  // EXDATEs aren't representable in Zoom's recurrence object — Zoom
  // generates a fixed run of identical occurrences with no per-instance
  // exclusions. The epic uses Google Calendar as the source of truth for
  // per-instance overrides, so when EXDATEs are present we fall back to
  // the static-link mode and let Google handle the cancellations.
  if (input.exdates && input.exdates.length > 0) {
    return notRepresentable(
      "exdate_present",
      `Zoom recurrence does not support per-instance EXDATEs (${input.exdates.length} present); falling back to static reusable join URL.`,
    );
  }

  let parsed: ReturnType<typeof rrulestrZoom>;
  try {
    parsed = rrulestrZoom(input.rrule, { forceset: false });
  } catch (err: any) {
    return notRepresentable(
      "unsupported_freq",
      `Could not parse RRULE for Zoom translation: ${err?.message || String(err)}`,
    );
  }
  // `rrulestr` may return an RRule or RRuleSet depending on the input. The
  // translator only supports a single RRULE line (no RDATE/EXDATE inside the
  // string itself — those come in via `exdates`). Pull the first rrule's
  // origOptions either way.
  const opts = "origOptions" in parsed
    ? (parsed as any).origOptions
    : (parsed as any).rrules?.()[0]?.origOptions;
  if (!opts) {
    return notRepresentable(
      "unsupported_freq",
      "RRULE could not be parsed into recurrence options.",
    );
  }

  const freq = opts.freq;
  const interval = Math.max(1, Math.round(opts.interval ?? 1));
  const count: number | undefined = opts.count ?? undefined;
  const until: Date | undefined = opts.until ?? undefined;

  // Reject components that change which instants Zoom would emit.
  if (opts.byweekno != null && (Array.isArray(opts.byweekno) ? opts.byweekno.length : true)) {
    return notRepresentable("byweekno_unsupported", "Zoom recurrence does not support BYWEEKNO.");
  }
  if (opts.byyearday != null && (Array.isArray(opts.byyearday) ? opts.byyearday.length : true)) {
    return notRepresentable("byyearday_unsupported", "Zoom recurrence does not support BYYEARDAY.");
  }
  if (opts.bymonth != null && (Array.isArray(opts.bymonth) ? opts.bymonth.length : true)) {
    return notRepresentable("bymonth_unsupported", "Zoom recurrence does not support BYMONTH.");
  }
  if (opts.byhour != null && (Array.isArray(opts.byhour) ? opts.byhour.length : true)) {
    return notRepresentable("byhour_byminute_unsupported", "Zoom recurrence does not support BYHOUR.");
  }
  if (opts.byminute != null && (Array.isArray(opts.byminute) ? opts.byminute.length : true)) {
    return notRepresentable("byhour_byminute_unsupported", "Zoom recurrence does not support BYMINUTE.");
  }
  // wkst defaults to MO in Zoom; rrule encodes weekdays as 0=MO. Anything
  // else changes weekly bucketing in ways Zoom can't represent.
  if (opts.wkst != null) {
    const wkstNum = typeof opts.wkst === "number" ? opts.wkst : (opts.wkst as any).weekday;
    if (typeof wkstNum === "number" && wkstNum !== 0) {
      return notRepresentable("wkst_unsupported", "Zoom recurrence assumes WKST=MO; other values are unsupported.");
    }
  }

  // Build end clause.
  const endClause: Pick<ZoomRecurrenceObject, "end_times" | "end_date_time"> = {};
  if (count != null) {
    if (count < 1 || count > ZOOM_END_TIMES_MAX) {
      return notRepresentable(
        "end_times_too_large",
        `Zoom recurrence supports COUNT 1..${ZOOM_END_TIMES_MAX}, got ${count}.`,
      );
    }
    endClause.end_times = count;
  } else if (until != null) {
    endClause.end_date_time = (until as Date).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  // If neither COUNT nor UNTIL is set, Zoom requires one — represent as
  // not-representable so the caller falls back to static link rather than
  // creating an open-ended Zoom recurrence (which Zoom rejects on the
  // type-8 endpoint).
  if (endClause.end_times == null && endClause.end_date_time == null) {
    return notRepresentable(
      "end_times_too_large",
      "Zoom recurrence requires COUNT or UNTIL; neither was supplied.",
    );
  }

  if (freq === RRULE_FREQ_YEARLY) {
    return notRepresentable("yearly_not_supported", "Zoom recurrence does not support yearly recurrences.");
  }

  if (freq === RRULE_FREQ_DAILY) {
    if (opts.byweekday != null && (Array.isArray(opts.byweekday) ? opts.byweekday.length : true)) {
      return notRepresentable(
        "monthly_byday_unsupported",
        "Zoom daily recurrence does not support BYDAY.",
      );
    }
    if (opts.bymonthday != null && (Array.isArray(opts.bymonthday) ? opts.bymonthday.length : true)) {
      return notRepresentable(
        "monthly_byday_unsupported",
        "Zoom daily recurrence does not support BYMONTHDAY.",
      );
    }
    if (interval > ZOOM_DAILY_INTERVAL_MAX) {
      return notRepresentable(
        "daily_interval_too_large",
        `Zoom daily recurrence supports INTERVAL ≤ ${ZOOM_DAILY_INTERVAL_MAX}, got ${interval}.`,
      );
    }
    return {
      fullyRepresentable: true,
      zoomRecurrence: { type: 1, repeat_interval: interval, ...endClause },
    };
  }

  if (freq === RRULE_FREQ_WEEKLY) {
    if (interval > ZOOM_WEEKLY_INTERVAL_MAX) {
      return notRepresentable(
        "weekly_interval_too_large",
        `Zoom weekly recurrence supports INTERVAL ≤ ${ZOOM_WEEKLY_INTERVAL_MAX}, got ${interval}.`,
      );
    }
    // BYDAY → weekly_days. With no BYDAY, default to the dtstart weekday;
    // but the translator doesn't know dtstart, so require BYDAY explicitly
    // here. Callers (the wrapper) supply dtstart-derived RRULEs that include
    // BYDAY for weekly.
    const byweekdayRaw = opts.byweekday;
    const byweekdayList: any[] = Array.isArray(byweekdayRaw)
      ? byweekdayRaw
      : byweekdayRaw != null
        ? [byweekdayRaw]
        : [];
    if (byweekdayList.length === 0) {
      // Without BYDAY, weekly_days is implied — but Zoom requires it.
      return notRepresentable(
        "monthly_byday_unsupported",
        "Zoom weekly recurrence requires BYDAY.",
      );
    }
    if (byweekdayList.length > 7) {
      return notRepresentable(
        "weekly_day_count_too_large",
        `Zoom weekly recurrence supports at most 7 BYDAY values, got ${byweekdayList.length}.`,
      );
    }
    if (byweekdayList.length > 1 && interval > 1) {
      return notRepresentable(
        "weekly_interval_with_multi_day",
        `Zoom weekly recurrence cannot combine INTERVAL=${interval} with multiple BYDAY values.`,
      );
    }
    const zoomDays: number[] = [];
    for (const wd of byweekdayList) {
      const wdNum = typeof wd === "number" ? wd : wd?.weekday;
      // Positional weekday in weekly context (e.g. 1MO) is meaningless for
      // Zoom weekly_days.
      const wdN = typeof wd === "object" && wd !== null ? wd.n : null;
      if (wdN != null && wdN !== 0 && wdN !== undefined) {
        return notRepresentable(
          "monthly_byday_unsupported",
          "Zoom weekly recurrence does not support positional BYDAY (e.g. 1MO).",
        );
      }
      const z = typeof wdNum === "number" ? rruleWeekdayToZoomDay(wdNum) : null;
      if (z == null) {
        return notRepresentable(
          "monthly_byday_unsupported",
          `Unrecognized BYDAY value: ${JSON.stringify(wd)}`,
        );
      }
      zoomDays.push(z);
    }
    zoomDays.sort((a, b) => a - b);
    return {
      fullyRepresentable: true,
      zoomRecurrence: {
        type: 2,
        repeat_interval: interval,
        weekly_days: zoomDays.join(","),
        ...endClause,
      },
    };
  }

  if (freq === RRULE_FREQ_MONTHLY) {
    if (interval > ZOOM_MONTHLY_INTERVAL_MAX) {
      return notRepresentable(
        "monthly_interval_too_large",
        `Zoom monthly recurrence supports INTERVAL ≤ ${ZOOM_MONTHLY_INTERVAL_MAX}, got ${interval}.`,
      );
    }
    const bymonthdayRaw = opts.bymonthday;
    const bymonthdayList: number[] = Array.isArray(bymonthdayRaw)
      ? bymonthdayRaw
      : bymonthdayRaw != null
        ? [bymonthdayRaw]
        : [];
    const byweekdayRaw = opts.byweekday;
    const byweekdayList: any[] = Array.isArray(byweekdayRaw)
      ? byweekdayRaw
      : byweekdayRaw != null
        ? [byweekdayRaw]
        : [];
    const bysetposRaw = opts.bysetpos;
    const bysetposList: number[] = Array.isArray(bysetposRaw)
      ? bysetposRaw
      : bysetposRaw != null
        ? [bysetposRaw]
        : [];

    // Case A: monthly by day-of-month.
    if (bymonthdayList.length > 0) {
      if (byweekdayList.length > 0) {
        return notRepresentable(
          "monthly_byday_unsupported",
          "Zoom monthly recurrence cannot combine BYMONTHDAY with BYDAY.",
        );
      }
      if (bymonthdayList.length > 1) {
        return notRepresentable(
          "monthly_bymonthday_multi",
          `Zoom monthly recurrence supports a single BYMONTHDAY, got ${bymonthdayList.length}.`,
        );
      }
      const day = bymonthdayList[0];
      if (day < 1 || day > 31) {
        return notRepresentable(
          "monthly_bymonthday_negative",
          `Zoom monthly recurrence supports BYMONTHDAY 1..31, got ${day}.`,
        );
      }
      return {
        fullyRepresentable: true,
        zoomRecurrence: {
          type: 3,
          repeat_interval: interval,
          monthly_day: day,
          ...endClause,
        },
      };
    }

    // Case B: monthly by weekday position. Two encodings:
    //   - BYDAY=MO + BYSETPOS=1   → first Monday
    //   - BYDAY=1MO               → same thing (positional weekday)
    // Zoom only supports BYSETPOS ∈ {1,2,3,4,-1}.
    if (byweekdayList.length === 1) {
      const wd = byweekdayList[0];
      const wdNum = typeof wd === "number" ? wd : wd?.weekday;
      const wdPos: number | null =
        typeof wd === "object" && wd !== null && wd.n != null && wd.n !== 0
          ? wd.n
          : null;
      const zoomDay = typeof wdNum === "number" ? rruleWeekdayToZoomDay(wdNum) : null;
      if (zoomDay == null) {
        return notRepresentable(
          "monthly_byday_unsupported",
          `Unrecognized BYDAY value: ${JSON.stringify(wd)}`,
        );
      }
      let pos: number | null = null;
      if (wdPos != null) {
        if (bysetposList.length > 0) {
          return notRepresentable(
            "complex_bysetpos",
            "Zoom monthly recurrence cannot combine positional BYDAY (e.g. 1MO) with BYSETPOS.",
          );
        }
        pos = wdPos;
      } else if (bysetposList.length === 1) {
        pos = bysetposList[0];
      } else if (bysetposList.length > 1) {
        return notRepresentable(
          "complex_bysetpos",
          `Zoom monthly recurrence supports a single BYSETPOS value, got ${bysetposList.length}.`,
        );
      } else {
        return notRepresentable(
          "monthly_missing_day_or_position",
          "Zoom monthly recurrence with BYDAY requires either BYSETPOS or a positional BYDAY (e.g. 1MO).",
        );
      }
      if (![1, 2, 3, 4, -1].includes(pos)) {
        return notRepresentable(
          "complex_bysetpos",
          `Zoom monthly recurrence supports BYSETPOS ∈ {1,2,3,4,-1}, got ${pos}.`,
        );
      }
      return {
        fullyRepresentable: true,
        zoomRecurrence: {
          type: 3,
          repeat_interval: interval,
          monthly_week: pos as 1 | 2 | 3 | 4 | -1,
          monthly_week_day: zoomDay,
          ...endClause,
        },
      };
    }

    if (byweekdayList.length > 1) {
      return notRepresentable(
        "monthly_byday_unsupported",
        "Zoom monthly recurrence supports only a single BYDAY weekday.",
      );
    }

    return notRepresentable(
      "monthly_missing_day_or_position",
      "Zoom monthly recurrence requires either BYMONTHDAY or BYDAY+BYSETPOS.",
    );
  }

  return notRepresentable(
    "unsupported_freq",
    `Zoom recurrence does not support FREQ=${freq}.`,
  );
}

export interface CreateRecurringMeetingInput extends CreateScheduledMeetingInput {
  /** Single RRULE line, e.g. `RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10`. */
  rrule: string;
  /** Optional EXDATE instants (UTC). When present, forces static-link mode. */
  exdates?: Date[];
}

export interface CreatedRecurringZoomMeeting {
  zoomMeetingId: string;
  zoomMeetingUuid: string;
  joinUrl: string;
  startUrl: string;
  password: string | null;
  mode: ZoomRecurrenceMode;
  /**
   * Canonical informational error code surfaced when Zoom's recurrence
   * model can't represent the requested RRULE. Always
   * `"zoom_recurrence_not_representable"` when present (i.e. when
   * `mode === "static_link_fallback"`). Mirrors the task's required
   * error mapping so downstream callers / loggers can branch on a
   * stable code instead of the narrower `fallbackReason` enum.
   */
  fallbackCode?: "zoom_recurrence_not_representable";
  /** Narrower structured enum explaining why the rule wasn't representable. */
  fallbackReason?: ZoomRecurrenceFallbackReason;
  /** Human-readable explanation echoed from the translator (when fallback). */
  fallbackMessage?: string;
  /** The translated Zoom recurrence object (when `mode === "zoom_recurring"`). */
  zoomRecurrence?: ZoomRecurrenceObject;
  raw: any;
}

/**
 * Create a Zoom meeting that represents a recurring series.
 *
 * - When the RRULE is fully representable in Zoom's recurrence model, this
 *   creates a type-8 recurring meeting with the translated `recurrence`
 *   object. All occurrences share a single `join_url` (the canonical Zoom
 *   behavior).
 * - When not representable, this falls back to the existing one-off
 *   `createScheduledMeeting` path (a single Zoom meeting whose join URL
 *   the booking saga reuses for every occurrence) and stamps
 *   `mode: "static_link_fallback"` plus the structured fallback reason.
 *
 * The fallback path deliberately reuses `createScheduledMeeting` rather
 * than introducing a second create code path; only the translation
 * decision is new in this phase.
 */
export async function createRecurringMeeting(
  input: CreateRecurringMeetingInput,
): Promise<CreatedRecurringZoomMeeting> {
  // Task #1044: when `booking_recurring_zoom_recurring_enabled` is OFF
  // we never call Zoom's recurrence translator — instead we synthesize
  // an "unrepresentable" translation result with the
  // `feature_flag_disabled` reason so the existing fallback path is
  // taken (single Zoom meeting whose join URL the saga reuses for
  // every occurrence). Saga, observability, and downstream metadata
  // all see the same `mode: "static_link_fallback"` shape they already
  // handle for the non-representable RRULE case.
  const flags = await getBookingFeatureFlags();
  const translation: ZoomRecurrenceTranslationResult = flags.zoomRecurring
    ? translateRRuleToZoomRecurrence({
        rrule: input.rrule,
        exdates: input.exdates,
        timezone: input.timezone,
      })
    : {
        fullyRepresentable: false,
        reason: "feature_flag_disabled",
        message:
          "Zoom-recurring meetings are administratively disabled (booking_recurring_zoom_recurring_enabled=false); using static-link fallback.",
      };

  // ---- Static-link fallback ------------------------------------------------
  if (!translation.fullyRepresentable) {
    // Structured observability event — informational, not a hard error.
    // The `code` field carries the canonical
    // `zoom_recurrence_not_representable` mapping required by the task
    // contract so log scrapers / downstream consumers can branch on it
    // without parsing the message text. The `reason` field carries the
    // narrower fallback enum from `ZoomRecurrenceFallbackReason`.
    console.log(
      JSON.stringify({
        event: "zoom_recurring_static_link_fallback_used",
        code: "zoom_recurrence_not_representable",
        topic: input.topic,
        timezone: input.timezone,
        rrule: input.rrule,
        exdateCount: input.exdates?.length ?? 0,
        reason: translation.reason,
        message: translation.message,
      }),
    );
    const fallbackBase = await createScheduledMeeting(input);
    return {
      zoomMeetingId: fallbackBase.id,
      zoomMeetingUuid: fallbackBase.uuid,
      joinUrl: fallbackBase.joinUrl,
      startUrl: fallbackBase.startUrl,
      password: fallbackBase.password,
      mode: "static_link_fallback",
      fallbackCode: "zoom_recurrence_not_representable",
      fallbackReason: translation.reason,
      fallbackMessage: translation.message,
      raw: fallbackBase.raw,
    };
  }

  // ---- Zoom type-8 recurring meeting --------------------------------------
  const host = await resolveZoomUserByEmail(input.hostEmail);
  if (!host) {
    throw new Error(
      `Zoom host not found for email "${input.hostEmail}". The account manager must exist as a Zoom user on the connected account.`,
    );
  }

  const startTimeIso = input.startTimeUtc.toISOString().replace(/\.\d{3}Z$/, "Z");
  const displayTimezone =
    typeof input.timezone === "string" && input.timezone.trim().length > 0
      ? input.timezone
      : "UTC";

  const body: Record<string, unknown> = {
    topic: input.topic.slice(0, 200),
    type: 8, // recurring meeting with fixed time
    start_time: startTimeIso,
    duration: Math.max(15, Math.round(input.durationMinutes)),
    timezone: displayTimezone,
    agenda: (input.agenda || "").slice(0, 2000),
    recurrence: translation.zoomRecurrence,
    settings: {
      host_video: true,
      participant_video: true,
      join_before_host: false,
      jbh_time: 0,
      mute_upon_entry: true,
      auto_recording: "cloud",
      waiting_room: false,
      use_pmi: false,
      approval_type: 2,
      audio: "both",
      registrants_email_notification: false,
      meeting_authentication: false,
    },
  };
  if (input.password) {
    body.password = input.password.slice(0, 10);
  }

  let data: any;
  try {
    data = await zoomApiRequestWithBody(
      `/users/${encodeURIComponent(host.id)}/meetings`,
      { method: "POST", body },
    );
  } catch (err: any) {
    // Hard error — surface as `zoom_recurring_create_failed` per the task
    // spec so callers can distinguish "Zoom rejected the create" from the
    // informational `zoom_recurrence_not_representable` case (which never
    // throws — it drives the fallback above).
    const wrapped = new Error(
      `zoom_recurring_create_failed: ${err?.message || String(err)}`,
    );
    (wrapped as any).cause = err;
    (wrapped as any).code = "zoom_recurring_create_failed";
    throw wrapped;
  }
  if (!data?.id) {
    const err = new Error("zoom_recurring_create_failed: response missing id");
    (err as any).code = "zoom_recurring_create_failed";
    throw err;
  }

  // Structured observability event for the success path. Mirrors the
  // shape of the fallback event above so log scrapers can group both
  // outcomes by `event` prefix `zoom_recurring_*`.
  console.log(
    JSON.stringify({
      event: "zoom_recurring_meeting_created",
      topic: input.topic,
      timezone: input.timezone,
      zoomMeetingId: String(data.id),
      recurrence: translation.zoomRecurrence,
    }),
  );

  return {
    zoomMeetingId: String(data.id),
    zoomMeetingUuid: String(data.uuid || ""),
    joinUrl: String(data.join_url || ""),
    startUrl: String(data.start_url || ""),
    password: data.password ?? null,
    mode: "zoom_recurring",
    zoomRecurrence: translation.zoomRecurrence,
    raw: data,
  };
}

/** Streams the authenticated Zoom download to a tmp file with a size cap. */
async function downloadZoomAudioToTmp(
  downloadUrl: string,
  recordId: string,
): Promise<
  | { outcome: "ok"; tmpPath: string; bytes: number }
  | { outcome: "not_found" }
  | { outcome: "too_large" }
> {
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const { Readable, Transform } = await import("stream");
  const { pipeline } = await import("stream/promises");

  const token = await getAccessToken();
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (response.status === 404) {
    return { outcome: "not_found" };
  }
  if (!response.ok || !response.body) {
    throw new Error(
      `[ZoomRevAi] Audio download failed (${response.status}) for record ${recordId}`,
    );
  }

  const tmpPath = path.join(os.tmpdir(), `zoom-revai-${recordId}.m4a`);
  let bytes = 0;
  let tooLarge = false;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > ZOOM_REVAI_MAX_AUDIO_BYTES) {
        tooLarge = true;
        cb(new Error("audio_too_large"));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as any),
      counter,
      fs.createWriteStream(tmpPath),
    );
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    if (tooLarge) return { outcome: "too_large" };
    throw err;
  }
  return { outcome: "ok", tmpPath, bytes };
}

const ZOOM_REVAI_SUBMITTING_STALE_MS = 30 * 60 * 1000;

const ZOOM_REVAI_SUBMIT_DEDUPE_PREFIX = "zoom_revai:submit:";

const ZOOM_REVAI_QUEUED_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * True when the marker means "leave this record alone" for enqueue purposes:
 * terminal states always block (failed rows must not bounce back to pending;
 * completed rows are done), and fresh in-flight states block while their
 * job chain is presumed alive. Stale in-flight states do NOT block — the
 * conditional claim re-takes them, bounded by the attempts cap.
 */
export function zoomRevAiMarkerBlocksEnqueue(
  marker: ZoomRevAiTranscriptionMarker,
): boolean {
  if (marker.state === "completed" || marker.state === "failed") return true;
  const age = (ts?: string) =>
    Date.now() - (ts ? new Date(ts).getTime() : 0);
  if (marker.state === "queued") return age(marker.queuedAt) < ZOOM_REVAI_QUEUED_STALE_MS;
  if (marker.state === "submitting") return age(marker.submittingAt) < ZOOM_REVAI_SUBMITTING_STALE_MS;
  if (marker.state === "submitted") return age(marker.submittedAt) < ZOOM_REVAI_SUBMITTED_STALE_MS;
  return false;
}

const ZOOM_REVAI_POLL_RETRY_MS = Math.max(
  5_000,
  Number(process.env.ZOOM_REVAI_POLL_RETRY_MS ?? 5 * 60 * 1000),
);

/**
 * Fetches the finished Rev AI transcript and applies it to the record with
 * provenance. Empty transcripts (Rev AI found no usable speech) go terminal.
 */
async function finalizeZoomRevAiTranscript(
  record: { id: string; title: string; rawPayloadJson: unknown },
  marker: ZoomRevAiTranscriptionMarker,
  revJobId: string,
): Promise<string> {
  const { fetchRevAiTranscriptText } = await import("./revAiClient");
  const text = (await fetchRevAiTranscriptText(revJobId)).trim();
  const storedFileTypes = (record.rawPayloadJson as any)?.zoomTranscriptUnavailable?.fileTypes;

  if (!text) {
    await markZoomTranscriptUnavailable(
      record,
      "transcription_failed",
      Array.isArray(storedFileTypes) ? storedFileTypes : undefined,
      {
        failureDetail: "empty_transcript",
        revAiMarker: {
          ...marker,
          state: "failed",
          failedAt: new Date().toISOString(),
          outcome: "empty_transcript",
          revJobId,
        },
      },
    );
    return "terminal:empty_transcript";
  }

  const applied = await applyZoomTranscriptToRecord(record.id, text, {
    transcriptSource: ZOOM_TRANSCRIPT_SOURCE_REVAI,
    revAiMarker: {
      ...marker,
      state: "completed",
      completedAt: new Date().toISOString(),
      outcome: "revai_transcript",
      revJobId,
    },
  });
  if (!applied) {
    // A fresher write (e.g. Zoom's own late transcript) beat us — mark the
    // pipeline done without touching the record content.
    await setZoomRevAiMarker(record.id, {
      state: "completed",
      completedAt: new Date().toISOString(),
      outcome: "lost_apply_race",
      revJobId,
    });
    return "skipped:transcript_already_present";
  }
  console.log(
    `[ZoomRevAi] Generated transcript applied for "${record.title}" (${record.id}) via Rev AI job ${revJobId}`,
  );
  return "completed:revai_transcript";
}

const ZOOM_REVAI_QUICK_POLL_INTERVAL_MS = Math.max(
  1,
  Number(process.env.ZOOM_REVAI_QUICK_POLL_INTERVAL_MS ?? 5000),
);

const ZOOM_REVAI_QUICK_POLL_ATTEMPTS = Math.max(
  0,
  Number(process.env.ZOOM_REVAI_QUICK_POLL_ATTEMPTS ?? 6),
);

export function getZoomRevAiMarker(
  rawPayloadJson: unknown,
): ZoomRevAiTranscriptionMarker | null {
  const m = (rawPayloadJson as any)?.zoomRevAiTranscription;
  if (!m || typeof m !== "object" || typeof m.state !== "string") return null;
  return m as ZoomRevAiTranscriptionMarker;
}

/** Unconditional marker patch (jsonb merge) for non-contended transitions. */
async function setZoomRevAiMarker(
  recordId: string,
  patch: Partial<ZoomRevAiTranscriptionMarker>,
): Promise<void> {
  const marker = sql`${rawCommunicationRecords.rawPayloadJson}->'zoomRevAiTranscription'`;
  await db
    .update(rawCommunicationRecords)
    .set({
      rawPayloadJson: sql`jsonb_set(
        coalesce(${rawCommunicationRecords.rawPayloadJson}, '{}'::jsonb),
        '{zoomRevAiTranscription}',
        coalesce(${marker}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
      )`,
      updatedAt: new Date(),
    })
    .where(eq(rawCommunicationRecords.id, recordId));
}

/**
 * Single entry point for putting a record onto the Rev AI pipeline — used by
 * the sweep's audio-but-no-transcript branch and the terminal-row revival
 * pass. Enforces (in order): kill switch, live-claim single-flight, the
 * attempts cap (going terminal on exhaustion), and the per-window submission
 * cap, then claims the marker and enqueues the durable submission job.
 */
async function maybeEnqueueZoomRevAiFallback(
  record: { id: string; title: string; rawPayloadJson: unknown },
  opts: { revival: boolean; fileTypes?: string[] },
): Promise<ZoomRevAiEnqueueOutcome> {
  if (isKillSwitchEnabled("zoom_revai_transcription")) {
    return "kill_switch";
  }

  const marker = getZoomRevAiMarker(record.rawPayloadJson);
  if (marker && zoomRevAiMarkerBlocksEnqueue(marker)) {
    return "in_flight";
  }
  if (marker && (marker.attempts ?? 0) >= ZOOM_REVAI_MAX_SUBMIT_ATTEMPTS) {
    // Stale in-flight marker with no attempts budget left: the pipeline died
    // mid-flight for the last allowed time. Terminal — no silent retries.
    await markZoomTranscriptUnavailable(
      record,
      "transcription_failed",
      opts.fileTypes,
      {
        failureDetail: "submit_attempts_exhausted",
        revAiMarker: {
          ...marker,
          state: "failed",
          failedAt: new Date().toISOString(),
          outcome: "attempts_exhausted",
        },
      },
    );
    return "attempts_exhausted";
  }

  const recent = await countRecentZoomRevAiSubmissions();
  if (recent >= ZOOM_REVAI_MAX_SUBMISSIONS_PER_SWEEP) {
    console.log(
      `[ZoomRevAi] Submission cap reached (${recent}/${ZOOM_REVAI_MAX_SUBMISSIONS_PER_SWEEP} in window) — deferring record ${record.id}`,
    );
    return "capped";
  }

  const claimed = await tryClaimZoomRevAiEnqueue(record.id, { revival: opts.revival });
  if (!claimed) {
    return "in_flight";
  }

  const { enqueueRepairJob } = await import("./repairDispatcher");
  await enqueueRepairJob({
    queueName: "zoom_revai_transcription",
    workloadClass: "repair",
    priority: 100,
    maxAttempts: 3,
    payload: { recordId: record.id, phase: "submit" },
    dedupeKey: `${ZOOM_REVAI_SUBMIT_DEDUPE_PREFIX}${record.id}`,
  });
  console.log(
    `[ZoomRevAi] Enqueued Rev AI transcription for "${record.title}" (${record.id})${opts.revival ? " [revived from unavailable]" : ""}`,
  );
  return "enqueued";
}

/**
 * Atomically moves the marker queued→submitting and consumes one attempt.
 * Also re-takes a STALE submitting claim (crashed mid-submit). Losing this
 * claim means another worker holds the submission slot — the costly Rev AI
 * POST can never run twice concurrently for one record.
 */
async function claimZoomRevAiSubmitting(recordId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const submittingStaleIso = new Date(Date.now() - ZOOM_REVAI_SUBMITTING_STALE_MS).toISOString();
  const marker = sql`${rawCommunicationRecords.rawPayloadJson}->'zoomRevAiTranscription'`;
  const claimed = await db
    .update(rawCommunicationRecords)
    .set({
      rawPayloadJson: sql`jsonb_set(
        coalesce(${rawCommunicationRecords.rawPayloadJson}, '{}'::jsonb),
        '{zoomRevAiTranscription}',
        coalesce(${marker}, '{}'::jsonb) || jsonb_build_object(
          'state', 'submitting',
          'submittingAt', ${nowIso}::text,
          'attempts', coalesce((${marker}->>'attempts')::int, 0) + 1
        )
      )`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(rawCommunicationRecords.id, recordId),
        sql`(${rawCommunicationRecords.contentText} IS NULL OR ${rawCommunicationRecords.contentText} = '')`,
        sql`coalesce((${marker}->>'attempts')::int, 0) < ${ZOOM_REVAI_MAX_SUBMIT_ATTEMPTS}`,
        sql`(
          ${marker}->>'state' = 'queued'
          OR (${marker}->>'state' = 'submitting' AND coalesce(${marker}->>'submittingAt', '') < ${submittingStaleIso})
        )`,
      ),
    )
    .returning({ id: rawCommunicationRecords.id });
  return claimed.length > 0;
}

const ZOOM_REVAI_SUBMITTED_STALE_MS = 24 * 60 * 60 * 1000;

const ZOOM_REVAI_SUBMISSION_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.ZOOM_REVAI_SUBMISSION_WINDOW_MS ?? 30 * 60 * 1000),
);

/**
 * Rolling-window count of Rev AI submission-job enqueues, shared across
 * instances via work_queue (any status — completed jobs still spent money).
 */
async function countRecentZoomRevAiSubmissions(): Promise<number> {
  const windowStart = new Date(Date.now() - ZOOM_REVAI_SUBMISSION_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workQueue)
    .where(
      and(
        eq(workQueue.queueName, ZOOM_REVAI_QUEUE_NAME),
        sql`${workQueue.dedupeKey} LIKE ${ZOOM_REVAI_SUBMIT_DEDUPE_PREFIX + "%"}`,
        sql`${workQueue.createdAt} >= ${windowStart}`,
      ),
    );
  return row?.count ?? 0;
}

const ZOOM_REVAI_MAX_SUBMISSIONS_PER_SWEEP = Math.max(
  0,
  Number(process.env.ZOOM_REVAI_MAX_SUBMISSIONS_PER_SWEEP ?? 10),
);

type ZoomRevAiEnqueueOutcome =
  | "enqueued"
  | "in_flight"
  | "capped"
  | "attempts_exhausted"
  | "kill_switch";

/**
 * Task #3701 revival pass, run by the periodic transcript-backfill sweep:
 * rows the #3689 sweep parked as terminal `unavailable` with reason
 * `no_transcript_after_window` whose stored fileTypes include M4A audio are
 * re-queued through the Rev AI fallback. The record's transcriptStatus stays
 * 'unavailable' while the pipeline runs (no terminal↔pending bouncing) —
 * it transitions only to 'ready' (success) or gets re-stamped with a
 * terminal `transcription_failed` reason (which this SELECT excludes, so a
 * failed revival can never loop).
 *
 * `restrictToIds` is TEST-ONLY scoping (same convention as the Front
 * re-match sweeps): offline tests scope the pass to their seeded rows
 * instead of enumerating the shared dev-DB backlog. Production call sites
 * must never pass it — the sweep would silently ignore every other record.
 */
export async function reviveUnavailableRecordsForRevAi(
  opts: { restrictToIds?: string[] } = {},
): Promise<{
  candidates: number;
  revived: number;
  capped: boolean;
}> {
  if (isKillSwitchEnabled("zoom_revai_transcription")) {
    return { candidates: 0, revived: 0, capped: false };
  }

  const recent = await countRecentZoomRevAiSubmissions();
  const budget = ZOOM_REVAI_MAX_SUBMISSIONS_PER_SWEEP - recent;
  if (budget <= 0) {
    return { candidates: 0, revived: 0, capped: true };
  }

  const { asc, inArray } = await import("drizzle-orm");
  const unavailableInfo = sql`${rawCommunicationRecords.rawPayloadJson}->'zoomTranscriptUnavailable'`;
  const candidates = await db
    .select({
      id: rawCommunicationRecords.id,
      title: rawCommunicationRecords.title,
      rawPayloadJson: rawCommunicationRecords.rawPayloadJson,
    })
    .from(rawCommunicationRecords)
    .where(
      and(
        eq(rawCommunicationRecords.sourceType, "zoom"),
        eq(rawCommunicationRecords.transcriptStatus, "unavailable"),
        sql`(${rawCommunicationRecords.contentText} IS NULL OR ${rawCommunicationRecords.contentText} = '')`,
        sql`${unavailableInfo}->>'reason' = 'no_transcript_after_window'`,
        sql`coalesce(${unavailableInfo}->'fileTypes', '[]'::jsonb) @> '["M4A"]'::jsonb`,
        zoomRevAiReclaimableSql(),
        ...(opts.restrictToIds && opts.restrictToIds.length > 0
          ? [inArray(rawCommunicationRecords.id, opts.restrictToIds)]
          : []),
      ),
    )
    .orderBy(asc(rawCommunicationRecords.createdAt))
    .limit(budget);

  let revived = 0;
  let capped = false;
  for (const candidate of candidates) {
    const storedFileTypes = (candidate.rawPayloadJson as any)?.zoomTranscriptUnavailable?.fileTypes;
    const outcome = await maybeEnqueueZoomRevAiFallback(
      { id: candidate.id, title: candidate.title ?? "", rawPayloadJson: candidate.rawPayloadJson },
      {
        revival: true,
        fileTypes: Array.isArray(storedFileTypes) ? storedFileTypes : undefined,
      },
    );
    if (outcome === "enqueued") revived++;
    if (outcome === "capped") {
      capped = true;
      break;
    }
  }

  if (candidates.length > 0) {
    console.log(
      `[ZoomRevAi] Revival pass: ${revived}/${candidates.length} terminal-unavailable records re-queued for Rev AI${capped ? " (cap hit)" : ""}`,
    );
  }
  return { candidates: candidates.length, revived, capped };
}

const ZOOM_REVAI_POLL_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.ZOOM_REVAI_POLL_TIMEOUT_MS ?? 6 * 60 * 60 * 1000),
);

const ZOOM_REVAI_MAX_AUDIO_BYTES = Math.max(
  1,
  Number(process.env.ZOOM_REVAI_MAX_AUDIO_BYTES ?? 512 * 1024 * 1024),
);

const ZOOM_REVAI_MAX_SUBMIT_ATTEMPTS = Math.max(
  1,
  Number(process.env.ZOOM_REVAI_MAX_SUBMIT_ATTEMPTS ?? 3),
);

/**
 * SQL twin of zoomRevAiMarkerBlocksEnqueue's inverse, used in conditional
 * claims and the revival SELECT: no marker at all, or a non-terminal marker
 * whose state timestamp has gone stale — always under the attempts cap.
 * ISO-8601 timestamps compare lexicographically; a missing timestamp
 * coalesces to '' which sorts before any ISO string (treated as stale).
 */
function zoomRevAiReclaimableSql() {
  const marker = sql`${rawCommunicationRecords.rawPayloadJson}->'zoomRevAiTranscription'`;
  const queuedStaleIso = new Date(Date.now() - ZOOM_REVAI_QUEUED_STALE_MS).toISOString();
  const submittingStaleIso = new Date(Date.now() - ZOOM_REVAI_SUBMITTING_STALE_MS).toISOString();
  const submittedStaleIso = new Date(Date.now() - ZOOM_REVAI_SUBMITTED_STALE_MS).toISOString();
  return sql`(
    ${marker} IS NULL
    OR (
      coalesce((${marker}->>'attempts')::int, 0) < ${ZOOM_REVAI_MAX_SUBMIT_ATTEMPTS}
      AND (
        (${marker}->>'state' = 'queued' AND coalesce(${marker}->>'queuedAt', '') < ${queuedStaleIso})
        OR (${marker}->>'state' = 'submitting' AND coalesce(${marker}->>'submittingAt', '') < ${submittingStaleIso})
        OR (${marker}->>'state' = 'submitted' AND coalesce(${marker}->>'submittedAt', '') < ${submittedStaleIso})
      )
    )
  )`;
}

/**
 * Durable work_queue processor for one record's Rev AI pipeline step. The
 * marker decides the phase: no revJobId → submit (Zoom re-check, M4A
 * download, Rev AI POST, quick poll), revJobId → poll (status check →
 * finalize / terminal / delayed re-poll). Every outcome is returned as the
 * job cursor so operators can watch convergence from the queue.
 */
export async function processZoomRevAiTranscriptionJob(
  recordId: string,
): Promise<string> {
  if (isKillSwitchEnabled("zoom_revai_transcription")) {
    // Leave the marker as-is: it goes stale-reclaimable on its own, so an
    // operator pause loses nothing once the switch is released.
    return "kill_switch:paused";
  }

  const [record] = await db
    .select()
    .from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.id, recordId))
    .limit(1);
  if (!record) return "skipped:record_missing";
  if (
    record.transcriptStatus === "ready" ||
    (record.contentText && record.contentText.length > 0)
  ) {
    return "skipped:transcript_already_present";
  }
  if (record.transcriptStatus === "failed") {
    return "skipped:record_failed_state";
  }

  const marker = getZoomRevAiMarker(record.rawPayloadJson);
  if (!marker) return "skipped:no_marker";
  if (marker.state === "completed" || marker.state === "failed") {
    return `skipped:marker_${marker.state}`;
  }

  const recordRef = {
    id: record.id,
    title: record.title ?? "",
    rawPayloadJson: record.rawPayloadJson,
  };
  const storedFileTypes = (record.rawPayloadJson as any)?.zoomTranscriptUnavailable?.fileTypes;
  const fileTypesForTerminal = Array.isArray(storedFileTypes) ? storedFileTypes : undefined;

  // ---- Poll phase: a Rev AI job already exists for this record. ----
  if (marker.revJobId) {
    const { getRevAiJobStatus, RevAiHttpError } = await import("./revAiClient");
    let status: Awaited<ReturnType<typeof getRevAiJobStatus>>;
    try {
      status = await getRevAiJobStatus(marker.revJobId);
    } catch (err: any) {
      if (err instanceof RevAiHttpError && err.status === 404) {
        // Rev AI job evaporated (expired/deleted). Reset to a reclaimable
        // queued marker so the next sweep/revival re-claims it — attempts
        // already consumed still count against the cap.
        await setZoomRevAiMarker(record.id, {
          state: "queued",
          queuedAt: new Date(0).toISOString(),
          revJobId: null,
          lastError: `revai_job_missing:${marker.revJobId}`,
        });
        return "requeued:revai_job_missing";
      }
      throw err;
    }

    if (status.status === "transcribed") {
      return finalizeZoomRevAiTranscript(recordRef, marker, marker.revJobId);
    }
    if (status.status === "failed") {
      await markZoomTranscriptUnavailable(
        recordRef,
        "transcription_failed",
        fileTypesForTerminal,
        {
          failureDetail: status.failure_detail || status.failure || "revai_job_failed",
          revAiMarker: {
            ...marker,
            state: "failed",
            failedAt: new Date().toISOString(),
            outcome: "revai_job_failed",
          },
        },
      );
      return "terminal:transcription_failed";
    }

    // Still in progress: give up past the timeout, otherwise re-poll later.
    const submittedAtMs = marker.submittedAt ? new Date(marker.submittedAt).getTime() : 0;
    if (Date.now() - submittedAtMs > ZOOM_REVAI_POLL_TIMEOUT_MS) {
      await markZoomTranscriptUnavailable(
        recordRef,
        "transcription_failed",
        fileTypesForTerminal,
        {
          failureDetail: "poll_timeout",
          revAiMarker: {
            ...marker,
            state: "failed",
            failedAt: new Date().toISOString(),
            outcome: "poll_timeout",
          },
        },
      );
      return "terminal:poll_timeout";
    }
    await enqueueZoomRevAiPoll(record.id);
    return "polling:in_progress";
  }

  // ---- Submit phase. ----
  if ((marker.attempts ?? 0) >= ZOOM_REVAI_MAX_SUBMIT_ATTEMPTS) {
    await markZoomTranscriptUnavailable(
      recordRef,
      "transcription_failed",
      fileTypesForTerminal,
      {
        failureDetail: "submit_attempts_exhausted",
        revAiMarker: {
          ...marker,
          state: "failed",
          failedAt: new Date().toISOString(),
          outcome: "attempts_exhausted",
        },
      },
    );
    return "terminal:submit_attempts_exhausted";
  }

  const claimedSubmitting = await claimZoomRevAiSubmitting(record.id);
  if (!claimedSubmitting) {
    return "skipped:submit_claim_lost";
  }
  const submittingMarker: ZoomRevAiTranscriptionMarker = {
    ...marker,
    state: "submitting",
    attempts: (marker.attempts ?? 0) + 1,
  };

  // Re-check Zoom live: the recording may have gained a real Zoom transcript
  // (which always wins), lost its audio, or vanished entirely.
  const payload = record.rawPayloadJson as any;
  const meetingUuid = payload?.meetingUuid || payload?.meetingId?.toString();
  if (!meetingUuid) {
    await markZoomTranscriptUnavailable(recordRef, "transcription_failed", fileTypesForTerminal, {
      failureDetail: "missing_meeting_uuid",
      revAiMarker: {
        ...submittingMarker,
        state: "failed",
        failedAt: new Date().toISOString(),
        outcome: "missing_meeting_uuid",
      },
    });
    return "terminal:missing_meeting_uuid";
  }

  let recordings: any;
  try {
    recordings = await zoomApiRequest(
      `/meetings/${encodeURIComponent(meetingUuid)}/recordings`,
    );
  } catch (err: any) {
    if (err instanceof ZoomPermanentError) {
      // Global Zoom auth outage — do NOT fail the job (dead-letter noise) or
      // the record. The submitting marker goes stale-reclaimable on its own.
      console.warn(
        `[ZoomRevAi] Zoom permanent auth/scope error for record ${record.id} — deferring (${err.kind})`,
      );
      return "skipped:zoom_permanent_error";
    }
    if (/404|3001/.test(err.message)) {
      await markZoomTranscriptUnavailable(recordRef, "recording_not_found", undefined, {
        revAiMarker: {
          ...submittingMarker,
          state: "failed",
          failedAt: new Date().toISOString(),
          outcome: "recording_not_found",
        },
      });
      return "terminal:recording_not_found";
    }
    throw err;
  }

  const recordingFiles = (recordings?.recording_files || []) as any[];
  const zoomTranscriptFile = recordingFiles.find(
    (f: any) => f?.file_type === "TRANSCRIPT" && f?.download_url,
  );
  if (zoomTranscriptFile) {
    // Zoom delivered its own transcript after all — it always wins over a
    // generated one, and we never spend Rev AI money on this record.
    const transcriptContent = await fetchTranscriptContent(zoomTranscriptFile.download_url);
    if (!transcriptContent) {
      throw new Error(
        `[ZoomRevAi] Zoom transcript download failed for record ${record.id} — retrying`,
      );
    }
    const applied = await applyZoomTranscriptToRecord(record.id, transcriptContent, {
      revAiMarker: {
        ...submittingMarker,
        state: "completed",
        completedAt: new Date().toISOString(),
        outcome: "zoom_transcript_won",
      },
    });
    if (!applied) {
      await setZoomRevAiMarker(record.id, {
        state: "completed",
        completedAt: new Date().toISOString(),
        outcome: "zoom_transcript_won",
      });
    }
    return "completed:zoom_transcript";
  }

  const audioFile = recordingFiles.find(
    (f: any) => f?.file_type === "M4A" && f?.download_url,
  );
  if (!audioFile) {
    const liveFileTypes = Array.from(
      new Set(
        recordingFiles
          .map((f: any) => (typeof f?.file_type === "string" ? f.file_type : null))
          .filter((t: string | null): t is string => !!t),
      ),
    );
    await markZoomTranscriptUnavailable(
      recordRef,
      "no_audio_file",
      liveFileTypes.length > 0 ? liveFileTypes : fileTypesForTerminal,
      {
        revAiMarker: {
          ...submittingMarker,
          state: "failed",
          failedAt: new Date().toISOString(),
          outcome: "no_audio_file",
        },
      },
    );
    return "terminal:no_audio_file";
  }

  // Download the audio and submit it to Rev AI.
  const download = await downloadZoomAudioToTmp(audioFile.download_url, record.id);
  if (download.outcome === "not_found") {
    await markZoomTranscriptUnavailable(recordRef, "recording_not_found", undefined, {
      revAiMarker: {
        ...submittingMarker,
        state: "failed",
        failedAt: new Date().toISOString(),
        outcome: "audio_download_404",
      },
    });
    return "terminal:audio_download_404";
  }
  if (download.outcome === "too_large") {
    await markZoomTranscriptUnavailable(
      recordRef,
      "transcription_failed",
      fileTypesForTerminal,
      {
        failureDetail: "audio_too_large",
        revAiMarker: {
          ...submittingMarker,
          state: "failed",
          failedAt: new Date().toISOString(),
          outcome: "audio_too_large",
        },
      },
    );
    return "terminal:audio_too_large";
  }

  let revJobId: string;
  try {
    const { submitRevAiJobFromFile } = await import("./revAiClient");
    revJobId = await submitRevAiJobFromFile(download.tmpPath, {
      filename: "audio.m4a",
      contentType: "audio/mp4",
      metadata: `zoom_transcript:${record.id}`,
    });
  } finally {
    const fs = await import("fs");
    await fs.promises.unlink(download.tmpPath).catch(() => {});
  }

  // Persist the job id IMMEDIATELY — a submitted job whose id is lost would
  // be unrecoverable (and re-submission costs money).
  const submittedAtIso = new Date().toISOString();
  await setZoomRevAiMarker(record.id, {
    state: "submitted",
    submittedAt: submittedAtIso,
    revJobId,
  });
  const submittedMarker: ZoomRevAiTranscriptionMarker = {
    ...submittingMarker,
    state: "submitted",
    submittedAt: submittedAtIso,
    revJobId,
  };
  console.log(
    `[ZoomRevAi] Submitted Rev AI job ${revJobId} for "${record.title}" (${record.id})`,
  );

  // Short in-job poll: most short meetings transcribe in well under a
  // minute, so this usually finishes without a delayed poll job.
  const { getRevAiJobStatus } = await import("./revAiClient");
  for (let i = 0; i < ZOOM_REVAI_QUICK_POLL_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, ZOOM_REVAI_QUICK_POLL_INTERVAL_MS));
    let status: Awaited<ReturnType<typeof getRevAiJobStatus>>;
    try {
      status = await getRevAiJobStatus(revJobId);
    } catch {
      break; // transient status error — fall through to the durable poll
    }
    if (status.status === "transcribed") {
      return finalizeZoomRevAiTranscript(recordRef, submittedMarker, revJobId);
    }
    if (status.status === "failed") {
      await markZoomTranscriptUnavailable(
        recordRef,
        "transcription_failed",
        fileTypesForTerminal,
        {
          failureDetail: status.failure_detail || status.failure || "revai_job_failed",
          revAiMarker: {
            ...submittedMarker,
            state: "failed",
            failedAt: new Date().toISOString(),
            outcome: "revai_job_failed",
          },
        },
      );
      return "terminal:transcription_failed";
    }
  }

  await enqueueZoomRevAiPoll(record.id);
  return "submitted:polling";
}

/** Enqueues the delayed durable poll job for a submitted Rev AI transcription. */
async function enqueueZoomRevAiPoll(recordId: string): Promise<void> {
  const { enqueueRepairJob } = await import("./repairDispatcher");
  // Minute-bucket in the dedupe key: the partial unique index only blocks
  // while a prior poll job is still live, but distinct buckets also keep a
  // just-completed poll from swallowing the follow-up enqueue.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  await enqueueRepairJob({
    queueName: "zoom_revai_transcription",
    workloadClass: "repair",
    priority: 100,
    maxAttempts: 3,
    retryAt: new Date(Date.now() + ZOOM_REVAI_POLL_RETRY_MS),
    payload: { recordId, phase: "poll" },
    dedupeKey: `zoom_revai:poll:${recordId}:${minuteBucket}`,
  });
}

/**
 * Atomically claims a record for the Rev AI pipeline by writing a fresh
 * 'queued' marker — the single-flight gate for enqueues. Preserves prior
 * `attempts` (they only increment at the submitting claim) and any prior
 * `revJobId` (a reclaimed submitted-stale marker goes back through the poll
 * path, which finishes the old job for free if it actually completed).
 * Returns false when another instance already holds a live claim or the
 * record no longer needs a transcript.
 */
async function tryClaimZoomRevAiEnqueue(
  recordId: string,
  opts: { revival: boolean },
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const marker = sql`${rawCommunicationRecords.rawPayloadJson}->'zoomRevAiTranscription'`;
  const claimed = await db
    .update(rawCommunicationRecords)
    .set({
      rawPayloadJson: sql`jsonb_set(
        coalesce(${rawCommunicationRecords.rawPayloadJson}, '{}'::jsonb),
        '{zoomRevAiTranscription}',
        coalesce(${marker}, '{}'::jsonb) || jsonb_build_object(
          'state', 'queued',
          'queuedAt', ${nowIso}::text,
          'attempts', coalesce((${marker}->>'attempts')::int, 0),
          'revivedFromUnavailable', coalesce((${marker}->>'revivedFromUnavailable')::boolean, ${opts.revival})
        )
      )`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(rawCommunicationRecords.id, recordId),
        sql`(${rawCommunicationRecords.contentText} IS NULL OR ${rawCommunicationRecords.contentText} = '')`,
        sql`${rawCommunicationRecords.transcriptStatus} IS DISTINCT FROM 'ready'`,
        sql`${rawCommunicationRecords.transcriptStatus} IS DISTINCT FROM 'failed'`,
        zoomRevAiReclaimableSql(),
      ),
    )
    .returning({ id: rawCommunicationRecords.id });
  return claimed.length > 0;
}

export function __resetZoomS2sWebhookVerifiedStampForTest(): void {
  zoomS2sWebhookVerifiedLastStampMs = 0;
}

/**
 * Task #4019 — the legacy token rows the ZOOM.md § Retirement step clears
 * once s2s is proven in production. Exported for the retirement prod action
 * (presence checks) and tests; `zoom_granted_scopes` deliberately survives
 * retirement (harmless metadata, still written by s2s mints).
 */
export const ZOOM_LEGACY_TOKEN_SETTING_KEYS = [
  SETTINGS_KEY_ACCESS,
  SETTINGS_KEY_REFRESH,
  SETTINGS_KEY_EXPIRES,
] as const;

export interface ZoomLegacyTokenRetirementResult {
  cleared: string[];
  alreadyAbsent: string[];
}

let zoomS2sWebhookVerifiedLastStampMs = 0;

/**
 * Deletes the three legacy user-level OAuth token rows (values are never
 * logged or embedded in audit rows — key names only). Hard-refuses outside
 * s2s mode as defense-in-depth: clearing these rows while oauth mode serves
 * traffic would sever the live integration.
 */
export async function retireLegacyZoomOauthTokens(
  actorId?: string | null,
): Promise<ZoomLegacyTokenRetirementResult> {
  const mode = await getZoomAuthMode();
  if (mode !== "s2s") {
    throw new Error(
      "refusing to retire legacy Zoom token rows while zoom_auth_mode != s2s (they are the live credentials in oauth mode)",
    );
  }
  const cleared: string[] = [];
  const alreadyAbsent: string[] = [];
  for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) {
    const row = await storage.getSystemSetting(key);
    if (row?.value) {
      await storage.deleteSystemSetting(key);
      cleared.push(key);
    } else {
      alreadyAbsent.push(key);
    }
  }
  if (cleared.length > 0) {
    try {
      await storage.recordAdminSettingChange({
        settingKey: SETTINGS_KEY_ACCESS,
        scope: "zoom_legacy_token_retirement",
        changedBy: actorId && actorId !== "system" ? actorId : null,
        oldValues: { presentKeys: cleared },
        newValues: { cleared: true },
      });
    } catch (err: any) {
      console.error("[Zoom] legacy-token retirement audit insert failed:", err?.message);
    }
    console.log(
      `[Zoom] Legacy OAuth token rows retired (${cleared.join(", ")}) — s2s single-app steady state`,
    );
  }
  return { cleared, alreadyAbsent };
}

const ZOOM_S2S_WEBHOOK_VERIFIED_STAMP_MIN_INTERVAL_MS = 5 * 60 * 1000;

function getZoomWebhookSecretsLabeled(): Array<{ source: ZoomWebhookSecretSource; token: string }> {
  const entries: Array<{ source: ZoomWebhookSecretSource; token: string | undefined }> = [
    { source: "legacy", token: process.env.ZOOM_WEBHOOK_SECRET_TOKEN },
    { source: "s2s", token: process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN },
  ];
  return entries.filter(
    (e): e is { source: ZoomWebhookSecretSource; token: string } =>
      typeof e.token === "string" && e.token.length > 0,
  );
}

export async function recordZoomS2sWebhookVerified(nowMs: number = Date.now()): Promise<void> {
  if (nowMs - zoomS2sWebhookVerifiedLastStampMs < ZOOM_S2S_WEBHOOK_VERIFIED_STAMP_MIN_INTERVAL_MS) {
    return;
  }
  try {
    await storage.setSystemSetting(
      ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING,
      new Date(nowMs).toISOString(),
    );
    zoomS2sWebhookVerifiedLastStampMs = nowMs;
  } catch (err: any) {
    console.error("[Zoom Webhook] failed to stamp S2S-verified evidence:", err?.message ?? err);
  }
}

export function __setZoomAutoSyncKickForTest(fn: (() => Promise<void>) | null): void {
  zoomAutoSyncKickOverrideForTest = fn;
}

/**
 * Task #4019 — the ONE auth-mode change sequence, shared by the team-lead
 * POST /api/integrations/zoom/auth-mode route and the
 * `zoom_s2s_auth_mode_cutover` prod action so the two surfaces can never
 * drift: equality short-circuit → preflight gate for s2s (unless `force`,
 * the documented break-glass) → setZoomAuthMode (audits + clears gates +
 * stamps the cutover clock) → status-cache invalidation → auto-sync kick.
 *
 * Cache invalidation is best-effort BY DESIGN: the mode has already changed,
 * so failing the whole call over a cosmetic cache would misreport a
 * successful flip as an error (the cache TTL self-corrects). The auto-sync
 * kick mirrors the OAuth connect callback and is fire-and-forget for the
 * same reason.
 */
export async function applyZoomAuthModeChange(
  mode: ZoomAuthMode,
  opts: { actorId?: string | null; force?: boolean } = {},
): Promise<ZoomAuthModeChangeResult> {
  const current = await getZoomAuthMode();
  if (mode === current) {
    return { kind: "unchanged", mode };
  }
  if (mode === "s2s" && opts.force !== true) {
    const preflight = await runZoomS2sPreflight();
    if (!preflight.ready) {
      return { kind: "not_ready", preflight };
    }
  }
  await setZoomAuthMode(mode, opts.actorId ?? undefined);
  try {
    const { invalidateIntegrationStatus } = await import("./integrationStatusCache");
    await invalidateIntegrationStatus("zoom");
  } catch (err: any) {
    console.error(
      "[Zoom] status-cache invalidation after auth-mode change failed:",
      err?.message ?? err,
    );
  }
  const kickAutoSync = zoomAutoSyncKickOverrideForTest ?? initZoomAutoSync;
  void kickAutoSync().catch((err) => {
    console.error("[Zoom] Failed to start auto-sync after auth-mode change:", err);
  });
  return { kind: "changed", mode, previous: current };
}

/**
 * Test seam: the real initZoomAutoSync starts the durable pipeline
 * (reconciliation cron + transcript backfill timers), which must not run
 * inside a test process. Tests swap in a recorder to assert the kick fires;
 * production always uses the real starter (override is null outside tests).
 */
let zoomAutoSyncKickOverrideForTest: (() => Promise<void>) | null = null;
