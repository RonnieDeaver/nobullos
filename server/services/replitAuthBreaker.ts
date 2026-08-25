// Task #2663 — Replit Auth (OIDC) session-refresh auth-dead breaker.
//
// WHY THIS IS NOT THE SHARED `createAuthDeadBreaker` FACTORY
// ----------------------------------------------------------
// Front / Zoom / Google Ads / SEMrush each have ONE system-wide OAuth token,
// so their breaker is a process-global gate: trip it and EVERY call path backs
// off, which is correct because the single shared credential is dead.
//
// Replit Auth is fundamentally different: there is one rotating refresh-token
// family PER SESSION (per signed-in browser). A global gate would be a footgun
// — the moment ONE operator's session hit a terminal refresh, a global breaker
// would short-circuit token acquisition for EVERY operator and lock the whole
// company out. So this breaker is PER-SESSION: it records which session
// fingerprints have hit a terminal (rotated / revoked) refresh failure and
// short-circuits re-driving that session's doomed refresh POST for a cooldown
// window, while leaving every healthy session completely untouched.
//
// HOW IT PAIRS WITH `isAuthenticated`
// -----------------------------------
// On a terminal refresh `isAuthenticated` logs the session out and routes it to
// a clean re-authentication. This gate stops the in-flight requests of that
// SAME dead session (which still carry the poisoned `req.user` until the logout
// / session-row purge propagates, especially across autoscale instances) from
// re-POSTing the revoked token over and over — the "logged out every few
// minutes" symptom. A successful refresh for a session clears its gate entry.
//
// PERSISTENCE & ALERTING
// ----------------------
// The per-session gate is in-memory only (it is short-lived and bounded; the
// shared Postgres `sessions` table + clean re-auth are the cross-instance
// source of truth, not this gate). What IS persisted — into a single
// `system_settings` row — is the AGGREGATE telemetry (trip count, last terminal
// code, last success, and the current sustained-failure STREAK) so the operator
// alert watcher (`replitAuthBreakerStuckAlerts.ts`) survives restarts and is
// consistent across instances.
//
// STREAK SEMANTICS (drives "single alert per sustained streak")
// -------------------------------------------------------------
// A streak starts on the first terminal trip after a clean stretch and ENDS on
// the next successful refresh of ANY session. A lone poisoned session that is
// cleanly recovered (user re-logs-in → a healthy refresh lands) ends the streak
// quickly and never crosses the alert threshold — that is normal churn, not an
// outage. A genuinely stuck situation (e.g. the OIDC issuer rejecting refreshes
// for everyone, no successful refresh for the threshold window) keeps the streak
// alive past the threshold and fires exactly one alert.

import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

/** `system_settings` key the aggregate telemetry is mirrored into. */
export const REPLIT_AUTH_BREAKER_STATE_KEY = "replit_auth_breaker_state";

/**
 * How long a session fingerprint stays gated after a terminal refresh. Short
 * enough that a legitimately re-authenticated session is never held back, long
 * enough to absorb the in-flight burst of a poisoned session's parallel
 * requests across instances.
 */
const SESSION_DEAD_TTL_MS = 5 * 60 * 1000;

/**
 * Hard cap on tracked dead sessions. A pathological flood (every session
 * failing) must not grow this map unbounded; oldest entries are evicted first.
 * Eviction is safe — a re-driven dead session simply re-trips.
 */
const MAX_TRACKED_SESSIONS = 5000;

/** Throttle window for the single loud operator log line. */
const LOG_THROTTLE_MS = 5 * 60 * 1000;

interface DeadSessionEntry {
  deadUntilMs: number;
  code: string;
  trippedAtMs: number;
}

const deadSessions = new Map<string, DeadSessionEntry>();

// ── Aggregate telemetry (persisted for the alert watcher) ────────────────────
let tripCount = 0;
let lastTrippedAtMs: number | null = null;
let lastTrippedCode: string | null = null;
let lastSuccessAtMs: number | null = null;
// Non-null while a sustained-failure streak is open (set on the first trip
// after a clean stretch, cleared on the next successful refresh).
let streakStartedAtMs: number | null = null;

const lastLogAtByKey = new Map<string, number>();

// Durable persist writes are fired fire-and-forget from the synchronous
// trip / success entry points; serialize them so a success-clear can never
// commit before a preceding trip persist. Each op catches its own errors.
let pendingPersist: Promise<void> = Promise.resolve();
function enqueuePersist(op: () => Promise<void>): void {
  pendingPersist = pendingPersist.then(op, op);
}

export function shouldLogReplitAuth(
  key: string,
  intervalMs: number = LOG_THROTTLE_MS,
): boolean {
  const now = Date.now();
  const last = lastLogAtByKey.get(key) ?? 0;
  if (now - last > intervalMs) {
    lastLogAtByKey.set(key, now);
    return true;
  }
  return false;
}

/** Drop expired gate entries so `deadSessionCount` reflects live state. */
function pruneExpired(now: number): void {
  for (const [fp, entry] of deadSessions) {
    if (entry.deadUntilMs <= now) deadSessions.delete(fp);
  }
}

/**
 * True if this session fingerprint is currently gated (recently hit a terminal
 * refresh). Callers use this to skip re-driving the doomed refresh POST.
 */
export function isSessionRefreshDead(fingerprint: string): boolean {
  const entry = deadSessions.get(fingerprint);
  if (!entry) return false;
  if (entry.deadUntilMs <= Date.now()) {
    deadSessions.delete(fingerprint);
    return false;
  }
  return true;
}

/**
 * Record that this session's refresh terminally failed. Gates the session,
 * advances aggregate telemetry, opens a streak if none is active, emits one
 * throttled operator log line, and persists the aggregate.
 */
export function markSessionRefreshDead(fingerprint: string, code: string): void {
  const now = Date.now();
  pruneExpired(now);
  if (deadSessions.size >= MAX_TRACKED_SESSIONS && !deadSessions.has(fingerprint)) {
    // Evict the oldest entry (insertion order) to stay bounded.
    const oldest = deadSessions.keys().next().value;
    if (oldest !== undefined) deadSessions.delete(oldest);
  }
  deadSessions.set(fingerprint, {
    deadUntilMs: now + SESSION_DEAD_TTL_MS,
    code,
    trippedAtMs: now,
  });

  tripCount += 1;
  lastTrippedAtMs = now;
  lastTrippedCode = code;
  if (streakStartedAtMs === null) streakStartedAtMs = now;

  if (shouldLogReplitAuth("replit_auth_breaker_trip")) {
    console.error(
      `[ReplitAuthBreaker] Session refresh terminally failed (${code}). ` +
        `Routing the affected session to a clean sign-in and gating its doomed ` +
        `refresh for ${Math.round(SESSION_DEAD_TTL_MS / 60000)} min. ` +
        `deadSessions=${deadSessions.size}`,
    );
  }

  enqueuePersist(persistState);
}

/**
 * Record a successful refresh for this session. Clears its gate entry and ends
 * any open sustained-failure streak (the system is demonstrably refreshing).
 */
export function recordSessionRefreshSuccess(fingerprint: string): void {
  deadSessions.delete(fingerprint);
  lastSuccessAtMs = Date.now();
  if (streakStartedAtMs !== null) {
    streakStartedAtMs = null;
    enqueuePersist(persistState);
  }
}

export interface ReplitAuthBreakerState {
  /** At least one session is currently gated. */
  breakerOpen: boolean;
  deadSessionCount: number;
  tripCount: number;
  lastTrippedAt: string | null;
  lastTrippedCode: string | null;
  lastSuccessAt: string | null;
  /** ISO time the current sustained-failure streak began, or null. */
  streakStartedAt: string | null;
}

export function getReplitAuthBreakerState(): ReplitAuthBreakerState {
  pruneExpired(Date.now());
  return {
    breakerOpen: deadSessions.size > 0,
    deadSessionCount: deadSessions.size,
    tripCount,
    lastTrippedAt: lastTrippedAtMs ? new Date(lastTrippedAtMs).toISOString() : null,
    lastTrippedCode,
    lastSuccessAt: lastSuccessAtMs ? new Date(lastSuccessAtMs).toISOString() : null,
    streakStartedAt: streakStartedAtMs ? new Date(streakStartedAtMs).toISOString() : null,
  };
}

// ── Durable persistence (aggregate only) ─────────────────────────────────────

async function persistState(): Promise<void> {
  try {
    await setSystemSetting(
      REPLIT_AUTH_BREAKER_STATE_KEY,
      JSON.stringify({
        tripCount,
        trippedAtMs: lastTrippedAtMs,
        code: lastTrippedCode,
        successAtMs: lastSuccessAtMs,
        streakStartedAtMs,
      }),
      "system",
    );
  } catch (err: any) {
    if (shouldLogReplitAuth("replit_auth_breaker_persist_error")) {
      console.error("[ReplitAuthBreaker] persist failed:", err?.message ?? err);
    }
  }
}

/**
 * Reconcile the in-memory aggregate against the durable signal. Adopts a later
 * trip / a later success / a started streak from another instance so the alert
 * watcher converges. Read failure → no-op (in-memory stays authoritative).
 */
export async function reconcileReplitAuthBreakerFromStore(): Promise<void> {
  let raw: string | undefined;
  try {
    raw = (await getSystemSetting(REPLIT_AUTH_BREAKER_STATE_KEY))?.value ?? undefined;
  } catch {
    return;
  }
  if (!raw) return;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const pTrip = Number(parsed.trippedAtMs) || null;
  const pSuccess = Number(parsed.successAtMs) || null;
  const pTripCount = Number(parsed.tripCount) || 0;
  const pStreak = Number(parsed.streakStartedAtMs) || null;
  const pCode = typeof parsed.code === "string" ? parsed.code : null;

  if (pTrip && (!lastTrippedAtMs || pTrip > lastTrippedAtMs)) {
    lastTrippedAtMs = pTrip;
    lastTrippedCode = pCode ?? lastTrippedCode;
  }
  if (pSuccess && (!lastSuccessAtMs || pSuccess > lastSuccessAtMs)) {
    lastSuccessAtMs = pSuccess;
  }
  if (pTripCount > tripCount) tripCount = pTripCount;

  // A later success ends a streak; otherwise adopt the earliest open streak so
  // the threshold clock reflects how long the issue has truly persisted.
  if (lastSuccessAtMs && pStreak && lastSuccessAtMs > pStreak) {
    streakStartedAtMs = null;
  } else if (pStreak && (streakStartedAtMs === null || pStreak < streakStartedAtMs)) {
    streakStartedAtMs = pStreak;
  }
}

/** Boot hydration — restore aggregate telemetry after a restart. */
export async function hydrateReplitAuthBreakerFromStore(): Promise<{ breakerOpen: boolean }> {
  await reconcileReplitAuthBreakerFromStore();
  return { breakerOpen: deadSessions.size > 0 };
}

// ── Test-only helpers. Production never calls these. ─────────────────────────

export function __resetReplitAuthBreakerForTest(): void {
  deadSessions.clear();
  tripCount = 0;
  lastTrippedAtMs = null;
  lastTrippedCode = null;
  lastSuccessAtMs = null;
  streakStartedAtMs = null;
  lastLogAtByKey.clear();
}

export async function __whenReplitAuthBreakerPersistSettledForTest(): Promise<void> {
  await pendingPersist.catch(() => {});
}

export async function __clearPersistedReplitAuthBreakerForTest(): Promise<void> {
  try {
    await setSystemSetting(REPLIT_AUTH_BREAKER_STATE_KEY, "", "system");
  } catch {
    /* best effort */
  }
}

export function __setReplitAuthBreakerStateForTest(args: {
  tripCount?: number;
  lastTrippedAtMs?: number | null;
  lastTrippedCode?: string | null;
  lastSuccessAtMs?: number | null;
  streakStartedAtMs?: number | null;
}): void {
  if (args.tripCount !== undefined) tripCount = args.tripCount;
  if (args.lastTrippedAtMs !== undefined) lastTrippedAtMs = args.lastTrippedAtMs;
  if (args.lastTrippedCode !== undefined) lastTrippedCode = args.lastTrippedCode;
  if (args.lastSuccessAtMs !== undefined) lastSuccessAtMs = args.lastSuccessAtMs;
  if (args.streakStartedAtMs !== undefined) streakStartedAtMs = args.streakStartedAtMs;
}
