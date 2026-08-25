/**
 * Task #4791 — connection-lost → reconnecting → recovered lifecycle.
 *
 * Incident: a fetch that dies with NO HTTP response (browser network layer —
 * "Failed to fetch" / "NetworkError" / "Load failed") used to fire a
 * fire-and-forget destructive toast that outlived the blip (~17 min
 * TOAST_REMOVE_DELAY) while the errored queries stayed errored until a manual
 * reload. This module owns the global connectivity state machine instead:
 *
 *   ok ── network/offline-class failure ──▶ lost (probing with backoff)
 *   lost ── probe success | any successful request | browser "online" ──▶ recovered
 *   recovered ── confirmation delay ──▶ ok        (or straight back to lost)
 *
 * Feeding it: the shared query/mutation cache error handlers in
 * ./queryClient.ts report ONLY the `network`/`offline` failure classes here
 * (every other class keeps its existing toast behavior).
 *
 * Probe discipline (outage-window-only — an always-on keep-alive would be new
 * always-on server load and is deliberately NOT built):
 *   - Runs ONLY while phase === "lost"; stops on the first success.
 *   - Target is a HEAD of the SPA shell ("/"): unauthenticated, outside the
 *     /api rate-limiter mounts, zero dependency work server-side.
 *   - ANY HTTP response — including a 503 from the boot gate — proves the
 *     server is reachable; only a rejected fetch keeps the outage window open.
 *   - Backoff modeled on the shared SSE reconnect policy (sseReconnect.ts):
 *     quick first probe, then 5 s → 10 s → … capped at 120 s, ±20 % jitter so
 *     many clients never reconnect in lockstep.
 *   - The probe NEVER touches credentials, token refresh, or breakers — it
 *     observes reachability and nothing else.
 *
 * Recovery side effects (once per recovery):
 *   - Actively-observed queries currently in `error` state are refetched
 *     (meta.silent ones included) so pages heal without a reload. Paused /
 *     inactive queries are left alone; mutations are NEVER auto-retried
 *     (a retried write can double a side effect).
 *
 * The UI surface is components/ConnectionStatusBanner.tsx (subscribed via
 * useSyncExternalStore) — deliberately not a toast: TOAST_LIMIT is 1, so any
 * later toast would evict a "persistent" connection toast.
 *
 * Leaf module: imports nothing from queryClient.ts (which imports us); the
 * query client arrives via bindQueryClient() after construction.
 */
import type { QueryClient } from "@tanstack/react-query";

export type ConnectionLossCause = "network" | "offline";
export type ConnectionPhase = "ok" | "lost" | "recovered";
export type ConnectionRecoveryTrigger = "probe" | "request" | "online";

export interface ConnectionLostState {
  phase: ConnectionPhase;
  /** Failure class that opened (or updated) the outage window; null when ok/recovered. */
  cause: ConnectionLossCause | null;
  /** Completed (failed) probe attempts in the current outage window. */
  probeAttempts: number;
}

export const CONNECTION_PROBE_PATH = "/";
/** First probe fires quickly so a short blip clears in seconds. */
export const CONNECTION_PROBE_INITIAL_DELAY_MS = 2_000;
export const CONNECTION_PROBE_BACKOFF_BASE_MS = 5_000;
export const CONNECTION_PROBE_BACKOFF_MAX_MS = 120_000;
export const CONNECTION_PROBE_JITTER_RATIO = 0.2;
/** How long the "Connection restored" confirmation stays before clearing. */
export const CONNECTION_RECOVERED_CONFIRMATION_MS = 4_000;

/**
 * Delay before the next probe. Attempt 0 (right after entering lost) is the
 * quick initial delay; subsequent attempts follow the SSE-style exponential
 * schedule capped at CONNECTION_PROBE_BACKOFF_MAX_MS. Jitter is uniform in
 * [1 − r, 1 + r] like sseReconnect.ts so parallel tabs spread out.
 */
export function nextConnectionProbeDelayMs(
  completedProbeAttempts: number,
  random: () => number = Math.random,
): number {
  const base =
    completedProbeAttempts <= 0
      ? CONNECTION_PROBE_INITIAL_DELAY_MS
      : Math.min(
          CONNECTION_PROBE_BACKOFF_BASE_MS * 2 ** (completedProbeAttempts - 1),
          CONNECTION_PROBE_BACKOFF_MAX_MS,
        );
  const factor =
    1 - CONNECTION_PROBE_JITTER_RATIO + random() * CONNECTION_PROBE_JITTER_RATIO * 2;
  return Math.round(base * factor);
}

interface ConnectionTrackerDeps {
  schedule: (fn: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  /** Resolves on ANY HTTP response (status irrelevant); rejects when unreachable. */
  probe: () => Promise<unknown>;
  random: () => number;
}

export interface ConnectionLostTracker {
  getState: () => ConnectionLostState;
  subscribe: (listener: () => void) => () => void;
  /** Called by the cache error handlers for network/offline failure classes. */
  reportConnectionLost: (cause: ConnectionLossCause) => void;
  /** Any proof of reachability: probe success, successful request, "online". */
  reportServerReachable: (trigger: ConnectionRecoveryTrigger) => void;
  /** Late-bound to avoid a queryClient ↔ tracker import cycle. */
  bindQueryClient: (client: Pick<QueryClient, "refetchQueries">) => void;
  /** Test seam: cancel timers and return to ok (keeps bindings/listeners). */
  reset: () => void;
}

const OK_STATE: ConnectionLostState = Object.freeze({
  phase: "ok",
  cause: null,
  probeAttempts: 0,
});

export function createConnectionLostTracker(
  overrides: Partial<ConnectionTrackerDeps> = {},
): ConnectionLostTracker {
  const deps: ConnectionTrackerDeps = {
    schedule: (fn, delayMs) => {
      const handle: unknown = setTimeout(fn, delayMs);
      // In node-based test realms an outstanding probe timer must never hold
      // the process open; browser timers are numbers and skip this.
      if (handle && typeof (handle as { unref?: unknown }).unref === "function") {
        (handle as { unref: () => void }).unref();
      }
      return handle;
    },
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    probe: () =>
      fetch(CONNECTION_PROBE_PATH, {
        method: "HEAD",
        // A cached response would fake reachability — always hit the network.
        cache: "no-store",
        credentials: "same-origin",
      }),
    random: Math.random,
    ...overrides,
  };

  let state: ConnectionLostState = OK_STATE;
  const listeners = new Set<() => void>();
  let probeTimer: unknown = null;
  let recoveredTimer: unknown = null;
  let probeInFlight = false;
  let boundClient: Pick<QueryClient, "refetchQueries"> | null = null;

  function setState(next: ConnectionLostState): void {
    state = next;
    for (const listener of Array.from(listeners)) listener();
  }

  function clearProbeTimer(): void {
    if (probeTimer !== null) {
      deps.cancel(probeTimer);
      probeTimer = null;
    }
  }

  function clearRecoveredTimer(): void {
    if (recoveredTimer !== null) {
      deps.cancel(recoveredTimer);
      recoveredTimer = null;
    }
  }

  function scheduleProbe(): void {
    clearProbeTimer();
    const delayMs = nextConnectionProbeDelayMs(state.probeAttempts, deps.random);
    probeTimer = deps.schedule(() => {
      probeTimer = null;
      // Fire-and-forget: runProbe handles both outcomes internally.
      void runProbe();
    }, delayMs);
  }

  async function runProbe(): Promise<void> {
    if (state.phase !== "lost" || probeInFlight) return;
    probeInFlight = true;
    try {
      await deps.probe();
      probeInFlight = false;
      reportServerReachable("probe");
    } catch {
      probeInFlight = false;
      if (state.phase !== "lost") return; // recovered via another trigger meanwhile
      setState({ ...state, probeAttempts: state.probeAttempts + 1 });
      scheduleProbe();
    }
  }

  function reportConnectionLost(cause: ConnectionLossCause): void {
    if (state.phase === "lost") {
      // Already tracking the outage — at most refresh the cause copy.
      if (state.cause !== cause) setState({ ...state, cause });
      return;
    }
    clearRecoveredTimer();
    setState({ phase: "lost", cause, probeAttempts: 0 });
    scheduleProbe();
  }

  function reportServerReachable(trigger: ConnectionRecoveryTrigger): void {
    if (state.phase !== "lost") return;
    clearProbeTimer();
    setState({ phase: "recovered", cause: null, probeAttempts: 0 });
    recoveredTimer = deps.schedule(() => {
      recoveredTimer = null;
      if (state.phase === "recovered") setState(OK_STATE);
    }, CONNECTION_RECOVERED_CONFIRMATION_MS);
    // Heal the pages: refetch actively-observed queries stuck in error state
    // (meta.silent included — the predicate is deliberately status-only).
    // Paused/inactive queries and mutations are untouched. Refetch failures
    // re-enter through the cache onError path, so rejection needs no handling
    // here. Every trigger kind ("probe" | "request" | "online") heals alike.
    if (boundClient) {
      // Fire-and-forget: refetch outcomes land in the query cache itself.
      void boundClient
        .refetchQueries({
          type: "active",
          predicate: (query) => query.state.status === "error",
        })
        .catch(() => {
          // Individual refetch failures already surfaced via the cache.
        });
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportConnectionLost,
    reportServerReachable,
    bindQueryClient: (client) => {
      boundClient = client;
    },
    reset: () => {
      clearProbeTimer();
      clearRecoveredTimer();
      probeInFlight = false;
      if (state !== OK_STATE) setState(OK_STATE);
    },
  };
}

/** App-wide singleton driven by queryClient.ts and the status banner. */
export const connectionLostTracker = createConnectionLostTracker();

let windowListenersInstalled = false;

/**
 * One-time wiring called from queryClient.ts after the client is constructed:
 * binds the refetch target and installs the browser online/offline listeners.
 * Safe in non-browser realms (pure-node tests) — listeners are skipped.
 */
export function bindConnectionLostQueryClient(
  client: Pick<QueryClient, "refetchQueries">,
): void {
  connectionLostTracker.bindQueryClient(client);
  if (windowListenersInstalled || typeof window === "undefined") return;
  windowListenersInstalled = true;
  // "online" means the network interface is back — treat it as recovery; if
  // the server is still unreachable the very next failed request re-enters
  // the lost state (and the probe loop) on its own.
  window.addEventListener("online", () => {
    connectionLostTracker.reportServerReachable("online");
  });
  // While lost, going fully offline only upgrades the banner copy.
  window.addEventListener("offline", () => {
    const current = connectionLostTracker.getState();
    if (current.phase === "lost" && current.cause !== "offline") {
      connectionLostTracker.reportConnectionLost("offline");
    }
  });
}

export function reportConnectionLost(cause: ConnectionLossCause): void {
  connectionLostTracker.reportConnectionLost(cause);
}

export function reportServerReachable(trigger: ConnectionRecoveryTrigger): void {
  connectionLostTracker.reportServerReachable(trigger);
}

/** Test seam — cancels outstanding probe/confirmation timers, back to ok. */
export function __test_resetConnectionLostTracker(): void {
  connectionLostTracker.reset();
}

// Register the reset in the between-suite module-state-reset registry
// (see server/services/moduleStateReset.ts — keep the global name and
// Map<string, () => void> shape in sync with that file and with
// tests/run-all-worker.mjs `restoreSharedGlobals()`).
// Inlined here rather than imported because this is a client leaf module
// and importing from server/ would introduce a cross-boundary cycle.
// No-op outside NODE_ENV=test so production code paths carry zero cost.
if (process.env.NODE_ENV === "test") {
  const _g = globalThis as Record<string, unknown>;
  const _REGISTRY_KEY = "__runAllModuleStateResets";
  let _reg = _g[_REGISTRY_KEY] as Map<string, () => void> | undefined;
  if (!(_reg instanceof Map)) {
    _reg = new Map();
    _g[_REGISTRY_KEY] = _reg;
  }
  _reg.set("connectionLostTracker", __test_resetConnectionLostTracker);
}
