/* test-registration
{
  "name": "Reimport never overwrites a saved composite sub-value with an evidence-less $0 (Task #3868)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3868: the #3858 marketing evidence gate works at the ROW grain — a composite where the parser found ONE part (e.g. LSA uniqueLeads via the quality table) but not another (adSpend defaults to 0) is evidence-backed, pre-checked on reimport when it differs, and applying it overwrote a REAL saved spend with a fabricated $0 the PDF never contained. importCompositeSubFieldNotFound now preserves the current form value for evidence-less zero sub-fields inside an applied composite, and the row badges the missing sub-field. A regression here silently destroys real saved ad-spend data on every routine reimport. Deterministic jsdom render of the real ReportForm — no DB, fully stubbed fetch.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/client/report-reimport-hide-other-consent-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3868 — SUB-FIELD-grain fabricated zeros must not ship through an
 * APPLIED marketing composite on reimport.
 *
 * Task #3858 (see report-initial-import-marketing-fabricated-zero.test.tsx,
 * the template for this harness) hides evidence-less ALL-ZERO composites.
 * The remaining gap: a PARTIALLY-parsed composite — LSA uniqueLeads found
 * via the quality table (fieldConfidence["marketing.lsa.uniqueLeads"]) while
 * adSpend stayed a parser-defaulted 0 — passes the row gate, is pre-checked
 * on reimport because it differs from saved data, and applying it used to
 * overwrite the operator's real saved $1,400 spend with a $0 the PDF never
 * contained. This test pins the fix:
 *
 *   • Saved report: lsa = 5 leads / $1,400. Reimport parses lsa
 *     uniqueLeads: 7 WITH sub-field evidence, adSpend: 0 WITHOUT — the row
 *     renders pre-checked with the "Not in PDF: adSpend" preserved-sub-field
 *     hint, and Apply + Save persists uniqueLeads 7 while KEEPING
 *     adSpend 1400.
 *   • Control: googleAds is fully parsed (11 leads / $2,000, non-zero
 *     sub-values) — both sub-values overwrite the saved 9 / $900 normally,
 *     proving the preservation is evidence-targeted, not a broken apply.
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/reports/report-3868" },
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
(globalThis as any).HTMLFormElement = dom.window.HTMLFormElement;
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
  id: "user-3868",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

const client = {
  id: "client-3868",
  firmName: "Partial Composite Firm",
  contactName: "Test Contact",
  products: [],
  hideOtherLeads: false,
  terminology: null,
};

const ZERO_LQ = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

// The operator's REAL saved ad spend that must survive a partial reimport.
const SAVED_LSA = { uniqueLeads: 5, adSpend: 1400, leadQuality: { good: 3, notQuotable: 1, missedCalls: 1, noData: 0 } };
const SAVED_GOOGLE_ADS = { uniqueLeads: 9, adSpend: 900, leadQuality: { good: 6, notQuotable: 2, missedCalls: 1, noData: 0 } };

const reportFixture = {
  id: "report-3868",
  clientId: "client-3868",
  reportMonth: "2026-06",
  status: "draft",
  shareToken: null,
  privacyMode: false,
  hideLeadQuality: false,
  webhookImportLogId: null,
  hasStoredPdfUrl: true,
  sections: [
    {
      sectionKey: "marketing",
      updatedAt: "2026-07-01T00:00:00.000Z",
      data: {
        totalLeads: 14,
        posture: "stable",
        lsa: SAVED_LSA,
        googleAds: SAVED_GOOGLE_ADS,
        otherLeads: { count: 0, description: "", leadQuality: { ...ZERO_LQ } },
      },
    },
  ],
};

// The reimport parse:
//  • lsa is PARTIALLY parsed — uniqueLeads: 7 came from the platform quality
//    table (sub-field evidence recorded), adSpend stayed the parser default 0
//    with NO evidence anywhere. Applying must keep the saved $1,400.
//  • googleAds is FULLY parsed with non-zero sub-values (control) — both
//    overwrite the saved values normally.
const reimportParsed = {
  reportMonth: "2026-06",
  clientName: "Partial Composite Firm",
  marketing: {
    totalLeads: 18,
    leadQuality: { ...ZERO_LQ },
    gbpLocations: [],
    lsa: {
      uniqueLeads: 7,
      adSpend: 0,
      leadQuality: { good: 5, notQuotable: 1, missedCalls: 1, noData: 0 },
    },
    googleAds: {
      uniqueLeads: 11,
      adSpend: 2000,
      leadQuality: { good: 8, notQuotable: 2, missedCalls: 1, noData: 0 },
    },
    webinar: { registrants: 0, attendees: 0, hotTransfers: 0, leads: 0, leadQuality: { ...ZERO_LQ } },
    reviewGeneration: { listContacted: 0, listReviews: 0, webinarReviews: 0, otherCount: 0, totalReviews: 0 },
    otherLeads: { total: 0, socialMedia: 0, directCalls: 0, referrals: 0, leadQuality: { ...ZERO_LQ } },
  },
  fieldConfidence: {
    // The quality-table path: sub-field evidence for uniqueLeads only —
    // exactly the parser shape that used to fabricate the $0 spend.
    "marketing.lsa.uniqueLeads": { confidence: "medium", source: "LSA uniqueLeads set from quality table total: 7" },
    "marketing.lsa.leadQuality": { confidence: "high", source: "LSA quality table" },
    "marketing.googleAds": { confidence: "high", source: "Google Ads: 11 leads, $2,000 spend" },
    "marketing.googleAds.leadQuality": { confidence: "high", source: "Google Ads quality table" },
  },
};

const sectionSaves: Array<{ sectionKey: string; body: any }> = [];
const reimportCalls: Array<any> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "POST",
      path: "/api/reports/report-3868/reimport",
      respond: ({ init }: any) => {
        reimportCalls.push(init?.body ?? null);
        return {
          status: 200,
          json: { reportId: "report-3868", parsed: reimportParsed, reconciliation: {} },
        };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-3868\/sections\/([^/?]+)$/,
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
      test: (url: string) => /^\/api\/reports\/report-3868$/.test(url),
      json: reportFixture,
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
    { path: "/api/clients", json: [client] },
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

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await flush(4);
}

// ===========================================================================
// Mount the real ReportForm for the existing report.
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

// ===========================================================================
// Step 1 — trigger the reimport; the review dialog opens with the partial
// LSA composite pre-checked AND badged with the missing sub-field.
// ===========================================================================
const reimportButton = $("button-reimport-from-source");
assert(
  reimportButton,
  "button-reimport-from-source must render (report fixture has hasStoredPdfUrl: true)",
);
await clickEl(reimportButton!);
await flush(6);

assert(
  reimportCalls.length === 1,
  `clicking Re-parse from Source must POST the reimport exactly once, got ${reimportCalls.length}`,
);
assert($("dialog-import-review"), "the import-review dialog must open after the reimport parse");

// 1a. The partial LSA composite renders as a normal selectable row (it has
// real sub-field evidence — the #3858 row gate must NOT hide it) and is
// pre-checked because it differs from saved.
const lsaCheckbox = $("checkbox-marketing.lsa");
assert(lsaCheckbox, "checkbox-marketing.lsa must render (partial composite has row evidence)");
assert(
  lsaCheckbox!.getAttribute("data-state") === "checked",
  `the differing LSA row must be PRE-checked on reimport, got data-state=` +
    `"${lsaCheckbox!.getAttribute("data-state")}"`,
);

// 1b. The row badges the evidence-less sub-field so applying is honest
// consent — the displayed $0 will NOT be written.
const preservedHint = $("text-preserved-subfields-marketing.lsa");
assert(
  preservedHint && /adSpend/.test(preservedHint.textContent || ""),
  `the LSA row must render the preserved-sub-field hint naming adSpend ` +
    `(the parser never found a spend), got ` +
    `${JSON.stringify(preservedHint?.textContent)}`,
);

// 1c. Control: the fully-parsed googleAds row carries NO preserved hint —
// every sub-value is real and will overwrite.
assert(
  $("checkbox-marketing.googleAds"),
  "checkbox-marketing.googleAds must render (fully-parsed control row)",
);
assert(
  !$("text-preserved-subfields-marketing.googleAds"),
  "the fully-parsed googleAds row must NOT carry a preserved-sub-field hint",
);

// ===========================================================================
// Step 2 — Apply, then Save: the flushed marketing PUT carries the parsed
// LSA leads (7) with the PRESERVED saved spend ($1,400) — never the $0 —
// while the fully-parsed googleAds control overwrites both sub-values.
// ===========================================================================
await clickEl($("button-apply-import")!);
assert(!$("dialog-import-review"), "the review dialog must close after Apply Selected Fields");

sectionSaves.length = 0;
const saveButton = $("button-save-status");
assert(saveButton, "button-save-status (Save) must render");
await clickEl(saveButton!);
await flush(6);

const marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
assert(
  marketingSaves.length > 0,
  `Save must flush a PUT sections/marketing (captured: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedMarketing = marketingSaves[marketingSaves.length - 1].body?.data ?? {};

assert(
  savedMarketing.lsa?.uniqueLeads === 7,
  `the evidenced LSA uniqueLeads (7, from the quality table) must apply, ` +
    `got ${JSON.stringify(savedMarketing.lsa)}`,
);
assert(
  savedMarketing.lsa?.adSpend === 1400,
  `the evidence-less parser-defaulted $0 adSpend must NOT overwrite the ` +
    `saved $1,400 — this is the Task #3868 fabricated-zero overwrite — ` +
    `got ${JSON.stringify(savedMarketing.lsa)}`,
);
assert(
  savedMarketing.googleAds?.uniqueLeads === 11 && savedMarketing.googleAds?.adSpend === 2000,
  `the fully-parsed googleAds control must overwrite BOTH sub-values ` +
    `(11 / $2,000) — preservation is evidence-targeted, got ` +
    `${JSON.stringify(savedMarketing.googleAds)}`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-reimport-marketing-partial-composite.test.tsx",
);

console.log(
  "report-reimport-marketing-partial-composite.test.tsx: PASS — a partially " +
    "parsed LSA composite (evidenced 7 leads, evidence-less $0 spend) is " +
    "badged in the review dialog, applies the real leads while preserving " +
    "the saved $1,400 spend, and the fully-parsed googleAds control still " +
    "overwrites both sub-values",
);
process.exit(0);
