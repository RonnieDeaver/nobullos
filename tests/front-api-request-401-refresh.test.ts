/* test-registration
{
  "name": "Front API 401 auto-refresh-and-retry (Task #1017/#1019)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1019: lock in the one-shot "401 → forced token refresh → retry once"
 * contract for `frontApiRequest` (Task #1017). Companion to the
 * `front-historical-recovery-retry` suite, which covers the same contract for
 * `fetchFrontRecoveryPageWithRetry` (Task #1015).
 */

import { storage } from "../server/storage";

interface SettingRow { key: string; value: string }
interface FetchInit { headers?: Record<string, string> }
type FetchHandler = (url: string, init: FetchInit) => Promise<Response>;
type StorageWithSettings = {
  getSystemSetting: (key: string) => Promise<SettingRow | undefined>;
  setSystemSetting: (key: string, value: string) => Promise<SettingRow>;
};

let failed = 0;
async function run(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    const err = e as Error;
    console.error(`  FAIL ${name}\n    ${err.stack ?? err.message}`);
    failed++;
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const settings = new Map<string, string>();
const storageOverride = storage as unknown as StorageWithSettings;
storageOverride.getSystemSetting = async (key: string) => {
  return settings.has(key) ? { key, value: settings.get(key)! } : undefined;
};
storageOverride.setSystemSetting = async (key: string, value: string) => {
  settings.set(key, value);
  return { key, value };
};
// Task #3785 — the accessor's confirm-before-trip path (Task #2416) re-reads
// tokens via getSystemSettingFresh before declaring a disconnect. Without
// this override the "fresh" read hits the REAL dev DB (which may hold live
// Front tokens) and the true-disconnect scenario proceeds to fetch.
(storageOverride as any).getSystemSettingFresh = async (key: string) => {
  return settings.has(key) ? { key, value: settings.get(key)! } : undefined;
};

process.env.FRONT_CLIENT_ID = process.env.FRONT_CLIENT_ID || "test-client-id";
process.env.FRONT_CLIENT_SECRET = process.env.FRONT_CLIENT_SECRET || "test-client-secret";

function seedConnected(opts?: { expiresAt?: number; access?: string; refresh?: string }) {
  settings.clear();
  const now = Math.floor(Date.now() / 1000);
  settings.set("front_access_token", opts?.access ?? "access-A");
  settings.set("front_refresh_token", opts?.refresh ?? "refresh-A");
  settings.set("front_token_expires_at", String(opts?.expiresAt ?? now + 3600));
}

let currentFetchHandler: FetchHandler = async () => {
  throw new Error("fetch handler not set");
};
const realFetch = globalThis.fetch;
const fetchOverride: typeof globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  // Only Front API + OAuth traffic is under test here. Other global
  // `fetch` calls must pass through to the real fetch so they are neither
  // intercepted nor miscounted as Front page calls. In particular, a
  // successful forced refresh calls `storeTokens`, which resets the Front
  // auth breaker and that fires a Redis-backed `system_settings` cache
  // invalidation over HTTP (Upstash). Routing that through the per-scenario
  // Front handler would inflate the page-call count (1 original + 1 retry
  // was being read as 3).
  if (!/frontapp\.com/.test(url)) {
    return realFetch(input as RequestInfo | URL, init);
  }
  const headers = (init?.headers as Record<string, string> | undefined) ?? {};
  return currentFetchHandler(url, { headers });
}) as typeof globalThis.fetch;
globalThis.fetch = fetchOverride;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}
function errorResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: headers ?? {} });
}

// `listInboxes` is the thinnest public wrapper around
// `frontApiRequest("/inboxes")` — exercises the path under test without
// expanding the module's exported surface.
const { listInboxes } = await import("../server/services/frontIntegration");

console.log("\n=== frontApiRequest 401 auto-refresh-and-retry (Task #1017/#1019) ===");

await run("401 once then 200 → exactly one forced refresh, second response returned", async () => {
  seedConnected();
  let pageCalls = 0;
  let refreshCalls = 0;
  const bearerSeen: string[] = [];
  currentFetchHandler = async (url, init) => {
    if (url.includes("/oauth/token")) {
      refreshCalls++;
      return jsonResponse({
        access_token: "access-refreshed",
        refresh_token: "refresh-A",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    pageCalls++;
    bearerSeen.push(String(init.headers?.Authorization ?? ""));
    if (pageCalls === 1) return errorResponse(401, "unauthorized");
    return jsonResponse({ _results: [{ id: "inbox-1" }] });
  };
  const inboxes = await listInboxes();
  assert(inboxes.length === 1 && inboxes[0].id === "inbox-1", "expected payload from second response");
  assert(refreshCalls === 1, `expected exactly 1 forced refresh, got ${refreshCalls}`);
  assert(pageCalls === 2, `expected 2 page calls (1 original + 1 retry), got ${pageCalls}`);
  assert(bearerSeen[0] === "Bearer access-A", `first call used wrong bearer: ${bearerSeen[0]}`);
  assert(
    bearerSeen[1] === "Bearer access-refreshed",
    `retry should use refreshed bearer, got: ${bearerSeen[1]}`,
  );
});

await run("two consecutive 401s do NOT loop — second 401 surfaces as Front API error", async () => {
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
    return errorResponse(401, "still unauthorized");
  };
  let caught: unknown = null;
  try {
    await listInboxes();
  } catch (e) {
    caught = e;
  }
  assert(caught != null, "should throw on persistent 401");
  const msg = caught instanceof Error ? caught.message : String(caught);
  assert(
    /^Front API error: 401\b/.test(msg),
    `expected "Front API error: 401 ..." surface, got: ${msg}`,
  );
  assert(refreshCalls === 1, `expected exactly 1 forced refresh (no loop), got ${refreshCalls}`);
  assert(
    pageCalls === 2,
    `expected exactly 2 page calls (1 original + 1 retry, no third), got ${pageCalls}`,
  );
});

await run("true disconnect surfaces legacy 'Front not connected' wording", async () => {
  settings.clear();
  currentFetchHandler = async () => {
    throw new Error("fetch should not be called when not connected");
  };
  let caught: unknown = null;
  try {
    await listInboxes();
  } catch (e) {
    caught = e;
  }
  assert(caught != null, "should throw when not connected");
  const msg = caught instanceof Error ? caught.message : String(caught);
  assert(
    msg === "Front not connected. Please authorize via Settings → Integrations.",
    `unexpected disconnect wording: ${msg}`,
  );
});

globalThis.fetch = realFetch;

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
}
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
console.log("\nAll Front 401 refresh-and-retry tests passed.");
