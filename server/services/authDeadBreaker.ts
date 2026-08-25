// Task #2137 — shared auth-dead circuit-breaker factory.
//
// `frontAuthBreaker.ts` and `semrushAuthBreaker.ts` were near-identical
// copies (googleAdsAuthBreaker.ts too, until Task #4008 retired the
// platform Google Ads connection) of the same
// process-global in-memory gate: a 5-minute cooldown that trips on
// terminal OAuth auth failures and short-circuits subsequent token
// acquisition so a dead refresh token stops flooding the logs. They
// differed only in the integration name, the terminal-code set, the log
// strings, and (for Front) an optional durable-signal layer (Task #2103).
//
// `createAuthDeadBreaker` produces one such breaker. Each integration
// module is now a thin wrapper that calls this factory and re-exports the
// pieces it needs under its historic names, so behavior is unchanged.
//
// The breaker is a process-global in-memory gate. It trips on terminal
// auth errors and short-circuits subsequent token acquisition for
// `cooldownMs` (default 5 min). During the cooldown:
//   - the integration's token accessor throws immediately (no network) so
//     every call path backs off instead of re-driving the refresh POST.
//   - the Integrations-Hub probe (`probeConnection`) bypasses the breaker
//     so a genuine operator reconnect clears the UI on the next poll.
//   - one throttled `console.error` is emitted per cooldown window so the
//     operator sees a single loud line, not thousands of stack traces.
// A successful refresh / operator reconnect immediately resets the
// breaker, so recovery needs no restart.

export interface AuthBreakerState {
  authBroken: boolean;
  errorCode: string | null;
  cooldownRemainingMs: number;
  breakerOpen: boolean;
  openedUntil: string | null;
  lastTrippedAt: string | null;
  lastTrippedCode: string | null;
  lastSuccessAt: string | null;
  tripCount: number;
}

/** Optional durable-signal layer (Task #2103 — Front only today). */
export interface AuthBreakerPersistenceConfig {
  /** `system_settings` key the trip state is mirrored into. */
  stateKey: string;
  getSystemSetting: (
    key: string,
  ) => Promise<{ value: string | null } | null | undefined>;
  setSystemSetting: (
    key: string,
    value: string,
    updatedBy?: string,
  ) => Promise<unknown>;
  /**
   * A fresh local trip persists asynchronously. Protect it from being
   * cleared by a store read that raced ahead of its own persist write:
   * never let a store-cleared reconcile wipe a breaker tripped within
   * this grace window. Defaults to 15s.
   */
  localTripGraceMs?: number;
}

export interface AuthDeadBreakerConfig {
  /** Console log prefix, e.g. `[Front]`. */
  logPrefix: string;
  /** Noun in "Suppressing {apiNoun} API calls", e.g. `Front`, `Google Ads`, `SEMrush`. */
  apiNoun: string;
  /** Label in "{breakerLabel} auth breaker open", e.g. `Front`, `Google Ads`, `Semrush`. */
  breakerLabel: string;
  /** Operator remediation sentence, e.g. `reconnect Front in Settings → Integrations.`. */
  operatorAction: string;
  /** Fallback code used in the error message when none is recorded. */
  defaultCode: string;
  /** Terminal (non-retryable) auth failure codes that trip the breaker. */
  terminalCodes: Set<string>;
  /** Cooldown window. Defaults to 5 minutes. */
  cooldownMs?: number;
  /** Optional durable-signal layer. */
  persistence?: AuthBreakerPersistenceConfig;
}

export interface AuthDeadBreaker {
  isTerminalCode(code: string | null | undefined): boolean;
  active(): boolean;
  trip(errorCode: string): void;
  recordSuccess(): void;
  reset(): void;
  error(): Error;
  getState(): AuthBreakerState;
  /**
   * Returns true at most once per `intervalMs` (default = the cooldown
   * window) for the given key. Used to throttle high-frequency auth log
   * lines so a credential flood collapses to one line per key per window.
   */
  shouldLog(key: string, intervalMs?: number): boolean;
  // ── Durable-signal layer (no-ops when persistence is not configured) ──
  reconcileFromStore(): Promise<void>;
  hydrateFromStore(): Promise<{ breakerOpen: boolean }>;
  // ── Test-only helpers. Production never calls these. ──
  __resetForTest(): void;
  __clearPersistedForTest(): Promise<void>;
  __readPersistedForTest(): Promise<string | null>;
  /**
   * Test-only: resolve once every persist/clear write queued by `trip` /
   * `reset` so far has settled (DB write + cache invalidation done). The
   * trip/reset entry points are synchronous and fire the durable write
   * fire-and-forget, so tests would otherwise have to guess a timeout
   * before reading the store back — which flakes under shared-dev-DB
   * contention. Awaiting this removes the guess entirely.
   */
  __whenPersistSettledForTest(): Promise<void>;
  __setStateForTest(args: {
    lastTrippedAtMs?: number | null;
    lastTrippedCode?: string | null;
    lastSuccessAtMs?: number | null;
    breakerOpenUntilMs?: number;
    tripCount?: number;
  }): void;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_LOCAL_TRIP_GRACE_MS = 15 * 1000;

export function createAuthDeadBreaker(config: AuthDeadBreakerConfig): AuthDeadBreaker {
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const persistence = config.persistence;
  const localTripGraceMs = persistence?.localTripGraceMs ?? DEFAULT_LOCAL_TRIP_GRACE_MS;

  let authBrokenUntilMs = 0;
  let lastAuthErrorCode: string | null = null;
  let lastAuthBreakerLogAt = 0;
  let lastTrippedAtMs: number | null = null;
  let lastTrippedCodeSticky: string | null = null;
  let lastSuccessAtMs: number | null = null;
  let tripCount = 0;

  // Durable persist/clear writes are fired fire-and-forget from the
  // synchronous `trip` / `reset` entry points. Serialize them through a
  // single tail promise so (a) a `reset` clear can never commit before a
  // preceding `trip` persist (which would leave the store "open" while
  // memory is reset → a false reopen on the next reconcile), and (b)
  // tests can deterministically await the write landing instead of
  // guessing a timeout. Each op already catches its own errors, so the
  // chain never rejects.
  let pendingPersist: Promise<void> = Promise.resolve();
  function enqueuePersist(op: () => Promise<void>): void {
    pendingPersist = pendingPersist.then(op, op);
  }

  // Generic throttle table so individual auth-related log lines can be
  // capped to one emission per window, keyed by an arbitrary string.
  const lastLogAtByKey = new Map<string, number>();

  function shouldLog(key: string, intervalMs: number = cooldownMs): boolean {
    const now = Date.now();
    const last = lastLogAtByKey.get(key) ?? 0;
    if (now - last > intervalMs) {
      lastLogAtByKey.set(key, now);
      return true;
    }
    return false;
  }

  function isTerminalCode(code: string | null | undefined): boolean {
    return !!code && config.terminalCodes.has(code);
  }

  function active(): boolean {
    return Date.now() < authBrokenUntilMs;
  }

  function trip(errorCode: string): void {
    const now = Date.now();
    authBrokenUntilMs = now + cooldownMs;
    lastAuthErrorCode = errorCode;
    lastTrippedAtMs = now;
    lastTrippedCodeSticky = errorCode;
    tripCount += 1;
    if (now - lastAuthBreakerLogAt > cooldownMs) {
      lastAuthBreakerLogAt = now;
      console.error(
        `${config.logPrefix} Auth breaker tripped (${errorCode}). Suppressing ${config.apiNoun} API calls for ${Math.round(
          cooldownMs / 60000,
        )} min. Operator action required: ${config.operatorAction}`,
      );
    }
    // Persist the trip so the badge + suppression survive a restart and
    // are consistent across autoscale instances. Fire-and-forget (queued):
    // a DB / cache hiccup must never break the synchronous
    // token-acquisition catch path that calls this.
    if (persistence) enqueuePersist(persistBreakerState);
  }

  function recordSuccess(): void {
    lastSuccessAtMs = Date.now();
  }

  /** Clear only the in-memory breaker (no durable write). */
  function resetInMemoryBreaker(): void {
    authBrokenUntilMs = 0;
    lastAuthErrorCode = null;
  }

  function reset(): void {
    resetInMemoryBreaker();
    // Clear the durable signal so a reconnect / successful probe on ANY
    // instance flips every instance's badge back to connected on the next
    // poll. Queued behind any in-flight trip persist for the same reason.
    if (persistence) enqueuePersist(clearPersistedBreakerState);
  }

  function error(): Error {
    const remainingMs = Math.max(0, authBrokenUntilMs - Date.now());
    return new Error(
      `${config.breakerLabel} auth breaker open (${lastAuthErrorCode || config.defaultCode}), retry in ${Math.ceil(
        remainingMs / 1000,
      )}s — ${config.operatorAction}`,
    );
  }

  function getState(): AuthBreakerState {
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

  // ── Durable persistence helpers (Task #2103) ─────────────────────────

  async function persistBreakerState(): Promise<void> {
    if (!persistence) return;
    try {
      await persistence.setSystemSetting(
        persistence.stateKey,
        JSON.stringify({
          code: lastAuthErrorCode,
          openedUntilMs: authBrokenUntilMs,
          trippedAtMs: lastTrippedAtMs,
          tripCount,
        }),
        "system",
      );
    } catch (err: any) {
      if (shouldLog("auth_breaker_persist_error")) {
        console.error(`${config.logPrefix} Auth breaker persist failed:`, err?.message ?? err);
      }
    }
  }

  async function clearPersistedBreakerState(): Promise<void> {
    if (!persistence) return;
    try {
      await persistence.setSystemSetting(persistence.stateKey, "", "system");
    } catch (err: any) {
      if (shouldLog("auth_breaker_clear_error")) {
        console.error(`${config.logPrefix} Auth breaker clear failed:`, err?.message ?? err);
      }
    }
  }

  /**
   * Reconcile the in-memory breaker against the durable `system_settings`
   * signal. Called once at boot (re-hydrate after a restart) and on every
   * Integrations-Hub status poll (so the badge reflects a trip / reconnect
   * that happened on another instance). Read-through cached, so the poll
   * is cheap.
   *
   * Rules:
   *  - Store read fails → no-op; the in-memory state stays authoritative.
   *  - Store has an open window later than ours → adopt it (cross-instance
   *    trip propagation + post-restart restore).
   *  - Store says "not open" → mirror that locally so the badge clears —
   *    UNLESS we just tripped locally and our own persist write may not
   *    have landed yet.
   */
  async function reconcileFromStore(): Promise<void> {
    if (!persistence) return;
    let raw: string | undefined;
    try {
      raw = (await persistence.getSystemSetting(persistence.stateKey))?.value ?? undefined;
    } catch {
      return;
    }

    const now = Date.now();
    let persistedOpenUntil = 0;
    let persistedCode: string | null = null;
    let persistedTrippedAt: number | null = null;
    let persistedTripCount = 0;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        persistedOpenUntil = Number(parsed.openedUntilMs) || 0;
        persistedCode = typeof parsed.code === "string" ? parsed.code : null;
        persistedTrippedAt = Number(parsed.trippedAtMs) || null;
        persistedTripCount = Number(parsed.tripCount) || 0;
      } catch {
        // malformed row — treat as "no persisted signal"
      }
    }

    if (persistedOpenUntil > now) {
      if (persistedOpenUntil > authBrokenUntilMs) {
        authBrokenUntilMs = persistedOpenUntil;
        lastAuthErrorCode = persistedCode;
        if (persistedTrippedAt) lastTrippedAtMs = persistedTrippedAt;
        lastTrippedCodeSticky = persistedCode ?? lastTrippedCodeSticky;
        if (persistedTripCount > tripCount) tripCount = persistedTripCount;
      }
      return;
    }

    // Store is not open. Clear locally so the badge converges across
    // instances, but never wipe a brand-new local trip whose persist may
    // still be in flight.
    if (authBrokenUntilMs > now) {
      if (lastTrippedAtMs && now - lastTrippedAtMs < localTripGraceMs) {
        return;
      }
      resetInMemoryBreaker();
    }
  }

  /**
   * Boot hydration. Re-hydrates the in-memory breaker from the durable
   * signal so the badge + suppression survive a restart. Thin wrapper over
   * the reconcile so there is a single source of truth for the merge
   * rules; returns the resulting open state for the startup log line.
   */
  async function hydrateFromStore(): Promise<{ breakerOpen: boolean }> {
    await reconcileFromStore();
    return { breakerOpen: active() };
  }

  // ── Test-only helpers ────────────────────────────────────────────────

  function __resetForTest(): void {
    reset();
    lastAuthBreakerLogAt = 0;
    lastTrippedAtMs = null;
    lastTrippedCodeSticky = null;
    lastSuccessAtMs = null;
    tripCount = 0;
    lastLogAtByKey.clear();
  }

  async function __clearPersistedForTest(): Promise<void> {
    await clearPersistedBreakerState();
  }

  async function __readPersistedForTest(): Promise<string | null> {
    if (!persistence) return null;
    const row = await persistence.getSystemSetting(persistence.stateKey).catch(() => null);
    return row ? row.value ?? null : null;
  }

  async function __whenPersistSettledForTest(): Promise<void> {
    // The queue never rejects (each op catches internally), but guard
    // anyway so a future op that throws can't reject this awaiter.
    await pendingPersist.catch(() => {});
  }

  function __setStateForTest(args: {
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

  return {
    isTerminalCode,
    active,
    trip,
    recordSuccess,
    reset,
    error,
    getState,
    shouldLog,
    reconcileFromStore,
    hydrateFromStore,
    __resetForTest,
    __clearPersistedForTest,
    __readPersistedForTest,
    __whenPersistSettledForTest,
    __setStateForTest,
  };
}
