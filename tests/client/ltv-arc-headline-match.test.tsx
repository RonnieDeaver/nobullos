/* test-registration
{
  "name": "Lifetime Value arc chart endpoint matches the headline totalLeads + gates (Task #4460, #4592)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4460: the LTV compounding arc's credibility claim — its last point equals lifetimeValue.totalLeads exactly — rendered from stubbed share payloads, plus the gates: no arc when a trend month lacks marketing.leadsBySource (legacy payloads must never chart a guess), no arc when totalLeads=0, and the 'unlocks with next month's report' note when totalLeads>0 with <2 trend months. Task #4592: when the trend window's per-source sum EXCEEDS totalLeads (data inconsistency), the arc hides and a console.warn flags it instead of charting an endpoint above the headline. jsdom render, fetch fully stubbed, no DB.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4460 — the Lifetime Value slide's cumulative "compounding arc"
 * (added in Task #4281) must always reconcile with the headline number:
 * the arc anchors BACKWARD (carried-in = totalLeads − Σ window leadsBySource,
 * clamped ≥ 0), so its last point IS `lifetimeValue.totalLeads`. Nothing
 * asserted that until this test. Scenarios:
 *
 *   (A) leadsBySource present on every trend month → the arc renders
 *       (.ltv-arc present) and the chart series' last point equals
 *       totalLeads exactly; its formatted value (what the gold endpoint
 *       label renders — `value.toLocaleString()`) equals the headline
 *       card's text. First point is the synthetic "Start" carrying
 *       carried-in = totalLeads − window sum, and the series is a
 *       non-decreasing cumulative walk.
 *   (B) ONE month missing marketing.leadsBySource → no .ltv-arc (legacy
 *       payloads never chart a guess) and no "unlocks" note (months ≥ 2).
 *   (C) totalLeads > 0 but only 1 trend month → no arc; the "unlocks with
 *       next month's report" note renders instead.
 *   (D) totalLeads = 0 (reviews keep the slide alive) → no arc, no note.
 *   (E) Task #4592 — window sum EXCEEDS totalLeads (data inconsistency) →
 *       no arc (never chart an endpoint above the headline), console.warn
 *       flags it with both numbers, and no "unlocks" note.
 *
 * On the endpoint-label assertion: the shared recharts shim renders `Area`
 * as null (pure-SVG leaf), so the literal <text> emitted by
 * renderArcEndpointLabel never mounts in jsdom. The label's text is, by
 * construction in LifetimeValueSlide.tsx, `value.toLocaleString()` of the
 * series' endpoint — so this test asserts through the shim's
 * data-chart-data seam that the endpoint value equals totalLeads AND that
 * its toLocaleString() rendering equals the headline element's text, which
 * is exactly the string the label draws.
 *
 * Harness copied from tests/client/lifetime-cases-not-provided-rendered
 * .test.tsx: review-velocity-render-loader shims heavy deps; fetch fully
 * stubbed; no DB.
 */

import { register } from "node:module";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

register("./review-velocity-render-loader.mjs", import.meta.url);

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

type TrendMonth = {
  month: string;
  marketing: { totalLeads: number; leadsBySource?: Record<string, number> };
};

/**
 * Minimal share-token payload (the `/api/share/:token` response). Each
 * scenario controls `lifetimeValue.totalLeads` and the trend window; the
 * rest keeps the page mounting cleanly.
 */
function buildFixture(totalLeads: number, trendData: TrendMonth[]) {
  return {
    report: {
      id: "r1",
      clientId: "c1",
      reportMonth: "2026-06",
      status: "final",
      title: "June 2026 Report",
      hideLeadQuality: false,
    },
    client: {
      id: "c1",
      firmName: "Jones Law Firm",
      contactName: "Test Contact",
      consultType: "standard",
      products: ["gbp"],
      terminology: null,
    },
    sections: [
      {
        sectionKey: "marketing",
        data: {
          posture: "stable",
          gbp: {
            locations: [
              { name: "Jones - Main Office", uniqueLeads: 10, reviewsGenerated: 2 },
            ],
          },
        },
      },
      { sectionKey: "intake", data: { totalLeads: 10, totalConsults: 4, leadToConsultRate: 40 } },
      { sectionKey: "sales", data: {} },
    ],
    trendData,
    dataAccess: [{ category: "consult_bookings", status: "available" }],
    lifetimeValue: {
      totalLeads,
      totalReviews: 12,
      totalCases: 3,
      hasHardData: true,
    },
  };
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

function arcEl(doc: Document): Element | null {
  return doc.querySelector(".ltv-arc");
}
/** The arc's series, via the recharts shim's data-chart-data seam. */
function arcSeries(doc: Document): Array<{ month: string; value: number }> {
  const chart = doc.querySelector('.ltv-arc [data-recharts="AreaChart"]');
  assert(chart, "arc chart element (AreaChart shim) must exist inside .ltv-arc");
  const raw = chart!.getAttribute("data-chart-data");
  assert(raw, "AreaChart shim must expose its data prop as data-chart-data");
  return JSON.parse(raw!);
}

const UNLOCK_NOTE = "The compounding arc chart unlocks with next month's report.";

// ---------------------------------------------------------------------------
// (A) leadsBySource on all months → arc renders; endpoint === totalLeads;
//     the endpoint label's text (value.toLocaleString()) === headline text.
// ---------------------------------------------------------------------------
{
  const totalLeads = 1234; // > window sum (8+9+10=27) → carried-in 1207
  const doc = await renderScenario(
    buildFixture(totalLeads, [
      { month: "2026-04", marketing: { totalLeads: 8, leadsBySource: { gbp: 5, googleAds: 3 } } },
      { month: "2026-05", marketing: { totalLeads: 9, leadsBySource: { gbp: 4, lsa: 5 } } },
      { month: "2026-06", marketing: { totalLeads: 10, leadsBySource: { gbp: 6, webinar: 4 } } },
    ]),
  );

  assert(arcEl(doc), "(A) .ltv-arc must render when every trend month has leadsBySource");

  const series = arcSeries(doc);
  assert(series.length === 4, `(A) series must be Start + 3 months, got ${series.length}`);
  assert(series[0].month === "Start", `(A) first point must be the synthetic "Start", got "${series[0].month}"`);
  assert(
    series[0].value === totalLeads - 27,
    `(A) carried-in must be totalLeads − window sum (${totalLeads - 27}), got ${series[0].value}`,
  );
  for (let i = 1; i < series.length; i++) {
    assert(
      series[i].value >= series[i - 1].value,
      `(A) cumulative series must be non-decreasing at index ${i}`,
    );
  }

  const last = series[series.length - 1];
  assert(
    last.value === totalLeads,
    `(A) the arc's last point must equal totalLeads exactly (${totalLeads}), got ${last.value}`,
  );

  // The gold endpoint label renders `value.toLocaleString()` of this point;
  // it must read identically to the headline card.
  const headline = doc.querySelector('[data-testid="text-lifetime-leads"]');
  assert(headline, "(A) headline totalLeads card must render");
  const headlineText = headline!.textContent!.trim();
  assert(
    last.value.toLocaleString() === headlineText,
    `(A) endpoint label text ("${last.value.toLocaleString()}") must equal the headline ("${headlineText}")`,
  );
  assert(!doc.body.textContent!.includes(UNLOCK_NOTE), "(A) no unlock note when the arc renders");
}

// ---------------------------------------------------------------------------
// (B) ONE month missing leadsBySource → no arc (never chart a guess), and no
//     unlock note either (the window has ≥2 months — the note is only for
//     the short-window gate).
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture(500, [
      { month: "2026-04", marketing: { totalLeads: 8, leadsBySource: { gbp: 8 } } },
      { month: "2026-05", marketing: { totalLeads: 9 } }, // legacy month: no breakdown
      { month: "2026-06", marketing: { totalLeads: 10, leadsBySource: { gbp: 10 } } },
    ]),
  );

  assert(!arcEl(doc), "(B) .ltv-arc must NOT render when any month lacks leadsBySource");
  assert(
    !doc.body.textContent!.includes(UNLOCK_NOTE),
    "(B) the unlock note is for the short-window gate only — not legacy payloads",
  );
}

// ---------------------------------------------------------------------------
// (C) totalLeads > 0 but <2 trend months → no arc; unlock note instead.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture(500, [
      { month: "2026-06", marketing: { totalLeads: 10, leadsBySource: { gbp: 10 } } },
    ]),
  );

  assert(!arcEl(doc), "(C) .ltv-arc must NOT render with a single trend month");
  assert(
    doc.body.textContent!.includes(UNLOCK_NOTE),
    "(C) the 'unlocks with next month's report' note must render instead of the arc",
  );
}

// ---------------------------------------------------------------------------
// (E) Task #4592 — windowTotal EXCEEDS totalLeads (data inconsistency): the
//     carried-in clamp would otherwise make the arc's endpoint (window sum)
//     exceed the headline. The slide must hide the arc and console.warn the
//     inconsistency, and NOT show the unlock note (months ≥ 2).
// ---------------------------------------------------------------------------
{
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  let doc: Document;
  try {
    // totalLeads 20 < window sum 8+9+10 = 27
    doc = await renderScenario(
      buildFixture(20, [
        { month: "2026-04", marketing: { totalLeads: 8, leadsBySource: { gbp: 8 } } },
        { month: "2026-05", marketing: { totalLeads: 9, leadsBySource: { gbp: 9 } } },
        { month: "2026-06", marketing: { totalLeads: 10, leadsBySource: { gbp: 10 } } },
      ]),
    );
  } finally {
    console.warn = origWarn;
  }

  assert(!arcEl(doc), "(E) .ltv-arc must NOT render when windowTotal > totalLeads");
  assert(
    !doc.body.textContent!.includes(UNLOCK_NOTE),
    "(E) the unlock note is for the short-window gate only — not the inconsistency gate",
  );
  const flagged = warns.some(
    (w) =>
      w.includes("[LifetimeValueSlide]") &&
      w.includes("27") &&
      w.includes("20") &&
      w.toLowerCase().includes("inconsistency"),
  );
  assert(
    flagged,
    `(E) a console.warn must flag the inconsistency naming both numbers; got: ${JSON.stringify(warns)}`,
  );
}

// ---------------------------------------------------------------------------
// (D) totalLeads = 0 (reviews keep the slide alive) → no arc, no note.
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildFixture(0, [
      { month: "2026-04", marketing: { totalLeads: 8, leadsBySource: { gbp: 8 } } },
      { month: "2026-05", marketing: { totalLeads: 9, leadsBySource: { gbp: 9 } } },
    ]),
  );

  assert(!arcEl(doc), "(D) .ltv-arc must NOT render when totalLeads is 0");
  assert(
    !doc.body.textContent!.includes(UNLOCK_NOTE),
    "(D) the unlock note requires totalLeads > 0",
  );
}

if (activeRoot) {
  await act(async () => {
    activeRoot.unmount();
  });
  activeRoot = null;
}

console.log(
  "ltv-arc-headline-match.test.tsx: PASS — " +
    "arc endpoint equals totalLeads (label text matches headline), carried-in anchors the Start point, " +
    "legacy month without leadsBySource hides the arc, <2 months shows the unlock note, totalLeads=0 shows neither",
);
process.exit(0);
