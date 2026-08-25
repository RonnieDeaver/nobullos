/* test-registration
{
  "name": "Lifetime cases hard-data + month-coverage predicate — flagged months, baseline-0 AND unflagged monthly 0 never count (only unflagged positives); calendar-complete missing months; both reports.ts computations wired (Tasks #3687/#4849)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4849 (extends #3687): the lifetime cases predicate that makes a confirmed \"0 cases signed\" impossible by construction — No-Data-flagged months AND unflagged zeros (report forms + AI parse coerce absent→0, so stored unflagged zeros mean \"never provided\") never count as hard data; only unflagged POSITIVE values do, so hasHardData implies totalCases > 0. Also locks the per-month provenance: getLifetimeCaseCoverage returns calendar-complete provided/missing month lists over the observed span (report-less months count as missing; year boundaries walk correctly; malformed months stay off the calendar). Pure shared accumulator (server/lib/lifetimeCases.ts) + a wiring scan that BOTH reports.ts lifetime computations feed report months and attach casesCoverage. DB-free, network-free, fast.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "scanPaths": [
    "server/routes/reports.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Tasks #3687 + #4849 — Lifetime cases hard-data + month-coverage predicate.
 *
 * The public report's Relationship Lifetime Value slide showed a confirmed
 * "0 / Confirmed client signings" even when case data was never provided.
 * Task #3687 fixed the flagged-month and baseline-0 paths; Task #4849 closes
 * the remaining hole (owner directive: a numeral 0 there is NEVER
 * acceptable): report forms and the AI-parse path coerce absent case counts
 * to 0 on save, so a stored UNFLAGGED 0 is indistinguishable from "never
 * provided" and must not read as a confirmed figure either.
 *
 * The rules live in the shared accumulator server/lib/lifetimeCases.ts
 * (used by the report-response builder AND the demo endpoint so they cannot
 * drift). This test locks the predicate:
 *   - No-Data-flagged months never add cases nor flip hasHardData;
 *   - an unflagged totalCases counts ONLY when POSITIVE — an unflagged 0 (or
 *     stored garbage like a negative) is NOT hard data, so by construction
 *     hasHardData ⇒ totalCases > 0 (a "confirmed 0" cannot be served);
 *   - only a POSITIVE baseline is hard data; 0/null/undefined baselines are
 *     not, and non-positive stored garbage (negative/NaN) contributes NOTHING
 *     to the total (it must never subtract from confirmed monthly figures);
 *   - missing/empty sales sections are no-ops (but their months still join
 *     the coverage span);
 *   - getLifetimeCaseCoverage exposes provided/missing month lists
 *     CALENDAR-COMPLETE over the observed span: report-less calendar months
 *     count as missing, year boundaries walk correctly, malformed months
 *     accumulate totals but stay off the calendar;
 * plus a wiring scan asserting BOTH reports.ts computations actually run
 * through the shared helper, feed it real report months, and attach the
 * casesCoverage payload fields (a unit-green helper that routes stopped
 * calling — or called without months — would otherwise regress silently).
 *
 * DB-free, network-free, fast.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  createLifetimeCaseAccumulator,
  addReportCasesToLifetime,
  getLifetimeCaseCoverage,
} = await import("../server/lib/lifetimeCases");

// ── (1) No baseline at all → not provided ──────────────────────────────────
{
  const acc = createLifetimeCaseAccumulator(null);
  assert.equal(acc.hasHardData, false, "null baseline must not be hard data");
  assert.equal(acc.totalCases, 0);
}
{
  const acc = createLifetimeCaseAccumulator(undefined);
  assert.equal(acc.hasHardData, false, "undefined baseline must not be hard data");
  assert.equal(acc.totalCases, 0);
}

// ── (2) Baseline 0 (edit forms coerce null → 0 on save) → NOT hard data ────
{
  const acc = createLifetimeCaseAccumulator(0);
  assert.equal(
    acc.hasHardData,
    false,
    "baseline 0 must not count as confirmed case data — client edit forms save 0 for 'never provided'",
  );
  assert.equal(acc.totalCases, 0);
}

// ── (2b) NEGATIVE stored baseline (schema doesn't forbid garbage) → contributes
//         NOTHING: it must neither count as hard data nor subtract from — or
//         zero out — confirmed monthly figures ────────────────────────────────
{
  const acc = createLifetimeCaseAccumulator(-5);
  assert.equal(acc.hasHardData, false, "negative baseline must not be hard data");
  assert.equal(acc.totalCases, 0, "negative baseline must not enter the total");
}
{
  // The reviewer-flagged trap: negative baseline + genuine positive month.
  // The confirmed month must survive intact — hasHardData=true with a
  // zeroed/negative total would render real confirmed cases as "not reported".
  const acc = createLifetimeCaseAccumulator(-5);
  addReportCasesToLifetime(acc, { totalCases: 5 }, "2026-01");
  assert.equal(acc.hasHardData, true, "the genuine positive month IS hard data");
  assert.equal(acc.totalCases, 5, "negative baseline must not eat the confirmed month's cases");
  assert.ok(acc.totalCases > 0, "invariant: hasHardData ⇒ totalCases > 0 even with a garbage baseline");
}

// ── (3) Positive baseline → genuinely provided, hard data ──────────────────
{
  const acc = createLifetimeCaseAccumulator(7);
  assert.equal(acc.hasHardData, true, "positive baseline IS hard data");
  assert.equal(acc.totalCases, 7);
}

// ── (4) No-Data-flagged month (intake saves totalCases: 0 + flag) → skipped ─
{
  const acc = createLifetimeCaseAccumulator(0);
  addReportCasesToLifetime(acc, { totalCases: 0, noDataFlags: { totalCases: true } }, "2026-01");
  assert.equal(acc.hasHardData, false, "No-Data-flagged month must not flip hasHardData");
  assert.equal(acc.totalCases, 0);
  assert.deepEqual([...acc.providedMonths], [], "flagged month is not provided");
  assert.deepEqual([...acc.observedMonths], ["2026-01"], "flagged month still joins the span");
}

// ── (5) Flagged month with a non-zero saved value → still skipped ENTIRELY ─
{
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(acc, { totalCases: 4, noDataFlags: { totalCases: true } }, "2026-02");
  assert.equal(acc.hasHardData, false, "flag wins: don't mark hard data");
  assert.equal(acc.totalCases, 0, "flag wins: don't add the placeholder value");
  assert.deepEqual([...acc.providedMonths], [], "flag wins: month is not provided");
}

// ── (6) UNFLAGGED 0 → NOT hard data (Task #4849 flip: forms/AI-parse coerce
//        absent→0, so a stored unflagged 0 means "never provided") ──────────
{
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(acc, { totalCases: 0, noDataFlags: {} }, "2026-03");
  assert.equal(
    acc.hasHardData,
    false,
    "unflagged 0 must NOT be hard data (empty flags object) — indistinguishable from never-provided",
  );
  assert.equal(acc.totalCases, 0);
  assert.deepEqual([...acc.providedMonths], [], "unflagged-0 month is not provided");
  assert.deepEqual([...acc.observedMonths], ["2026-03"], "unflagged-0 month still joins the span");
}
{
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(acc, { totalCases: 0 }, "2026-03");
  assert.equal(acc.hasHardData, false, "unflagged 0 must NOT be hard data (flags absent)");
  assert.equal(acc.totalCases, 0);
}
{
  // Stored garbage (negative) must not count either — and must never
  // subtract from the confirmed total.
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(acc, { totalCases: -3 }, "2026-03");
  assert.equal(acc.hasHardData, false, "negative stored value is not hard data");
  assert.equal(acc.totalCases, 0, "negative stored value must not subtract");
}

// ── (7) Missing / empty sales sections → no-ops (months still observed) ────
{
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(acc, undefined, "2026-01");
  addReportCasesToLifetime(acc, null, "2026-02");
  addReportCasesToLifetime(acc, {}, "2026-03");
  addReportCasesToLifetime(acc, { totalCases: null }, "2026-04");
  assert.equal(acc.hasHardData, false, "absent sections / null values are not hard data");
  assert.equal(acc.totalCases, 0);
  assert.deepEqual(
    [...acc.observedMonths].sort(),
    ["2026-01", "2026-02", "2026-03", "2026-04"],
    "section-less months still join the coverage span",
  );
  assert.deepEqual([...acc.providedMonths], []);
}

// ── (8) Flag false + POSITIVE value → counts; unrelated flags irrelevant ───
{
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(
    acc,
    { totalCases: 2, noDataFlags: { totalCases: false, noShowRate: true } },
    "2026-05",
  );
  assert.equal(acc.hasHardData, true, "totalCases flag false + positive value counts (other flags irrelevant)");
  assert.equal(acc.totalCases, 2);
  assert.deepEqual([...acc.providedMonths], ["2026-05"], "positive unflagged month is provided");
}

// ── (9) Mixed history: only unflagged POSITIVE months count ────────────────
{
  const acc = createLifetimeCaseAccumulator(0);
  addReportCasesToLifetime(acc, { totalCases: 0, noDataFlags: { totalCases: true } }, "2026-01");
  addReportCasesToLifetime(acc, { totalCases: 3 }, "2026-02");
  addReportCasesToLifetime(acc, { totalCases: 9, noDataFlags: { totalCases: true } }, "2026-03");
  addReportCasesToLifetime(acc, { totalCases: 0 }, "2026-04");
  assert.equal(acc.totalCases, 3, "only the unflagged positive month's value is added");
  assert.equal(acc.hasHardData, true);
  assert.deepEqual([...acc.providedMonths], ["2026-02"], "only the positive month is provided");
}

// ── (10) By construction: hasHardData ⇒ totalCases > 0 (a confirmed-0
//         payload is impossible from the accumulator) ───────────────────────
{
  const shapes: Array<Parameters<typeof addReportCasesToLifetime>[1]> = [
    { totalCases: 0 },
    { totalCases: 0, noDataFlags: {} },
    { totalCases: 0, noDataFlags: { totalCases: true } },
    { totalCases: 5, noDataFlags: { totalCases: true } },
    { totalCases: -1 },
    { totalCases: null },
    {},
    null,
    undefined,
  ];
  for (const baseline of [null, undefined, 0, -5, NaN]) {
    const acc = createLifetimeCaseAccumulator(baseline);
    shapes.forEach((s, i) => addReportCasesToLifetime(acc, s, `2026-${String(i + 1).padStart(2, "0")}`));
    assert.equal(acc.hasHardData, false, `no genuinely provided data (baseline ${baseline}) must stay soft`);
    assert.equal(acc.totalCases, 0);
  }
  // And every hard-data accumulator has a positive total — regardless of
  // baseline garbage.
  for (const baseline of [null, undefined, 0, -5, 7]) {
    const hard = createLifetimeCaseAccumulator(baseline);
    addReportCasesToLifetime(hard, { totalCases: 1 }, "2026-01");
    assert.ok(
      hard.hasHardData && hard.totalCases > 0,
      `hasHardData implies a positive total (baseline ${baseline})`,
    );
  }
}

// ── (11) Coverage: calendar-complete over the span, report-less months
//         count as missing (Task #4849) ─────────────────────────────────────
{
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(acc, { totalCases: 5 }, "2026-01");
  addReportCasesToLifetime(acc, { totalCases: 0 }, "2026-04"); // unflagged 0 → missing
  addReportCasesToLifetime(acc, { totalCases: 2, noDataFlags: { totalCases: true } }, "2026-06"); // flagged → missing
  const cov = getLifetimeCaseCoverage(acc);
  assert.deepEqual(cov.providedMonths, ["2026-01"]);
  assert.deepEqual(
    cov.missingMonths,
    ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
    "missing must be calendar-complete: report-less Feb/Mar/May AND non-provided Apr/Jun",
  );
}

// ── (12) Coverage walks year boundaries ─────────────────────────────────────
{
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(acc, { totalCases: 4 }, "2025-11");
  addReportCasesToLifetime(acc, { totalCases: 6 }, "2026-02");
  const cov = getLifetimeCaseCoverage(acc);
  assert.deepEqual(cov.providedMonths, ["2025-11", "2026-02"]);
  assert.deepEqual(cov.missingMonths, ["2025-12", "2026-01"], "Dec→Jan rollover must enumerate correctly");
}

// ── (13) Complete positive series → no missing months ───────────────────────
{
  const acc = createLifetimeCaseAccumulator(2);
  addReportCasesToLifetime(acc, { totalCases: 1 }, "2026-01");
  addReportCasesToLifetime(acc, { totalCases: 2 }, "2026-02");
  addReportCasesToLifetime(acc, { totalCases: 3 }, "2026-03");
  const cov = getLifetimeCaseCoverage(acc);
  assert.deepEqual(cov.providedMonths, ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(cov.missingMonths, [], "fully covered span has no missing months");
  assert.equal(acc.totalCases, 8, "baseline + all positive months");
}

// ── (14) Malformed/absent months: totals accumulate, calendar unaffected ───
{
  const acc = createLifetimeCaseAccumulator(null);
  addReportCasesToLifetime(acc, { totalCases: 2 }, undefined);
  addReportCasesToLifetime(acc, { totalCases: 3 }, "garbage");
  addReportCasesToLifetime(acc, { totalCases: 4 }, "2026-13"); // impossible month
  assert.equal(acc.totalCases, 9, "malformed months still accumulate their values");
  assert.equal(acc.hasHardData, true);
  const cov = getLifetimeCaseCoverage(acc);
  assert.deepEqual(cov.providedMonths, [], "malformed months cannot be placed on the calendar");
  assert.deepEqual(cov.missingMonths, [], "no well-formed span → nothing to report missing");
}

// ── (15) Empty accumulator coverage → both lists empty ──────────────────────
{
  const acc = createLifetimeCaseAccumulator(9);
  const cov = getLifetimeCaseCoverage(acc);
  assert.deepEqual(cov.providedMonths, []);
  assert.deepEqual(cov.missingMonths, []);
}

// ── (16) Wiring — both reports.ts lifetime computations use the helper ──────
// A unit-green helper the routes stopped calling would regress silently, so
// scan the route source: the shared report-response builder AND the demo
// endpoint must init + feed the accumulator WITH the report month, attach the
// casesCoverage payload fields, and the old inline predicate
// (`hasHardCaseData`, which treated ANY defined totalCases as hard data) must
// be gone.
{
  const src = readFileSync(new URL("../server/routes/reports.ts", import.meta.url), "utf8");
  const count = (re: RegExp) => (src.match(re) ?? []).length;
  assert.equal(
    count(/createLifetimeCaseAccumulator\(/g),
    2,
    "both lifetime computations must init the shared accumulator",
  );
  assert.equal(
    count(/addReportCasesToLifetime\(lifetimeCases, salesData, r\.reportMonth\)/g),
    2,
    "both lifetime computations must feed the accumulator the report month (per-month provenance, Task #4849)",
  );
  assert.equal(
    count(/casesCoverage: getLifetimeCaseCoverage\(lifetimeCases\)/g),
    2,
    "both lifetimeValue payloads must attach the shared coverage fields (Task #4849)",
  );
  assert.equal(
    count(/hasHardCaseData/g),
    0,
    "the old inline hasHardCaseData predicate must not survive anywhere in reports.ts",
  );
}

console.log(
  "lifetime-cases-not-provided.test.ts: PASS — flagged months, baseline-0 AND unflagged monthly 0 never count as hard data; " +
    "only unflagged positives do (hasHardData ⇒ totalCases > 0, confirmed-0 impossible); coverage is calendar-complete " +
    "(report-less months missing, year rollover, malformed months off-calendar); both reports.ts computations wired " +
    "with months + casesCoverage through the shared accumulator",
);
process.exit(0);
