/* test-registration
{
  "name": "LSA PaceCell schedule dropdown — jsdom mount confirms the .pace-menu Schedule row shows the correct label for every schedule variant and that no chip-schedule-* element exists (regression guard against re-introducing the removed chip)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4825: the schedule chip was removed from LsaDashboard PaceCell in Task #4820 and its coverage was deleted along with it. This re-pins the dropdown Schedule row (the only remaining schedule surface) for all canonical day-set variants, and asserts the chip is absent so future regressions are caught immediately. DB-free, network-free, fast jsdom render.",
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
 * Task #4825 — LSA PaceCell schedule dropdown coverage.
 *
 * Task #4820 removed the schedule chip from PaceCell but kept the "Schedule"
 * row inside the pacing dropdown (PacePill). The old test covered both and was
 * deleted with the chip. This file re-pins the dropdown row only:
 *
 *   - null / undefined lsa_schedule_days  → "Every day"
 *   - [] (empty)                          → "Every day"
 *   - all 7 days                          → "Every day"
 *   - Mon–Fri contiguous run              → "Mon–Fri"
 *   - Mon, Wed, Fri (non-contiguous)      → "Mon, Wed, Fri"
 *
 * Also asserts no [data-testid^="chip-schedule-"] element exists in any
 * variant (regression guard against re-introducing the chip).
 *
 * DB-free, network-free, fast jsdom render. Globals + css stub installed by
 * combined-pace-cell-setup.mjs (--import).
 */

import { strict as assert } from "node:assert";

const dom = (globalThis as any).window;

// Throw on any unexpected network access — PaceCell makes no calls.
(globalThis as any).fetch = () => {
  throw new Error("unexpected fetch from lsa-pace-cell-schedule test");
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { PaceCell } = await import("../../client/src/pages/adsOs/LsaDashboard");

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}
function eq(a: unknown, b: unknown, label: string): void {
  assert.equal(a, b, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const doc = (globalThis as any).document;

/** Minimal LsaDashboardRow — only the fields PaceCell actually reads. */
function makeRow(extra: Record<string, unknown>): any {
  return {
    customer_id: "1234567890",
    descriptive_name: "Test LSA",
    client_name: null,
    lsa_city: null,
    currency_code: "USD",
    doer: null,
    checker: null,
    cost_30d: 0,
    charged_leads_30d: 0,
    cpl_30d: null,
    cost_prev: 0,
    charged_leads_prev: 0,
    cpl_prev: null,
    answer_rate_30d: null,
    answer_calls_30d: 0,
    answer_connected_30d: 0,
    ads_running: true,
    pacing_pct: 50,
    monthly_budget: 2000,
    mtd_spend: 1000,
    recommended_weekly_budget: 500,
    health_score: null,
    health_band: null,
    health_at: null,
    alerts: [],
    alerts_at: null,
    ...extra,
  };
}

let root: any = null;

async function mount(r: any): Promise<void> {
  const container = doc.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(PaceCell as any, { r, c: "USD" }));
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    root = null;
  });
}

/** Click the pill button to open the dropdown. */
async function openPill(): Promise<void> {
  const pill = doc.querySelector('[data-testid="pill-pace-1234567890"]') as HTMLElement | null;
  ok(!!pill, "pacing pill renders");
  await act(async () => {
    pill!.dispatchEvent(
      new dom.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  ok(!!doc.querySelector(".pace-menu"), "clicking the pill opens the dropdown");
}

/** Read all label→value rows from the open dropdown. */
function menuRows(): { label: string; value: string }[] {
  return Array.from(doc.querySelectorAll(".pace-menu .row")).map((el: any) => ({
    label: el.querySelector(".k")?.textContent ?? "",
    value: el.querySelector(".v")?.textContent ?? "",
  }));
}

/** Return the value of the "Schedule" row, or null if absent. */
function scheduleValue(): string | null {
  const row = menuRows().find((r) => r.label === "Schedule");
  return row?.value ?? null;
}

/** Assert no chip-schedule-* test id exists anywhere in the document. */
function assertNoChip(label: string): void {
  const chip = doc.querySelector('[data-testid^="chip-schedule-"]');
  ok(!chip, `no chip-schedule-* element exists — ${label}`);
}

// ── 1. lsa_schedule_days: undefined (field absent) → "Every day" ────────────
{
  await mount(makeRow({}));
  await openPill();
  eq(scheduleValue(), "Every day", "undefined schedule days → Every day");
  assertNoChip("undefined days");
  await unmount();
}

// ── 2. lsa_schedule_days: null → "Every day" ────────────────────────────────
{
  await mount(makeRow({ lsa_schedule_days: null }));
  await openPill();
  eq(scheduleValue(), "Every day", "null schedule days → Every day");
  assertNoChip("null days");
  await unmount();
}

// ── 3. lsa_schedule_days: [] (empty array) → "Every day" ────────────────────
{
  await mount(makeRow({ lsa_schedule_days: [] }));
  await openPill();
  eq(scheduleValue(), "Every day", "empty array → Every day");
  assertNoChip("empty array");
  await unmount();
}

// ── 4. All 7 days → "Every day" ─────────────────────────────────────────────
{
  await mount(
    makeRow({ lsa_schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }),
  );
  await openPill();
  eq(scheduleValue(), "Every day", "all 7 days → Every day");
  assertNoChip("all 7 days");
  await unmount();
}

// ── 5. Mon–Fri contiguous run → "Mon–Fri" ───────────────────────────────────
{
  await mount(makeRow({ lsa_schedule_days: ["Mon", "Tue", "Wed", "Thu", "Fri"] }));
  await openPill();
  eq(scheduleValue(), "Mon–Fri", "Mon–Fri contiguous → Mon–Fri");
  assertNoChip("Mon–Fri");
  await unmount();
}

// ── 6. Mon, Wed, Fri (non-contiguous) → "Mon, Wed, Fri" ────────────────────
{
  await mount(makeRow({ lsa_schedule_days: ["Mon", "Wed", "Fri"] }));
  await openPill();
  eq(scheduleValue(), "Mon, Wed, Fri", "Mon/Wed/Fri → Mon, Wed, Fri");
  assertNoChip("Mon/Wed/Fri");
  await unmount();
}

// ── 7. Sat–Sun weekend only (contiguous, 2 days — too short for range format)
{
  await mount(makeRow({ lsa_schedule_days: ["Sat", "Sun"] }));
  await openPill();
  eq(scheduleValue(), "Sat, Sun", "Sat+Sun → Sat, Sun");
  assertNoChip("Sat+Sun");
  await unmount();
}

console.log(`\n✓ All ${passed} assertions passed.`);
