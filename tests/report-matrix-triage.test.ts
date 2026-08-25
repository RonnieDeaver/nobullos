/* test-registration
{
  "name": "Report matrix needs-action triage derivation (Task #4351)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure calendar/classification helper with an injected clock: no DB, no network, no DOM, finishes in well under a second, and it guards the report matrix's default action-first view against silent due/missing/draft drift.",
  "tier": "small"
}
test-registration */
/**
 * Task #4351 — the report matrix's action-first view is driven entirely by
 * computeClientTriage (client/src/lib/reportMatrixTriage.ts). This exercises
 * the derivation the UI renders verbatim:
 *
 *   - due month = the most recently completed calendar month (injected
 *     clock, year boundaries included);
 *   - missing months respect the onboarding cutoff (months before a
 *     client's first report are never holes);
 *   - drafts surface regardless of age, newest first;
 *   - priority ordering: due > missing backlog > drafts, alphabetical ties.
 *
 * All fixtures use a FIXED injected `now` — never the wall clock — so this
 * test is immune to calendar rot (see memory: calendar-month fixture
 * collisions).
 */

import assert from "node:assert/strict";
import {
  computeClientTriage,
  compareTriage,
  monthKeyOffset,
  type TriageInputRow,
  type TriageReportCell,
} from "../client/src/lib/reportMatrixTriage";

let idCounter = 0;
function report(status: string): TriageReportCell {
  idCounter += 1;
  return {
    id: `r-${idCounter}`,
    status,
    shareToken: status === "final" ? `tok-${idCounter}` : null,
    totalLeads: 0,
    totalCases: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function row(
  clientId: string,
  firmName: string,
  reports: Record<string, TriageReportCell>,
): TriageInputRow {
  return { clientId, firmName, clientCode: null, reports };
}

function triageOne(r: TriageInputRow, now: Date, lookbackMonths?: number) {
  const [entry] = computeClientTriage([r], now, lookbackMonths);
  return entry;
}

// Fixed clock: April 15, 2026 → due month 2026-03, older window 2026-02, 2026-01.
const NOW = new Date(2026, 3, 15);

// ---------------------------------------------------------------------------
// monthKeyOffset
// ---------------------------------------------------------------------------
assert.equal(monthKeyOffset(NOW, 0), "2026-04", "current month key");
assert.equal(monthKeyOffset(NOW, -1), "2026-03", "previous month key");
assert.equal(
  monthKeyOffset(new Date(2026, 0, 20), -1),
  "2025-12",
  "backward across the year boundary",
);
assert.equal(
  monthKeyOffset(new Date(2025, 11, 5), 1),
  "2026-01",
  "forward across the year boundary",
);

// ---------------------------------------------------------------------------
// Bucket derivation
// ---------------------------------------------------------------------------

// 1. Zero-report client: due only — no missing (nothing pre-dates onboarding).
{
  const e = triageOne(row("c1", "Zero Reports LLC", {}), NOW);
  assert.equal(e.dueMonth, "2026-03", "zero-report client owes the due month");
  assert.deepEqual(e.missingMonths, [], "no missing months before first report");
  assert.deepEqual(e.drafts, [], "no drafts");
  assert.equal(e.latest, null, "no latest report");
  assert.equal(e.needsAction, true, "zero-report client needs action");
}

// 2. Fully current client: finals for due + both older window months.
{
  const e = triageOne(
    row("c2", "Current Firm", {
      "2026-01": report("final"),
      "2026-02": report("final"),
      "2026-03": report("final"),
    }),
    NOW,
  );
  assert.equal(e.dueMonth, null, "due month satisfied");
  assert.deepEqual(e.missingMonths, [], "no holes");
  assert.deepEqual(e.drafts, [], "no drafts");
  assert.equal(e.needsAction, false, "fully current client is caught up");
  assert.equal(e.latest?.month, "2026-03", "latest points at newest month");
}

// 3. Draft in the due month: not "due" (report exists) but surfaces as draft.
{
  const e = triageOne(
    row("c3", "Draft Due Firm", {
      "2026-02": report("final"),
      "2026-03": report("draft"),
    }),
    NOW,
  );
  assert.equal(e.dueMonth, null, "a draft still satisfies the due month");
  assert.equal(e.drafts.length, 1, "the draft surfaces");
  assert.equal(e.drafts[0].month, "2026-03");
  assert.equal(e.needsAction, true, "draft work needs action");
  assert.equal(e.latest?.month, "2026-03", "latest includes drafts");
}

// 4. Onboarding cutoff: first-ever report in the due month — older window
//    months are pre-onboarding, never holes.
{
  const e = triageOne(row("c4", "New Client", { "2026-03": report("final") }), NOW);
  assert.equal(e.dueMonth, null);
  assert.deepEqual(
    e.missingMonths,
    [],
    "months before the first report are not missing",
  );
  assert.equal(e.needsAction, false, "freshly onboarded client is caught up");
}

// 5. Real hole: reporting since January, February skipped.
{
  const e = triageOne(
    row("c5", "Gap Firm", {
      "2026-01": report("final"),
      "2026-03": report("final"),
    }),
    NOW,
  );
  assert.equal(e.dueMonth, null);
  assert.deepEqual(e.missingMonths, ["2026-02"], "the February hole is missing");
  assert.equal(e.needsAction, true);
}

// 6. Stray old drafts surface regardless of age, newest first.
{
  const e = triageOne(
    row("c6", "Old Drafts Firm", {
      "2025-10": report("draft"),
      "2025-12": report("draft"),
      "2026-01": report("final"),
      "2026-02": report("final"),
      "2026-03": report("final"),
    }),
    NOW,
  );
  assert.deepEqual(
    e.drafts.map((d) => d.month),
    ["2025-12", "2025-10"],
    "drafts listed newest first, even outside the lookback window",
  );
  assert.equal(e.needsAction, true, "old drafts are still open work");
}

// 7. Year-boundary window: in January 2026 the due month is 2025-12 and the
//    older window crosses into 2025.
{
  const january = new Date(2026, 0, 20);
  const e = triageOne(
    row("c7", "Boundary Firm", {
      "2025-10": report("final"),
      "2025-12": report("final"),
    }),
    january,
  );
  assert.equal(e.dueMonth, null, "2025-12 report satisfies the January due month");
  assert.deepEqual(e.missingMonths, ["2025-11"], "November hole across the boundary");
}

// 8. lookbackMonths parameter bounds the older window.
{
  const e = triageOne(
    row("c8", "Short Window Firm", {
      "2025-11": report("final"),
      "2026-03": report("final"),
    }),
    NOW,
    2,
  );
  assert.deepEqual(
    e.missingMonths,
    ["2026-02"],
    "window of 2 checks only the single older month",
  );
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------
{
  const rows: TriageInputRow[] = [
    row("caught-up", "Alpha Done", {
      "2026-01": report("final"),
      "2026-02": report("final"),
      "2026-03": report("final"),
    }),
    row("draft-only", "Draft Only Co", {
      "2026-02": report("draft"),
      "2026-03": report("final"),
    }),
    row("missing-only", "Missing Only Co", {
      "2026-01": report("final"),
      "2026-03": report("final"),
    }),
    row("due-b", "Bravo Due", { "2026-02": report("final") }),
    row("due-a", "Alpha Due", { "2026-02": report("final") }),
    row("due-missing", "Worst Backlog", { "2025-12": report("final") }),
  ];
  const order = computeClientTriage(rows, NOW).map((e) => e.clientId);
  assert.deepEqual(
    order,
    ["due-missing", "due-a", "due-b", "missing-only", "draft-only", "caught-up"],
    "due+missing outranks due-only; due-only ties break alphabetically; missing beats drafts; caught-up last",
  );

  const entries = computeClientTriage(rows, NOW);
  const worst = entries.find((e) => e.clientId === "due-missing")!;
  assert.equal(worst.dueMonth, "2026-03");
  assert.deepEqual(
    worst.missingMonths,
    ["2026-02", "2026-01"],
    "missing months listed newest first",
  );

  // compareTriage is a pure comparator: symmetric on equal-priority names.
  const dueA = entries.find((e) => e.clientId === "due-a")!;
  const dueB = entries.find((e) => e.clientId === "due-b")!;
  assert.ok(compareTriage(dueA, dueB) < 0, "alphabetical tiebreak");
  assert.ok(compareTriage(dueB, dueA) > 0, "comparator antisymmetry");
}

console.log("report-matrix-triage: all assertions passed");
