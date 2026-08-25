/* test-registration
{
  "name": "Front historical recovery retry (Task #1015)",
  "tier": "medium"
}
test-registration */
/**
 * Unit tests for the Task #1015 Front historical recovery retry helper.
 *
 * These tests stub out global.fetch and the storage system-settings
 * methods so they can run without DB or network. They cover:
 *   - token accessor is called per page (not reused across pages)
 *   - token expiring between page 1 and page 2 — page 2 succeeds with
 *     an automatic refresh, no auth-failure classification
 *   - 401 then forced-refresh succeeds — same page is retried and
 *     continues
 *   - 401 after forced refresh still 401 — classified as a true auth
 *     failure (front_auth_unauthorized_after_refresh) and not infinitely
 *     retried
 *   - timeout on a page then success on retry
 *   - 503 on a page then success on retry
 *   - retry exhaustion on repeated 503s yields a typed error with a
 *     stable reason code
 *   - existing 429 + Retry-After behavior preserved
 */

import { storage } from "../server/storage";
// Task #2100 added a PROCESS-GLOBAL Front auth-dead breaker
// (server/services/frontAuthBreaker.ts). Groups in this file deliberately
// simulate a permanent/invalid_grant refresh failure (e.g. the persistent
// 401-after-refresh cases), which trips the breaker. Once open, every
// later group inherits the OPEN breaker and `getValidFrontAccessToken`
// short-circuits with "Front auth breaker open (front_not_connected)".
// Reset the breaker (in-memory + durable signal) before each `run` so
// every group that exercises token refresh starts from a CLOSED breaker.
import { __resetFrontAuthBreakerForTest } from "../server/services/frontAuthBreaker";

let failed = 0;
async function run(name: string, fn: () => void | Promise<void>) {
  __resetFrontAuthBreakerForTest();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
    failed++;
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// In-memory fake of the system-settings store the helpers read.
const settings = new Map<string, string>();
// Task #1787 Stage 6 added `front_recovery_active_inbox_filter_enabled`
// (default ON). When enabled, runTargetedWindowBackfill loads an active
// inbox filter via a sibling Front API call that this test's per-page
// retry counters would (incorrectly) attribute to the page-fetch. Disable
// the switch here so the assertions exercise the pure retry path.
settings.set("front_recovery_active_inbox_filter_enabled", "false");
(storage as any).getSystemSetting = async (key: string) => {
  return settings.has(key) ? { key, value: settings.get(key)! } : undefined;
};
(storage as any).getSystemSettings = async (keys: string[]) => {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = settings.get(k);
  return out;
};
(storage as any).setSystemSetting = async (key: string, value: string) => {
  settings.set(key, value);
  return { key, value };
};
// Task #3785 — the accessor's confirm-before-trip path (Task #2416) re-reads
// tokens via getSystemSettingFresh before declaring a disconnect. Without
// this override the "fresh" read hits the REAL dev DB (which may hold live
// Front tokens) and the not-connected scenario proceeds to fetch.
(storage as any).getSystemSettingFresh = async (key: string) => {
  return settings.has(key) ? { key, value: settings.get(key)! } : undefined;
};

// Stub Front OAuth env so refresh attempts don't bail with "credentials not configured".
process.env.FRONT_CLIENT_ID = process.env.FRONT_CLIENT_ID || "test-client-id";
process.env.FRONT_CLIENT_SECRET = process.env.FRONT_CLIENT_SECRET || "test-client-secret";

// Force the Pool-Epic kill-switch reader to consume the stubbed
// `getSystemSettings` synchronously so the lazy-cache returns the
// disabled value on the first call instead of falling back to the
// hard-coded ON default.
const { ensurePoolEpicSwitchesLoaded } = await import(
  "../server/services/poolEpicKillSwitches"
);
await ensurePoolEpicSwitchesLoaded();

// Helper to seed a connected, valid Front auth state.
function seedConnected(opts?: { expiresAt?: number; access?: string; refresh?: string }) {
  settings.clear();
  const now = Math.floor(Date.now() / 1000);
  settings.set("front_access_token", opts?.access ?? "access-A");
  settings.set("front_refresh_token", opts?.refresh ?? "refresh-A");
  settings.set("front_token_expires_at", String(opts?.expiresAt ?? now + 3600));
}

// fetch mock with a per-test scripted handler.
type FetchHandler = (url: string, init: any) => Promise<Response>;
let currentFetchHandler: FetchHandler = async () => {
  throw new Error("fetch handler not set");
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return currentFetchHandler(url, init ?? {});
}) as any;

function jsonResponse(body: any, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}
function errorResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: headers ?? {} });
}

// Import after fetch + storage stubs are in place so the module captures them.
const { fetchFrontRecoveryPageWithRetry, runTargetedWindowBackfill } = await import(
  "../server/services/frontHistoricalRecovery"
);
const { getValidFrontAccessToken } = await import(
  "../server/services/frontIntegration"
);

console.log("\n=== Front historical recovery retry helper (Task #1015) ===");

await run("calls token accessor per page (not reused stale across pages)", async () => {
  seedConnected({ expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  let bearerSeen: string[] = [];
  currentFetchHandler = async (url, init) => {
    bearerSeen.push(String(init.headers?.Authorization ?? ""));
    return jsonResponse({ _results: [{ id: "c1" }], _pagination: { next: null } });
  };
  const r1 = await fetchFrontRecoveryPageWithRetry({
    pageUrl: "/conversations?limit=1",
    windowLabel: "w-1",
    pageNumber: 1,
  });
  assert(r1.conversations.length === 1, "page 1 should return 1 conv");
  // Mid-run: rotate the access token in storage. Helper must pick it up.
  settings.set("front_access_token", "access-B");
  const r2 = await fetchFrontRecoveryPageWithRetry({
    pageUrl: "/conversations?limit=1&page_token=2",
    windowLabel: "w-1",
    pageNumber: 2,
  });
  assert(r2.conversations.length === 1, "page 2 should return 1 conv");
  assert(bearerSeen[0] === "Bearer access-A", `page 1 used wrong token: ${bearerSeen[0]}`);
  assert(bearerSeen[1] === "Bearer access-B", `page 2 used wrong token: ${bearerSeen[1]}`);
});

await run("token near-expiry triggers automatic refresh between pages", async () => {
  seedConnected({ expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  let bearerSeen: string[] = [];
  let refreshCalls = 0;
  currentFetchHandler = async (url, init) => {
    if (url.includes("/oauth/token")) {
      refreshCalls++;
      // Simulate Front issuing a new access token.
      return jsonResponse({
        access_token: "access-refreshed",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    bearerSeen.push(String(init.headers?.Authorization ?? ""));
    return jsonResponse({ _results: [{ id: "c" }], _pagination: { next: null } });
  };
  // Page 1: token is fresh. Page 2: simulate token expiring by setting
  // expires_at into the past — accessor should refresh.
  await fetchFrontRecoveryPageWithRetry({ pageUrl: "/p1", windowLabel: "w-1", pageNumber: 1 });
  settings.set("front_token_expires_at", String(Math.floor(Date.now() / 1000) - 1));
  await fetchFrontRecoveryPageWithRetry({ pageUrl: "/p2", windowLabel: "w-1", pageNumber: 2 });
  assert(refreshCalls === 1, `expected 1 refresh call, got ${refreshCalls}`);
  assert(bearerSeen[0] === "Bearer access-A", `page 1 unexpected bearer: ${bearerSeen[0]}`);
  assert(
    bearerSeen[1] === "Bearer access-refreshed",
    `page 2 should use refreshed token, got: ${bearerSeen[1]}`,
  );
});

await run("401 then forced-refresh succeeds — same page retried, continues", async () => {
  seedConnected();
  let pageCalls = 0;
  let refreshCalls = 0;
  currentFetchHandler = async (url) => {
    if (url.includes("/oauth/token")) {
      refreshCalls++;
      return jsonResponse({
        access_token: "access-refreshed",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    pageCalls++;
    if (pageCalls === 1) return errorResponse(401, "unauthorized");
    return jsonResponse({ _results: [{ id: "ok" }], _pagination: { next: null } });
  };
  const r = await fetchFrontRecoveryPageWithRetry({
    pageUrl: "/p",
    windowLabel: "w-1",
    pageNumber: 1,
  });
  assert(r.conversations.length === 1, "expected one conv after refresh+retry");
  assert(r.refreshedDuringFetch === true, "refreshedDuringFetch should be true");
  assert(refreshCalls === 1, `expected 1 refresh, got ${refreshCalls}`);
  assert(pageCalls === 2, `expected 2 page calls, got ${pageCalls}`);
});

await run("401 after forced refresh still 401 — typed auth failure, no infinite retry", async () => {
  seedConnected();
  let pageCalls = 0;
  let refreshCalls = 0;
  let probeCalls = 0;
  currentFetchHandler = async (url) => {
    if (url.includes("/oauth/token")) {
      refreshCalls++;
      return jsonResponse({
        access_token: "access-refreshed",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    // Task #1869 Step 2 — soft-gate `/me` probe runs once before
    // classifying a persistent 401 as terminal. It must not be
    // counted as a page-fetch attempt.
    if (url.endsWith("/me") || url.includes("/me?")) {
      probeCalls++;
      return errorResponse(401, "still unauthorized");
    }
    pageCalls++;
    return errorResponse(401, "still unauthorized");
  };
  let caught: any = null;
  try {
    await fetchFrontRecoveryPageWithRetry({
      pageUrl: "/p",
      windowLabel: "w-1",
      pageNumber: 1,
    });
  } catch (e) {
    caught = e;
  }
  assert(caught != null, "should throw on persistent 401");
  assert(
    caught?.reasonCode === "front_auth_unauthorized_after_refresh",
    `wrong reasonCode: ${caught?.reasonCode}`,
  );
  assert(refreshCalls === 1, `expected exactly 1 forced refresh, got ${refreshCalls}`);
  // The forced-refresh attempt is "free" (doesn't consume an attempt
  // slot), so we expect 2 page calls total: 1 original + 1 retry.
  assert(pageCalls === 2, `expected 2 page calls, got ${pageCalls}`);
  // Task #1869 Step 2 — soft-gate probe ran exactly once and (being
  // unauthorized too) confirmed the 401 was terminal, not a race.
  assert(probeCalls === 1, `expected exactly 1 /me probe, got ${probeCalls}`);
});

await run("timeout on a page then success on retry", async () => {
  seedConnected();
  let pageCalls = 0;
  currentFetchHandler = async (url, init) => {
    pageCalls++;
    if (pageCalls === 1) {
      // Simulate a fetch abort (timeout): throw an AbortError-like error.
      const err = new Error("aborted");
      (err as any).name = "AbortError";
      throw err;
    }
    return jsonResponse({ _results: [{ id: "ok" }], _pagination: { next: null } });
  };
  const r = await fetchFrontRecoveryPageWithRetry({
    pageUrl: "/p",
    windowLabel: "w-1",
    pageNumber: 1,
    signalTimeoutMs: 1000,
  });
  assert(r.conversations.length === 1, "expected success after timeout retry");
  assert(pageCalls === 2, `expected 2 page calls, got ${pageCalls}`);
});

await run("503 on a page then success on retry", async () => {
  seedConnected();
  let pageCalls = 0;
  currentFetchHandler = async () => {
    pageCalls++;
    if (pageCalls === 1) return errorResponse(503, "Service Unavailable");
    return jsonResponse({ _results: [{ id: "ok" }], _pagination: { next: null } });
  };
  const r = await fetchFrontRecoveryPageWithRetry({
    pageUrl: "/p",
    windowLabel: "w-1",
    pageNumber: 1,
  });
  assert(r.conversations.length === 1, "expected success after 503 retry");
  assert(pageCalls === 2, `expected 2 page calls, got ${pageCalls}`);
});

await run("retry exhaustion on repeated 503 yields typed error with stable code", async () => {
  seedConnected();
  let pageCalls = 0;
  currentFetchHandler = async () => {
    pageCalls++;
    return errorResponse(503, "Service Unavailable");
  };
  let caught: any = null;
  try {
    await fetchFrontRecoveryPageWithRetry({
      pageUrl: "/p",
      windowLabel: "w-1",
      pageNumber: 1,
    });
  } catch (e) {
    caught = e;
  }
  assert(caught != null, "should throw after exhaustion");
  assert(
    caught?.reasonCode === "front_5xx_retry_exhausted",
    `wrong reasonCode: ${caught?.reasonCode}`,
  );
  assert(pageCalls === 3, `expected 3 page attempts, got ${pageCalls}`);
});

await run("429 Retry-After is honored and does not consume a regular attempt slot", async () => {
  seedConnected();
  let pageCalls = 0;
  const start = Date.now();
  currentFetchHandler = async () => {
    pageCalls++;
    if (pageCalls === 1) return errorResponse(429, "Too Many Requests", { "retry-after": "1" });
    return jsonResponse({ _results: [{ id: "ok" }], _pagination: { next: null } });
  };
  const r = await fetchFrontRecoveryPageWithRetry({
    pageUrl: "/p",
    windowLabel: "w-1",
    pageNumber: 1,
  });
  const elapsed = Date.now() - start;
  assert(r.conversations.length === 1, "expected success after 429 wait");
  assert(pageCalls === 2, `expected 2 page calls, got ${pageCalls}`);
  assert(elapsed >= 900, `expected to wait at least ~1s for Retry-After, got ${elapsed}ms`);
});

await run("runTargetedWindowBackfill: retry exhaustion → partial with lastPageUrl preserved", async () => {
  seedConnected();
  // Always 503 — every attempt of every page exhausts retries.
  let pageCalls = 0;
  currentFetchHandler = async (url) => {
    if (url.includes("/oauth/token")) {
      return jsonResponse({
        access_token: "access-A",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    pageCalls++;
    return errorResponse(503, "Service Unavailable");
  };
  const checkpoint = await runTargetedWindowBackfill(
    {
      label: "w-integration-503",
      afterTimestamp: 1700000000,
      beforeTimestamp: 1700100000,
    },
    { dryRun: true, resume: false, jobId: "test-job" },
  );
  assert(checkpoint.status === "partial", `expected partial, got ${checkpoint.status}`);
  assert(
    checkpoint.statusReason === "front_5xx_retry_exhausted",
    `expected front_5xx_retry_exhausted reason, got ${checkpoint.statusReason}`,
  );
  assert(
    typeof checkpoint.lastPageUrl === "string" && checkpoint.lastPageUrl.length > 0,
    "lastPageUrl should be preserved for resume",
  );
  assert(checkpoint.pages === 0, `pages should be 0 (no successful page), got ${checkpoint.pages}`);
  assert(pageCalls === 3, `expected 3 retry attempts on the first page, got ${pageCalls}`);
});

await run("runTargetedWindowBackfill: persistent 401 after refresh → blocked", async () => {
  seedConnected();
  let refreshCalls = 0;
  currentFetchHandler = async (url) => {
    if (url.includes("/oauth/token")) {
      refreshCalls++;
      return jsonResponse({
        access_token: "access-refreshed",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    return errorResponse(401, "still unauthorized");
  };
  const checkpoint = await runTargetedWindowBackfill(
    {
      label: "w-integration-401",
      afterTimestamp: 1700000000,
      beforeTimestamp: 1700100000,
    },
    { dryRun: true, resume: false, jobId: "test-job" },
  );
  assert(checkpoint.status === "blocked", `expected blocked, got ${checkpoint.status}`);
  assert(
    checkpoint.statusReason === "front_auth_unauthorized_after_refresh",
    `expected unauthorized-after-refresh reason, got ${checkpoint.statusReason}`,
  );
  assert(refreshCalls === 1, `expected exactly 1 forced refresh, got ${refreshCalls}`);
});

await run("missing access AND refresh tokens classified as front_not_connected", async () => {
  settings.clear();
  currentFetchHandler = async () => {
    throw new Error("fetch should not be called when not connected");
  };
  let caught: any = null;
  try {
    await fetchFrontRecoveryPageWithRetry({
      pageUrl: "/p",
      windowLabel: "w-1",
      pageNumber: 1,
    });
  } catch (e) {
    caught = e;
  }
  assert(caught != null, "should throw when not connected");
  assert(
    caught?.reasonCode === "front_not_connected",
    `wrong reasonCode: ${caught?.reasonCode}`,
  );
});

// Task #1016: per-page result + error must surface retry counters
// (broken down by reason) and a token-refresh count so the admin UI
// can render badges on each window card.
await run("page result includes retriesByReason + tokenRefreshes counters", async () => {
  seedConnected();
  let pageCalls = 0;
  currentFetchHandler = async (url) => {
    if (url.includes("/oauth/token")) {
      return jsonResponse({
        access_token: "access-refreshed",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    pageCalls++;
    if (pageCalls === 1) return errorResponse(503, "Service Unavailable");
    if (pageCalls === 2) return errorResponse(401, "unauthorized");
    return jsonResponse({ _results: [{ id: "ok" }], _pagination: { next: null } });
  };
  const r = await fetchFrontRecoveryPageWithRetry({
    pageUrl: "/p",
    windowLabel: "w-counters",
    pageNumber: 1,
  });
  assert(r.conversations.length === 1, "expected success after retries");
  assert(r.refreshedDuringFetch === true, "should mark refreshedDuringFetch");
  assert((r.retriesByReason?.front_503 ?? 0) === 1, `expected 1 front_503 retry, got ${r.retriesByReason?.front_503}`);
  assert(r.tokenRefreshes >= 1, `expected at least 1 token refresh, got ${r.tokenRefreshes}`);
});

await run("exhausted retry error carries retriesByReason for window attribution", async () => {
  seedConnected();
  currentFetchHandler = async (url) => {
    if (url.includes("/oauth/token")) {
      return jsonResponse({
        access_token: "access-A",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    return errorResponse(502, "Bad Gateway");
  };
  let caught: any = null;
  try {
    await fetchFrontRecoveryPageWithRetry({ pageUrl: "/p", windowLabel: "w-err", pageNumber: 1 });
  } catch (e) {
    caught = e;
  }
  assert(caught != null, "should throw on exhaustion");
  assert((caught.retriesByReason?.front_502 ?? 0) === 3, `expected 3 front_502 retries on err, got ${caught.retriesByReason?.front_502}`);
});

await run("runTargetedWindowBackfill aggregates retry + refresh counters into the checkpoint", async () => {
  seedConnected();
  currentFetchHandler = async (url) => {
    if (url.includes("/oauth/token")) {
      return jsonResponse({
        access_token: "access-A",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    return errorResponse(503, "Service Unavailable");
  };
  const checkpoint = await runTargetedWindowBackfill(
    {
      label: "w-counters-int",
      afterTimestamp: 1700000000,
      beforeTimestamp: 1700100000,
    },
    { dryRun: true, resume: false, jobId: "test-job" },
  );
  assert(checkpoint.status === "partial", `expected partial, got ${checkpoint.status}`);
  assert(
    (checkpoint.retriesByReason?.front_503 ?? 0) === 3,
    `expected 3 front_503 retries on checkpoint, got ${JSON.stringify(checkpoint.retriesByReason)}`,
  );
  assert(
    (checkpoint.totalRetries ?? 0) === 3,
    `expected totalRetries=3, got ${checkpoint.totalRetries}`,
  );
});

// Task #1873 — Regression coverage for the Task #1869 Step 1 single-flight
// + re-read-and-retry path in `refreshAccessToken`. These tests live in the
// Front auth suite (not a standalone file) so they share fetch/storage
// stubbing with the recovery tests above.
await run("concurrent refreshAccessToken callers collapse to a single OAuth POST", async () => {
  seedConnected();
  // Force every caller down the refresh branch by expiring the access
  // token; without this they would hit the cached-token fast path.
  settings.set("front_token_expires_at", String(Math.floor(Date.now() / 1000) - 1));
  let postCount = 0;
  currentFetchHandler = async (url) => {
    if (url.includes("/oauth/token")) {
      postCount++;
      // Small delay so concurrent callers stack on the in-flight promise
      // before the first POST resolves and clears it.
      await new Promise((r) => setTimeout(r, 25));
      return jsonResponse({
        access_token: "access-single-flight",
        refresh_token: "refresh-single-flight",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    throw new Error(`unexpected fetch in single-flight test: ${url}`);
  };
  const tokens = await Promise.all(
    [0, 1, 2, 3, 4].map(() => getValidFrontAccessToken({ purpose: "test-single-flight" })),
  );
  assert(
    postCount === 1,
    `expected exactly 1 OAuth POST across 5 concurrent callers, got ${postCount}`,
  );
  assert(
    tokens.every((t) => t === "access-single-flight"),
    `all callers should receive the winner's token, got ${JSON.stringify(tokens)}`,
  );
});

await run("race loser observes freshly-written token and logs refresh_outcome=race_recovered", async () => {
  seedConnected({ refresh: "refresh-A" });
  settings.set("front_token_expires_at", String(Math.floor(Date.now() / 1000) - 1));
  let postCount = 0;
  const bodiesSeen: string[] = [];
  currentFetchHandler = async (url, init) => {
    if (url.includes("/oauth/token")) {
      postCount++;
      const body = String(init?.body ?? "");
      bodiesSeen.push(body);
      if (postCount === 1) {
        // Simulate the cross-process race: another replica won the
        // refresh and rotated `front_refresh_token` to "refresh-B"
        // before our POST hit Front, so Front rejects our captured
        // (now-consumed) "refresh-A" with a permanent 4xx.
        settings.set("front_refresh_token", "refresh-B");
        return errorResponse(400, JSON.stringify({ error: "invalid_grant" }));
      }
      // Re-read-and-retry path: the loser re-reads storage, sees the
      // winner's "refresh-B", and the retry succeeds.
      return jsonResponse({
        access_token: "access-after-race",
        refresh_token: "refresh-C",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    throw new Error(`unexpected fetch in race-recovered test: ${url}`);
  };

  const realLog = console.log;
  const realWarn = console.warn;
  const logs: string[] = [];
  console.log = (msg: any, ...rest: any[]) => {
    logs.push(String(msg));
    realLog(msg, ...rest);
  };
  console.warn = (msg: any, ...rest: any[]) => {
    logs.push(String(msg));
    realWarn(msg, ...rest);
  };
  let token: string;
  try {
    token = await getValidFrontAccessToken({ purpose: "test-race", forceRefresh: true });
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }

  assert(token === "access-after-race", `expected race-recovered token, got ${token}`);
  assert(postCount === 2, `expected exactly 2 OAuth POSTs (1 racing + 1 retry), got ${postCount}`);
  assert(
    bodiesSeen[0].includes("refresh_token=refresh-A"),
    `first POST should use captured refresh-A, got body: ${bodiesSeen[0]}`,
  );
  assert(
    bodiesSeen[1].includes("refresh_token=refresh-B"),
    `retry POST should use re-read refresh-B, got body: ${bodiesSeen[1]}`,
  );
  assert(
    logs.some((l) => l.includes("refresh_outcome=race_recovered")),
    `expected a refresh_outcome=race_recovered log line, got:\n${logs.join("\n")}`,
  );
  assert(
    !logs.some((l) => /refresh_outcome=permanent(?!_)/.test(l)),
    `race-recovered path must not emit refresh_outcome=permanent, got:\n${logs.join("\n")}`,
  );
  assert(
    settings.get("front_access_token") === "access-after-race",
    "winner's access token should be persisted by the retry",
  );
});

globalThis.fetch = realFetch;

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll Front historical recovery retry tests passed.");
}
// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the process
// exits on its own once the tests settle — no manual process.exit() (Task #2084).
