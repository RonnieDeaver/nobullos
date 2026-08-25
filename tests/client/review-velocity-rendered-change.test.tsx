/* test-registration
{
  "name": "Review-velocity change badge + sparkline RENDER correctly in PublicReport Review Generation panel (Task #2610)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2610 (gated during the #2615 rebase to satisfy the #2616 smoke-gate guard): mounts the REAL PublicReport and asserts the Review-velocity change badge + sparkline actually render (increase → green ↑ badge + sparkline; no-change → badge hidden, sparkline shown; single point → neither). A wiring regression slips past the pure helper test. Fast, DB-free, deterministic jsdom render with heavy deps shimmed and fetch fully stubbed.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2610 — The "Velocity Trend" sparkline + month-over-month CHANGE BADGE
 * must actually RENDER (be wired) in the Review Generation panel inside
 * `client/src/pages/PublicReport.tsx`, not merely be computed correctly by the
 * pure `computeReviewVelocityChange` helper (already locked by the unit test
 * `tests/client/review-velocity-math.test.ts`, Task #2598).
 *
 * A wiring regression — the change badge rendering when it should be hidden (or
 * vice-versa), the wrong up/down color/glyph, or the sparkline chart rendering
 * with fewer than 2 points (or NOT rendering with >= 2) — would slip past the
 * pure helper test today. This test mounts the REAL PublicReport against a known
 * `/api/share/:token` fixture and asserts the rendered Velocity Trend block for
 * three scenarios:
 *
 *   (a) INCREASE (current > previous month) → change badge renders, GREEN with
 *       an "↑" glyph and the percent, AND the sparkline chart renders (>= 2 pts).
 *   (b) NO CHANGE (current == previous month) → change badge is HIDDEN, but the
 *       sparkline chart still renders (>= 2 points).
 *   (c) SINGLE point (< 2 months of history) → neither the sparkline chart NOR
 *       the change badge render.
 *
 * The change math (which point is "current" vs "previous", the pin-latest-to-
 * panel-total rule, the hide-on-zero-delta rule) is read from the shared
 * `computeReviewVelocity` / `computeReviewVelocityChange` helpers so a change to
 * the math breaks BOTH the panel and this assertion's fixture sanity checks in
 * lockstep.
 *
 * Task #4844 — scenario (a) additionally asserts the panel's three labeled
 * stats (this-month / window-total / window-average) render with the helper's
 * values. Task #4981 — scenario (c) asserts the sparse-history COLLAPSE: with
 * <= 1 month in the trailing window the row renders ONE "This month" stat
 * (never three identical numbers with duplicated "Current month" labels).
 *
 * Heavy browser-only deps reached through PublicReport's import graph (recharts,
 * framer-motion, maplibre via InteractiveHeatmap, CeoPulseChartRenderer) are
 * redirected to lightweight shims by `review-velocity-render-loader.mjs` (shared
 * with the Task #2597 goal-band render test). The recharts shim renders the
 * AreaChart container's children so the sparkline's presence/absence is
 * assertable via its wrapper test id.
 */

import { register } from "node:module";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

// Must be registered BEFORE the dynamic import of PublicReport below so the
// heavy-dep shims are in place when its module graph loads.
register("./review-velocity-render-loader.mjs", import.meta.url);

// Task #2829 — fail loudly if ANY rendered list in the report page logs
// React's missing-key warning (redraw/flicker risk, see Task #2813). Scoped
// to the key warning only; jsdom/recharts SVG casing noise is untouched.
const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/share/test-token" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLImageElement = dom.window.HTMLImageElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
(globalThis as any).IntersectionObserver = IntersectionObserverStub;
(dom.window as any).IntersectionObserver = IntersectionObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true;
(dom.window as any).confirm = () => true;
(globalThis as any).scrollTo = () => {};
(dom.window as any).scrollTo = () => {};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Canonical sources — the shared velocity + change helpers the panel reads, so
// a change to the math breaks BOTH the panel and these fixture sanity checks.
// ---------------------------------------------------------------------------
const { computeReviewVelocity, computeReviewVelocityChange } = await import(
  "../../client/src/lib/reviewVelocity"
);

// ---------------------------------------------------------------------------
// Fixture — a minimal but valid SharedReportData (the `/api/share/:token`
// payload). Products are empty so all platform-gated branches are inert; only
// the marketing slide's Review Generation panel inputs matter:
//   - reviewGeneration.list.reviews → panel total → pinned LATEST velocity point
//   - trendData months → the earlier (non-pinned) velocity points
// NO monthlyTarget is set so the goal band stays neutral (the band wiring is
// covered by review-velocity-rendered-band.test.tsx); this test focuses purely
// on the change badge + sparkline render.
//
// `panelTotal` = list.reviews (webinar/other are 0). The latest series point is
// pinned to panelTotal, and every EARLIER point is its trendData
// marketing.totalReviews — so the badge compares (panelTotal vs the
// second-to-last trendData value).
// ---------------------------------------------------------------------------
function buildFixture(panelTotalReviews: number, trendValues: number[]) {
  const reviewGeneration: any = {
    list: { reviews: panelTotalReviews, activationRate: 50 },
    webinar: { reviews: 0, activationRate: 0 },
    other: { count: 0 },
  };

  // One trendData month per value. The LAST month's value is overwritten by the
  // panel-total pin, so only its presence (a point) matters, not its number.
  const trendData = trendValues.map((v, i) => ({
    month: `2025-${String(i + 1).padStart(2, "0")}`,
    marketing: { totalReviews: v },
  }));

  return {
    report: {
      id: "report-1",
      clientId: "client-1",
      reportMonth: "2025-05",
      status: "final",
      title: "May 2025 Review",
    },
    client: {
      id: "client-1",
      firmName: "Test Firm",
      contactName: "Test Contact",
      consultType: "standard",
      products: [],
      terminology: null,
    },
    sections: [
      { sectionKey: "marketing", data: { posture: "stable", reviewGeneration } },
      { sectionKey: "intake", data: {} },
      { sectionKey: "sales", data: {} },
    ],
    trendData,
  };
}

// ---------------------------------------------------------------------------
// Mount the real PublicReport against a scenario fixture and return the
// document so the test can query the rendered Velocity Trend block.
// ---------------------------------------------------------------------------
const React = (await import("react")).default;
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

let activeRoot: any = null;

async function renderScenario(fixture: any): Promise<Document> {
  // Fresh root + fetch stub + QueryClient per scenario so the per-token share
  // query refetches the scenario's fixture instead of reusing a cached one.
  if (activeRoot) {
    await act(async () => {
      activeRoot.unmount();
    });
    activeRoot = null;
  }
  dom.window.document.getElementById("root")!.innerHTML = "";

  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/share", json: fixture },
      { path: "/api/phase-settings", json: [] },
      { path: "/api/auth/user", json: null, status: 401 },
    ],
    defaultJson: {},
  }) as any;

  const PublicReport = (await import("@/pages/PublicReport")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });

  const container = dom.window.document.getElementById("root")!;
  await act(async () => {
    activeRoot = ReactDOMClient.createRoot(container);
    activeRoot.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(PublicReport as any),
      ),
    );
  });
  // Let the share query resolve + effects settle.
  await flush(0);
  await flush(0);
  await flush(0);

  return dom.window.document;
}

// ---------------------------------------------------------------------------
// Scenario (a): INCREASE → change badge renders GREEN with "↑" + the percent,
// and the sparkline chart renders. trend [10, 20] + panel total 30 → series
// [10, 20, 30]: current 30 > prev 20 → +10 (+50%), up.
// ---------------------------------------------------------------------------
{
  const PANEL_TOTAL = 30;
  const TREND = [10, 20, 99]; // last value overwritten by the panel-total pin
  const velocity = computeReviewVelocity(
    TREND.map((v, i) => ({ month: `m${i}`, marketing: { totalReviews: v } })),
    PANEL_TOTAL,
  );
  const { series } = velocity;
  const change = computeReviewVelocityChange(series);
  assert(change.show === true, "fixture sanity: increase must show the badge");
  assert(change.direction === "up", "fixture sanity: increase must be up");
  assert(change.delta > 0, "fixture sanity: delta must be positive");
  const expectedPct = Math.abs(change.pct); // 50

  const doc = await renderScenario(buildFixture(PANEL_TOTAL, TREND));

  // The headline must render so we know the panel mounted (not loading/empty).
  const headline = doc.querySelector('[data-testid="text-review-velocity"]');
  assert(headline, "(a) review-velocity headline must render");

  // Task #4844 — the three labeled stats render the helper's values: this
  // month = pinned latest point (30), 90-day total = 10 + 20 + 30 = 60. Read
  // from the shared helper result so a math change breaks fixture + assert in
  // lockstep.
  assert(velocity.windowTotal === 60, "fixture sanity: window total must be 60");
  const monthStat = doc.querySelector('[data-testid="text-review-velocity-month"]');
  assert(monthStat, "(a) 'This month' stat must render");
  assert(
    monthStat!.textContent === String(velocity.currentMonth),
    `(a) 'This month' stat must show ${velocity.currentMonth}, got "${monthStat!.textContent}"`,
  );
  const totalStat = doc.querySelector('[data-testid="text-review-velocity-total"]');
  assert(totalStat, "(a) window-total stat must render");
  assert(
    totalStat!.textContent === String(velocity.windowTotal),
    `(a) window-total stat must show ${velocity.windowTotal}, got "${totalStat!.textContent}"`,
  );
  const totalLabelEl = doc.querySelector('[data-testid="text-review-velocity-total-label"]');
  assert(
    totalLabelEl?.textContent === velocity.totalLabel && velocity.totalLabel === "90-day total",
    `(a) total label must read "90-day total", got "${totalLabelEl?.textContent}"`,
  );

  // Sparkline renders with >= 2 points.
  const sparkline = doc.querySelector(
    '[data-testid="chart-review-velocity-sparkline"]',
  );
  assert(sparkline, "(a) sparkline chart must render with >= 2 points");
  assert(
    sparkline!.querySelector('[data-recharts="AreaChart"]'),
    "(a) sparkline AreaChart must render inside the chart wrapper",
  );

  // Change badge renders, GREEN, with the up glyph + percent.
  const badge = doc.querySelector(
    '[data-testid="badge-review-velocity-change"]',
  );
  assert(badge, "(a) change badge must render on an increase");
  const badgeText = (badge!.textContent ?? "").trim();
  assert(
    badgeText.includes("↑"),
    `(a) change badge must show the up glyph "↑", got "${badgeText}"`,
  );
  assert(
    badgeText.includes(`${expectedPct}%`),
    `(a) change badge must show ${expectedPct}%, got "${badgeText}"`,
  );
  assert(
    badge!.className.includes("text-report-healthy-bright"),
    `(a) increase badge must be GREEN, got class "${badge!.className}"`,
  );
  assert(
    !badge!.className.includes("text-report-crimson-bright"),
    "(a) increase badge must NOT be red",
  );
}

// ---------------------------------------------------------------------------
// Scenario (a2): DECREASE → change badge renders RED with "↓" + the percent,
// and the sparkline chart renders. trend [40, 30] + panel total 20 → series
// [40, 30, 20]: current 20 < prev 30 → -10 (-33%), down.
// ---------------------------------------------------------------------------
{
  const PANEL_TOTAL = 20;
  const TREND = [40, 30, 99]; // last value overwritten by the panel-total pin
  const { series } = computeReviewVelocity(
    TREND.map((v, i) => ({ month: `m${i}`, marketing: { totalReviews: v } })),
    PANEL_TOTAL,
  );
  const change = computeReviewVelocityChange(series);
  assert(change.show === true, "fixture sanity: decrease must show the badge");
  assert(change.direction === "down", "fixture sanity: decrease must be down");
  assert(change.delta < 0, "fixture sanity: delta must be negative");
  const expectedPct = Math.abs(change.pct); // 33

  const doc = await renderScenario(buildFixture(PANEL_TOTAL, TREND));

  const sparkline = doc.querySelector(
    '[data-testid="chart-review-velocity-sparkline"]',
  );
  assert(sparkline, "(a2) sparkline chart must render with >= 2 points");

  const badge = doc.querySelector(
    '[data-testid="badge-review-velocity-change"]',
  );
  assert(badge, "(a2) change badge must render on a decrease");
  const badgeText = (badge!.textContent ?? "").trim();
  assert(
    badgeText.includes("↓"),
    `(a2) change badge must show the down glyph "↓", got "${badgeText}"`,
  );
  assert(
    badgeText.includes(`${expectedPct}%`),
    `(a2) change badge must show ${expectedPct}%, got "${badgeText}"`,
  );
  assert(
    badge!.className.includes("text-report-crimson-bright"),
    `(a2) decrease badge must be RED, got class "${badge!.className}"`,
  );
  assert(
    !badge!.className.includes("text-report-healthy-bright"),
    "(a2) decrease badge must NOT be green",
  );
}

// ---------------------------------------------------------------------------
// Scenario (b): NO CHANGE → change badge HIDDEN, sparkline still renders.
// trend [10, 30] + panel total 30 → series [10, 30, 30]: current 30 == prev 30
// → delta 0 → badge hidden. 3 points → sparkline renders.
// ---------------------------------------------------------------------------
{
  const PANEL_TOTAL = 30;
  const TREND = [10, 30, 99]; // second-to-last (30) equals the pinned panel total
  const { series } = computeReviewVelocity(
    TREND.map((v, i) => ({ month: `m${i}`, marketing: { totalReviews: v } })),
    PANEL_TOTAL,
  );
  const change = computeReviewVelocityChange(series);
  assert(change.delta === 0, "fixture sanity: no-change must have delta 0");
  assert(change.show === false, "fixture sanity: no-change must hide the badge");

  const doc = await renderScenario(buildFixture(PANEL_TOTAL, TREND));

  const sparkline = doc.querySelector(
    '[data-testid="chart-review-velocity-sparkline"]',
  );
  assert(sparkline, "(b) sparkline chart must still render with >= 2 points");

  assert(
    !doc.querySelector('[data-testid="badge-review-velocity-change"]'),
    "(b) change badge must be HIDDEN when there is no month-over-month change",
  );
}

// ---------------------------------------------------------------------------
// Scenario (c): SINGLE point (< 2 months) → neither the sparkline NOR the badge
// render. trend [single] + panel total 15 → series [15]: 1 point < 2.
// Task #4981 — with <= 1 month in the trailing window the three-stat row also
// COLLAPSES to ONE "This month" stat: the helper still reports the degenerate
// duplicate stats/labels (fixture sanity below), but the panel must NOT render
// them as three identical stats. No target is set in this fixture, so the
// collapsed stat takes the neutral MUTED no-target color and no band chip /
// target annotation renders — the no-target direction of the "exactly when a
// target is set" rule (the target-set direction is scenario (e) of the band
// suite, review-velocity-rendered-band.test.tsx).
// ---------------------------------------------------------------------------
{
  const PANEL_TOTAL = 15;
  const TREND = [99]; // single month → pinned to panel total → 1 series point
  const velocity = computeReviewVelocity(
    TREND.map((v, i) => ({ month: `m${i}`, marketing: { totalReviews: v } })),
    PANEL_TOTAL,
  );
  const { series } = velocity;
  assert(series.length === 1, "fixture sanity: single trend month → 1 point");

  const doc = await renderScenario(buildFixture(PANEL_TOTAL, TREND));

  // The single collapsed stat still renders under the canonical velocity test
  // id (panel mounted, not loading/empty) — but the chart + badge must not.
  const headline = doc.querySelector('[data-testid="text-review-velocity"]');
  assert(headline, "(c) review-velocity stat must still render");

  assert(
    !doc.querySelector('[data-testid="chart-review-velocity-sparkline"]'),
    "(c) sparkline chart must NOT render with < 2 points",
  );
  assert(
    !doc.querySelector('[data-testid="badge-review-velocity-change"]'),
    "(c) change badge must NOT render with < 2 points",
  );

  // Task #4981 — fixture sanity: the helper's sparse result is exactly the
  // degeneracy the collapse hides — all three stats the same number, both
  // window labels "Current month".
  assert(velocity.totalLabel === "Current month", "fixture sanity: 1-month total label");
  assert(velocity.avgLabel === "Current month", "fixture sanity: 1-month average label");
  assert(
    velocity.currentMonth === PANEL_TOTAL &&
      velocity.windowTotal === PANEL_TOTAL &&
      velocity.trailingAvg === PANEL_TOTAL,
    "fixture sanity: with 1 month all three helper stats are the same number",
  );

  // The collapsed row: ONE stat, labelled "This month", showing the single
  // pinned point. The duplicate slots must NOT reach the DOM: no separate
  // month/total stats, no second/third label, no "Current month" text.
  assert(
    headline!.textContent === String(PANEL_TOTAL),
    `(c) collapsed stat must show the single pinned point ${PANEL_TOTAL}, got "${headline!.textContent}"`,
  );
  const monthLabelEl = doc.querySelector('[data-testid="text-review-velocity-month-label"]');
  assert(
    monthLabelEl?.textContent === "This month",
    `(c) collapsed stat label must read "This month", got "${monthLabelEl?.textContent}"`,
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-month"]'),
    "(c) the separate 'This month' stat slot must NOT render when collapsed",
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-total"]'),
    "(c) the window-total stat slot must NOT render when collapsed",
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-total-label"]'),
    "(c) the window-total label must NOT render when collapsed",
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-label"]'),
    "(c) the separate average label must NOT render when collapsed",
  );
  // Exactly ONE metric stat inside the velocity focus panel, no duplicated
  // "Current month" text, and the reviews/mo unit stays with the single stat.
  const panel = headline!.closest(".bg-report-charcoal");
  assert(panel, "(c) velocity focus panel must exist");
  const metricCount = panel!.querySelectorAll(".metric-large").length;
  assert(
    metricCount === 1,
    `(c) exactly ONE stat must render in the collapsed panel, got ${metricCount}`,
  );
  assert(
    !(panel!.textContent ?? "").includes("Current month"),
    "(c) 'Current month' must NOT appear in the collapsed panel",
  );
  assert(
    (panel!.textContent ?? "").includes("reviews / mo"),
    "(c) the reviews/mo unit must stay with the collapsed stat",
  );
  // No target in this fixture → the collapsed stat takes the neutral muted
  // no-target color (never a silent green/red verdict) and the band chip +
  // "Target: N / mo" annotation must NOT render.
  assert(
    headline!.className.includes("text-report-ink-inverse-muted"),
    `(c) no-target collapsed stat must be neutral muted, got class "${headline!.className}"`,
  );
  assert(
    !doc.querySelector('[data-testid="badge-review-velocity-band"]'),
    "(c) band chip must NOT render with no target set",
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-target"]'),
    "(c) 'Target: N / mo' annotation must NOT render with no target set",
  );
}

if (activeRoot) {
  await act(async () => {
    activeRoot.unmount();
  });
  activeRoot = null;
}

keyWarningGuard.assertNoKeyWarnings("review-velocity-rendered-change.test.tsx");

console.log(
  "review-velocity-rendered-change.test.tsx: PASS — change badge (↑ green on increase, hidden on no-change) + sparkline (>= 2 points only) render correctly in PublicReport Review Generation panel",
);
