/* test-registration
{
  "name": "Lifetime-vs-monthly lead mismatch operator alert — emission, slide-formula parity, per-report dedupe (Task #4620)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4620: the Lifetime Value slide hides its compounding-arc chart when the trend window's per-source lead sum exceeds lifetimeValue.totalLeads, and until this alert existed the only signal was a browser console.warn no operator ever sees. This suite pins the serve-time twin: the exact slide formula (gbp+googleAds+lsa+webinar), dispatch only on windowTotal > totalLeads, per-report dedupe key lifetime_lead_mismatch:<reportId>, the slide's legacy-payload and <2-month gates, and test-mode inertness. Dispatcher fully stubbed, DB-free, milliseconds. A drift here re-opens the silent data-inconsistency class the alert exists to catch.",
  "tier": "small"
}
test-registration */
/**
 * Task #4620 — server/services/lifetimeLeadMismatchAlerts.ts is the
 * serve-time twin of the client gate added in Task #4592
 * (client/src/pages/publicReport/LifetimeValueSlide.tsx). Pins:
 *
 *   1. windowTotal > totalLeads dispatches exactly one notifyByType call
 *      with the registered id and dedupeKey `lifetime_lead_mismatch:<reportId>`,
 *      naming report/client/month and BOTH numbers (text + metadata).
 *   2. The window sum uses the slide's exact formula:
 *      (gbp||0)+(googleAds||0)+(lsa||0)+(webinar||0) per month.
 *   3. The slide's gates are mirrored: totalLeads <= 0, fewer than 2 months,
 *      or ANY month missing its per-source breakdown (legacy payload) never
 *      dispatch — and neither does windowTotal <= totalLeads (equal is fine:
 *      the slide charts carried-in = 0).
 *   4. Per-report dedupe: a repeat serve of the SAME report inside the
 *      re-alert window dispatches nothing further; a DIFFERENT report alerts
 *      independently.
 *   5. Under NODE_ENV=test with no injected stub the check is inert.
 *   6. The alert id is registered in the canonical registry.
 */
import assert from "node:assert/strict";

import {
  LIFETIME_LEAD_MISMATCH_NOTIFICATION_ID,
  LIFETIME_LEAD_MISMATCH_DEDUPE_PREFIX,
  checkLifetimeLeadMismatch,
  computeTrendWindowLeadTotal,
  __setLifetimeLeadMismatchNotifyForTest,
  __resetLifetimeLeadMismatchAlertsForTest,
  __drainLifetimeLeadMismatchAlertsForTest,
} from "../server/services/lifetimeLeadMismatchAlerts";
import { NOTIFICATION_REGISTRY } from "../server/services/notifications/registry";

interface CapturedNotify {
  id: string;
  payload: { text: string };
  options: Record<string, any>;
}

let captured: CapturedNotify[] = [];
const notifyStub = (async (id: any, payload: any, options?: any) => {
  captured.push({ id, payload, options: options ?? {} });
  return { outcome: "delivered" } as any;
}) as any;

function freshStub(): void {
  __resetLifetimeLeadMismatchAlertsForTest();
  captured = [];
  __setLifetimeLeadMismatchNotifyForTest(notifyStub);
}

const baseInput = {
  reportId: "report-a",
  clientId: "client-1",
  reportMonth: "2026-07",
  totalLeads: 100,
};

async function main(): Promise<void> {
  // ── 2. Formula parity with the slide ────────────────────────────────────
  assert.equal(
    computeTrendWindowLeadTotal([
      { gbp: 1, googleAds: 2, lsa: 3, webinar: 4 },
      { gbp: 10, googleAds: 0, lsa: 0, webinar: 0 },
    ]),
    20,
    "window total = per-month (gbp+googleAds+lsa+webinar) summed",
  );
  // Missing buckets coerce to 0 exactly like the slide's (s.x || 0).
  assert.equal(
    computeTrendWindowLeadTotal([{ gbp: 5 }, { lsa: 7 }]),
    12,
    "absent source buckets count as 0",
  );
  // Slide gates: <2 months, or any month without a breakdown → no claim.
  assert.equal(computeTrendWindowLeadTotal([{ gbp: 5 }]), null, "<2 months = null");
  assert.equal(
    computeTrendWindowLeadTotal([{ gbp: 5 }, undefined, { gbp: 1 }]),
    null,
    "any legacy month without leadsBySource = null",
  );
  console.log("  ok  (2) window formula matches the slide (incl. legacy/short gates)");

  // ── 1. Mismatch dispatches exactly once, with ids + both numbers ────────
  freshStub();
  checkLifetimeLeadMismatch({
    ...baseInput,
    monthlyLeadsBySource: [
      { gbp: 60, googleAds: 20, lsa: 15, webinar: 10 }, // 105
      { gbp: 30, googleAds: 5, lsa: 5, webinar: 5 }, // 45 → window 150 > 100
    ],
  });
  await __drainLifetimeLeadMismatchAlertsForTest();
  assert.equal(captured.length, 1, `mismatch dispatches exactly one alert (got ${captured.length})`);
  const alert = captured[0];
  assert.equal(alert.id, LIFETIME_LEAD_MISMATCH_NOTIFICATION_ID, "registered notification id");
  assert.equal(
    alert.options.dedupeKey,
    `${LIFETIME_LEAD_MISMATCH_DEDUPE_PREFIX}report-a`,
    "dedupeKey is per-report",
  );
  const text = String(alert.payload.text ?? "");
  for (const needle of ["report-a", "client-1", "2026-07", "150", "100"]) {
    assert.ok(text.includes(needle), `alert body names ${needle}`);
  }
  assert.equal(alert.options.metadata?.trendWindowLeadTotal, 150, "metadata window total");
  assert.equal(alert.options.metadata?.totalLeads, 100, "metadata lifetime headline");
  console.log("  ok  (1) one dispatch with registered id, per-report dedupeKey, both numbers");

  // ── 3. Non-mismatch inputs never dispatch ────────────────────────────────
  freshStub();
  // equal — the slide charts carried-in = 0, no inconsistency
  checkLifetimeLeadMismatch({
    ...baseInput,
    monthlyLeadsBySource: [{ gbp: 50 }, { gbp: 50 }],
  });
  // below headline
  checkLifetimeLeadMismatch({
    ...baseInput,
    reportId: "report-b",
    monthlyLeadsBySource: [{ gbp: 10 }, { gbp: 10 }],
  });
  // no headline (slide never attempts the arc)
  checkLifetimeLeadMismatch({
    ...baseInput,
    reportId: "report-c",
    totalLeads: 0,
    monthlyLeadsBySource: [{ gbp: 50 }, { gbp: 60 }],
  });
  // legacy month without breakdown (slide's legacy-payload gate)
  checkLifetimeLeadMismatch({
    ...baseInput,
    reportId: "report-d",
    monthlyLeadsBySource: [{ gbp: 500 }, undefined],
  });
  // single month (slide needs >= 2 points)
  checkLifetimeLeadMismatch({
    ...baseInput,
    reportId: "report-e",
    monthlyLeadsBySource: [{ gbp: 500 }],
  });
  await __drainLifetimeLeadMismatchAlertsForTest();
  assert.equal(captured.length, 0, "no dispatch for consistent/ungated payloads");
  console.log("  ok  (3) equal/below/zero-headline/legacy/single-month inputs stay silent");

  // ── 4. Per-report dedupe window ──────────────────────────────────────────
  freshStub();
  const mismatch = {
    ...baseInput,
    monthlyLeadsBySource: [{ gbp: 100 }, { gbp: 100 }], // 200 > 100
  };
  checkLifetimeLeadMismatch(mismatch);
  checkLifetimeLeadMismatch(mismatch); // hot share link, same report
  checkLifetimeLeadMismatch({ ...mismatch, reportId: "report-other" });
  await __drainLifetimeLeadMismatchAlertsForTest();
  assert.equal(captured.length, 2, "same report throttled in-process; different report alerts");
  assert.deepEqual(
    captured.map((c) => c.options.dedupeKey).sort(),
    [
      `${LIFETIME_LEAD_MISMATCH_DEDUPE_PREFIX}report-a`,
      `${LIFETIME_LEAD_MISMATCH_DEDUPE_PREFIX}report-other`,
    ],
    "one dispatch per distinct report",
  );
  console.log("  ok  (4) per-report re-alert throttle, independent reports alert");

  // ── 5. Test-mode inert without an injected stub ──────────────────────────
  __resetLifetimeLeadMismatchAlertsForTest(); // clears the stub too
  checkLifetimeLeadMismatch(mismatch); // must not touch the real dispatcher
  await __drainLifetimeLeadMismatchAlertsForTest();
  console.log("  ok  (5) NODE_ENV=test with no stub is inert (no dispatcher import)");

  // ── 6. Registry entry ────────────────────────────────────────────────────
  const entry = NOTIFICATION_REGISTRY.find((n) => n.id === LIFETIME_LEAD_MISMATCH_NOTIFICATION_ID);
  assert.ok(entry, "alert id is registered in the canonical registry");
  assert.equal(entry!.implemented, true, "registry entry marked implemented");
  console.log("  ok  (6) canonical registry entry present");

  __resetLifetimeLeadMismatchAlertsForTest();
}

main().then(
  () => {
    console.log("lifetime-lead-mismatch-alerts: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("lifetime-lead-mismatch-alerts: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
