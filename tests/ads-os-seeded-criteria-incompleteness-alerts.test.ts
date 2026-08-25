/* test-registration
{
  "name": "Ads OS seeded criteria incompleteness alerts — isSeededMinimal, isOverdue, daily-dedupe, alert firing and suppression (Task #4832)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4832: core alert-service logic is pure-function and fetch-free. isSeededMinimal and isOverdue are deterministic helpers; the check function uses injected read/dispatch stubs so no DB or Slack call is touched. Fast unit test that guards the 7-day grace window and single-alert-per-day dedupe invariant.",
  "tier": "small"
}
test-registration */
/**
 * Task #4832 regression tests: Ads OS seeded criteria incompleteness alert.
 *
 * Coverage:
 *   1. isSeededMinimal — correctly identifies seeded-only vs operator-filled docs.
 *   2. isOverdue — correctly applies the 7-day grace window.
 *   3. No doc in store → skipped (only seeded docs are relevant).
 *   4. Doc within grace window → skipped_none_overdue.
 *   5. Doc past grace window → alert fired with overdue client list.
 *   6. Second call on same UTC day → skipped_already_alerted_today.
 *   7. Call on next UTC day → fires again.
 *   8. Kill switch disabled → skipped_disabled (baseline not advanced, fires after re-enable).
 *   9. Operator fills in business_name → no longer seeded-minimal, not included.
 *  10. Mixed: one overdue + one within window → only overdue client in alert.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import {
  isSeededMinimal,
  isOverdue,
  checkSeededCriteriaIncompletenessAlert,
  __testHelpers,
} from "../server/services/adsOs/seededCriteriaIncompletenessAlerts";

// ── helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const { STALE_THRESHOLD_MS } = __testHelpers;

/** Returns a fake doc seeded N days ago (no operator fields). */
function seededDoc(daysAgo: number): Record<string, any> {
  const seededAt = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  return { updated_at: seededAt, schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"] };
}

/** Returns a doc that an operator has saved (has business_name). */
function operatorDoc(): Record<string, any> {
  return {
    updated_at: new Date().toISOString(),
    business_name: "Acme Law",
    service_area: "Atlanta, GA",
    schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  };
}

interface DispatchCall {
  text: string;
  notificationId: string;
}

function makeDispatcher(calls: DispatchCall[], delivered = true) {
  return async (
    id: string,
    payload: { text: string },
    _opts: unknown,
  ): Promise<{ delivered: boolean; status?: string }> => {
    calls.push({ notificationId: id, text: payload.text });
    return { delivered };
  };
}

function cleanup(): void {
  __testHelpers.resetForTests();
}

// ── 1. isSeededMinimal ────────────────────────────────────────────────────────

{
  const label = "isSeededMinimal";
  // No operator fields at all
  assert.equal(
    isSeededMinimal({ updated_at: new Date().toISOString(), schedule_days: ["Mon"] }),
    true,
    `${label}: schedule-only doc should be minimal`,
  );
  // Has business_name
  assert.equal(
    isSeededMinimal({ business_name: "Acme", service_area: "" }),
    false,
    `${label}: doc with business_name should not be minimal`,
  );
  // Has service_area only
  assert.equal(
    isSeededMinimal({ business_name: "", service_area: "Atlanta, GA" }),
    false,
    `${label}: doc with service_area should not be minimal`,
  );
  // Empty strings: still minimal
  assert.equal(
    isSeededMinimal({ business_name: "   ", service_area: "  " }),
    true,
    `${label}: whitespace-only fields still count as minimal`,
  );
  // Both present
  assert.equal(
    isSeededMinimal({ business_name: "Acme", service_area: "Atlanta, GA" }),
    false,
    `${label}: both fields present → not minimal`,
  );
}

// ── 2. isOverdue ─────────────────────────────────────────────────────────────

{
  const label = "isOverdue";
  const now = Date.now();
  // 8 days ago — past threshold
  assert.equal(
    isOverdue({ updated_at: new Date(now - 8 * DAY_MS).toISOString() }, now),
    true,
    `${label}: 8 days old should be overdue`,
  );
  // 6 days ago — within grace window
  assert.equal(
    isOverdue({ updated_at: new Date(now - 6 * DAY_MS).toISOString() }, now),
    false,
    `${label}: 6 days old should NOT be overdue`,
  );
  // Exactly at threshold — NOT overdue (>= semantics)
  assert.equal(
    isOverdue({ updated_at: new Date(now - STALE_THRESHOLD_MS + 1000).toISOString() }, now),
    false,
    `${label}: just under threshold should not be overdue`,
  );
  // Missing updated_at — can't determine age → not overdue
  assert.equal(
    isOverdue({}, now),
    false,
    `${label}: missing updated_at → not overdue`,
  );
}

// ── 3-10. checkSeededCriteriaIncompletenessAlert ──────────────────────────────

// ── 3. No doc in store → not included ────────────────────────────────────────
cleanup();
{
  __testHelpers.setReadForTests(async () => null); // all docs absent
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  const r = await checkSeededCriteriaIncompletenessAlert(Date.now());
  assert.equal(r.overdueClients.length, 0, "3: no docs → no overdue clients");
  assert.equal(r.decision, "skipped_none_overdue", "3: decision");
  assert.equal(calls.length, 0, "3: no dispatch call");
}

// ── 4. Doc within grace window → not overdue ─────────────────────────────────
cleanup();
{
  __testHelpers.setReadForTests(async () => seededDoc(3)); // 3 days ago
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  const r = await checkSeededCriteriaIncompletenessAlert(Date.now());
  assert.equal(r.overdueClients.length, 0, "4: within grace window → no overdue");
  assert.equal(r.decision, "skipped_none_overdue", "4: decision");
  assert.equal(calls.length, 0, "4: no dispatch");
}

// ── 5. Overdue doc → alert fired ─────────────────────────────────────────────
cleanup();
{
  __testHelpers.setReadForTests(async () => seededDoc(8)); // 8 days old
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  const r = await checkSeededCriteriaIncompletenessAlert(Date.now());
  assert.ok(r.overdueClients.length > 0, "5: should have overdue clients");
  assert.equal(r.decision, "alerted", "5: decision should be alerted");
  assert.equal(calls.length, 1, "5: exactly one dispatch call");
  assert.ok(calls[0].text.includes("seeded criteria"), "5: text mentions seeded criteria");
  assert.ok(
    calls[0].notificationId === __testHelpers.NOTIFICATION_ID,
    "5: correct notification id",
  );
}

// ── 6. Second call same day → skipped ────────────────────────────────────────
cleanup();
{
  __testHelpers.setReadForTests(async () => seededDoc(8));
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  const now = Date.now();
  await checkSeededCriteriaIncompletenessAlert(now);
  assert.equal(__testHelpers.getLastAlertedDate(), new Date(now).toISOString().slice(0, 10), "6: lastAlertedDate set");

  // Second call on same day
  const r2 = await checkSeededCriteriaIncompletenessAlert(now + 1000);
  assert.equal(r2.decision, "skipped_already_alerted_today", "6: second call skipped");
  assert.equal(calls.length, 1, "6: only one dispatch total");
}

// ── 7. Call on next UTC day → fires again ────────────────────────────────────
cleanup();
{
  __testHelpers.setReadForTests(async () => seededDoc(8));
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  // Simulate: already alerted yesterday
  const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  __testHelpers.setLastAlertedDate(yesterday);

  const r = await checkSeededCriteriaIncompletenessAlert(Date.now());
  assert.equal(r.decision, "alerted", "7: next day should fire again");
  assert.equal(calls.length, 1, "7: one dispatch on next day");
}

// ── 8. Kill switch disabled → skipped_disabled ────────────────────────────────
cleanup();
{
  // Inject disabled state without touching the real DB.
  __testHelpers.setIsEnabledForTests(async () => false);
  __testHelpers.setReadForTests(async () => seededDoc(8));
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));

  const r = await checkSeededCriteriaIncompletenessAlert(Date.now());
  assert.equal(r.decision, "skipped_disabled", "8: kill switch → skipped_disabled");
  assert.equal(calls.length, 0, "8: no dispatch when disabled");
  // lastAlertedDate not set — re-enabling tomorrow should fire
  assert.equal(__testHelpers.getLastAlertedDate(), null, "8: lastAlertedDate not advanced");
}

// ── 9. Operator-filled doc → not seeded-minimal → excluded ───────────────────
cleanup();
{
  __testHelpers.setReadForTests(async () => operatorDoc());
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  const r = await checkSeededCriteriaIncompletenessAlert(Date.now());
  assert.equal(r.overdueClients.length, 0, "9: operator-filled docs excluded");
  assert.equal(r.decision, "skipped_none_overdue", "9: decision");
  assert.equal(calls.length, 0, "9: no dispatch");
}

// ── 10. Mixed: one overdue + one within window ────────────────────────────────
cleanup();
{
  let callCount = 0;
  const targets = await import("../server/services/prodActions/platformOpsActions").then(
    (m) => m.SCHEDULE_SYNC_TARGETS,
  );
  __testHelpers.setReadForTests(async (_cid: string) => {
    // Alternate: first client 8 days old, rest within window
    callCount++;
    return callCount === 1 ? seededDoc(8) : seededDoc(3);
  });
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  const r = await checkSeededCriteriaIncompletenessAlert(Date.now());
  assert.equal(r.overdueClients.length, 1, "10: only the 8-day-old doc is overdue");
  assert.equal(r.decision, "alerted", "10: decision");
  // Text should mention exactly 1 client by name (the first SCHEDULE_SYNC_TARGET)
  assert.ok(
    r.overdueClients[0].client === targets[0].client,
    `10: overdue client is ${targets[0].client}`,
  );
}

// ── 11. Full lifecycle: seed → alert fires → operator saves → alert clears ────
cleanup();
{
  // Phase 1: client has a seeded-minimal doc that is overdue
  __testHelpers.setReadForTests(async () => seededDoc(8));
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  const day1 = Date.now();
  const r1 = await checkSeededCriteriaIncompletenessAlert(day1);
  assert.ok(r1.overdueClients.length > 0, "11a: seeded doc is overdue — clients in list");
  assert.equal(r1.decision, "alerted", "11a: alert fires on overdue seeded doc");
  assert.equal(calls.length, 1, "11a: exactly one dispatch call");

  // Phase 2: operator saves the criteria doc (business_name + service_area filled in).
  // Simulate this by switching the read stub to return an operator-filled doc.
  __testHelpers.setReadForTests(async () => operatorDoc());

  // Even on a new UTC day (next day), the alert should not fire because the doc is
  // no longer seeded-minimal — it's been completed by the operator.
  const day2 = day1 + DAY_MS; // next calendar day
  const r2 = await checkSeededCriteriaIncompletenessAlert(day2);
  assert.equal(r2.overdueClients.length, 0, "11b: operator-saved doc → no overdue clients");
  assert.equal(r2.decision, "skipped_none_overdue", "11b: alert does not fire after operator saves");
  assert.equal(calls.length, 1, "11b: no additional dispatch after operator fills in doc");
}

// ── 12. All SCHEDULE_SYNC_TARGETS have operator-filled docs → zero overdue, no dispatch ──
cleanup();
{
  const targets = await import("../server/services/prodActions/platformOpsActions").then(
    (m) => m.SCHEDULE_SYNC_TARGETS,
  );

  // Record every CID the check loop actually reads so we can verify full coverage.
  const readCids: string[] = [];
  __testHelpers.setReadForTests(async (cid: string) => {
    readCids.push(cid);
    return operatorDoc(); // all targets: operator has filled business_name + service_area
  });
  const calls: DispatchCall[] = [];
  __testHelpers.setDispatcherForTests(makeDispatcher(calls));
  __testHelpers.setIsEnabledForTests(async () => true);

  const r = await checkSeededCriteriaIncompletenessAlert(Date.now());

  // Core invariants: no overdue clients, no dispatch.
  assert.equal(
    r.overdueClients.length,
    0,
    `12: all ${targets.length} targets operator-filled → overdueClients.length === 0`,
  );
  assert.equal(r.decision, "skipped_none_overdue", "12: decision is skipped_none_overdue");
  assert.equal(calls.length, 0, "12: no dispatch fired when all docs are complete");

  // Verify the full loop: every SCHEDULE_SYNC_TARGET CID must have been queried.
  const expectedCids = targets.map((t) => t.cid).sort();
  const observedCids = [...readCids].sort();
  assert.equal(
    observedCids.length,
    expectedCids.length,
    `12: read stub called once per target (expected ${expectedCids.length}, got ${observedCids.length})`,
  );
  assert.deepEqual(
    observedCids,
    expectedCids,
    "12: every SCHEDULE_SYNC_TARGET CID was queried by the check loop",
  );
}

// Final cleanup
cleanup();
