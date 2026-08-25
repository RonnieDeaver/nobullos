/* test-registration
{
  "name": "Per-provider cross-instance OAuth refresh lease \u2014 Zoom/SEMrush (Task #2378)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2378 — Per-provider cross-instance OAuth refresh lease coverage.
 *
 * tests/oauth-refresh-cross-process-lease.test.ts proves the GENERIC lease
 * contract on `withSingleFlightOAuthRefresh` directly. This file proves each
 * rotating-refresh-token provider is actually WIRED to that contract end to
 * end, so a cross-instance login race can never make two autoscale instances
 * both POST a refresh (the loser would POST a token the winner just rotated →
 * `invalid_grant` → recovery dies).
 *
 * Per provider (Zoom, SEMrush) we assert, through the provider's own public
 * refresh entrypoint (Google Ads left this set with Task #4008 — its env
 * refresh token never rotates, so cross-instance mints can't race):
 *
 *   1. Two "instances" sharing one cross-process lease never both POST — the
 *      winner (no sibling result yet) POSTs exactly once; the loser (a sibling
 *      rotated the token while it waited for the lease) reuses that token and
 *      POSTs zero times.
 *   2. `onLeaseAcquiredRecheck` reuses the sibling-refreshed token and skips
 *      the POST when the stored access token is still within that provider's
 *      pre-expiry skew (Zoom 300s, SEMrush 60s), and the lease is released
 *      regardless.
 *   3. The skew is honored, not trivially short-circuited: when the stored
 *      token is INSIDE the skew window (still needs refreshing) the recheck
 *      proceeds to the POST.
 *
 * The cross-instance race is modeled by a serializing stub lease whose
 * `acquire` optionally flips the shared in-memory token store to "what the
 * sibling just rotated" — exactly the state a loser observes when it finally
 * wins the lease. Two instances are modeled by resetting the in-process
 * single-flight Map between them (each autoscale instance has its own Map; the
 * lease + recheck is the only thing that crosses the process boundary).
 *
 * Pure in-memory — the token stores, the fetch transport, and the lease are
 * all stubbed; no real DB or network. Runs via tests/run-all.ts.
 */
import { strict as assert } from "node:assert";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  type OAuthCrossProcessLease,
  __setOAuthRefreshLeaseForTest,
} from "../server/services/oauthRefreshLease";
import { storage } from "../server/storage";
import { refreshAccessToken as zoomRefreshAccessToken } from "../server/services/zoomIntegration";
import { __refreshAccessTokenForTest as semrushRefreshAccessToken } from "../server/services/semrushApi";
import { resetSemrushAuthBreaker } from "../server/services/semrushAuthBreaker";

// --- shared in-memory system_settings store (Zoom + SEMrush) --------------

const settingStore = new Map<string, string>();
const realGetSystemSetting = storage.getSystemSetting.bind(storage);
const realSetSystemSetting = storage.setSystemSetting.bind(storage);
const realRecordAdminSettingChange = storage.recordAdminSettingChange.bind(storage);

function installStorageStub(): void {
  (storage as any).getSystemSetting = async (key: string) =>
    settingStore.has(key) ? { key, value: settingStore.get(key)! } : undefined;
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    settingStore.set(key, value);
    return { key, value };
  };
  (storage as any).recordAdminSettingChange = async () => ({});
}

function restoreStorageStub(): void {
  (storage as any).getSystemSetting = realGetSystemSetting;
  (storage as any).setSystemSetting = realSetSystemSetting;
  (storage as any).recordAdminSettingChange = realRecordAdminSettingChange;
}

// --- shared global.fetch stub ---------------------------------------------

const realFetch = globalThis.fetch;

function installFetchStub(handler: (url: string) => any): void {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    return handler(url);
  }) as any;
}

function jsonResponse(body: Record<string, unknown>): any {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// --- serializing cross-process lease with an optional on-acquire flip ------

/** A promise-chain mutex masquerading as the cross-process lease. `onAcquire`
 * fires while the lease is held and is used to flip the shared store to the
 * token a sibling rotated — i.e. what a loser sees the moment it wins the
 * lease. */
function makeLease(onAcquire?: () => void): {
  lease: OAuthCrossProcessLease;
  acquireCount: () => number;
  releaseCount: () => number;
  maxConcurrent: () => number;
} {
  let tail: Promise<void> = Promise.resolve();
  let current = 0;
  let maxConcurrent = 0;
  let acquireCount = 0;
  let releaseCount = 0;
  const lease: OAuthCrossProcessLease = {
    async acquire() {
      let release!: () => void;
      const next = new Promise<void>((r) => (release = r));
      const prev = tail;
      tail = prev.then(() => next);
      await prev;
      current += 1;
      maxConcurrent = Math.max(maxConcurrent, current);
      acquireCount += 1;
      if (onAcquire) onAcquire();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        releaseCount += 1;
        current -= 1;
        release();
      };
    },
  };
  return {
    lease,
    acquireCount: () => acquireCount,
    releaseCount: () => releaseCount,
    maxConcurrent: () => maxConcurrent,
  };
}

// --- provider adapters -----------------------------------------------------

/** A provider exposes: how to seed its token store to an expired state (so the
 * refresh entrypoint decides to refresh), how to flip the store to a fresh /
 * within-skew sibling-rotated token, its public refresh entry, and a POST
 * counter scoped to its token endpoint. */
interface ProviderAdapter {
  name: string;
  skewLabel: string;
  /** The access token a loser must reuse after a sibling refreshes. */
  siblingAccessToken: string;
  reset(): void;
  seedExpired(): void;
  /** Sibling rotated a token well beyond the skew (recheck must reuse it). */
  flipToFreshBeyondSkew(): void;
  /** Sibling token is still inside the skew window (recheck must re-POST). */
  flipToWithinSkew(): void;
  refresh(): Promise<string>;
  postCount(): number;
}

// Zoom: storage singleton, expiry in SECONDS, 300s skew.
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
let zoomPosts = 0;
const zoomAdapter: ProviderAdapter = {
  name: "Zoom",
  skewLabel: "300s",
  siblingAccessToken: "zoom-sibling-access",
  postCount: () => zoomPosts,
  reset() {
    zoomPosts = 0;
    settingStore.clear();
    installFetchStub((url) => {
      assert.ok(url.startsWith(ZOOM_TOKEN_URL), `Zoom POSTed unexpected url: ${url}`);
      zoomPosts += 1;
      return jsonResponse({
        access_token: "zoom-post-access",
        refresh_token: "zoom-rt-rotated",
        expires_in: 3600,
        scope: "x",
      });
    });
  },
  seedExpired() {
    const nowSec = Math.floor(Date.now() / 1000);
    settingStore.set("zoom_access_token", "zoom-stale-access");
    settingStore.set("zoom_refresh_token", "zoom-rt");
    settingStore.set("zoom_token_expires_at", String(nowSec - 10));
  },
  flipToFreshBeyondSkew() {
    const nowSec = Math.floor(Date.now() / 1000);
    settingStore.set("zoom_access_token", "zoom-sibling-access");
    settingStore.set("zoom_token_expires_at", String(nowSec + 3600));
  },
  flipToWithinSkew() {
    const nowSec = Math.floor(Date.now() / 1000);
    settingStore.set("zoom_access_token", "zoom-within-skew-access");
    settingStore.set("zoom_token_expires_at", String(nowSec + 100));
  },
  async refresh() {
    return zoomRefreshAccessToken();
  },
};

// SEMrush: storage singleton, expiry in MILLISECONDS, 60s skew.
// Task #3666 — endpoint changed from /dag/device/token to /oauth2/access_token.
const SEMRUSH_TOKEN_URL = "https://oauth.semrush.com/oauth2/access_token";
let semrushPosts = 0;
const semrushAdapter: ProviderAdapter = {
  name: "SEMrush",
  skewLabel: "60s",
  siblingAccessToken: "semrush-sibling-access",
  postCount: () => semrushPosts,
  reset() {
    semrushPosts = 0;
    settingStore.clear();
    resetSemrushAuthBreaker();
    installFetchStub((url) => {
      assert.ok(url.startsWith(SEMRUSH_TOKEN_URL), `SEMrush POSTed unexpected url: ${url}`);
      semrushPosts += 1;
      return jsonResponse({
        access_token: "semrush-post-access",
        refresh_token: "semrush-rt-rotated",
        expires_in: 604800,
      });
    });
  },
  seedExpired() {
    settingStore.set("semrush_access_token", "semrush-stale-access");
    settingStore.set("semrush_refresh_token", "semrush-rt");
    settingStore.set("semrush_token_expires_at", String(Date.now() - 10_000));
  },
  flipToFreshBeyondSkew() {
    settingStore.set("semrush_access_token", "semrush-sibling-access");
    settingStore.set("semrush_token_expires_at", String(Date.now() + 3_600_000));
  },
  flipToWithinSkew() {
    settingStore.set("semrush_access_token", "semrush-within-skew-access");
    settingStore.set("semrush_token_expires_at", String(Date.now() + 30_000));
  },
  async refresh() {
    return semrushRefreshAccessToken();
  },
};

// (Google Ads adapter removed by Task #4008 — the platform connection and its
// rotating refresh token are gone; the env-trio mint has no rotation to race.)

const ADAPTERS = [zoomAdapter, semrushAdapter];

// --- case runners ----------------------------------------------------------

/** Winner instance: no sibling has refreshed yet (lease does not flip the
 * store), so the recheck still sees an expired token and the POST proceeds
 * exactly once. */
async function runWinnerPosts(a: ProviderAdapter): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  a.reset();
  a.seedExpired();
  const { lease, acquireCount, releaseCount } = makeLease();
  __setOAuthRefreshLeaseForTest(lease);
  try {
    await a.refresh();
    assert.equal(a.postCount(), 1, `${a.name}: winner must POST exactly once`);
    assert.ok(acquireCount() >= 1, `${a.name}: refresh must acquire the cross-process lease`);
    assert.equal(releaseCount(), acquireCount(), `${a.name}: lease must be released after acquire`);
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
  }
}

/** Loser instance: a sibling rotated a fresh (beyond-skew) token while we
 * waited for the lease, so the recheck reuses it and the POST is skipped.
 * Winner-POSTs (above) + this together prove two instances never both POST. */
async function runLoserReusesSiblingToken(a: ProviderAdapter): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  a.reset();
  a.seedExpired();
  const { lease, acquireCount, releaseCount } = makeLease(() => a.flipToFreshBeyondSkew());
  __setOAuthRefreshLeaseForTest(lease);
  try {
    const token = await a.refresh();
    assert.equal(
      a.postCount(),
      0,
      `${a.name}: loser must skip the POST when a sibling refreshed within the ${a.skewLabel} skew`,
    );
    assert.equal(
      token,
      a.siblingAccessToken,
      `${a.name}: loser must reuse the sibling-rotated token`,
    );
    assert.ok(acquireCount() >= 1, `${a.name}: refresh must acquire the cross-process lease`);
    assert.equal(
      releaseCount(),
      acquireCount(),
      `${a.name}: lease must be released even when the POST is skipped`,
    );
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
  }
}

/** The skew is honored, not blindly short-circuited: the sibling token is
 * inside the pre-expiry skew window (still needs refreshing), so the recheck
 * declines to reuse it and the POST proceeds. */
async function runWithinSkewStillPosts(a: ProviderAdapter): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  a.reset();
  a.seedExpired();
  const { lease } = makeLease(() => a.flipToWithinSkew());
  __setOAuthRefreshLeaseForTest(lease);
  try {
    await a.refresh();
    assert.equal(
      a.postCount(),
      1,
      `${a.name}: recheck must still POST when the stored token is inside the ${a.skewLabel} skew`,
    );
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
  }
}

async function main(): Promise<void> {
  installStorageStub();
  const cases: Array<[string, () => Promise<void>]> = [];
  for (const a of ADAPTERS) {
    cases.push([`${a.name}: winner POSTs exactly once under the lease`, () => runWinnerPosts(a)]);
    cases.push([
      `${a.name}: loser reuses the sibling-rotated token, no second POST`,
      () => runLoserReusesSiblingToken(a),
    ]);
    cases.push([
      `${a.name}: recheck honors the ${a.skewLabel} skew and re-POSTs when stale`,
      () => runWithinSkewStillPosts(a),
    ]);
  }
  try {
    for (const [name, fn] of cases) {
      try {
        await fn();
        console.log(`  ✓ ${name}`);
      } catch (err: any) {
        console.error(`  ✗ ${name}: ${err?.message ?? err}`);
        process.exitCode = 1;
      }
    }
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
    restoreStorageStub();
    globalThis.fetch = realFetch;
  }
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("oauth-refresh-cross-process-lease-per-provider test cases failed");
  }
  console.log("oauth-refresh-cross-process-lease-per-provider: OK");
}

await main();
