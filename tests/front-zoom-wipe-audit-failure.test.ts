/* test-registration
{
  "name": "Front/Zoom wipe audit-write failure counter + operator alert (Task #3128)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3128: Front/Zoom credential-wipe audit-write failure visibility. The disconnect breadcrumb is the ONLY durable record of a Front/Zoom token wipe; if its INSERT fails the named per-integration counter must increment and the dedicated \"wipe_audit_write_failed\" alert must fire (mirrors the SEMrush pattern from Task #3126). Fast, pure in-memory: credential clears go to the in-memory override stores, audit + notify are stubbed — no shared dev-DB writes.",
  "tier": "small"
}
test-registration */
/**
 * Task #3128 — Front & Zoom credential-wipe audit-write failure visibility.
 *
 * Mirrors the "wipe audit write failure" case in tests/semrush-wipe-audit.test.ts
 * (Task #3126). The disconnect breadcrumb written via
 * storage.recordAdminSettingChange is the ONLY durable record of a Front/Zoom
 * credential wipe; before Task #3128 an insert failure was swallowed into a
 * console.error that expires with the autoscale deployment log window.
 *
 * Locked contract, per integration:
 *   1. The credential clear itself still completes (audit failure never
 *      blocks the wipe path).
 *   2. The named per-integration counter increments exactly once
 *      (front.wipe_audit_write_failed / zoom.wipe_audit_write_failed).
 *   3. A dedicated low-severity operator alert fires on the integration's
 *      auth notification type with dedupeKey "wipe_audit_write_failed",
 *      naming the counter and carrying the audit error.
 *   4. Success path: when the audit insert succeeds, the counter does NOT
 *      increment and no audit-failure alert fires.
 *
 * Pure in-memory: credential clears are routed to the in-memory credential
 * store overrides (__setFrontCredentialStoreOverrideForTests /
 * __setZoomCredentialStoreOverrideForTests) so the shared dev DB's real
 * tokens are never touched; recordAdminSettingChange is stubbed via the
 * (storage as any) pattern; the alert is captured via the injected notify
 * overrides so no real notification is dispatched.
 */
import { strict as assert } from "node:assert";

process.env.NODE_ENV = "test";

import { storage } from "../server/storage";
import {
  disconnect as frontDisconnect,
  __setFrontCredentialStoreOverrideForTests,
  __setFrontWipeAuditNotifyOverrideForTest,
  __resetFrontWipeAuditWriteFailedCountForTest,
  getFrontWipeAuditWriteFailedCount,
  FRONT_WIPE_AUDIT_WRITE_FAILED_COUNTER,
} from "../server/services/frontIntegration";
import {
  disconnect as zoomDisconnect,
  __setZoomCredentialStoreOverrideForTests,
  __setZoomWipeAuditNotifyOverrideForTest,
  __resetZoomWipeAuditWriteFailedCountForTest,
  getZoomWipeAuditWriteFailedCount,
  ZOOM_WIPE_AUDIT_WRITE_FAILED_COUNTER,
} from "../server/services/zoomIntegration";

const originalRecord = (storage as any).recordAdminSettingChange;

interface AuditCall {
  settingKey: string;
  scope: string;
  changedBy: string | null;
  oldValues: unknown;
  newValues: unknown;
}

type StubState = {
  auditCalls: AuditCall[];
  notifyCalls: Array<[string, any, any]>;
  credentialStore: Map<string, string>;
};

function installStubs(opts: { failAuditWrite: boolean }): StubState {
  const state: StubState = {
    auditCalls: [],
    notifyCalls: [],
    credentialStore: new Map<string, string>([["seed", "present"]]),
  };

  (storage as any).recordAdminSettingChange = async (data: AuditCall) => {
    if (opts.failAuditWrite) {
      throw new Error("simulated pool exhaustion: audit insert failed");
    }
    state.auditCalls.push(data);
    return data;
  };

  __setFrontCredentialStoreOverrideForTests(state.credentialStore);
  __setZoomCredentialStoreOverrideForTests(state.credentialStore);

  const capture = async (id: string, payload: any, notifyOpts: any) => {
    state.notifyCalls.push([id, payload, notifyOpts]);
  };
  __setFrontWipeAuditNotifyOverrideForTest(capture);
  __setZoomWipeAuditNotifyOverrideForTest(capture);

  return state;
}

function restoreAll(): void {
  (storage as any).recordAdminSettingChange = originalRecord;
  __setFrontCredentialStoreOverrideForTests(null);
  __setZoomCredentialStoreOverrideForTests(null);
  __setFrontWipeAuditNotifyOverrideForTest(null);
  __setZoomWipeAuditNotifyOverrideForTest(null);
  __resetFrontWipeAuditWriteFailedCountForTest();
  __resetZoomWipeAuditWriteFailedCountForTest();
}

// ---------------------------------------------------------------------------
// Shared assertion body for the failure case.
// ---------------------------------------------------------------------------
async function runFailureCase(
  integration: "front" | "zoom",
): Promise<void> {
  __resetFrontWipeAuditWriteFailedCountForTest();
  __resetZoomWipeAuditWriteFailedCountForTest();
  const state = installStubs({ failAuditWrite: true });
  try {
    const doDisconnect = integration === "front" ? frontDisconnect : zoomDisconnect;
    // The disconnect must NOT throw even though the audit insert fails.
    await doDisconnect(undefined, {
      trigger: "connect_terminal_auth_error",
      reason: "test: simulated terminal auth error",
    } as any);

    // 1. The credential clear itself completed (keys blanked in the
    //    in-memory override store — Front clears 4 keys, Zoom clears 3).
    const clearedKeys = [...state.credentialStore.entries()].filter(
      ([k, v]) => k !== "seed" && v === "",
    );
    assert.ok(
      clearedKeys.length >= 3,
      `${integration}: credential keys must still be cleared when the audit insert fails (got ${clearedKeys.length})`,
    );

    // 2. No audit row landed (insert was simulated to fail).
    assert.equal(
      state.auditCalls.length,
      0,
      `${integration}: audit insert was simulated to fail — no audit row recorded`,
    );

    // 3. Named counter incremented exactly once, on the right integration.
    const expectedCount = integration === "front"
      ? getFrontWipeAuditWriteFailedCount()
      : getZoomWipeAuditWriteFailedCount();
    const otherCount = integration === "front"
      ? getZoomWipeAuditWriteFailedCount()
      : getFrontWipeAuditWriteFailedCount();
    assert.equal(
      expectedCount,
      1,
      `${integration}.wipe_audit_write_failed counter must increment exactly once`,
    );
    assert.equal(
      otherCount,
      0,
      `the OTHER integration's counter must NOT increment`,
    );

    // 4. Dedicated alert fired with the distinct dedupeKey on the
    //    integration's own auth notification type.
    assert.equal(
      state.notifyCalls.length,
      1,
      `${integration}: exactly one audit-failure alert must fire`,
    );
    const [alertId, alertPayload, alertOpts] = state.notifyCalls[0];
    assert.equal(
      alertId,
      integration === "front"
        ? "integration.front.auth_failed"
        : "integration.zoom.auth_failed",
    );
    assert.equal(alertOpts.dedupeKey, "wipe_audit_write_failed");
    const counterName = integration === "front"
      ? FRONT_WIPE_AUDIT_WRITE_FAILED_COUNTER
      : ZOOM_WIPE_AUDIT_WRITE_FAILED_COUNTER;
    assert.ok(
      typeof alertPayload?.text === "string" &&
        alertPayload.text.includes(counterName) &&
        alertPayload.text.includes("simulated pool exhaustion") &&
        alertPayload.text.includes("connect_terminal_auth_error"),
      `${integration}: alert text must name the counter, carry the audit error, and the wipe trigger`,
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// Success path — audit insert lands, counter stays at 0, no failure alert.
// ---------------------------------------------------------------------------
async function runSuccessCase(integration: "front" | "zoom"): Promise<void> {
  __resetFrontWipeAuditWriteFailedCountForTest();
  __resetZoomWipeAuditWriteFailedCountForTest();
  const state = installStubs({ failAuditWrite: false });
  try {
    const doDisconnect = integration === "front" ? frontDisconnect : zoomDisconnect;
    await doDisconnect("admin-user-1", {
      trigger: "manual_disconnect",
      reason: "test: routine manual disconnect",
    } as any);

    assert.equal(
      state.auditCalls.length,
      1,
      `${integration}: the disconnect audit breadcrumb must be written on the success path`,
    );
    assert.equal(state.auditCalls[0].scope, "manual_disconnect");
    assert.equal(getFrontWipeAuditWriteFailedCount(), 0, "front counter must stay 0");
    assert.equal(getZoomWipeAuditWriteFailedCount(), 0, "zoom counter must stay 0");
    assert.equal(
      state.notifyCalls.length,
      0,
      `${integration}: no audit-failure alert may fire when the insert succeeds`,
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    [
      "Front wipe audit write failure → clear completes, counter increments, dedicated alert fires",
      () => runFailureCase("front"),
    ],
    [
      "Zoom wipe audit write failure → clear completes, counter increments, dedicated alert fires",
      () => runFailureCase("zoom"),
    ],
    [
      "Front success path → audit row written, counter 0, no failure alert",
      () => runSuccessCase("front"),
    ],
    [
      "Zoom success path → audit row written, counter 0, no failure alert",
      () => runSuccessCase("zoom"),
    ],
  ];

  let failures = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      failures++;
      console.error(`  ✗ ${name}: ${err?.message ?? err}`);
      if (err?.stack) console.error(err.stack);
    }
  }

  if (failures > 0) {
    throw new Error(`front-zoom-wipe-audit-failure: ${failures} test(s) failed`);
  }
  console.log("front-zoom-wipe-audit-failure: OK");
}

let exitCode = 0;
main()
  .catch((err) => {
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
