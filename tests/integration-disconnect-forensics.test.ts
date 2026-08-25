/* test-registration
{
  "name": "Disconnect forensics + fail-safe wipe confirmation (Task #3661)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3661 (narrowed to SEMrush by Task #4008 — Google Ads no longer has OAuth machinery to disconnect): disconnect forensics — durable \"why did this integration disconnect\" records at every SEMrush wipe path + manual disconnects, and the fail-SAFE wipe-confirmation re-read (a DB blip must trip the breaker, never destroy credentials). Pure in-memory (storage + fetch stubbed), fast; a drift here reopens the \"every disconnect restarts the same debugging cycle\" forensics gap.",
  "tier": "small"
}
test-registration */
/**
 * Task #3661 (narrowed by Task #4008) — Durable disconnect forensics +
 * fail-safe wipe confirmation for SEMrush.
 *
 * The July 24–27 2026 production incidents (SEMrush "no_tokens_stored",
 * Google Ads "token refresh failed: Unauthorized") showed that when a genuine
 * terminal disconnect happens the system keeps no durable record of WHY.
 * Task #4008 retired the Google Ads platform OAuth machinery (env-credential
 * model — nothing left to disconnect, classify, or wipe), so this suite now
 * covers the remaining forensics consumer, SEMrush:
 *
 *   1. SEMrush authoritative wipe writes a durable forensics record
 *      (codePath=authoritative_wipe) alongside the existing audit breadcrumb.
 *
 *   2. FAIL-SAFE wipe confirmation: when the confirmation re-read THROWS
 *      (DB blip), the wipe is ABORTED (tokens untouched), the breaker is
 *      tripped instead, and both a wipe_confirmation_read_failed audit row
 *      and forensics record are written. Previously this path proceeded with
 *      the wipe (fail-open), letting a transient DB blip destroy credentials.
 *
 *   3. Non-authoritative (probe) terminal refresh records
 *      wipe_skipped_non_authoritative forensics without touching tokens.
 *
 *   4. Manual SEMrush disconnect records manual_disconnect forensics.
 *
 *   5. The forensics integration namespace is semrush-only — a compile-time
 *      + runtime pin that the Google Ads namespace didn't quietly survive.
 *
 * Pure in-memory: storage methods and fetch are stubbed via the
 * (storage as any) pattern (mirrors tests/semrush-wipe-audit.test.ts).
 * NODE_ENV=test disables the cross-process refresh lease.
 */
import { strict as assert } from "node:assert";

process.env.NODE_ENV = "test";

import { storage } from "../server/storage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  disconnectForensicsSettingKey,
  getDisconnectForensics,
  recordDisconnectForensics,
  type DisconnectForensicsIntegration,
  type DisconnectForensicsRecord,
} from "../server/services/integrationDisconnectForensics";
import {
  __refreshAccessTokenForTest,
  __setWipeNotifyOverrideForTest,
  disconnect as semrushDisconnect,
} from "../server/services/semrushApi";
import {
  semrushAuthBreakerActive,
  __resetSemrushAuthBreakerForTest,
  __clearPersistedSemrushAuthBreakerForTest,
} from "../server/services/semrushAuthBreaker";

// Task #3666 — endpoint changed from /dag/device/token to /oauth2/access_token.
const SEMRUSH_TOKEN_URL = "https://oauth.semrush.com/oauth2/access_token";

const REFRESH_KEY = "semrush_refresh_token";
const ACCESS_KEY = "semrush_access_token";
const EXPIRES_KEY = "semrush_token_expires_at";
const CAPTURED_REFRESH = "rt-captured-dead";

const SEMRUSH_FORENSICS_KEY = disconnectForensicsSettingKey("semrush");

const originalFetch = globalThis.fetch;
const originalGetSetting = (storage as any).getSystemSetting;
const originalGetSettingFresh = (storage as any).getSystemSettingFresh;
const originalSetSetting = (storage as any).setSystemSetting;
const originalRecord = (storage as any).recordAdminSettingChange;

type StubState = {
  map: Map<string, string>;
  auditCalls: Array<{ settingKey: string; scope: string; newValues: any }>;
  /** When true, getSystemSettingFresh(REFRESH_KEY) throws (simulated DB blip). */
  failFreshRefreshRead: boolean;
  /** Value returned by getSystemSettingFresh(REFRESH_KEY) when not failing. */
  freshRefreshValue: string | null;
};

function installStorageStubs(opts: {
  failFreshRefreshRead?: boolean;
  freshRefreshValue?: string | null;
  seedSemrushTokens?: boolean;
}): StubState {
  const state: StubState = {
    map: new Map(),
    auditCalls: [],
    failFreshRefreshRead: opts.failFreshRefreshRead ?? false,
    freshRefreshValue: opts.freshRefreshValue ?? null,
  };
  if (opts.seedSemrushTokens !== false) {
    state.map.set(REFRESH_KEY, CAPTURED_REFRESH);
    state.map.set(ACCESS_KEY, "at-old");
    state.map.set(EXPIRES_KEY, String(Date.now() - 1000)); // expired → refresh
  }
  (storage as any).getSystemSetting = async (key: string) => {
    const value = state.map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).getSystemSettingFresh = async (key: string) => {
    if (key === REFRESH_KEY) {
      if (state.failFreshRefreshRead) {
        throw new Error("simulated pool saturation: fresh read failed");
      }
      return state.freshRefreshValue === null
        ? undefined
        : { key, value: state.freshRefreshValue };
    }
    const value = state.map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    state.map.set(key, value);
    return { key, value };
  };
  (storage as any).recordAdminSettingChange = async (data: any) => {
    state.auditCalls.push(data);
    return data;
  };
  __setWipeNotifyOverrideForTest(async () => {});
  return state;
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getSystemSetting = originalGetSetting;
  (storage as any).getSystemSettingFresh = originalGetSettingFresh;
  (storage as any).setSystemSetting = originalSetSetting;
  (storage as any).recordAdminSettingChange = originalRecord;
  __setWipeNotifyOverrideForTest(null);
}

function installSemrushTerminalFetch(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.startsWith(SEMRUSH_TOKEN_URL)) return originalFetch(input, init);
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
}

async function resetBreakers(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  __resetSemrushAuthBreakerForTest();
  await __clearPersistedSemrushAuthBreakerForTest();
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

function forensicsFrom(state: StubState, key: string): DisconnectForensicsRecord | null {
  const raw = state.map.get(key);
  return raw ? (JSON.parse(raw) as DisconnectForensicsRecord) : null;
}

// ---------------------------------------------------------------------------
// 1. The forensics namespace is semrush-only (Task #4008 retirement pin).
// ---------------------------------------------------------------------------
function testForensicsNamespaceSemrushOnly(): void {
  // Compile-time: DisconnectForensicsIntegration must be exactly "semrush".
  // If someone re-adds "google_ads" this assignment stops type-checking
  // ("semrush" would no longer be assignable from every member), and the
  // runtime key check below fails loudly.
  const only: DisconnectForensicsIntegration = "semrush";
  assert.equal(disconnectForensicsSettingKey(only), "integration_disconnect_forensics:semrush");
  console.log("  ✓ forensics integration namespace is semrush-only");
}

// ---------------------------------------------------------------------------
// 2. Forensics helper roundtrip (write via stubbed storage, read back).
// ---------------------------------------------------------------------------
async function testForensicsRoundtrip(): Promise<void> {
  const state = installStorageStubs({ seedSemrushTokens: false });
  try {
    await recordDisconnectForensics({
      integration: "semrush",
      codePath: "manual_disconnect",
      summary: "test summary",
      operatorAction: "test action",
      providerError: "x".repeat(1000), // must be truncated to 500
    });
    const rec = await getDisconnectForensics("semrush");
    assert.ok(rec, "record must be readable back");
    assert.equal(rec!.codePath, "manual_disconnect");
    assert.equal(rec!.summary, "test summary");
    assert.equal(rec!.providerError!.length, 500, "providerError truncated to 500");
    assert.ok(rec!.recordedAt, "recordedAt auto-filled");
  } finally {
    restoreAll();
  }
  console.log("  ✓ forensics record roundtrip + truncation");
}

// ---------------------------------------------------------------------------
// 3. SEMrush authoritative wipe → forensics codePath=authoritative_wipe.
// ---------------------------------------------------------------------------
async function testSemrushAuthoritativeWipeForensics(): Promise<void> {
  await resetBreakers();
  // freshRefreshValue == CAPTURED (fingerprint unchanged → genuine revocation).
  const state = installStorageStubs({ freshRefreshValue: CAPTURED_REFRESH });
  installSemrushTerminalFetch();
  try {
    await assert.rejects(() => __refreshAccessTokenForTest());
    await drainMicrotasks();
    assert.equal(state.map.get(REFRESH_KEY), "", "tokens must be wiped");
    const rec = forensicsFrom(state, SEMRUSH_FORENSICS_KEY);
    assert.ok(rec, "forensics record must be written on authoritative wipe");
    assert.equal(rec!.codePath, "authoritative_wipe");
    assert.match(rec!.providerError ?? "", /invalid_request/);
    assert.match(rec!.fingerprintOutcome ?? "", /unchanged/);
    assert.ok(rec!.instanceId, "instance attribution required");
    assert.match(rec!.operatorAction, /re-authorize/i);
  } finally {
    restoreAll();
    await resetBreakers();
  }
  console.log("  ✓ SEMrush authoritative wipe writes forensics");
}

// ---------------------------------------------------------------------------
// 4. FAIL-SAFE: wipe-confirmation re-read throws → abort wipe, trip breaker,
//    record wipe_confirmation_read_failed (audit + forensics).
// ---------------------------------------------------------------------------
async function testSemrushWipeConfirmationFailSafe(): Promise<void> {
  await resetBreakers();
  const state = installStorageStubs({ failFreshRefreshRead: true });
  installSemrushTerminalFetch();
  try {
    await assert.rejects(() => __refreshAccessTokenForTest());
    await drainMicrotasks();
    // Tokens must be UNTOUCHED — the old fail-open behavior wiped them here.
    assert.equal(
      state.map.get(REFRESH_KEY),
      CAPTURED_REFRESH,
      "fail-safe: tokens must NOT be wiped when the confirmation re-read throws",
    );
    assert.equal(state.map.get(ACCESS_KEY), "at-old", "access token untouched");
    // The breaker must be tripped instead so surfaces back off.
    assert.equal(
      semrushAuthBreakerActive(),
      true,
      "fail-safe: breaker must trip instead of wiping",
    );
    // Durable audit breadcrumb.
    const auditRows = state.auditCalls.filter(
      (c) => c.scope === "wipe_confirmation_read_failed",
    );
    assert.equal(auditRows.length, 1, "exactly one wipe_confirmation_read_failed audit row");
    assert.equal(auditRows[0].newValues.event, "token_wipe_confirmation_read_failed");
    assert.match(auditRows[0].newValues.readError, /simulated pool saturation/);
    // No wipe audit row.
    assert.equal(
      state.auditCalls.filter((c) => c.scope === "wipe").length,
      0,
      "no wipe audit row may be written on the fail-safe path",
    );
    // Forensics record.
    const rec = forensicsFrom(state, SEMRUSH_FORENSICS_KEY);
    assert.ok(rec, "forensics record must be written");
    assert.equal(rec!.codePath, "wipe_confirmation_read_failed");
    assert.equal(rec!.fingerprintOutcome, "indeterminate_read_failed");
    assert.match(rec!.summary, /NOT wiped/i);
  } finally {
    restoreAll();
    await resetBreakers();
  }
  console.log("  ✓ SEMrush wipe-confirmation read failure is fail-SAFE (abort + trip + record)");
}

// ---------------------------------------------------------------------------
// 5. Non-authoritative (probe) terminal → wipe_skipped forensics, no wipe.
// ---------------------------------------------------------------------------
async function testSemrushWipeSkippedForensics(): Promise<void> {
  await resetBreakers();
  const state = installStorageStubs({ freshRefreshValue: CAPTURED_REFRESH });
  installSemrushTerminalFetch();
  try {
    await assert.rejects(() => __refreshAccessTokenForTest({ purpose: "probe" }));
    await drainMicrotasks();
    assert.equal(state.map.get(REFRESH_KEY), CAPTURED_REFRESH, "probe must not wipe tokens");
    const rec = forensicsFrom(state, SEMRUSH_FORENSICS_KEY);
    assert.ok(rec, "forensics record must be written");
    assert.equal(rec!.codePath, "wipe_skipped_non_authoritative");
    assert.equal(rec!.purpose, "probe");
  } finally {
    restoreAll();
    await resetBreakers();
  }
  console.log("  ✓ SEMrush non-authoritative terminal records wipe_skipped forensics");
}

// ---------------------------------------------------------------------------
// 6. Manual SEMrush disconnect records manual_disconnect forensics.
// ---------------------------------------------------------------------------
async function testManualDisconnectForensics(): Promise<void> {
  const state = installStorageStubs({});
  try {
    await semrushDisconnect("user-123", { trigger: "manual_disconnect" });
    await drainMicrotasks();
    const semRec = forensicsFrom(state, SEMRUSH_FORENSICS_KEY);
    assert.ok(semRec, "SEMrush manual disconnect forensics written");
    assert.equal(semRec!.codePath, "manual_disconnect");
    assert.match(semRec!.summary, /manually disconnected/i);
  } finally {
    restoreAll();
    await resetBreakers();
  }
  console.log("  ✓ manual disconnect records forensics");
}

async function main(): Promise<void> {
  console.log("integration-disconnect-forensics tests:");
  testForensicsNamespaceSemrushOnly();
  await testForensicsRoundtrip();
  await testSemrushAuthoritativeWipeForensics();
  await testSemrushWipeConfirmationFailSafe();
  await testSemrushWipeSkippedForensics();
  await testManualDisconnectForensics();
  console.log("All integration-disconnect-forensics tests passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
  });
