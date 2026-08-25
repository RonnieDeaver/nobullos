/* test-registration
{
  "name": "Decimal Avg Case Value + No-Show Rate survive save + render in report views (Task #2767)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2767: end-to-end decimal SURVIVAL — typed decimals (5250.50 / 12.5) must reach the persisted sales section unrounded via the Save flush AND render with decimals in PublicReport (12.5% stat + $850.5 formatCurrency line). The typing test above only covers keystroke commit; this is the only save-path + rendered-display guard. Deterministic jsdom render of the real ReportForm AND PublicReport — no DB, fully stubbed fetch.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/client/report-decimal-save-display-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2767 — Decimal Average Case Value and No-Show Rate SURVIVE the save
 * path and DISPLAY with their decimals in the report views.
 *
 * Task #2762 dropped `allowDecimal: false` from these two report-editor inputs
 * and extended the decimal drift-guard lint to the safeNumber route — but the
 * lint cannot prove the end-to-end behavior: a decimal typed into the editor
 * must reach the persisted sales section unrounded, and the rendered report
 * must show it. This test locks both halves:
 *
 * PHASE 1 — ReportForm (editor + save path):
 *   - Mount the REAL ReportForm for an existing report, open the Sales tab.
 *   - Type "5250.50" into input-case-value and "12.5" into input-no-show-rate.
 *   - The controlled inputs re-render from COMMITTED form state, so asserting
 *     the displayed values ("5250.5" / "12.5") proves safeNumber did not floor.
 *   - Click the Save button (flushes the sales autosave) and capture the
 *     PUT /api/reports/:id/sections/sales body: data.averageCaseValue must be
 *     exactly 5250.5 and data.noShowRate exactly 12.5 — no rounding anywhere
 *     in the save path.
 *
 * PHASE 2 — PublicReport (rendered report):
 *   - Mount the REAL PublicReport against an /api/share fixture whose sales
 *     section carries averageCaseValue 850.5 and noShowRate 12.5 (850.5 keeps
 *     the currency under the $1K threshold so formatCurrency renders the raw
 *     decimal instead of the "$X.XK" compaction).
 *   - stat-no-show-rate must render "12.5%" (percent display keeps the decimal).
 *   - The Revenue Leak Analysis "× $850.5 avg ..." line must render the decimal
 *     currency (formatCurrency path keeps the decimal).
 *
 * PHASE 3 — PublicReport ≥ $1K currency path (Task #2776):
 *   - Remount PublicReport with averageCaseValue 5250.5 — ABOVE formatCurrency's
 *     old $1K "$X.XK" compaction threshold.
 *   - Deliberate decision: the avg case value is a USER-ENTERED figure and must
 *     render exactly ("$5,250.50"), never compacted to "$5.3K". Computed
 *     aggregates (unrealized revenue headline) stay compact ("$84K").
 *   - Locks both halves: "$5,250.50" present, "$5.3K" absent, "$84K" headline.
 *
 * Heavy browser-only deps for BOTH component graphs are stubbed by
 * report-decimal-save-display-setup.mjs (registered via --import).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

// Task #2829 — fail loudly if ANY rendered list in the report pages logs
// React's missing-key warning (redraw/flicker risk, see Task #2813). Scoped
// to the key warning only; jsdom/recharts SVG casing noise is untouched.
const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/reports/report-2767" },
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
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).FocusEvent = (dom.window as any).FocusEvent ?? dom.window.Event;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(dom.window.HTMLElement.prototype as any).hasPointerCapture =
  (dom.window.HTMLElement.prototype as any).hasPointerCapture || (() => false);
(dom.window.HTMLElement.prototype as any).releasePointerCapture =
  (dom.window.HTMLElement.prototype as any).releasePointerCapture || (() => {});

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const testUser = {
  id: "user-2767",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

// Captured PUT /api/reports/report-2767/sections/<key> bodies, in order.
const sectionSaves: Array<{ sectionKey: string; body: any }> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-2767\/sections\/([^/?]+)$/,
      respond: ({ url, init }: any) => {
        const sectionKey = url.split("/").pop()!;
        const body = JSON.parse(init?.body ?? "{}");
        sectionSaves.push({ sectionKey, body });
        return {
          status: 200,
          json: { sectionKey, data: body.data, updatedAt: new Date().toISOString() },
        };
      },
    },
    {
      test: (url: string) => /^\/api\/reports\/report-2767$/.test(url),
      json: {
        id: "report-2767",
        clientId: "client-2767",
        reportMonth: "2026-06",
        status: "draft",
        shareToken: null,
        privacyMode: false,
        hideLeadQuality: false,
        webhookImportLogId: null,
        sections: [],
      },
    },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/locations"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access/detection"),
      json: {},
    },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/command-panel"),
      json: null,
    },
    { path: "/api/clients", json: [] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router, Route } = await import("wouter");
const ReportForm = (await import("../../client/src/pages/ReportForm")).default;

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLInputElement.prototype,
  "value",
)!.set!;

async function typeValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeValueSetter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await flush(4);
}

// ===========================================================================
// PHASE 1 — ReportForm: type decimals, save, assert the persisted payload.
// ===========================================================================
const container = document.getElementById("root")!;
const qc = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
let root: any = null;
await act(async () => {
  root = createRoot(container);
  root.render(
    React.createElement(
      QueryClientProvider,
      { client: qc } as any,
      React.createElement(
        Router as any,
        null,
        React.createElement(Route as any, { path: "/reports/:id", component: ReportForm }),
      ),
    ),
  );
});
await flush();

await clickEl($("tab-sales")!);

const caseValueInput = $("input-case-value") as HTMLInputElement | null;
assert(caseValueInput, "input-case-value must render on the Sales tab");
const noShowInput = $("input-no-show-rate") as HTMLInputElement | null;
assert(noShowInput, "input-no-show-rate must render on the Sales tab");

// Type the decimals. These are controlled inputs whose value re-renders from
// the COMMITTED form state, so the displayed value proves what was committed.
// React's type="number" controlled-input handling compares values numerically,
// so the DOM may keep the typed "5250.50" or re-render the committed "5250.5" —
// both prove the decimal survived. A floored commit re-renders "5250".
await typeValue(caseValueInput!, "5250.50");
assert(
  caseValueInput!.value === "5250.5" || caseValueInput!.value === "5250.50",
  `Average Case Value input must keep the decimal, got "${caseValueInput!.value}" ` +
    `(a floored commit would re-render "5250")`,
);

await typeValue(noShowInput!, "12.5");
assert(
  noShowInput!.value === "12.5",
  `committed No-Show Rate must keep the decimal — expected "12.5", got ` +
    `"${noShowInput!.value}" (a floored commit would show "12")`,
);

// Save: the header Save button flushes all pending autosaves (saveSales →
// PUT /sections/sales) before the status PATCH.
sectionSaves.length = 0;
const saveButton = $("button-save-status");
assert(saveButton, "button-save-status (Save) must render");
await clickEl(saveButton!);
await flush(6);

const salesSaves = sectionSaves.filter((s) => s.sectionKey === "sales");
assert(
  salesSaves.length > 0,
  `clicking Save must flush a PUT /api/reports/report-2767/sections/sales ` +
    `(captured section saves: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedSales = salesSaves[salesSaves.length - 1].body?.data ?? {};
assert(
  savedSales.averageCaseValue === 5250.5,
  `persisted sales.averageCaseValue must be exactly 5250.5 (no flooring/rounding ` +
    `in the save path), got ${JSON.stringify(savedSales.averageCaseValue)}`,
);
assert(
  savedSales.noShowRate === 12.5,
  `persisted sales.noShowRate must be exactly 12.5 (no flooring/rounding in the ` +
    `save path), got ${JSON.stringify(savedSales.noShowRate)}`,
);

// The editor still displays the decimals after the save round-trip.
const caseValueAfterSave = ($("input-case-value") as HTMLInputElement).value;
assert(
  caseValueAfterSave === "5250.5" || caseValueAfterSave === "5250.50",
  `Average Case Value input must still show the decimal after save, got "${caseValueAfterSave}"`,
);
assert(
  ($("input-no-show-rate") as HTMLInputElement).value === "12.5",
  "No-Show Rate input must still show 12.5 after save",
);

await act(async () => {
  root.unmount();
});

// ===========================================================================
// PHASE 2 — PublicReport: decimals RENDER in the shared report.
// ===========================================================================
// averageCaseValue 850.5 stays under formatCurrency's $1K "$X.XK" compaction
// threshold, so a preserved decimal renders literally as "$850.5"; noShowRate
// 12.5 renders via the percent display as "12.5%".
const shareFixture = {
  report: {
    id: "report-share-2767",
    clientId: "client-2767",
    reportMonth: "2026-06",
    status: "final",
    title: "June 2026 Review",
    hideLeadQuality: false,
  },
  client: {
    id: "client-2767",
    firmName: "Decimal Firm",
    contactName: "Test Contact",
    consultType: "free",
    products: [],
    terminology: null,
  },
  dataAccess: [
    { category: "consult_bookings", status: "available" },
    { category: "sales_conversions", status: "available" },
  ],
  sections: [
    {
      sectionKey: "intake",
      data: { totalConsults: 40, leadToConsultRate: 20, qualityScore: 80, noDataFlags: {} },
    },
    {
      sectionKey: "sales",
      data: {
        totalCases: 4,
        consultToCaseRate: 10,
        averageCaseValue: 850.5,
        noShowRate: 12.5,
        qualityScore: 80,
        noDataFlags: {},
      },
    },
    {
      sectionKey: "marketing",
      data: { posture: "stable", otherLeads: { count: 100, description: "Referrals" } },
    },
  ],
  trendData: [],
};

document.getElementById("root")!.innerHTML = "";
globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/share", json: shareFixture },
    { path: "/api/phase-settings", json: [] },
    { path: "/api/auth/user", json: null, status: 401 },
  ],
  defaultJson: {},
}) as any;

const PublicReport = (await import("../../client/src/pages/PublicReport")).default;
const qc2 = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
});
let root2: any = null;
await act(async () => {
  root2 = createRoot(document.getElementById("root")!);
  root2.render(
    React.createElement(
      QueryClientProvider,
      { client: qc2 } as any,
      React.createElement(PublicReport as any),
    ),
  );
});
await flush();

// No-Show Rate stat renders the decimal percent.
const noShowStat = $("stat-no-show-rate");
assert(noShowStat, "stat-no-show-rate must render on the Sales Deep Dive slide");
const noShowText = (noShowStat!.textContent ?? "").trim();
assert(
  noShowText.includes("12.5%"),
  `stat-no-show-rate must display the decimal "12.5%", got "${noShowText}" ` +
    `(a floored display would show "12%" or "13%")`,
);

// Revenue Leak Analysis renders the decimal avg case value via formatCurrency.
// Fixture math: totalLeads 100, target consults 65 → gap 25; target cases 12 →
// gap 8; casesFromIntake round(25 × 0.30) = 8 → totalMissed 16 > 0, so the
// "× $850.5 avg average case value" recoverable-revenue line renders.
const bodyText = dom.window.document.body.textContent ?? "";
assert(
  bodyText.includes("$850.5"),
  `PublicReport must render the decimal avg case value "$850.5" in the Revenue ` +
    `Leak Analysis line (a floored formatCurrency would show "$850")`,
);

await act(async () => {
  root2.unmount();
});

// ===========================================================================
// PHASE 3 — PublicReport ≥ $1K currency path (Task #2776).
// ===========================================================================
// averageCaseValue 5250.5 is ABOVE the $1K threshold where formatCurrency used
// to compact precise values to "$5.3K". The deliberate decision: user-entered
// avg case value renders EXACTLY ("$5,250.50"); computed aggregates (the
// unrealized-revenue headline) stay compact. Fixture math is identical to
// Phase 2 (totalMissed 16), so unrealizedRevenue = 16 × 5250.5 = 84,008 →
// compact headline "$84K".
const shareFixtureOver1k = {
  ...shareFixture,
  sections: shareFixture.sections.map((s) =>
    s.sectionKey === "sales"
      ? { ...s, data: { ...s.data, averageCaseValue: 5250.5 } }
      : s,
  ),
};

document.getElementById("root")!.innerHTML = "";
globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/share", json: shareFixtureOver1k },
    { path: "/api/phase-settings", json: [] },
    { path: "/api/auth/user", json: null, status: 401 },
  ],
  defaultJson: {},
}) as any;

const qc3 = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
});
let root3: any = null;
await act(async () => {
  root3 = createRoot(document.getElementById("root")!);
  root3.render(
    React.createElement(
      QueryClientProvider,
      { client: qc3 } as any,
      React.createElement(PublicReport as any),
    ),
  );
});
await flush();

const bodyTextOver1k = dom.window.document.body.textContent ?? "";
assert(
  bodyTextOver1k.includes("$5,250.50"),
  `PublicReport must render the EXACT avg case value "$5,250.50" for amounts ` +
    `over $1K in the Revenue Leak Analysis line (the old formatCurrency ` +
    `compacted it to "$5.3K", hiding the cents)`,
);
assert(
  !bodyTextOver1k.includes("$5.3K"),
  `PublicReport must NOT compact the user-entered avg case value to "$5.3K" — ` +
    `precise currency values render exactly`,
);
assert(
  bodyTextOver1k.includes("$84K"),
  `the computed unrealized-revenue headline must STAY compact ("$84K" for ` +
    `16 × $5,250.50 = $84,008) — only user-entered precise values render exactly. ` +
    `Body rendered neither; got a leakage headline of: ` +
    `"${(dom.window.document.querySelector('[data-testid="text-total-unrealized-revenue"]')?.textContent ?? "<missing>").trim()}"`,
);

await act(async () => {
  root3.unmount();
});

keyWarningGuard.assertNoKeyWarnings("report-decimal-save-display.test.tsx");

console.log(
  "report-decimal-save-display.test.tsx: PASS — 5250.50 / 12.5 commit without flooring, " +
    "the saved sales section keeps averageCaseValue 5250.5 + noShowRate 12.5, " +
    "PublicReport renders 12.5% and $850.5 with their decimals, and the ≥ $1K path " +
    "renders the exact $5,250.50 (compact $84K headline preserved)",
);
process.exit(0);
