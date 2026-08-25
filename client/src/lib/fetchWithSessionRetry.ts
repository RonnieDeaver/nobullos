/**
 * Task #4789 — Reusable fetch helper for the feedback submit / upload-url
 * paths. These calls bypass React Query (raw fetch), so they had no 401
 * refresh-retry or human error-copy before this fix.
 *
 * Scope: deliberately narrow — the feedback submit + upload-url paths
 * (Task #4789) and the NoBull Brief admin page's mutations
 * (CeoPulseAdmin.tsx, Task #4802). The app-wide React Query 401 handler
 * (handleAuthLoss in queryClient.ts) covers React Query calls; adopt this
 * helper elsewhere only via an explicit task.
 *
 * On 401: silently asks Clerk to refresh the session token and retries once.
 * On all failures: maps the HTTP status to a human-readable message so callers
 * can show the real reason without exposing technical detail.
 */

export interface FetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  /** Non-null when the request failed; human copy for a toast description. */
  errorMessage: string | null;
  errorKind: "session_expired" | "rate_limited" | "server_error" | "network" | null;
}

/** Ask Clerk to refresh the active session token (best-effort). */
async function clerkRefreshSession(): Promise<void> {
  try {
    const clerk = (window as any).Clerk;
    if (clerk?.session?.getToken) {
      await clerk.session.getToken({ skipCache: true });
    }
  } catch {
    // Refresh failure is non-fatal; the retry will surface the 401 again.
  }
}

async function doFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: "include" });
}

function mapStatus(status: number): Pick<FetchResult, "errorMessage" | "errorKind"> {
  if (status === 401) {
    return {
      errorMessage:
        "Your session expired. Please refresh the page to sign in again, then re-submit.",
      errorKind: "session_expired",
    };
  }
  if (status === 429) {
    return {
      errorMessage:
        "You've sent too many requests. Please wait a minute and try submitting again.",
      errorKind: "rate_limited",
    };
  }
  return {
    errorMessage:
      "A server error occurred. Your draft is preserved — please try again in a moment.",
    errorKind: "server_error",
  };
}

/**
 * Make a fetch request with credentials, retrying once after a silent Clerk
 * session refresh on 401. Returns a typed result; never throws.
 */
export async function fetchWithSessionRetry(
  input: RequestInfo,
  init?: RequestInit,
): Promise<FetchResult> {
  let res: Response;
  try {
    res = await doFetch(input, init);
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      errorMessage:
        "Could not reach the server. Check your connection and try again.",
      errorKind: "network",
    };
  }

  if (res.status === 401) {
    // Silent Clerk refresh + one retry.
    await clerkRefreshSession();
    try {
      res = await doFetch(input, init);
    } catch {
      return {
        ok: false,
        status: 0,
        data: null,
        errorMessage:
          "Could not reach the server. Check your connection and try again.",
        errorKind: "network",
      };
    }
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body — ignore, callers check ok / status.
  }

  if (res.ok) {
    return { ok: true, status: res.status, data, errorMessage: null, errorKind: null };
  }

  return {
    ok: false,
    status: res.status,
    data,
    ...mapStatus(res.status),
  };
}
