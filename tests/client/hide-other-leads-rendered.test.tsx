/* test-registration
{
  "name": "Hide Other leads — suppression path RENDERS correctly in PublicReport (Task #2758)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2758 — "Hide Other leads" RENDERS correctly in PublicReport.
 *
 * Guards the end-to-end suppression path: server payload (hideOtherLeads: true)
 * → PublicReport render → displayed Total Leads is the adjusted figure.
 *
 * The pure helper `adjustDisplayLeads` is already locked by
 * `tests/hide-other-leads-surfaces.test.ts`. This test catches a WIRING
 * regression — e.g. the `data.client.hideOtherLeads` guard moving or the
 * `otherLeadsCount = 0` zeroing block being removed — that would slip past
 * the pure-function test.
 *
 * Investigation finding (confirmed pre-task): Jones Law Firm April 2026 share
 * link already shows 463 leads (not 1,007) — the public report path has been
 * correct since Task #2667. The PublicReport historical trend chart (lines
 * 3181-3191) also rebuilds the Total line from active sources when
 * hideOtherLeads=true, so there are NO outstanding gaps in PublicReport.
 * The Task #2758 fixes were admin surfaces only (ReportComparison +
 * TrendAnalytics — both leads AND conversion rates).
 *
 * Scenarios tested:
 *   (A) hideOtherLeads=true  → Total Leads shows 463 (1,007 − 544 Other),
 *       NO "Other" lead-source row, and the Missed Call Rate card shows the
 *       rate over the REDUCED lead set (Other's missed calls AND lead count
 *       both excluded — Task #2680 symmetric recompute, Task #2759 assertion).
 *   (B) hideOtherLeads=false → Total Leads shows 1,007 (raw persisted value),
 *       "Other" row renders, Missed Call Rate uses the FULL lead set.
 *   (C) hideOtherLeads=true, otherLeads.count=0 → Total Leads shows raw (463,
 *       no Other to subtract)
 *   (D) Task #2775 — multi-source trend rebuild: with gbp + google_ads +
 *       webinar ACTIVE and lsa INACTIVE, the toggle-ON trend Total must equal
 *       exactly gbp + googleAds + webinar (equiv) per month — catching a
 *       regression that drops a gated source, double-counts one (e.g. sums
 *       raw webinarHT instead of the webinar equiv), or fails to exclude an
 *       inactive product's leadsBySource value present in the month row.
 *       Task #2789 — this webinar inclusion is DELIBERATE: the chart's Total
 *       reconciles with the lines drawn (incl. "Webinar (equiv.)"), so it may
 *       differ from the Total Leads card (totalLeadsExcludingWebinar). The
 *       divergent case must render the clarifying footnote
 *       (text-trend-total-webinar-footnote); no-webinar cases must NOT.
 *       Task #2803 — the toggle-OFF case is ALSO divergent for webinar
 *       clients: the raw persisted marketing.totalLeads is the source
 *       report's grand total, which the import parser canonically treats as
 *       GBP + Google Ads + LSA + RAW webinar leads + Other (reconciliation /
 *       Other-residual math in pdfImportParser.ts; raw-persist invariant in
 *       server/routes/reports.ts, Task #2760), while the card excludes
 *       webinar. So the footnote renders toggle-OFF too, with raw-leads
 *       wording (no "× 1.6 equivalents" claim, since the raw total carries
 *       raw webinar leads, not equivalents).
 *   Task #4982 — Other-leads disclosure clarifiers: toggle OFF (B) renders
 *       the 'includes 544 "Other" leads — not attributed to our campaigns'
 *       sub-line on the Marketing hero and the Engine Health leads hero,
 *       plus the compact count-only version on the Engine Health Marketing
 *       status row; toggle ON (A) and count=0 (C) render none of them. The
 *       gate is the derive layer's FINAL otherLeadsCount — the same value
 *       the totals carry — so disclosure and totals can never disagree.
 *
 * Missed-call-rate expectations are derived from the shared
 * `@shared/missedCallRate` `computeMissedCallRate` helper (the same module the
 * card reads), so a re-threshold/rounding change breaks both in lockstep.
 *
 * Heavy browser-only deps are shimmed by the existing
 * `review-velocity-render-loader.mjs` loader.
 */

import { register } from "node:module";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

register("./review-velocity-render-loader.mjs", import.meta.url);

// Task #2822 — fail loudly if ANY rendered list in the report page logs
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
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }));
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
class ResizeObserverStub {
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
class IntersectionObserverStub {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
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

// Task #2765 — locate the Historical Trends "Leads by Source (Monthly)"
// LineChart via the recharts shim's serialized `data-chart-data` attribute
// (review-velocity-render-loader.mjs), identified as the only LineChart whose
// rows carry both a `total` and a `gbp` series.
function findTrendChartData(doc: Document): Array<{ month: string; total: number; gbp: number }> {
  const charts = Array.from(
    doc.querySelectorAll('[data-recharts="LineChart"][data-chart-data]'),
  );
  const matches = charts
    .map((el) => JSON.parse(el.getAttribute("data-chart-data")!))
    .filter(
      (rows: any) =>
        Array.isArray(rows) &&
        rows.length > 0 &&
        rows.every((r: any) => "total" in r && "gbp" in r),
    );
  assert(
    matches.length === 1,
    `expected exactly one leads-by-source trend LineChart, found ${matches.length}`,
  );
  return matches[0];
}

// Canonical source for the Missed Call Rate the Intake card renders — the
// card computes `computeMissedCallRate(displayedMissedCalls, totalLeads)` live
// from the SAME lead set as the displayed total (Task #2680), so this test's
// expectations must come from the same helper.
const { computeMissedCallRate } = await import("@shared/missedCallRate");

// Fixture missed-call inputs (see buildFixture below):
//   GBP location missedCalls = 63; Other bucket missedCalls = 137.
const GBP_MISSED = 63;
const OTHER_MISSED = 137;
const GBP_LEADS = 463;
const OTHER_LEADS = 544;

/**
 * Build a minimal share-token payload (the `/api/share/:token` response) with
 * GBP leads and an explicit Other bucket, so the hide-other toggle has clear
 * numbers to suppress.
 *
 * Jones Law Firm scenario values:
 *   gbpTotalLeads = 463  (one GBP location, uniqueLeads=463)
 *   otherLeads.count = 544
 *   Toggle ON  → totalLeadsExcludingWebinar = 463 + 0 = 463
 *   Toggle OFF → totalLeadsExcludingWebinar = 463 + 544 = 1,007
 */
function buildFixture(hideOtherLeads: boolean, otherCount = 544) {
  return {
    report: {
      id: "r1",
      clientId: "c1",
      reportMonth: "2026-04",
      status: "final",
      title: "April 2026 Report",
      hideLeadQuality: false,
    },
    client: {
      id: "c1",
      firmName: "Jones Law Firm",
      contactName: "Test Contact",
      consultType: "standard",
      products: ["gbp"],
      terminology: null,
      hideOtherLeads,
    },
    sections: [
      {
        sectionKey: "marketing",
        data: {
          posture: "stable",
          gbp: {
            locations: [
              {
                name: "Jones - Main Office",
                uniqueLeads: 463,
                reviewsGenerated: 15,
                leadQuality: { good: 300, notQuotable: 100, missedCalls: GBP_MISSED, noData: 0 },
              },
            ],
          },
          otherLeads: {
            count: otherCount,
            description: "",
            leadQuality: { good: 200, notQuotable: 100, missedCalls: OTHER_MISSED, noData: 0 },
          },
        },
      },
      { sectionKey: "intake", data: { totalLeads: 1007, totalConsults: 46, leadToConsultRate: 4.6 } },
      { sectionKey: "sales", data: {} },
    ],
    trendData: [
      { month: "2026-02", marketing: { totalLeads: 950, leadsBySource: { gbp: 400 } } },
      { month: "2026-03", marketing: { totalLeads: 980, leadsBySource: { gbp: 430 } } },
      { month: "2026-04", marketing: { totalLeads: 1007, leadsBySource: { gbp: 463 } } },
    ],
    // Marks intake data as provided so the Intake Deep Dive slide renders its
    // real metrics (incl. the Missed Call Rate card) instead of "Data Required".
    dataAccess: [{ category: "consult_bookings", status: "available" }],
  };
}

// Task #2775 — multi-source fixture values (scenario D). lsa is present in
// every month row but the product is INACTIVE, so the toggle-ON rebuilt Total
// must exclude it. webinar (equiv) differs from webinarHT (raw hot transfers)
// so summing the wrong key is detectable.
const MULTI_MONTHS = [
  { month: "2026-02", totalLeads: 950, gbp: 400, googleAds: 100, lsa: 50, webinar: 48, webinarHT: 30 },
  { month: "2026-03", totalLeads: 980, gbp: 430, googleAds: 110, lsa: 60, webinar: 51, webinarHT: 32 },
  { month: "2026-04", totalLeads: 1007, gbp: 463, googleAds: 120, lsa: 70, webinar: 56, webinarHT: 35 },
];

function buildMultiSourceFixture(hideOtherLeads: boolean) {
  const base = buildFixture(hideOtherLeads);
  base.client.products = ["gbp", "google_ads", "webinar"]; // lsa NOT active
  base.trendData = MULTI_MONTHS.map((m) => ({
    month: m.month,
    marketing: {
      totalLeads: m.totalLeads,
      leadsBySource: {
        gbp: m.gbp,
        googleAds: m.googleAds,
        lsa: m.lsa, // present in the row, but product inactive → must be excluded
        webinar: m.webinar,
        webinarHT: m.webinarHT,
      },
    },
  }));
  return base;
}

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
  if (activeRoot) {
    await act(async () => { activeRoot.unmount(); });
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
  await flush(0);
  await flush(0);
  await flush(0);

  return dom.window.document;
}

// ---------------------------------------------------------------------------
// Scenario (A): hideOtherLeads=true → Total Leads = 463 (Other suppressed)
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildFixture(true));

  const el = doc.querySelector('[data-testid="text-total-leads-ht"]');
  assert(el, "(A) text-total-leads-ht must render with hideOtherLeads=true");
  assert(
    el!.textContent === "463",
    `(A) toggle ON → Total Leads must be 463 (gbp only, Other suppressed), got "${el!.textContent}"`,
  );

  const otherRow = doc.querySelector('[data-testid="row-lead-source-other"]');
  assert(
    !otherRow,
    "(A) toggle ON → Other lead-source row must not render (otherLeadsCount=0)",
  );

  // Task #2759 — Missed Call Rate must use the REDUCED lead set: numerator
  // drops Other's missed calls AND denominator drops Other's lead count.
  const reducedRate = computeMissedCallRate(GBP_MISSED, GBP_LEADS);
  const fullRate = computeMissedCallRate(GBP_MISSED + OTHER_MISSED, GBP_LEADS + OTHER_LEADS);
  assert(
    reducedRate !== fullRate,
    "fixture sanity: reduced vs full missed-call rate must differ or the assertion proves nothing",
  );
  const mcr = doc.querySelector('[data-testid="stat-missed-call-rate"]');
  assert(mcr, "(A) Missed Call Rate card must render");
  assert(
    mcr!.textContent!.includes(`${reducedRate}%`),
    `(A) toggle ON → Missed Call Rate must be ${reducedRate}% (${GBP_MISSED}/${GBP_LEADS}, Other excluded from BOTH sides), got "${mcr!.textContent}"`,
  );
  assert(
    !mcr!.textContent!.includes(`${fullRate}%`),
    `(A) toggle ON → Missed Call Rate must NOT show the full-set rate ${fullRate}%`,
  );
  // Guard the asymmetric failure mode too: numerator keeps Other's missed
  // calls but denominator drops its leads (the exploding-rate bug class).
  const asymmetricRate = computeMissedCallRate(GBP_MISSED + OTHER_MISSED, GBP_LEADS);
  assert(
    !mcr!.textContent!.includes(`${asymmetricRate}%`),
    `(A) toggle ON → Missed Call Rate must NOT show the asymmetric rate ${asymmetricRate}% (Other missed calls over reduced denominator)`,
  );

  // Task #2765 — the Historical Trends chart must rebuild its Total line from
  // ACTIVE sources only when the toggle is on, so it agrees with the Total
  // Leads card beside it (463, not the raw persisted 1,007).
  const trend = findTrendChartData(doc);
  const current = trend[trend.length - 1];
  assert(
    current.total === GBP_LEADS,
    `(A) toggle ON → trend chart current-month Total must be ${GBP_LEADS} (rebuilt from active sources, Other excluded), got ${current.total}`,
  );
  assert(
    trend.every((r) => r.total === r.gbp),
    `(A) toggle ON → EVERY trend month's Total must equal its active-source (gbp) sum, got ${JSON.stringify(trend)}`,
  );

  // Task #2789 — no webinar product active → the chart Total cannot diverge
  // from the card, so the webinar footnote must NOT render.
  assert(
    !doc.querySelector('[data-testid="text-trend-total-webinar-footnote"]'),
    "(A) toggle ON, no webinar product → trend webinar footnote must NOT render",
  );

  // Task #4982 — toggle ON zeroes the derive layer's final otherLeadsCount,
  // so NO Other-leads disclosure clarifier may render anywhere on the deck
  // (Marketing hero, Engine Health leads hero, Engine Health status row).
  for (const id of [
    "text-total-leads-other-annotation",
    "text-engine-hero-leads-other-note",
    "text-engine-marketing-other-note",
  ]) {
    assert(
      !doc.querySelector(`[data-testid="${id}"]`),
      `(A) toggle ON → ${id} must NOT render (otherLeadsCount zeroed by the toggle)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scenario (B): hideOtherLeads=false → Total Leads = 1,007 (Other included)
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildFixture(false));

  const el = doc.querySelector('[data-testid="text-total-leads-ht"]');
  assert(el, "(B) text-total-leads-ht must render with hideOtherLeads=false");
  assert(
    el!.textContent === "1007",
    `(B) toggle OFF → Total Leads must be 1,007 (gbp 463 + other 544), got "${el!.textContent}"`,
  );

  const otherRow = doc.querySelector('[data-testid="row-lead-source-other"]');
  assert(
    !!otherRow,
    "(B) toggle OFF → Other lead-source row must render (otherLeadsCount=544 > 0)",
  );

  // Task #2759 — with the toggle OFF the Missed Call Rate uses the FULL lead
  // set: Other's missed calls in the numerator, Other's leads in the denominator.
  const fullRate = computeMissedCallRate(GBP_MISSED + OTHER_MISSED, GBP_LEADS + OTHER_LEADS);
  const mcr = doc.querySelector('[data-testid="stat-missed-call-rate"]');
  assert(mcr, "(B) Missed Call Rate card must render");
  assert(
    mcr!.textContent!.includes(`${fullRate}%`),
    `(B) toggle OFF → Missed Call Rate must be ${fullRate}% (${GBP_MISSED + OTHER_MISSED}/${GBP_LEADS + OTHER_LEADS}, Other included on BOTH sides), got "${mcr!.textContent}"`,
  );

  // Task #2765 — toggle OFF: the trend chart's Total line must be the RAW
  // persisted totalLeads per month (Other included), matching the 1,007 card.
  const trend = findTrendChartData(doc);
  const current = trend[trend.length - 1];
  assert(
    current.total === GBP_LEADS + OTHER_LEADS,
    `(B) toggle OFF → trend chart current-month Total must be ${GBP_LEADS + OTHER_LEADS} (raw persisted totalLeads), got ${current.total}`,
  );
  const rawTotals = [950, 980, 1007];
  assert(
    trend.length === rawTotals.length && trend.every((r, i) => r.total === rawTotals[i]),
    `(B) toggle OFF → trend Totals must be the raw persisted values ${JSON.stringify(rawTotals)}, got ${JSON.stringify(trend.map((r) => r.total))}`,
  );

  // Task #2803 — no webinar product active → no card-vs-chart webinar
  // divergence exists, so the footnote must NOT render (toggle OFF).
  assert(
    !doc.querySelector('[data-testid="text-trend-total-webinar-footnote"]'),
    "(B) toggle OFF, no webinar product → trend webinar footnote must NOT render",
  );

  // Task #4982 — with 544 Other leads inside the displayed 1,007, all three
  // disclosure clarifiers render the ACTUAL count (jsdom textContent keeps the
  // rendered quotes around "Other" literal). The engine hero is the leads
  // fallback here (sales data empty → revenue not computable) — exactly the
  // variant the clarifier must annotate.
  const expectedClarifier = `includes ${OTHER_LEADS} "Other" leads — not attributed to our campaigns`;
  const heroNote = doc.querySelector('[data-testid="text-total-leads-other-annotation"]');
  assert(heroNote, "(B) toggle OFF → Marketing hero Other-leads clarifier must render");
  assert(
    heroNote!.textContent === expectedClarifier,
    `(B) Marketing hero clarifier must read "${expectedClarifier}", got "${heroNote!.textContent}"`,
  );
  const engineHeroNote = doc.querySelector('[data-testid="text-engine-hero-leads-other-note"]');
  assert(engineHeroNote, "(B) toggle OFF → Engine Health leads-hero clarifier must render");
  assert(
    engineHeroNote!.textContent === expectedClarifier,
    `(B) Engine Health hero clarifier must read "${expectedClarifier}", got "${engineHeroNote!.textContent}"`,
  );
  const engineRowNote = doc.querySelector('[data-testid="text-engine-marketing-other-note"]');
  assert(engineRowNote, "(B) toggle OFF → Engine Health Marketing status row must carry the compact clarifier");
  assert(
    engineRowNote!.textContent === `includes ${OTHER_LEADS} "Other" leads`,
    `(B) compact row clarifier must state the count without the attribution tail, got "${engineRowNote!.textContent}"`,
  );
}

// ---------------------------------------------------------------------------
// Scenario (C): hideOtherLeads=true but otherLeads.count=0 → full count shows
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildFixture(true, 0));

  const el = doc.querySelector('[data-testid="text-total-leads-ht"]');
  assert(el, "(C) text-total-leads-ht must render with hideOtherLeads=true + count=0");
  assert(
    el!.textContent === "463",
    `(C) toggle ON + no Other → Total Leads still 463 (nothing to subtract), got "${el!.textContent}"`,
  );

  // Task #4982 — otherLeads.count=0: nothing to disclose, clarifiers absent.
  assert(
    !doc.querySelector('[data-testid="text-total-leads-other-annotation"]') &&
      !doc.querySelector('[data-testid="text-engine-hero-leads-other-note"]') &&
      !doc.querySelector('[data-testid="text-engine-marketing-other-note"]'),
    "(C) otherLeads.count=0 → no Other-leads disclosure clarifiers anywhere",
  );
}

// ---------------------------------------------------------------------------
// Scenario (D): Task #2775 — multi-source trend rebuild with toggle ON.
// Active products gbp + google_ads + webinar; lsa INACTIVE but its
// leadsBySource value is present in every month row. The rebuilt Total must
// equal exactly the sum of the three ACTIVE source values per month.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildMultiSourceFixture(true));

  const trend = findTrendChartData(doc);
  assert(
    trend.length === MULTI_MONTHS.length,
    `(D) trend chart must have ${MULTI_MONTHS.length} months, got ${trend.length}`,
  );

  for (let i = 0; i < MULTI_MONTHS.length; i++) {
    const m = MULTI_MONTHS[i];
    const row = trend[i] as any;
    const expected = m.gbp + m.googleAds + m.webinar;

    // Sanity: the fixture makes every wrong sum distinct from the right one,
    // or an assertion below could pass by coincidence.
    assert(
      expected !== m.totalLeads &&
        expected !== expected + m.lsa &&
        m.webinar !== m.webinarHT,
      `(D) fixture sanity: month ${m.month} must distinguish active-sum / raw total / lsa-included / webinarHT-swapped values`,
    );

    // The inactive product's value must be PRESENT in the chart row (the data
    // mapper passes all sources through) — proving exclusion is a gating
    // decision, not missing data.
    assert(
      row.lsa === m.lsa,
      `(D) month ${m.month}: lsa value ${m.lsa} must be present in the chart row (got ${row.lsa}) or the exclusion assertion proves nothing`,
    );

    assert(
      row.total === expected,
      `(D) month ${m.month}: toggle ON → Total must be ${expected} (gbp ${m.gbp} + googleAds ${m.googleAds} + webinar equiv ${m.webinar}); ` +
        `NOT ${expected + m.lsa} (inactive lsa included), NOT ${m.gbp + m.googleAds + m.webinarHT} (raw webinarHT swapped for equiv), ` +
        `NOT ${m.totalLeads} (raw persisted total). Got ${row.total}`,
    );
  }

  // Task #2789 — the webinar-inclusive Total is deliberate, and THIS is the
  // divergent case (toggle ON + webinar active): the chart Total (gbp +
  // googleAds + webinar equiv) exceeds the card's webinar-excluding figure.
  // The clarifying footnote must render so a client can reconcile the two.
  const footnote = doc.querySelector('[data-testid="text-trend-total-webinar-footnote"]');
  assert(
    footnote,
    "(D) toggle ON + webinar active → trend webinar footnote must render",
  );
  assert(
    /Total line includes webinar lead equivalents/i.test(footnote!.textContent || ""),
    `(D) footnote must explain the Total includes webinar equivalents, got "${footnote!.textContent}"`,
  );
}

// ---------------------------------------------------------------------------
// Scenario (E): same multi-source fixture, toggle OFF → Total stays the raw
// persisted totalLeads (the rebuild must remain gated on hideOtherLeads).
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildMultiSourceFixture(false));

  const trend = findTrendChartData(doc);
  assert(
    trend.length === MULTI_MONTHS.length &&
      trend.every((r, i) => r.total === MULTI_MONTHS[i].totalLeads),
    `(E) toggle OFF → multi-source trend Totals must be the raw persisted values ${JSON.stringify(MULTI_MONTHS.map((m) => m.totalLeads))}, got ${JSON.stringify(trend.map((r) => r.total))}`,
  );

  // Task #2803 — toggle OFF shows the raw persisted Total, which INCLUDES
  // raw webinar leads (parser invariant: total = GBP + Ads + LSA + webinar
  // leads + Other) while the Total Leads card excludes webinar — so the
  // footnote MUST render for webinar clients here too, with the raw-leads
  // wording (it must NOT claim "× 1.6 equivalents": the raw total carries
  // raw webinar leads, not the equivalent series the toggle-ON rebuild uses).
  const offFootnote = doc.querySelector('[data-testid="text-trend-total-webinar-footnote"]');
  assert(
    offFootnote,
    "(E) toggle OFF + webinar active → trend webinar footnote MUST render (raw total includes webinar leads)",
  );
  assert(
    /Total line includes webinar leads/i.test(offFootnote!.textContent || ""),
    `(E) toggle OFF footnote must use the raw-leads wording, got "${offFootnote!.textContent}"`,
  );
  assert(
    !/equivalents|×\s*1\.6/i.test(offFootnote!.textContent || ""),
    `(E) toggle OFF footnote must NOT claim × 1.6 equivalents (raw total carries raw webinar leads), got "${offFootnote!.textContent}"`,
  );
}

if (activeRoot) {
  await act(async () => {
    activeRoot.unmount();
  });
  activeRoot = null;
}

// Task #2822 — zero tolerance for the React missing-key warning across every
// render this test performed (all five toggle scenarios).
keyWarningGuard.assertNoKeyWarnings("hide-other-leads-rendered.test.tsx");

console.log(
  "hide-other-leads-rendered.test.tsx: PASS — " +
  "toggle ON=463 (reduced missed-call rate, no Other slice), toggle OFF=1007 (full rate, Other slice), no-other=463, " +
  "multi-source trend Total = sum of ACTIVE sources only (inactive lsa excluded, webinar equiv not raw HT) with toggle OFF staying raw, " +
  "Other-leads disclosure clarifiers gate on the final otherLeadsCount (Task #4982)",
);
process.exit(0);
