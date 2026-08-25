/* test-registration
{
  "name": "Review-velocity goal band RENDERS in PublicReport Review Generation panel (Task #2597)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2597: the review-velocity goal band's COMPUTATION is locked by the unit test above, but its WIRING into the Review Generation panel (PublicReport.tsx) — headline color, band chip, \"Target: N / mo\" annotation, chart target reference line, and the \"no target → neutral, no green/red, no chip/annotation/line\" invariant — had no rendered-screen coverage. Gate the rendered test so band-wiring drift fails fast (deterministic jsdom render, no DB, fully stubbed fetch + shimmed charts).",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2597 — The review-velocity GOAL BAND (Task #2579) must actually RENDER
 * (be wired) in the Review Generation panel inside `client/src/pages/PublicReport.tsx`,
 * not merely be computed correctly by the shared `getReviewVelocityBand` helper
 * (which is already locked by the pure unit test
 * `tests/review-velocity-severity.test.ts`).
 *
 * A wiring regression — the headline color forking off the wrong band, the band
 * chip / "Target: N / mo" annotation / chart target reference line rendering
 * when they shouldn't (or vice-versa), or the panel silently painting a green /
 * red verdict with NO target set — would slip past the pure helper test today.
 *
 * This test mounts the REAL PublicReport against a known `/api/share/:token`
 * fixture and asserts the rendered Review Generation panel for four scenarios:
 *
 *   (a) target set ABOVE pace  → on_track / green headline, "On track" band chip,
 *                                "Target: N / mo" annotation, chart target line.
 *   (b) target set BELOW pace  → off_track / red (non-green) headline,
 *                                "Off track" band chip, annotation + target line.
 *   (c) NO target set          → neutral gold headline (NO green, NO red), and
 *                                NO band chip, NO "Target: N / mo" annotation,
 *                                NO chart reference line.
 *   (d) target set, BEHIND pace → behind / yellow headline (NOT green/red/gold),
 *                                "Behind pace" band chip, annotation + target
 *                                line. This is the middle early-warning state
 *                                (velocity below target but >= BEHIND_RATIO of
 *                                it) that (a)/(b)/(c) leave unverified (#2619).
 *   (e) SPARSE history (1 month), target set → the three-stat row COLLAPSES
 *                                to ONE "This month" stat carrying the band
 *                                color; band chip + annotation intact, no
 *                                duplicated "Current month" labels (#4981).
 *
 * The band labels, classification thresholds, and gold/green/red mapping are
 * read from the shared `@shared/reviewVelocitySeverity` module so a rename /
 * re-threshold breaks BOTH the panel and this assertion in lockstep.
 *
 * Task #4844 — scenario (a) additionally asserts the panel's three labeled
 * stats ("This month" count, "90-day total", 90-day average) render from the
 * one helper result, and that the goal-band color stays on the AVERAGE only
 * (the month/total stats never take the band verdict color).
 *
 * Heavy browser-only deps reached through PublicReport's import graph (recharts,
 * framer-motion, maplibre via InteractiveHeatmap, CeoPulseChartRenderer) are
 * redirected to lightweight shims by `review-velocity-render-loader.mjs`. The
 * recharts shim renders container children and a queryable `ReferenceLine`
 * marker so the chart target line's presence/absence is assertable.
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
// Canonical sources — the shared band classifier + labels the panel reads, so
// a rename / re-threshold breaks BOTH the panel and these expectations.
// ---------------------------------------------------------------------------
const { getReviewVelocityBand, getReviewVelocityBandLabel } = await import(
  "@shared/reviewVelocitySeverity"
);
// Task #4981 — the shared velocity helper, for the sparse scenario's fixture
// sanity checks (1 trend month → 1-month window → all three stats the same
// number), so a change to the window math breaks fixture + assert in lockstep.
const { computeReviewVelocity } = await import(
  "../../client/src/lib/reviewVelocity"
);

// ---------------------------------------------------------------------------
// Fixture — a minimal but valid SharedReportData (the `/api/share/:token`
// payload). Products are empty so all platform-gated branches are inert; only
// the marketing slide's Review Generation panel inputs matter:
//   - reviewGeneration.list.reviews → panel total → pinned latest velocity point
//   - reviewGeneration.monthlyTarget → the goal band's target
//   - 3 trendData months (chartData.length >= 2 so the sparkline + target line render)
//     — or fewer via `historyMonths` (Task #4981: 1 month → collapsed row)
// With equal monthly review counts the trailing average == `reviews`, so the
// band is fully determined by (reviews vs monthlyTarget).
// ---------------------------------------------------------------------------
function buildFixture(reviews: number, monthlyTarget: number | null, historyMonths: number = 3) {
  const reviewGeneration: any = {
    list: { reviews, activationRate: 50 },
    webinar: { reviews: 0, activationRate: 0 },
    other: { count: 0 },
  };
  if (monthlyTarget !== null) reviewGeneration.monthlyTarget = monthlyTarget;

  // historyMonths keeps the NEWEST months (default 3 = the full 90-day
  // window); the Task #4981 sparse scenario passes 1 so the trailing window
  // holds a single month and the stat row collapses.
  const trendData = [
    { month: "2025-03", marketing: { totalReviews: reviews } },
    { month: "2025-04", marketing: { totalReviews: reviews } },
    { month: "2025-05", marketing: { totalReviews: reviews } },
  ].slice(3 - historyMonths);

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
// document body so the test can query the rendered Review Generation panel.
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
// Scenario (a): target ABOVE pace → on_track / green.
// reviews 30 vs target 10 → trailingAvg 30 >= 10 → on_track.
// ---------------------------------------------------------------------------
{
  const ABOVE_REVIEWS = 30;
  const ABOVE_TARGET = 10;
  assert(
    getReviewVelocityBand(ABOVE_REVIEWS, ABOVE_TARGET) === "on_track",
    "fixture sanity: above-pace must classify on_track",
  );

  const doc = await renderScenario(buildFixture(ABOVE_REVIEWS, ABOVE_TARGET));

  const headline = doc.querySelector('[data-testid="text-review-velocity"]');
  assert(headline, "(a) review-velocity headline must render");
  assert(
    headline!.textContent === String(ABOVE_REVIEWS),
    `(a) headline must show trailing avg ${ABOVE_REVIEWS}, got "${headline!.textContent}"`,
  );
  const aClass = headline!.className;
  assert(aClass.includes("text-report-healthy-bright"), `(a) headline must be GREEN (on_track), got class "${aClass}"`);
  assert(!aClass.includes("text-report-crimson-bright"), "(a) headline must NOT be red");
  assert(!aClass.includes("text-report-gold"), "(a) headline must NOT be behind-gold");
  assert(!aClass.includes("text-report-ink-inverse-muted"), "(a) headline must NOT be neutral muted");

  // Task #4844 — the three labeled stats. Fixture months are all equal to
  // ABOVE_REVIEWS and the latest point is pinned to the panel total, so:
  // this month = ABOVE_REVIEWS, 90-day total = 3 × ABOVE_REVIEWS.
  const monthStat = doc.querySelector('[data-testid="text-review-velocity-month"]');
  assert(monthStat, "(a) 'This month' stat must render");
  assert(
    monthStat!.textContent === String(ABOVE_REVIEWS),
    `(a) 'This month' stat must show the pinned latest point ${ABOVE_REVIEWS}, got "${monthStat!.textContent}"`,
  );
  const monthLabel = doc.querySelector('[data-testid="text-review-velocity-month-label"]');
  assert(monthLabel, "(a) 'This month' label must render");
  assert(
    monthLabel!.textContent === "This month",
    `(a) month label must read "This month", got "${monthLabel!.textContent}"`,
  );
  const totalStat = doc.querySelector('[data-testid="text-review-velocity-total"]');
  assert(totalStat, "(a) window-total stat must render");
  assert(
    totalStat!.textContent === String(ABOVE_REVIEWS * 3),
    `(a) 90-day total must sum the 3-month window (${ABOVE_REVIEWS * 3}), got "${totalStat!.textContent}"`,
  );
  const totalLabel = doc.querySelector('[data-testid="text-review-velocity-total-label"]');
  assert(totalLabel, "(a) window-total label must render");
  assert(
    totalLabel!.textContent === "90-day total",
    `(a) total label must read "90-day total" with 3 months of history, got "${totalLabel!.textContent}"`,
  );
  const avgLabelEl = doc.querySelector('[data-testid="text-review-velocity-label"]');
  assert(avgLabelEl, "(a) average label must still render");
  assert(
    avgLabelEl!.textContent === "90-day trailing average",
    `(a) average label must read "90-day trailing average", got "${avgLabelEl!.textContent}"`,
  );
  // The goal-band verdict color belongs to the AVERAGE alone — the month and
  // total stats must stay neutral white, never green/red/gold.
  for (const [el, name] of [[monthStat, "month"], [totalStat, "total"]] as const) {
    assert(
      !el!.className.includes("text-report-healthy-bright") &&
        !el!.className.includes("text-report-crimson-bright") &&
        !el!.className.includes("text-report-gold") &&
        !el!.className.includes("text-report-ink-inverse-muted"),
      `(a) ${name} stat must NOT take the band color, got class "${el!.className}"`,
    );
  }

  const chip = doc.querySelector('[data-testid="badge-review-velocity-band"]');
  assert(chip, "(a) band chip must render when target is set");
  assert(
    chip!.textContent === getReviewVelocityBandLabel("on_track"),
    `(a) band chip must read "${getReviewVelocityBandLabel("on_track")}", got "${chip!.textContent}"`,
  );

  const targetAnno = doc.querySelector('[data-testid="text-review-velocity-target"]');
  assert(targetAnno, "(a) target annotation must render when target is set");
  assert(
    targetAnno!.textContent === `Target: ${ABOVE_TARGET} / mo`,
    `(a) target annotation must read "Target: ${ABOVE_TARGET} / mo", got "${targetAnno!.textContent}"`,
  );

  const refLine = doc.querySelector('[data-testid="recharts-reference-line"]');
  assert(refLine, "(a) chart target reference line must render when target is set");
  assert(
    refLine!.textContent === `Target ${ABOVE_TARGET}`,
    `(a) reference line label must read "Target ${ABOVE_TARGET}", got "${refLine!.textContent}"`,
  );
}

// ---------------------------------------------------------------------------
// Scenario (b): target BELOW pace → off_track / red (non-green).
// reviews 4 vs target 20 → trailingAvg 4 < 20*0.7(=14) → off_track.
// ---------------------------------------------------------------------------
{
  const BELOW_REVIEWS = 4;
  const BELOW_TARGET = 20;
  assert(
    getReviewVelocityBand(BELOW_REVIEWS, BELOW_TARGET) === "off_track",
    "fixture sanity: below-pace must classify off_track",
  );

  const doc = await renderScenario(buildFixture(BELOW_REVIEWS, BELOW_TARGET));

  const headline = doc.querySelector('[data-testid="text-review-velocity"]');
  assert(headline, "(b) review-velocity headline must render");
  const bClass = headline!.className;
  assert(bClass.includes("text-report-crimson-bright"), `(b) headline must be RED (off_track), got class "${bClass}"`);
  assert(!bClass.includes("text-report-healthy-bright"), "(b) below-pace headline must NOT be green");
  assert(!bClass.includes("text-report-gold"), "(b) below-pace headline must NOT be behind-gold");
  assert(!bClass.includes("text-report-ink-inverse-muted"), "(b) below-pace headline must NOT be neutral muted");

  const chip = doc.querySelector('[data-testid="badge-review-velocity-band"]');
  assert(chip, "(b) band chip must render when target is set");
  assert(
    chip!.textContent === getReviewVelocityBandLabel("off_track"),
    `(b) band chip must read "${getReviewVelocityBandLabel("off_track")}", got "${chip!.textContent}"`,
  );

  const targetAnno = doc.querySelector('[data-testid="text-review-velocity-target"]');
  assert(targetAnno, "(b) target annotation must render when target is set");
  assert(
    targetAnno!.textContent === `Target: ${BELOW_TARGET} / mo`,
    `(b) target annotation must read "Target: ${BELOW_TARGET} / mo", got "${targetAnno!.textContent}"`,
  );

  const refLine = doc.querySelector('[data-testid="recharts-reference-line"]');
  assert(refLine, "(b) chart target reference line must render when target is set");
}

// ---------------------------------------------------------------------------
// Scenario (c): NO target → neutral gold, NO band verdict / annotation / line.
// reviews 12, target absent → band "none" → gold, no green/red.
// ---------------------------------------------------------------------------
{
  const NEUTRAL_REVIEWS = 12;
  assert(
    getReviewVelocityBand(NEUTRAL_REVIEWS, null) === "none",
    "fixture sanity: no-target must classify none",
  );

  const doc = await renderScenario(buildFixture(NEUTRAL_REVIEWS, null));

  const headline = doc.querySelector('[data-testid="text-review-velocity"]');
  assert(headline, "(c) review-velocity headline must render");
  assert(
    headline!.textContent === String(NEUTRAL_REVIEWS),
    `(c) headline must show trailing avg ${NEUTRAL_REVIEWS}, got "${headline!.textContent}"`,
  );
  const cClass = headline!.className;
  assert(cClass.includes("text-report-ink-inverse-muted"), `(c) no-target headline must be neutral MUTED, got class "${cClass}"`);
  assert(!cClass.includes("text-report-healthy-bright"), "(c) no-target headline must NOT be green");
  assert(!cClass.includes("text-report-crimson-bright"), "(c) no-target headline must NOT be red");
  assert(!cClass.includes("text-report-gold"), "(c) no-target headline must NOT be behind-gold");

  assert(
    !doc.querySelector('[data-testid="badge-review-velocity-band"]'),
    "(c) band chip must NOT render with no target set",
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-target"]'),
    "(c) 'Target: N / mo' annotation must NOT render with no target set",
  );
  assert(
    !doc.querySelector('[data-testid="recharts-reference-line"]'),
    "(c) chart target reference line must NOT render with no target set",
  );
}

// ---------------------------------------------------------------------------
// Scenario (d): target set, BEHIND pace → behind / gold (Task #2619).
// reviews 16 vs target 20 → 16 >= 20*0.7(=14) AND 16 < 20 → behind. This is the
// middle early-warning state — the one client-facing band (a)/(b)/(c) leave
// unverified at the render level. A wiring regression that mis-colored or
// mislabeled this warning (e.g. forking it to green/red/gold) would slip past
// the other scenarios.
// ---------------------------------------------------------------------------
{
  const BEHIND_REVIEWS = 16;
  const BEHIND_TARGET = 20;
  assert(
    getReviewVelocityBand(BEHIND_REVIEWS, BEHIND_TARGET) === "behind",
    "fixture sanity: behind-pace must classify behind",
  );

  const doc = await renderScenario(buildFixture(BEHIND_REVIEWS, BEHIND_TARGET));

  const headline = doc.querySelector('[data-testid="text-review-velocity"]');
  assert(headline, "(d) review-velocity headline must render");
  assert(
    headline!.textContent === String(BEHIND_REVIEWS),
    `(d) headline must show trailing avg ${BEHIND_REVIEWS}, got "${headline!.textContent}"`,
  );
  const dClass = headline!.className;
  assert(dClass.includes("text-report-gold"), `(d) headline must be GOLD (behind), got class "${dClass}"`);
  assert(!dClass.includes("text-report-healthy-bright"), "(d) behind-pace headline must NOT be green");
  assert(!dClass.includes("text-report-crimson-bright"), "(d) behind-pace headline must NOT be red");
  assert(!dClass.includes("text-report-ink-inverse-muted"), "(d) behind-pace headline must NOT be neutral muted");

  const chip = doc.querySelector('[data-testid="badge-review-velocity-band"]');
  assert(chip, "(d) band chip must render when target is set");
  assert(
    chip!.textContent === getReviewVelocityBandLabel("behind"),
    `(d) band chip must read "${getReviewVelocityBandLabel("behind")}", got "${chip!.textContent}"`,
  );

  const targetAnno = doc.querySelector('[data-testid="text-review-velocity-target"]');
  assert(targetAnno, "(d) target annotation must render when target is set");
  assert(
    targetAnno!.textContent === `Target: ${BEHIND_TARGET} / mo`,
    `(d) target annotation must read "Target: ${BEHIND_TARGET} / mo", got "${targetAnno!.textContent}"`,
  );

  const refLine = doc.querySelector('[data-testid="recharts-reference-line"]');
  assert(refLine, "(d) chart target reference line must render when target is set");
  assert(
    refLine!.textContent === `Target ${BEHIND_TARGET}`,
    `(d) reference line label must read "Target ${BEHIND_TARGET}", got "${refLine!.textContent}"`,
  );
}

// ---------------------------------------------------------------------------
// Scenario (e): SPARSE history (1 month) + target set → COLLAPSED single stat
// (Task #4981). With <= 1 month in the trailing window this-month ==
// window-total == trailing-average and both window labels degrade to
// "Current month" — three identical stats rendered as broken repeated text
// (the reported screenshot: "THIS MONTH 13 / CURRENT MONTH 13 / CURRENT MONTH
// 13 reviews/mo"). The panel must render ONE "This month" stat carrying the
// goal-band color, with the band chip + "Target: N / mo" annotation intact
// (the average IS the single month's count, so the band verdict is
// unchanged). reviews 13 vs target 10 → on_track.
// ---------------------------------------------------------------------------
{
  const SPARSE_REVIEWS = 13;
  const SPARSE_TARGET = 10;
  assert(
    getReviewVelocityBand(SPARSE_REVIEWS, SPARSE_TARGET) === "on_track",
    "fixture sanity: sparse above-pace must classify on_track",
  );
  // The helper's degenerate sparse result is exactly what the collapse hides:
  // one trend month → 1-month window → all three stats the same number, both
  // window labels "Current month".
  const sparse = computeReviewVelocity(
    [{ month: "2025-05", marketing: { totalReviews: SPARSE_REVIEWS } }],
    SPARSE_REVIEWS,
  );
  assert(sparse.monthsCount === 1, "fixture sanity: one trend month → 1-month window");
  assert(
    sparse.currentMonth === SPARSE_REVIEWS &&
      sparse.windowTotal === SPARSE_REVIEWS &&
      sparse.trailingAvg === SPARSE_REVIEWS,
    "fixture sanity: with 1 month all three helper stats are the same number",
  );
  assert(
    sparse.totalLabel === "Current month" && sparse.avgLabel === "Current month",
    "fixture sanity: 1-month window labels degrade to Current month",
  );

  const doc = await renderScenario(buildFixture(SPARSE_REVIEWS, SPARSE_TARGET, 1));

  // ONE stat, labelled "This month", showing the month's count with the band
  // color on it (the collapse hands the verdict color to the single stat).
  const stat = doc.querySelector('[data-testid="text-review-velocity"]');
  assert(stat, "(e) the collapsed single stat must render");
  assert(
    stat!.textContent === String(SPARSE_REVIEWS),
    `(e) collapsed stat must show ${SPARSE_REVIEWS}, got "${stat!.textContent}"`,
  );
  assert(
    stat!.className.includes("text-report-healthy-bright"),
    `(e) collapsed stat must carry the on_track band color, got class "${stat!.className}"`,
  );
  const monthLabel = doc.querySelector('[data-testid="text-review-velocity-month-label"]');
  assert(
    monthLabel?.textContent === "This month",
    `(e) collapsed stat label must read "This month", got "${monthLabel?.textContent}"`,
  );

  // The duplicate slots must NOT render: no separate month/total stats, no
  // second/third label, and no "Current month" text anywhere in the panel.
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-month"]'),
    "(e) the separate 'This month' stat slot must NOT render when collapsed",
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-total"]'),
    "(e) the window-total stat slot must NOT render when collapsed",
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-total-label"]'),
    "(e) the window-total label must NOT render when collapsed",
  );
  assert(
    !doc.querySelector('[data-testid="text-review-velocity-label"]'),
    "(e) the separate average label must NOT render when collapsed",
  );
  const panel = stat!.closest(".bg-report-charcoal");
  assert(panel, "(e) velocity focus panel must exist");
  const metricCount = panel!.querySelectorAll(".metric-large").length;
  assert(
    metricCount === 1,
    `(e) exactly ONE stat must render in the collapsed panel, got ${metricCount}`,
  );
  assert(
    !(panel!.textContent ?? "").includes("Current month"),
    "(e) 'Current month' must NOT appear in the collapsed panel",
  );
  assert(
    (panel!.textContent ?? "").includes("reviews / mo"),
    "(e) the reviews/mo unit must stay with the collapsed stat",
  );

  // Band chip + target annotation are preserved exactly as with full history.
  const chip = doc.querySelector('[data-testid="badge-review-velocity-band"]');
  assert(chip, "(e) band chip must render when target is set");
  assert(
    chip!.textContent === getReviewVelocityBandLabel("on_track"),
    `(e) band chip must read "${getReviewVelocityBandLabel("on_track")}", got "${chip!.textContent}"`,
  );
  const targetAnno = doc.querySelector('[data-testid="text-review-velocity-target"]');
  assert(targetAnno, "(e) target annotation must render when target is set");
  assert(
    targetAnno!.textContent === `Target: ${SPARSE_TARGET} / mo`,
    `(e) target annotation must read "Target: ${SPARSE_TARGET} / mo", got "${targetAnno!.textContent}"`,
  );
  // With a single month there is no sparkline, so the chart target reference
  // line cannot render — target presence is conveyed by the chip + annotation.
  assert(
    !doc.querySelector('[data-testid="recharts-reference-line"]'),
    "(e) no chart reference line without a sparkline (single-point history)",
  );
}

if (activeRoot) {
  await act(async () => {
    activeRoot.unmount();
  });
  activeRoot = null;
}

keyWarningGuard.assertNoKeyWarnings("review-velocity-rendered-band.test.tsx");

console.log(
  "review-velocity-rendered-band.test.tsx: PASS — goal band wiring renders (above→green, below→red, behind→yellow, none→gold) in PublicReport Review Generation panel",
);
