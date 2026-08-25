/* test-registration
{
  "name": "Ads OS combined PaceCell reconciliation breakdown — jsdom pins per-member inputs, stale flags, legacy rows, included unbudgeted spend labels, and exclusion of stale Off contributions",
  "regression": true,
  "smoke": true,
  "smokeReason": "The combined pill is the operator-visible reconciliation surface. This fast DB-free jsdom mount pins its totals, account inputs, unbudgeted-spend label, and stale-Off exclusion; fetch is never called.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/combined-pace-cell-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3897 — combined (Main Dashboard) PaceCell reconciliation details.
 *
 * The combined pill's dropdown used to show one line per member account
 * (pace % · budget · MTD). Task #3897 adds the reconciliation inputs the
 * pacing stores already carry as muted sub-lines under each member row. This
 * mounts the REAL CombinedPaceCell in jsdom and pins:
 *
 *   1. Fully-populated GAds member (run generated TODAY): three sub-lines —
 *      "Expected $… · Budget from ClickUp", "Schedule ≈ Mon–Fri (inferred
 *      from recent spend)", and a plain "As of today <time>" with NO warn
 *      tone. Totals rows carry no sub-lines and the member's main value line
 *      keeps its pace/budget/MTD format.
 *   2. LSA member with a saved weekend schedule + sheet budget + a run from
 *      3 days ago: "Budget from legacy budget sheet", "Schedule Sat, Sun" (no ≈
 *      marker), and an amber "As of <date>, <time> — stale, re-run before
 *      comparing" warn line.
 *   3. Legacy member payload (predates the fields): NO sub-lines at all.
 *
 * DB-free, network-free, fetch never called. jsdom globals + css stub are
 * installed by tests/client/combined-pace-cell-setup.mjs (--import).
 */

import { strict as assert } from "node:assert";

const dom = (globalThis as any).window;

// The test must never hit the network; CombinedPaceCell makes no calls, so a
// throwing fetch doubles as a regression tripwire on the import graph.
(globalThis as any).fetch = () => {
  throw new Error("unexpected fetch from CombinedPaceCell test");
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { CombinedPaceCell } = await import("../../client/src/pages/adsOs/MainDashboard");

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const doc = (globalThis as any).document;

function member(extra: Record<string, unknown>): any {
  return {
    product: "gads",
    customer_id: "9000000001",
    descriptive_name: "Acme GAds",
    city: null,
    ads_status: "on",
    spend_30d: 0,
    leads_30d: 0,
    metrics_failed: false,
    pacing_pct: 5,
    pacing_budget: 1000,
    pacing_mtd: 500,
    ...extra,
  };
}

function row(members: any[], overrides: Record<string, unknown> = {}): any {
  return {
    client: "Acme Law",
    doer: null,
    checker: null,
    currency_code: "USD",
    has_gads: true,
    has_lsa: false,
    has_active_monitoring: true,
    spend_30d: 0,
    leads_30d: 0,
    cpl_30d: null,
    metrics_partial: false,
    pacing_pct: 5,
    pacing_budget: 1000,
    pacing_mtd: 500,
    pacing_hit: false,
    members,
    ...overrides,
  };
}

let root: any = null;
async function mount(r: any): Promise<void> {
  const container = doc.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(CombinedPaceCell as any, { r, c: "USD" }));
  });
}
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    root = null;
  });
}
async function openPill(): Promise<void> {
  const p = doc.querySelector('[data-testid="pill-pace-acme-law"]') as HTMLElement | null;
  assert.ok(p, "combined pacing pill renders");
  await act(async () => {
    p!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.ok(doc.querySelector(".pace-menu"), "clicking the pill opens the dropdown");
}

function menuRows(): { label: string; value: string }[] {
  return Array.from(doc.querySelectorAll(".pace-menu .row")).map((r: any) => ({
    label: r.querySelector(".k")?.textContent ?? "",
    value: r.querySelector(".v")?.textContent ?? "",
  }));
}
function menuSubs(): { text: string; warn: boolean }[] {
  return Array.from(doc.querySelectorAll(".pace-menu .sub")).map((el: any) => ({
    text: el.textContent ?? "",
    warn: String(el.className).includes("warn"),
  }));
}

// Expected "as of" fragments computed via the SAME locale APIs the component
// uses, so the assertions are locale-independent.
function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function dateLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── 1. Fully-populated GAds member, run from TODAY ──────────────────────────
{
  const nowIso = new Date().toISOString();
  await mount(
    row([
      member({
        pacing_expected: 750,
        pacing_budget_source: "clickup",
        pacing_schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        pacing_schedule_source: "inferred",
        pacing_generated_at: nowIso,
      }),
    ]),
  );
  await openPill();
  const rows = menuRows();
  ok(rows[0]?.label === "Total budget" && rows[0]?.value === "$1,000.00",
    "totals row unchanged: Total budget $1,000.00");
  ok(rows[1]?.label === "Total MTD spend" && rows[1]?.value === "$500.00",
    "totals row unchanged: Total MTD spend $500.00");
  ok(rows[2]?.label === "GAds" && rows[2]?.value === "+5% · $1,000.00 · MTD $500.00",
    "member value line keeps its pace/budget/MTD format");
  const subs = menuSubs();
  ok(subs.length === 3, "fully-populated member renders exactly three sub-lines");
  ok(subs[0]?.text === "Expected $750.00 · Budget from ClickUp" && !subs[0]?.warn,
    "sub-line 1: expected-to-date + ClickUp budget source");
  ok(subs[1]?.text === "Schedule ≈ Mon–Fri (inferred from recent spend)" && !subs[1]?.warn,
    "sub-line 2: schedule with the ≈ inferred marker");
  ok(subs[2]?.text === `As of today ${timeLabel(new Date(nowIso))}` && !subs[2]?.warn,
    "sub-line 3: today's run shows a plain as-of line (no warn tone)");
  await unmount();
}

// ── 2. LSA member: saved schedule, sheet budget, 3-day-old run ──────────────
{
  const staleAt = new Date(Date.now() - 3 * 86400000);
  await mount(
    row([
      member({
        product: "lsa",
        city: "Springfield",
        pacing_expected: 200,
        pacing_budget_source: "sheet",
        pacing_schedule_days: ["Sat", "Sun"],
        pacing_schedule_source: "saved",
        pacing_generated_at: staleAt.toISOString(),
      }),
    ]),
  );
  await openPill();
  ok(menuRows()[2]?.label === "LSA · Springfield", "LSA member row keeps its city label");
  const subs = menuSubs();
  ok(subs[0]?.text === "Expected $200.00 · Budget from legacy budget sheet" && !subs[0]?.warn,
    "an old sheet-sourced row is visibly identified as legacy until fleet refresh");
  ok(subs[1]?.text === "Schedule Sat, Sun" && !subs[1]?.warn,
    "saved schedule renders WITHOUT the inferred marker");
  ok(
    subs[2]?.text ===
      `As of ${dateLabel(staleAt)}, ${timeLabel(staleAt)} — stale, re-run before comparing`,
    "non-today run: as-of line carries the stale re-run flag",
  );
  ok(subs[2]?.warn === true, "stale as-of line gets the amber warn tone");
  await unmount();
}

// ── 3. Legacy member payload (fields absent): no sub-lines ──────────────────
{
  await mount(row([member({})]));
  await openPill();
  ok(menuRows().length === 3, "legacy member still renders totals + its main line");
  ok(menuSubs().length === 0, "legacy member (no reconciliation fields) renders zero sub-lines");
  await unmount();
}

// ── 4. Included unbudgeted spend is visible; excluded stale Off is omitted ──
{
  await mount(
    row(
      [
        member({ pacing_included: true }),
        member({
          product: "lsa",
          city: "Austin",
          pacing_pct: null,
          pacing_budget: null,
          pacing_mtd: 275,
          pacing_included: true,
        }),
        member({
          product: "lsa",
          city: "Oldtown",
          ads_status: "off",
          pacing_budget: 900,
          pacing_mtd: 600,
          pacing_included: false,
        }),
      ],
      { pacing_mtd: 775 },
    ),
  );
  await openPill();
  const rows = menuRows();
  ok(
    rows[1]?.label === "Total MTD spend" && rows[1]?.value === "$775.00",
    "total MTD includes budgeted + unbudgeted counted spend",
  );
  ok(
    rows.some(
      (entry) =>
        entry.label === "LSA · Austin" &&
        entry.value === "No budget configured · MTD $275.00",
    ),
    "included unbudgeted account remains visible with its spend contribution",
  );
  ok(
    !rows.some((entry) => entry.label.includes("Oldtown")),
    "excluded stale Off account is omitted so account lines reconcile to totals",
  );
  await unmount();
}

console.log(`\ncombined-pace-cell-reconciliation: ${passed} assertion(s) passed (Task #3897).`);
