/* test-registration
{
  "name": "Missed Call Rate symmetric hideOtherLeads + 0–100% clamp + pushed-or-No-data resolution (Tasks #2680/#4983)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tasks #2680/#4983: the Missed Call Rate logic lives in one shared helper (shared/missedCallRate.ts) consumed by all three write paths + the public renderer. Gate this fast, DB-free unit test so a regression in the symmetric hideOtherLeads handling, the 0–100% clamp (the >100% bug), or the three-tier pushed-or-No-data resolution (bucket evidence → recompute; pushed stored rate > 0 → clamped; else null — a stored 0 is never trusted) fails fast rather than silently re-shipping an impossible percentage or a fabricated healthy 0%. Also source-scans ReportForm.tsx to pin that the editor preview and saveIntake share ONE memoized resolution (preview = persisted value, hideOtherLeads included).",
  "scanPaths": [
    "client/src/pages/ReportForm.tsx"
  ],
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import {
  clampMissedCallRate,
  clampPercent,
  computeMissedCallRate,
  applyHideOtherLeads,
  applyRecomputedMissedCallRate,
  resolveMissedCallRate,
  resolveMissedCallRateWithSource,
} from "../shared/missedCallRate";

/**
 * Task #2680 — Missed Call Rate (%) sanity.
 *
 * The bug: the missed-call numerator and the total-leads denominator were drawn
 * from different lead sets, the per-client `hideOtherLeads` toggle (Task #2667)
 * was applied to only one side, and nothing clamped the result — so a client
 * report could show an impossible value like 5,300%. These tests lock in the two
 * core guarantees: (1) `hideOtherLeads` is applied SYMMETRICALLY to numerator
 * and denominator, and (2) the rate is always clamped to 0–100%.
 *
 * Task #4983 adds the shared three-tier resolution (`resolveMissedCallRate`)
 * every surface and write path routes through: bucket evidence → the #2680
 * recompute; else a pushed/typed stored rate > 0 → clamped stored; else null
 * ("No data"). A stored 0 is NEVER trusted — both write paths historically
 * stamped recomputed 0s over months with no call tracking, so "0% · Healthy"
 * was fabricated whenever a month had lead volume but no missed-call data.
 */
async function run() {
  // === clamp: the hard 0–100 guard against absurd persisted values ===
  assert.equal(clampMissedCallRate(5300), 100, "5,300% clamps to 100%");
  assert.equal(clampMissedCallRate(100.1), 100, "just over 100 clamps to 100");
  assert.equal(clampMissedCallRate(50), 50, "in-range value passes through");
  assert.equal(clampMissedCallRate(0), 0, "zero stays zero");
  assert.equal(clampMissedCallRate(-5), 0, "negative degrades to 0");
  assert.equal(clampMissedCallRate(NaN), 0, "NaN degrades to 0");
  assert.equal(clampMissedCallRate(Infinity), 0, "Infinity degrades to 0");
  assert.equal(clampMissedCallRate(33.333), 33.3, "rounds to one decimal");

  // === clampPercent: the generic 0–100 guard reused across the report sweep ===
  // The public report renders several persisted rates raw (lead→consult,
  // consult→case, no-show) and every %-unit historical trend point. They all
  // route through clampPercent so a legacy absurd value (e.g. 5,300%) can never
  // render anywhere, not just on the missed-call KPI.
  assert.equal(clampPercent(5300), 100, "5,300% clamps to 100%");
  assert.equal(clampPercent(133.7), 100, "over 100 clamps to 100");
  assert.equal(clampPercent(72), 72, "in-range value passes through");
  assert.equal(clampPercent(0), 0, "zero stays zero");
  assert.equal(clampPercent(-9), 0, "negative degrades to 0");
  assert.equal(clampPercent(NaN), 0, "NaN degrades to 0");
  assert.equal(clampPercent(Infinity), 0, "Infinity degrades to 0");
  assert.equal(clampPercent(48.667), 48.7, "rounds to one decimal");
  // Persisted JSON payloads can drift to numeric strings — coerce, don't zero.
  assert.equal(clampPercent("5300" as unknown as number), 100, "numeric string over 100 clamps to 100");
  assert.equal(clampPercent("72" as unknown as number), 72, "numeric string in range passes through");
  // clampMissedCallRate must stay a thin delegate of clampPercent.
  assert.equal(
    clampMissedCallRate(5300),
    clampPercent(5300),
    "clampMissedCallRate delegates to clampPercent",
  );

  // === computeMissedCallRate: numerator/denominator from one shared set ===
  assert.equal(computeMissedCallRate(5, 20), 25, "5 missed of 20 = 25%");
  assert.equal(computeMissedCallRate(0, 20), 0, "no missed = 0%");
  // The exact >100% pathology from the bug report: 53 missed but only 1 lead.
  assert.equal(
    computeMissedCallRate(53, 1),
    100,
    "53 missed ÷ 1 lead clamps to 100% (was 5,300%)",
  );
  // Denominator guard — never divide by zero into Infinity/NaN.
  assert.equal(computeMissedCallRate(5, 0), 0, "zero denominator = 0%");
  assert.equal(computeMissedCallRate(5, -3), 0, "negative denominator = 0%");

  // === applyHideOtherLeads: SYMMETRIC handling (the core fix) ===
  // Full figures INCLUDE the Other bucket: 30 total leads, 12 missed calls,
  // of which Other contributes 10 leads and 8 missed calls.
  const full = { missedCalls: 12, totalLeads: 30, otherMissedCalls: 8, otherLeadCount: 10 };

  // Toggle OFF → keep Other on BOTH sides.
  const off = applyHideOtherLeads({ ...full, hideOtherLeads: false });
  assert.equal(off.missedCalls, 12, "OFF keeps Other in numerator");
  assert.equal(off.totalLeads, 30, "OFF keeps Other in denominator");
  assert.equal(computeMissedCallRate(off.missedCalls, off.totalLeads), 40, "OFF: 12/30 = 40%");

  // Toggle ON → drop Other from BOTH sides (not just one).
  const on = applyHideOtherLeads({ ...full, hideOtherLeads: true });
  assert.equal(on.missedCalls, 4, "ON removes Other's 8 missed calls from numerator");
  assert.equal(on.totalLeads, 20, "ON removes Other's 10 leads from denominator");
  assert.equal(computeMissedCallRate(on.missedCalls, on.totalLeads), 20, "ON: 4/20 = 20%");

  // Regression guard for the asymmetric bug: if Other were dropped from ONLY
  // the denominator while its missed calls stayed in the numerator, the rate
  // would jump to 12/20 = 60% — strictly worse than the correct symmetric 20%.
  const asymmetricWrong = computeMissedCallRate(full.missedCalls, on.totalLeads);
  assert.equal(asymmetricWrong, 60, "asymmetric (numerator keeps Other) would inflate to 60%");
  assert.notEqual(
    computeMissedCallRate(on.missedCalls, on.totalLeads),
    asymmetricWrong,
    "symmetric handling must NOT match the asymmetric inflated value",
  );

  // Symmetric handling can itself produce >100% inputs when Other dominates the
  // lead count; the clamp must still hold.
  const otherHeavy = applyHideOtherLeads({
    missedCalls: 60,
    totalLeads: 61,
    otherMissedCalls: 5,
    otherLeadCount: 60,
    hideOtherLeads: true,
  });
  assert.equal(otherHeavy.missedCalls, 55, "ON: numerator 60-5");
  assert.equal(otherHeavy.totalLeads, 1, "ON: denominator 61-60");
  assert.equal(
    computeMissedCallRate(otherHeavy.missedCalls, otherHeavy.totalLeads),
    100,
    "55 missed ÷ 1 remaining lead still clamps to 100%",
  );

  // === resolveMissedCallRate: pushed data or No data (Task #4983) ===
  // Missed-call data is PUSHED from client call reporting (webhook/PDF
  // quality tables) or typed by an operator — the bucket fields are
  // structural 0s otherwise, so lead volume alone must never fabricate a
  // healthy 0%.

  // Tier 1 — bucket evidence wins, and delegates to the #2680 recompute.
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 5, totalLeads: 20, storedRate: 55 }),
    25,
    "bucket evidence → same-lead-set recompute (stored rate loses)",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 12, totalLeads: 30, storedRate: 0 }),
    computeMissedCallRate(12, 30),
    "tier 1 equals the shared #2680 recompute exactly (bucket-backed reports render byte-identically)",
  );
  // Tier 2 — a pushed/typed stored rate displays when buckets carry nothing.
  // Prod-pinned (read-only replica, 2026-08-18): Parman & Easterday 2026-07
  // stored 9.5 with all-zero buckets rendered "0% · Healthy" before this fix.
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 137, storedRate: 9.5 }),
    9.5,
    "Parman class: the pushed 9.5% displays, not a recomputed 0%",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 40, storedRate: 33.3 }),
    33.3,
    "Clyatt class: an issue-level pushed rate is never masked as healthy",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 10, storedRate: "20" }),
    20,
    "Robinson class: persisted numeric string coerces (JSONB drift)",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 10, storedRate: 5300 }),
    100,
    "absurd stored rate clamps to 100 (same guard as the card)",
  );
  // Tier 3 — no evidence, no pushed rate → null ("No data"), never 0.
  // Prod-pinned: Cambridge Immigration Law 2026-07 — 340 leads, intake `{}`,
  // no missed-call data anywhere — must say "No data", not "0% · Healthy".
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 340, storedRate: undefined }),
    null,
    "Cambridge class: lead volume alone never fabricates a 0%",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 340, storedRate: 0 }),
    null,
    "a stored 0 is NEVER trusted (write paths stamped computed 0s historically)",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 0, storedRate: null }),
    null,
    "fully empty month → null",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 12, storedRate: -4 }),
    null,
    "negative stored junk degrades to No data, not 0%",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 12, storedRate: "garbage" }),
    null,
    "non-numeric stored junk degrades to No data",
  );
  // Evidence needs BOTH sides of the ratio: a numerator with no denominator
  // cannot recompute (never divide by zero) — the pushed rate still displays.
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 3, totalLeads: 0, storedRate: 12.5 }),
    12.5,
    "numerator without denominator falls through to the stored tier",
  );
  // hideOtherLeads symmetry — callers pass the ALREADY-adjusted pair (the
  // Task #2680 contract), so the resolver judges evidence on the same lead
  // set the card displays.
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: on.missedCalls, totalLeads: on.totalLeads, storedRate: 0 }),
    20,
    "adjusted pair (toggle ON) resolves 4/20 = 20%",
  );
  // When the toggle strips ALL evidence (Other held every missed call), the
  // resolver falls through — symmetric with what the deck displays.
  const otherOnly = applyHideOtherLeads({
    missedCalls: 8,
    totalLeads: 30,
    otherMissedCalls: 8,
    otherLeadCount: 10,
    hideOtherLeads: true,
  });
  assert.equal(otherOnly.missedCalls, 0, "toggle ON strips Other-only missed calls");
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: otherOnly.missedCalls, totalLeads: otherOnly.totalLeads, storedRate: 0 }),
    null,
    "evidence gone after hide → No data, not a recomputed 0% over 20 leads",
  );
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: otherOnly.missedCalls, totalLeads: otherOnly.totalLeads, storedRate: 12.5 }),
    12.5,
    "…while a pushed rate still displays after the hide strips the buckets",
  );

  // === resolveMissedCallRateWithSource: the resolver names its own tier ===
  // Surfaces that CAPTION the rate's provenance (the report-editor preview's
  // "(from Leads Performance)" / "(pushed from client report)" labels) must
  // branch on the resolver's verdict, never re-derive the tier predicate
  // locally — that local re-derivation is exactly how the editor preview
  // diverged from the save path for hideOtherLeads clients.
  assert.deepEqual(
    resolveMissedCallRateWithSource({ bucketMissedCalls: 5, totalLeads: 20, storedRate: 55 }),
    { rate: 25, source: "buckets" },
    "tier 1 labels itself buckets (and outranks a conflicting stored rate)",
  );
  assert.deepEqual(
    resolveMissedCallRateWithSource({ bucketMissedCalls: 0, totalLeads: 137, storedRate: 9.5 }),
    { rate: 9.5, source: "stored" },
    "tier 2 labels itself stored (Parman class)",
  );
  assert.deepEqual(
    resolveMissedCallRateWithSource({ bucketMissedCalls: 0, totalLeads: 340, storedRate: 0 }),
    { rate: null, source: null },
    "tier 3 carries no source (Cambridge class — stored 0 never trusted)",
  );
  // The plain resolver is a thin delegate — the two can never disagree.
  for (const params of [
    { bucketMissedCalls: 5, totalLeads: 20, storedRate: 55 },
    { bucketMissedCalls: 0, totalLeads: 137, storedRate: 9.5 },
    { bucketMissedCalls: 0, totalLeads: 340, storedRate: 0 },
    { bucketMissedCalls: 3, totalLeads: 0, storedRate: 12.5 },
  ]) {
    assert.equal(
      resolveMissedCallRate(params),
      resolveMissedCallRateWithSource(params).rate,
      "resolveMissedCallRate delegates to the source-aware implementation",
    );
  }
  // The editor-preview hide-Other scenario end-to-end at resolver level: a
  // hidden-Other client whose ONLY missed calls sit in the Other bucket. The
  // UNADJUSTED pair would caption a bucket rate; the adjusted pair (what the
  // form's single memoized resolution feeds) resolves "No data" — the preview
  // must show the latter, matching what Save persists.
  assert.equal(
    resolveMissedCallRateWithSource({ bucketMissedCalls: 8, totalLeads: 30, storedRate: 0 }).source,
    "buckets",
    "unadjusted pair would (wrongly, pre-fix) caption a bucket rate",
  );
  assert.deepEqual(
    resolveMissedCallRateWithSource({
      bucketMissedCalls: otherOnly.missedCalls,
      totalLeads: otherOnly.totalLeads,
      storedRate: 0,
    }),
    { rate: null, source: null },
    "adjusted pair previews No data — preview and save agree for hidden-Other clients",
  );

  // === ReportForm preview wiring: preview IS the save resolution ===
  // Source-scan pin (same pattern as the monolith-split scan tests): the form
  // must (1) resolve through the source-aware resolver exactly once — the
  // shared missedCallPreview memo, (2) persist that same memo's rate in
  // saveIntake, (3) caption by the resolver's source verdict, and (4) never
  // recompute a preview percentage from the unadjusted bucket sums again.
  const { readFileSync } = await import("node:fs");
  const reportFormSrc = readFileSync("client/src/pages/ReportForm.tsx", "utf8");
  const withSourceCalls = reportFormSrc.match(/resolveMissedCallRateWithSource\(/g) ?? [];
  assert.equal(
    withSourceCalls.length,
    1,
    "ReportForm resolves the preview through resolveMissedCallRateWithSource exactly once (the shared memo)",
  );
  assert.ok(
    reportFormSrc.includes("missedCallRate: missedCallPreview.rate ?? 0"),
    "saveIntake persists the SAME memoized resolution the preview renders",
  );
  assert.ok(
    reportFormSrc.includes('missedCallPreview.source === "buckets"'),
    "preview captions branch on the resolver's buckets verdict",
  );
  assert.ok(
    reportFormSrc.includes('missedCallPreview.source === "stored"'),
    "preview captions branch on the resolver's stored verdict",
  );
  assert.ok(
    !reportFormSrc.includes("calculatedLeadQuality.missedCalls / calculatedTotalLeads"),
    "the unadjusted preview recompute (ignored hideOtherLeads) is gone",
  );

  // === applyRecomputedMissedCallRate: trend's current month must match the card ===
  // The Missed Call Rate card recomputes the rate live over the active-product
  // lead set; the historical trend stores each month's persisted rate. A report
  // imported before the recompute shipped carries a stale persisted value (here
  // 5,300% for the current month) that disagrees with the card's 9.1%. The helper
  // overrides ONLY the current month with the card's recomputed value; historical
  // months keep their persisted figures and the input is never mutated.
  const trend = [
    { month: "2026-03", intake: { missedCallRate: 4.2, totalConsults: 11 } },
    { month: "2026-04", intake: { missedCallRate: 6.8, totalConsults: 14 } },
    { month: "2026-05", intake: { missedCallRate: 5300, totalConsults: 7 } },
  ];
  const corrected = applyRecomputedMissedCallRate(trend, "2026-05", 9.1)!;
  assert.equal(corrected[2].intake.missedCallRate, 9.1, "current month overridden with card value");
  assert.equal(corrected[2].intake.totalConsults, 7, "current month's other intake fields preserved");
  assert.equal(corrected[0].intake.missedCallRate, 4.2, "historical month untouched");
  assert.equal(corrected[1].intake.missedCallRate, 6.8, "historical month untouched");
  assert.equal(corrected[2].month, "2026-05", "month key preserved");
  // Immutability — the source series must be unchanged.
  assert.equal(trend[2].intake.missedCallRate, 5300, "input series is not mutated");
  assert.notEqual(corrected[2], trend[2], "current-month object is a fresh copy");
  assert.equal(corrected[0], trend[0], "untouched months keep referential identity");
  // No matching month → series returned with no overrides.
  const noMatch = applyRecomputedMissedCallRate(trend, "2026-12", 9.1)!;
  assert.equal(noMatch[2].intake.missedCallRate, 5300, "no current-month match leaves all points as-is");
  // Null series passes through unchanged.
  assert.equal(applyRecomputedMissedCallRate(null, "2026-05", 9.1), null, "null trend passes through");
  // A null card value stamps null over the current point: with no displayed
  // missed-call evidence and no pushed rate the card shows "No data"
  // (Task #4983 resolver → null), and the chart beside it must not keep a
  // stored 0% the card no longer vouches for.
  const nulled = applyRecomputedMissedCallRate(trend, "2026-05", null)!;
  assert.equal(nulled[2].intake.missedCallRate, null, "null card value nulls the current trend point");
  assert.equal(nulled[0].intake.missedCallRate, 4.2, "historical months survive a null stamp");

  console.log("missed-call-rate.test.ts: all assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
