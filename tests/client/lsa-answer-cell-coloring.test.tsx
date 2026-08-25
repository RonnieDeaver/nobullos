/* test-registration
{
  "name": "LSA AnswerCell coloring thresholds — jsdom unit confirms green (>=95%), amber (>=80%), red (<80%), and null renders a dash at each boundary value",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4830: AnswerCell uses two hard-coded coloring thresholds (95/80). Without a test a mis-edit ships silently. This pins every boundary value (null, 79, 80, 94, 95, 100) and the null path. DB-free, network-free, fast jsdom render.",
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
 * Task #4830 — AnswerCell answer-rate coloring threshold guard.
 *
 * AnswerCell colors the answer-rate pill based on two thresholds:
 *   rate >= 95  → class "g" (green)
 *   rate >= 80  → class "w" (amber)
 *   rate <  80  → class "b" (red)
 *   rate === null → renders a dash span with class "muted", no pill
 *
 * Boundary values tested: null, 79, 80, 94, 95, 100.
 *
 * DB-free, network-free, fast jsdom render. Globals + css stub installed by
 * combined-pace-cell-setup.mjs (--import).
 */

import { strict as assert } from "node:assert";

// Throw on any unexpected network access.
(globalThis as any).fetch = () => {
  throw new Error("unexpected fetch from lsa-answer-cell-coloring test");
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { AnswerCell } = await import("../../client/src/pages/adsOs/LsaDashboard");

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

/** Minimal LsaDashboardRow — only the fields AnswerCell actually reads. */
function makeRow(answer_rate_30d: number | null): any {
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
    answer_rate_30d,
    answer_calls_30d: 100,
    answer_connected_30d: answer_rate_30d ?? 0,
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
  };
}

let root: any = null;

async function mount(r: any): Promise<void> {
  const container = doc.getElementById("root")!;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(AnswerCell as any, { r }));
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    root = null;
  });
}

/** Return the rendered span element inside #root. */
function getSpan(): HTMLElement | null {
  return doc.querySelector("#root span") as HTMLElement | null;
}

// ── 1. null → dash, no pill ──────────────────────────────────────────────────
{
  await mount(makeRow(null));
  const span = getSpan();
  ok(!!span, "null: span renders");
  ok(span!.classList.contains("muted"), "null: span has class 'muted'");
  eq(span!.textContent, "—", "null: text content is dash");
  ok(!span!.classList.contains("dash-pill"), "null: no dash-pill class");
  await unmount();
}

// ── 2. rate = 79 → red ("b") ─────────────────────────────────────────────────
{
  await mount(makeRow(79));
  const span = getSpan();
  ok(!!span, "79: span renders");
  ok(span!.classList.contains("dash-pill"), "79: has dash-pill class");
  ok(span!.classList.contains("b"), "79: class is 'b' (red)");
  ok(!span!.classList.contains("w"), "79: not 'w'");
  ok(!span!.classList.contains("g"), "79: not 'g'");
  await unmount();
}

// ── 3. rate = 80 → amber ("w"), boundary inclusive ──────────────────────────
{
  await mount(makeRow(80));
  const span = getSpan();
  ok(!!span, "80: span renders");
  ok(span!.classList.contains("dash-pill"), "80: has dash-pill class");
  ok(span!.classList.contains("w"), "80: class is 'w' (amber)");
  ok(!span!.classList.contains("b"), "80: not 'b'");
  ok(!span!.classList.contains("g"), "80: not 'g'");
  await unmount();
}

// ── 4. rate = 94 → amber ("w"), below green threshold ───────────────────────
{
  await mount(makeRow(94));
  const span = getSpan();
  ok(!!span, "94: span renders");
  ok(span!.classList.contains("dash-pill"), "94: has dash-pill class");
  ok(span!.classList.contains("w"), "94: class is 'w' (amber)");
  ok(!span!.classList.contains("b"), "94: not 'b'");
  ok(!span!.classList.contains("g"), "94: not 'g'");
  await unmount();
}

// ── 5. rate = 95 → green ("g"), boundary inclusive ──────────────────────────
{
  await mount(makeRow(95));
  const span = getSpan();
  ok(!!span, "95: span renders");
  ok(span!.classList.contains("dash-pill"), "95: has dash-pill class");
  ok(span!.classList.contains("g"), "95: class is 'g' (green)");
  ok(!span!.classList.contains("w"), "95: not 'w'");
  ok(!span!.classList.contains("b"), "95: not 'b'");
  await unmount();
}

// ── 6. rate = 100 → green ("g") ─────────────────────────────────────────────
{
  await mount(makeRow(100));
  const span = getSpan();
  ok(!!span, "100: span renders");
  ok(span!.classList.contains("dash-pill"), "100: has dash-pill class");
  ok(span!.classList.contains("g"), "100: class is 'g' (green)");
  ok(!span!.classList.contains("w"), "100: not 'w'");
  ok(!span!.classList.contains("b"), "100: not 'b'");
  await unmount();
}

console.log(`\n✓ All ${passed} assertions passed.`);
