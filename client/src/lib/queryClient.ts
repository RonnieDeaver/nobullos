import { QueryClient, QueryFunction, QueryCache, MutationCache } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { parseGoogleAdsDisconnectedError } from "@shared/googleAdsDisconnect";
import { parseIntegrationStatusUnknownError } from "@shared/integrationStatusUnknown";
import { classifyQueryFailure, humanizeQueryError } from "./queryErrorCopy";
import {
  bindConnectionLostQueryClient,
  reportConnectionLost,
  reportServerReachable,
} from "./connectionLost";

export const CLIENT_PRIMARY_QUERY_MAX_CONCURRENCY = 4;
export const CLIENT_DEFERRED_QUERY_MAX_CONCURRENCY = 2;
export const CLIENT_HEAVY_QUERY_STALE_TIME_MS = 60_000;
export const CLIENT_DEFERRED_QUERY_STEP_DELAY_MS = 300;

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export const primaryQuerySemaphore = new Semaphore(CLIENT_PRIMARY_QUERY_MAX_CONCURRENCY);
export const deferredQuerySemaphore = new Semaphore(CLIENT_DEFERRED_QUERY_MAX_CONCURRENCY);

export async function throttledFetch(
  url: string,
  init: RequestInit,
  semaphore: Semaphore,
): Promise<Response> {
  await semaphore.acquire();
  try {
    return await fetch(url, init);
  } finally {
    semaphore.release();
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

/** How long to wait between boot-503 retry attempts (ms). */
const BOOT_503_RETRY_DELAY_MS = 3_000;
/** Maximum number of silent retries for a boot-503 gate response. */
const BOOT_503_MAX_RETRIES = 10;

async function isBoot503(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const clone = res.clone();
    const body = await clone.json();
    return body?.code === "BOOT_503";
  } catch {
    return false;
  }
}

/**
 * Task #3964 (F-QK) — dev-only query-key shape guard.
 *
 * The default query function builds its request URL as `queryKey.join("/")`,
 * so the repository convention for default-queryFn keys is: ordered URL
 * fragments — a leading absolute path string, optional scalar segments, and
 * optionally a query string ("?…") carried in a segment. Nothing validated
 * that at runtime, so a key like `["/api/clients", undefined]` silently
 * fetched `/api/clients/undefined` (real bug class: mystery 404s and
 * accidental cache aliasing). Keys with a custom `queryFn` never reach this
 * guard — it runs inside the default queryFn only, and only for queries that
 * actually execute (a query gated off by `enabled:` is never validated).
 *
 * Dev-only by construction: the call is gated on `import.meta.env.DEV`, which
 * Vite statically replaces with `false` in production builds, so the branch
 * is compiled out — zero production overhead. Under Node (tests/tsx) where
 * `import.meta.env` is undefined, it falls back to NODE_ENV !== "production".
 */
export const QUERY_KEY_SHAPE_GUARD_ENABLED: boolean =
  typeof import.meta.env !== "undefined"
    ? import.meta.env.DEV === true
    : typeof process !== "undefined" && process.env.NODE_ENV !== "production";

/**
 * Returns a human-readable problem description when `queryKey` does not fit
 * the default-queryFn URL-fragment shape, or null when the key is valid.
 * Pure — exported for unit tests.
 */
export function validateApiQueryKeyShape(queryKey: readonly unknown[]): string | null {
  if (queryKey.length === 0) return "query key is empty";
  for (let i = 0; i < queryKey.length; i++) {
    const entry = queryKey[i];
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        return `entry ${i} is a non-finite number (${String(entry)})`;
      }
      continue;
    }
    if (typeof entry !== "string") {
      const kind =
        entry === null ? "null" : Array.isArray(entry) ? "an array" : `of type ${typeof entry}`;
      return `entry ${i} is ${kind} — default-queryFn keys may contain only strings and finite numbers (they are joined with "/" into the request URL)`;
    }
    if (entry.length === 0) return `entry ${i} is an empty string`;
  }
  const first = queryKey[0];
  if (typeof first !== "string" || !first.startsWith("/")) {
    return `first entry must be an absolute path string starting with "/" (got ${JSON.stringify(first)})`;
  }
  const url = queryKey.join("/");
  const path = url.split(/[?#]/, 1)[0];
  const segments = path.split("/").slice(1); // drop the empty segment before the leading "/"
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    // A trailing empty segment (trailing "/") is tolerated; an interior one
    // ("//") means a fragment resolved to nothing.
    if (segment === "" && i < segments.length - 1) {
      return `URL "${url}" contains an empty path segment ("//")`;
    }
    if (
      segment === "undefined" ||
      segment === "null" ||
      segment === "NaN" ||
      segment === "[object Object]"
    ) {
      return `URL "${url}" contains a "${segment}" path segment — an unresolved value leaked into the query key`;
    }
  }
  return null;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    if (QUERY_KEY_SHAPE_GUARD_ENABLED) {
      const problem = validateApiQueryKeyShape(queryKey);
      if (problem) {
        let printable: string;
        try {
          printable = JSON.stringify(queryKey);
        } catch {
          printable = String(queryKey);
        }
        throw new Error(
          `Malformed query key ${printable}: ${problem} — fix the useQuery call site (default-queryFn keys are joined with "/" into the request URL)`,
        );
      }
    }
    const url = queryKey.join("/") as string;
    let res = await fetch(url, { credentials: "include" });

    for (let attempt = 0; attempt < BOOT_503_MAX_RETRIES && await isBoot503(res); attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, BOOT_503_RETRY_DELAY_MS));
      res = await fetch(url, { credentials: "include" });
    }

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

/**
 * Transient-failure classifier for the global query retry policy.
 *
 * Production runs behind an edge proxy under continuous background-job load,
 * so a page-load burst of 10-15 parallel queries can catch a single transient
 * 5xx or dropped connection. With `retry: false` that one blip fires the
 * global "Request failed" toast (the Sheets-page symptom). Retrying only
 * genuinely transient failures — bare 5xx responses and browser network
 * errors — lets those blips self-heal invisibly.
 *
 * Deliberately NOT transient:
 * - 4xx including 429 (retrying rate-limit responses would hammer harder);
 * - BOOT_503 (`getQueryFn` already runs its own dedicated 10×3s retry loop;
 *   re-entering it from the outer retry would stack ~30s per attempt);
 * - the two structured 503 contracts (Google-Ads-disconnected, integration
 *   status-unknown) — dedicated page UI renders those immediately, and the
 *   state won't change within a retry window.
 */
export function isTransientQueryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  if (/^(500|502|503|504):/.test(msg)) {
    if (msg.includes("BOOT_503")) return false;
    if (parseGoogleAdsDisconnectedError(error)) return false;
    if (parseIntegrationStatusUnknownError(error)) return false;
    return true;
  }
  return (
    msg.includes("Failed to fetch") ||
    msg.includes("NetworkError") ||
    msg.includes("Load failed")
  );
}

/** Max transient retries for queries (attempts = retries + 1). */
export const TRANSIENT_QUERY_RETRY_LIMIT = 2;

/** Backoff between transient retries: 1s, 2s, … capped at 5s. */
export function transientRetryDelay(attemptIndex: number): number {
  return Math.min(1000 * 2 ** attemptIndex, 5000);
}

/**
 * Task #4346 — single-string form of the humane error copy, kept for
 * surfaces that compose their own toast titles (e.g. RisDashboard). The
 * failure-class → copy mapping lives in ./queryErrorCopy.ts; this wrapper
 * exists so there is exactly ONE translation path for request errors.
 */
export function formatQueryError(error: unknown): string {
  return humanizeQueryError(error).description;
}

/**
 * Task #4685 — the global error toasts render ONLY the humane copy (plain
 * title + recovery sentence). The raw technical text (status line / server
 * body snippet) is deliberately NOT appended: operators kept seeing
 * `429: {"message":…}`-style payloads under the humane line (flagged in
 * audits/os-impeccable-2026-08/growth-tools.md). Surfaces that need the raw
 * detail for bug reports still get it from
 * `humanizeQueryError(error).technicalDetail` (inline panels keep using it).
 */

/**
 * Task #2663 — when a 401 reaches the client it means the server has
 * terminally ended this session (e.g. a dead refresh-token family routed to a
 * clean re-authentication). Distinguish that genuine auth-loss from a transient
 * network blip: only act on an explicit `401:` error, and only when we actually
 * had an authenticated user cached — public/unauthenticated pages must not be
 * yanked to sign-in. Acting once, we null the cached auth user (so the app
 * renders its sign-in surface instead of a stuck zeros dashboard) and reload at
 * the root for a clean sign-in, rather than looping on a "Request failed" toast.
 */
let authLossHandled = false;
function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("401:");
}

/**
 * Task #2882 — sessionStorage marker set just before the auth-loss redirect.
 * A toast fired pre-redirect would be wiped by the full page reload, so the
 * marker survives the reload (same tab only) and App.tsx shows a
 * "Your session expired — please sign in again" toast on boot, then clears it.
 */
export const SESSION_EXPIRED_STORAGE_KEY = "nobull:session-expired";

/** Set the marker; swallows storage errors (private mode / quota). */
export function markSessionExpired(): void {
  try {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(SESSION_EXPIRED_STORAGE_KEY, "1");
    }
  } catch {
    // Storage unavailable — the redirect still happens, just without the toast.
  }
}

/** Read-and-clear the marker on boot. Returns true if it was set. */
export function consumeSessionExpiredMarker(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const wasSet = window.sessionStorage.getItem(SESSION_EXPIRED_STORAGE_KEY) === "1";
    if (wasSet) window.sessionStorage.removeItem(SESSION_EXPIRED_STORAGE_KEY);
    return wasSet;
  } catch {
    return false;
  }
}

function handleAuthLoss(): void {
  if (authLossHandled) return;
  // Only treat this as auth-loss if we were actually signed in.
  if (!queryClient.getQueryData(["/api/auth/user"])) return;
  authLossHandled = true;
  queryClient.setQueryData(["/api/auth/user"], null);
  markSessionExpired();
  if (typeof window !== "undefined") {
    window.location.assign("/");
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (isUnauthorizedError(error)) {
        handleAuthLoss();
        return;
      }
      {
        // Task #4791 — a fetch that died with NO HTTP response (network /
        // offline class) feeds the connection-lost lifecycle: one
        // self-dismissing "reconnecting" banner + outage-window-only probe +
        // auto-refetch on recovery, instead of a destructive toast that
        // outlives the blip. Deliberately BEFORE the meta.silent check —
        // silent background queries are still genuine connectivity signals
        // (the banner is global state, not a per-query toast). Every other
        // failure class falls through to the existing behavior unchanged.
        const failureClass = classifyQueryFailure(error);
        if (failureClass === "network" || failureClass === "offline") {
          reportConnectionLost(failureClass);
          return;
        }
      }
      if (query.meta?.silent) return;
      // Task #2794 — structured "Google Ads disconnected" 503: the Ads
      // Hygiene page renders a page-level reconnect banner for this code,
      // so the generic "Request failed" toast would be noise on top.
      if (parseGoogleAdsDisconnectedError(error)) return;
      // Task #2820 — status-unknown 503 from a dedicated integration status
      // route (Task #2811 contract): the consuming card renders a neutral
      // "checking / temporarily unavailable" state, so the generic toast
      // would falsely imply an outage on top of it.
      if (parseIntegrationStatusUnknownError(error)) return;
      if (error instanceof Error && error.message.startsWith("403:")) return;
      const humane = humanizeQueryError(error, { kind: "query" });
      toast({
        title: humane.title,
        description: humane.description,
        variant: "destructive",
      });
    },
    // Task #4791 — any successful query proves the server is reachable; the
    // tracker no-ops unless it is currently in the lost state.
    onSuccess: () => {
      reportServerReachable("request");
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (isUnauthorizedError(error)) {
        handleAuthLoss();
        return;
      }
      {
        // Task #4791 — same connection-lost routing as the query cache (the
        // banner replaces the destructive toast for this class only). The
        // mutation itself is NOT retried — recovery only refetches queries.
        const failureClass = classifyQueryFailure(error);
        if (failureClass === "network" || failureClass === "offline") {
          reportConnectionLost(failureClass);
          return;
        }
      }
      if (mutation.meta?.silent) return;
      // Task #2794 — same suppression for mutations (Run Audit / Keyword
      // Intel / Compute Alerts); the page banner owns this state.
      if (parseGoogleAdsDisconnectedError(error)) return;
      const humane = humanizeQueryError(error, { kind: "mutation" });
      toast({
        title: humane.title,
        description: humane.description,
        variant: "destructive",
      });
    },
    // Task #4791 — successful writes count as reachability proof too.
    onSuccess: () => {
      reportServerReachable("request");
    },
  }),
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      // Self-heal transient blips (5xx / network) before surfacing the global
      // "Request failed" toast; terminal 4xx still fails on the first attempt.
      // Per-query `retry` settings override this default.
      retry: (failureCount, error) =>
        failureCount < TRANSIENT_QUERY_RETRY_LIMIT && isTransientQueryError(error),
      retryDelay: transientRetryDelay,
    },
    mutations: {
      // Never auto-retry writes — a retried mutation can double a side effect.
      retry: false,
    },
  },
});

// Task #4791 — late-bind the client into the connection-lost tracker (leaf
// module, no import cycle) and install the browser online/offline listeners.
bindConnectionLostQueryClient(queryClient);
