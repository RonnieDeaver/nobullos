// Task #2102 — SEMrush auth-dead circuit breaker.
//
// Thin wrapper over the shared `createAuthDeadBreaker` factory
// (`authDeadBreaker.ts`, Task #2137). When the system-wide SEMrush OAuth
// refresh token is terminally rejected (SEMrush returns `invalid_request` —
// NOT the spec `invalid_grant` — plus `invalid_client` /
// `unauthorized_client`; surfaced here as `semrush_refresh_failed_permanent`
// / `semrush_no_refresh_token` / `semrush_not_connected`), nothing the code
// can do will fix it — the operator must re-authorize SEMrush via the
// device flow. Per SEMrush's OAuth docs (the refresh exchange POSTs to
// https://oauth.semrush.com/dag/device/token; a rejected refresh token
// returns a 4xx with `invalid_request`), retrying a dead refresh token is
// pure noise. Without a global backoff the Local-Dominance sweep (one
// attempt per client × location) plus the Integrations-Hub probe keep
// re-driving the refresh POST, flooding the logs.
//
// The breaker is a process-global in-memory gate. It trips on terminal
// SEMrush auth errors and short-circuits subsequent token acquisition for
// the cooldown window (default 5 min). During the cooldown:
//   - `getAccessToken` throws immediately (no network) so every SEMrush
//     API call path backs off instead of re-driving the refresh POST.
//   - The Integrations-Hub probe (`probeConnection`) does NOT go through
//     `getAccessToken`, so it naturally bypasses the breaker and a
//     genuine operator reconnect clears the UI on the next poll.
//   - The Local-Dominance sweep sees `breakerOpen` and short-circuits the
//     whole run to `paused_auth` instead of attempting every location.
//   - One throttled `console.error` is emitted per cooldown window so the
//     operator sees a single loud line, not thousands of stack traces.
// A successful refresh (background) or a successful device-flow reconnect
// immediately resets the breaker, so recovery needs no restart.
//
// Task #2122 — durable breaker signal (mirrors the Front breaker, Task
// #2103). The in-memory breaker above is per-process and resets on
// restart, so on autoscale the `paused_auth` short-circuit of the
// Local-Dominance sweep could silently lift after a deploy / restart
// (until the next dead refresh re-tripped it) and be inconsistent across
// instances. The shared factory's optional `persistence` layer (configured
// below) mirrors the trip state (code + cooldown-until) into a single
// `system_settings` row so it survives restarts and converges across
// instances. The row is read through the same Redis-backed
// `system_settings` cache every other setting uses, so reconcile reads
// are cheap. The hot token-acquisition path (`semrushAuthBreakerActive`)
// stays purely in-memory for speed; boot hydration restores it after a
// restart and each instance re-trips itself on its first dead refresh, so
// suppression converges within the cooldown window without a per-call DB
// read.

import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

import { createAuthDeadBreaker } from "./authDeadBreaker";
// Task #3670 — v4 API-key mode makes the whole OAuth breaker dormant: while
// SEMRUSH_V4_API_KEY is set, no request path reads/refreshes OAuth tokens,
// so a stale persisted trip (or a race that trips it) must never surface
// "Reconnect Required" or pause the sweep. `semrushAuthBreakerActive()` is
// the single gate every consumer (sweep, prod-actions, status routes,
// getAccessToken short-circuit) uses, so gating it here keeps them all in
// lockstep.
import { isSemrushKeyMode } from "./semrushAuthMode";

// Terminal SEMrush auth failure codes. Transient (5xx / network) refresh
// failures are deliberately excluded — they are retryable and must NOT
// trip the breaker.
export const TERMINAL_SEMRUSH_AUTH_CODES = new Set<string>([
  "semrush_not_connected",
  "semrush_no_refresh_token",
  "semrush_refresh_failed_permanent",
]);

const breaker = createAuthDeadBreaker({
  logPrefix: "[Semrush]",
  apiNoun: "SEMrush",
  breakerLabel: "Semrush",
  operatorAction: "re-authorize SEMrush in Settings → Integrations.",
  defaultCode: "semrush_not_connected",
  terminalCodes: TERMINAL_SEMRUSH_AUTH_CODES,
  persistence: {
    stateKey: "semrush_auth_breaker_state",
    getSystemSetting,
    setSystemSetting,
  },
});

export function isSemrushAuthTerminalCode(code: string | null | undefined): boolean {
  return breaker.isTerminalCode(code);
}

export function semrushAuthBreakerActive(): boolean {
  // Task #3670 — dormant in key mode (see header note).
  if (isSemrushKeyMode()) return false;
  return breaker.active();
}

export function tripSemrushAuthBreaker(errorCode: string): void {
  // Task #3670 — key mode never trips the OAuth breaker: a key-mode 401/403
  // is a key problem surfaced by SemrushApiKeyRejectedError, and no OAuth
  // refresh runs that could produce a terminal code.
  if (isSemrushKeyMode()) {
    console.warn(
      `[Semrush] auth-breaker trip suppressed (API-key mode active) — code=${errorCode}`,
    );
    return;
  }
  breaker.trip(errorCode);
}

export function recordSemrushCallSuccess(): void {
  breaker.recordSuccess();
}

export function resetSemrushAuthBreaker(): void {
  breaker.reset();
}

/**
 * Task #2122 — reconcile the in-memory breaker against the durable
 * `system_settings` signal. Called once at boot (re-hydrate after a
 * restart) and on every Integrations-Hub status poll (so suppression
 * reflects a trip / reconnect that happened on another instance).
 */
export function reconcileSemrushAuthBreakerFromStore(): Promise<void> {
  return breaker.reconcileFromStore();
}

/**
 * Task #2122 — boot hydration. Re-hydrates the in-memory breaker from the
 * durable signal so suppression survives a restart.
 */
export function hydrateSemrushAuthBreakerFromStore(): Promise<{ breakerOpen: boolean }> {
  return breaker.hydrateFromStore();
}

export function semrushAuthBreakerError(): Error {
  return breaker.error();
}

/**
 * Inspect the in-memory SEMrush auth-breaker state. Mirrors
 * `getFrontAuthState` for the Integrations-Hub status route and the
 * regression tests.
 */
export function getSemrushAuthState() {
  return breaker.getState();
}

/** Test-only: clear the breaker between cases. Production never calls this. */
export function __resetSemrushAuthBreakerForTest(): void {
  breaker.__resetForTest();
}

/** Test-only: await the durable signal being cleared. Production never calls this. */
export function __clearPersistedSemrushAuthBreakerForTest(): Promise<void> {
  return breaker.__clearPersistedForTest();
}

/** Test-only: read the raw durable signal value. Production never calls this. */
export function __readPersistedSemrushAuthBreakerForTest(): Promise<string | null> {
  return breaker.__readPersistedForTest();
}

/** Test-only: await the fire-and-forget trip/reset persist landing. Production never calls this. */
export function __whenSemrushAuthBreakerPersistSettledForTest(): Promise<void> {
  return breaker.__whenPersistSettledForTest();
}

/** Test-only: synthesize breaker introspection fields. Production never calls this. */
export function __setSemrushAuthStateForTest(args: {
  lastTrippedAtMs?: number | null;
  lastTrippedCode?: string | null;
  lastSuccessAtMs?: number | null;
  breakerOpenUntilMs?: number;
  tripCount?: number;
}): void {
  breaker.__setStateForTest(args);
}
