/* test-registration
{
  "name": "Hide Other leads — display-time adjustment on all report surfaces (Task #2758)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2758: the `adjustDisplayLeads` helper is the single display-time correction point for the \"Hide Other leads\" toggle on ReportComparison and TrendAnalytics (both previously showed raw persisted totals that silently included Other). Gate this fast, DB-free unit test so a regression in the subtraction, the floor-at-zero guard, or the toggle on/off branches fails fast and is traceable to this surface.",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import { adjustDisplayLeads, adjustLeadToConsultRate } from "../shared/missedCallRate";

/**
 * Task #2758 — "Hide Other leads" on every report surface.
 *
 * Guards the display-time `adjustDisplayLeads` helper that ReportComparison
 * and TrendAnalytics use to suppress the Other bucket from displayed lead
 * totals when a client's `hideOtherLeads` flag is ON.
 *
 * The critical invariant: when the flag is ON the admin view must show the
 * same lead total the client sees on the public report — i.e.
 * `intake.totalLeads − marketing.otherLeads.count`. When OFF the raw
 * persisted total is returned unchanged.
 *
 * These are pure function tests — no DB, no network, no jsdom. Fast and
 * deterministic; suitable for the smoke gate.
 */
async function run() {
  // === toggle OFF — persisted total passes through unchanged ===
  assert.equal(
    adjustDisplayLeads(1007, 544, false),
    1007,
    "OFF: raw persisted total returned as-is",
  );
  assert.equal(
    adjustDisplayLeads(0, 0, false),
    0,
    "OFF: zero total stays zero",
  );
  assert.equal(
    adjustDisplayLeads(463, 0, false),
    463,
    "OFF: no-Other report returns total unchanged",
  );

  // === toggle ON — Other bucket subtracted from persisted total ===
  // Jones Law Firm scenario: persisted totalLeads = 1007, otherLeads.count = 544
  // Expected displayed total = 463 (what the client sees on the public report).
  assert.equal(
    adjustDisplayLeads(1007, 544, true),
    463,
    "ON: Jones scenario — 1007 − 544 = 463 (matches public report figure)",
  );
  assert.equal(
    adjustDisplayLeads(500, 100, true),
    400,
    "ON: generic subtraction",
  );
  assert.equal(
    adjustDisplayLeads(463, 0, true),
    463,
    "ON: no-Other report (count=0) returns total unchanged",
  );

  // === floor at 0 — never negative even with bad persisted data ===
  assert.equal(
    adjustDisplayLeads(10, 50, true),
    0,
    "ON: other-count > total floors at 0, never negative",
  );
  assert.equal(
    adjustDisplayLeads(0, 100, true),
    0,
    "ON: zero total with non-zero other count floors at 0",
  );

  // === coercion — handles numeric strings / null / undefined ===
  assert.equal(
    adjustDisplayLeads("1007" as unknown as number, "544" as unknown as number, true),
    463,
    "ON: numeric strings coerced correctly",
  );
  assert.equal(
    adjustDisplayLeads(null as unknown as number, null as unknown as number, false),
    0,
    "OFF: null inputs degrade to 0",
  );
  assert.equal(
    adjustDisplayLeads(undefined as unknown as number, undefined as unknown as number, true),
    0,
    "ON: undefined inputs degrade to 0",
  );

  // === ReportComparison scenario: two report months compared ===
  // Month A: 1007 total, 544 other → adjusted 463
  // Month B: 950 total, 480 other → adjusted 470
  // With toggle ON: leads went 463 → 470 (increase).
  // With toggle OFF: leads went 1007 → 950 (decrease).
  const monthA_total = 1007, monthA_other = 544;
  const monthB_total = 950,  monthB_other = 480;

  const adjA_on = adjustDisplayLeads(monthA_total, monthA_other, true);
  const adjB_on = adjustDisplayLeads(monthB_total, monthB_other, true);
  assert.equal(adjA_on, 463, "Comparison ON: month A adjusted");
  assert.equal(adjB_on, 470, "Comparison ON: month B adjusted");
  assert.ok(adjB_on > adjA_on, "Comparison ON: trend is increase (leads grew without Other)");

  const adjA_off = adjustDisplayLeads(monthA_total, monthA_other, false);
  const adjB_off = adjustDisplayLeads(monthB_total, monthB_other, false);
  assert.equal(adjA_off, 1007, "Comparison OFF: month A raw");
  assert.equal(adjB_off, 950,  "Comparison OFF: month B raw");
  assert.ok(adjB_off < adjA_off, "Comparison OFF: raw totals show decrease (Other inflated earlier month)");

  // === TrendAnalytics summary scenario: sum across months ===
  // Three months of data with toggle ON must sum only the non-Other leads.
  const months = [
    { totalLeads: 1007, otherCount: 544 },
    { totalLeads: 950,  otherCount: 480 },
    { totalLeads: 800,  otherCount: 300 },
  ];
  const totalOn  = months.reduce((s, m) => s + adjustDisplayLeads(m.totalLeads, m.otherCount, true),  0);
  const totalOff = months.reduce((s, m) => s + adjustDisplayLeads(m.totalLeads, m.otherCount, false), 0);
  assert.equal(totalOn,  463 + 470 + 500, "TrendAnalytics ON: sum excludes Other");
  assert.equal(totalOff, 1007 + 950 + 800, "TrendAnalytics OFF: sum uses raw totals");

  // === adjustLeadToConsultRate — rate symmetry ===
  // When toggle is OFF the persisted rate passes through unchanged.
  assert.equal(
    adjustLeadToConsultRate(46, 463, 9.9, false),
    9.9,
    "Rate OFF: persisted rate returned unchanged",
  );
  assert.equal(
    adjustLeadToConsultRate(0, 0, 0, false),
    0,
    "Rate OFF: zero persisted rate returns 0",
  );

  // When toggle is ON the rate is recomputed from the adjusted denominator.
  // Jones scenario: 46 consults / 463 adjusted leads = 9.9% (matches public report).
  // Persisted rate was 4.6% (46/1007 with Other included) — ON must return ~9.9%.
  const jonesRate = adjustLeadToConsultRate(46, 463, 4.6, true);
  assert.ok(
    jonesRate >= 9.9 && jonesRate <= 10.0,
    `Rate ON: Jones — 46/463 ≈ 9.9%, got ${jonesRate}`,
  );

  // Generic: 50 consults / 500 adjusted leads = 10%.
  assert.equal(
    adjustLeadToConsultRate(50, 500, 7.0, true),
    10,
    "Rate ON: 50/500 = 10.0%",
  );

  // When adjusted leads = 0 the rate must be 0 (no division by zero).
  assert.equal(
    adjustLeadToConsultRate(5, 0, 99.9, true),
    0,
    "Rate ON: adjusted leads = 0 → rate 0 (no divide-by-zero)",
  );

  // Rate is clamped at 100 (cannot exceed 100%).
  assert.equal(
    adjustLeadToConsultRate(500, 100, 50.0, true),
    100,
    "Rate ON: consults > leads → clamped at 100%",
  );

  // Symmetry: OFF uses persisted rate; ON recomputes.
  // If persisted rate was computed with Other included it diverges from ON rate.
  const persistedWithOther = 4.6; // 46/1007
  const onRate = adjustLeadToConsultRate(46, 463, persistedWithOther, true);
  const offRate = adjustLeadToConsultRate(46, 463, persistedWithOther, false);
  assert.ok(
    onRate > offRate,
    `Rate symmetry: ON (${onRate}%) > OFF (${offRate}%) — toggle removes Other inflation`,
  );

  // ReportComparison rate comparison scenario: two months with toggle ON.
  // Month A: 46 consults / 463 adjusted leads ≈ 9.9% (persisted 4.6%)
  // Month B: 52 consults / 470 adjusted leads ≈ 11.1% (persisted 5.5%)
  const rateA = adjustLeadToConsultRate(46, 463, 4.6, true);
  const rateB = adjustLeadToConsultRate(52, 470, 5.5, true);
  assert.ok(rateB > rateA, `Rate comparison ON: month B (${rateB}%) > month A (${rateA}%)`);

  console.log("hide-other-leads-surfaces.test.ts: all assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
