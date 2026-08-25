// Task #2100 — Front auth-dead circuit breaker.
//
// Thin wrapper over the shared `createAuthDeadBreaker` factory
// (`authDeadBreaker.ts`, Task #2137). When Front's OAuth refresh token is
// terminally rejected (`invalid_grant` / `invalid_token`, surfaced here as
// `front_refresh_failed_permanent` / `front_no_refresh_token` /
// `front_not_connected`), nothing the code can do will fix it — the
// operator must reconnect Front. Per Front's OAuth docs (POST
// https://app.frontapp.com/oauth/token, HTTP Basic client_id:client_secret;
// refresh tokens roll on a 6-month window and a revoked token returns 4xx
// `invalid_grant`), retrying a revoked token is pure noise. Without a global
// backoff every Front surface (live sync, webhook apply, historical
// recovery, analytics refresh, the auto-closure self-heal loop) keeps
// hammering the token endpoint and the `/me` 401-refresh path, producing
// thousands of error log lines.
//
// The breaker is a process-global in-memory gate. It trips on terminal
// Front auth errors and short-circuits subsequent token acquisition for the
// cooldown window (default 5 min). During the cooldown:
//   - `getValidFrontAccessToken` throws immediately (no network) so every
//     Front call path backs off instead of re-driving the refresh POST.
//   - The Integrations-Hub probe (`probeConnection`) bypasses the breaker
//     so a genuine operator reconnect clears the UI on the next poll.
//   - The auto-closure self-heal loop sees `breakerOpen` and skips its
//     tick (`front_auth_dead`) instead of enqueuing recovery / apply work.
//   - One throttled `console.error` is emitted per cooldown window so the
//     operator sees a single loud line, not thousands of stack traces.
// `storeTokens` (operator reconnect OR a successful background refresh)
// and a successful `/me` probe immediately reset the breaker, so recovery
// needs no restart.
//
// Task #2103 — durable breaker signal. The in-memory breaker is
// per-process and resets on restart, so on autoscale the "Front
// disconnected — reconnect required" badge could vanish after a deploy /
// restart and be inconsistent across instances. The trip state (code +
// cooldown-until) is mirrored into a single `system_settings` row so it
// survives restarts and is consistent across instances. The hot
// token-acquisition path (`frontAuthBreakerActive`) stays purely in-memory
// for speed; boot hydration restores it after a restart and each instance
// re-trips itself on the first dead refresh, so suppression converges
// within the cooldown window without a per-call DB read.

import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { createAuthDeadBreaker } from "./authDeadBreaker";

// Terminal Front auth failure codes (subset of `FrontAuthErrorCode`).
// `front_refresh_failed_transient` is deliberately excluded — 5xx /
// network refresh failures are retryable and must NOT trip the breaker.
export const TERMINAL_FRONT_AUTH_CODES = new Set<string>([
  "front_not_connected",
  "front_no_refresh_token",
  "front_refresh_failed_permanent",
]);

const breaker = createAuthDeadBreaker({
  logPrefix: "[Front]",
  apiNoun: "Front",
  breakerLabel: "Front",
  operatorAction: "reconnect Front in Settings → Integrations.",
  defaultCode: "front_not_connected",
  terminalCodes: TERMINAL_FRONT_AUTH_CODES,
  persistence: {
    stateKey: "front_auth_breaker_state",
    getSystemSetting,
    setSystemSetting,
  },
});

export function isFrontAuthTerminalCode(code: string | null | undefined): boolean {
  return breaker.isTerminalCode(code);
}

export function frontAuthBreakerActive(): boolean {
  return breaker.active();
}

export function tripFrontAuthBreaker(errorCode: string): void {
  breaker.trip(errorCode);
}

export function recordFrontCallSuccess(): void {
  breaker.recordSuccess();
}

export function resetFrontAuthBreaker(): void {
  breaker.reset();
}

export function reconcileFrontAuthBreakerFromStore(): Promise<void> {
  return breaker.reconcileFromStore();
}

export function hydrateFrontAuthBreakerFromStore(): Promise<{ breakerOpen: boolean }> {
  return breaker.hydrateFromStore();
}

export function frontAuthBreakerError(): Error {
  return breaker.error();
}

/**
 * Returns true at most once per `intervalMs` (default = the breaker
 * window) for the given key. Used to throttle high-frequency auth log
 * lines so a credential flood collapses to one line per key per window.
 */
export function shouldLogFrontAuth(key: string, intervalMs?: number): boolean {
  return breaker.shouldLog(key, intervalMs);
}

/**
 * Inspect the in-memory Front auth-breaker state. Used by the
 * Integrations-Hub status route (render "Front disconnected — reconnect
 * required") and the auto-closure self-heal gate.
 */
export function getFrontAuthState() {
  return breaker.getState();
}

/** Test-only: clear the breaker between cases. Production never calls this. */
export function __resetFrontAuthBreakerForTest(): void {
  breaker.__resetForTest();
}

/** Test-only: await the durable signal being cleared. Production never calls this. */
export function __clearPersistedFrontAuthBreakerForTest(): Promise<void> {
  return breaker.__clearPersistedForTest();
}

/** Test-only: read the raw durable signal value. Production never calls this. */
export function __readPersistedFrontAuthBreakerForTest(): Promise<string | null> {
  return breaker.__readPersistedForTest();
}

/** Test-only: await the fire-and-forget trip/reset persist landing. Production never calls this. */
export function __whenFrontAuthBreakerPersistSettledForTest(): Promise<void> {
  return breaker.__whenPersistSettledForTest();
}

/** Test-only: synthesize breaker introspection fields. Production never calls this. */
export function __setFrontAuthStateForTest(args: {
  lastTrippedAtMs?: number | null;
  lastTrippedCode?: string | null;
  lastSuccessAtMs?: number | null;
  breakerOpenUntilMs?: number;
  tripCount?: number;
}): void {
  breaker.__setStateForTest(args);
}
