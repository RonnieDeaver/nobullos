/* test-registration
{
  "name": "INITIAL PDF import never applies fabricated MARKETING zeros (Task #3858)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3858: the intake (#3830) and sales (#3852) fabricated-zero gates cover the entry-tracked scalar metrics, but the Marketing rows of the import review dialog are COMPOSITE objects (Google Ads / LSA leads+spend, webinar figures) with no noDataFlags mechanism — and before #3858 an all-zero parser-defaulted composite counted as 'has value' (nested leadQuality object is truthy) and rendered PRE-CHECKED, defaulting first uploads into stamping fabricated $0 spend / 0-lead figures. COMPOSITE_IMPORT_METRIC_KEYS now routes these rows through importMetricNotFound (descendant evidence + deep non-zero value) and the apply path refuses them via selApplied. A regression confined to the composite gate would ship fabricated marketing zeros on first uploads without failing the intake/sales gates. Deterministic jsdom render of the real ReportForm — no DB, fully stubbed fetch.",
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
 * Task #3858 — fabricated (evidence-less) parse zeros must not ship through
 * the MARKETING section of the initial PDF import either.
 *
 * Marketing differs structurally from the intake/sales gates (#3830/#3852):
 * its dialog rows are composite objects (googleAds = leads+spend+quality)
 * and the form state has NO marketing noDataFlags — so the gate is at the
 * ROW grain, via COMPOSITE_IMPORT_METRIC_KEYS in
 * shared/importMetricPresence.ts (evidence = a fieldConfidence entry on the
 * key or any dotted descendant; value = any non-zero numeric leaf). This
 * test pins it:
 *
 *   • marketing.googleAds arrives ALL-ZERO with NO parse evidence (the
 *     parser's defaulted shape). It must render NO selectable row (listed
 *     under "Not found in PDF" instead) and applying the dialog must NOT
 *     write it (the form keeps its untouched defaults).
 *   • marketing.lsa arrives with real values (7 leads / $1,400) WITH parse
 *     evidence — pre-checked, full value visible in the row, and the values
 *     land in the created report's marketing section PUT.
 *   • marketing.webinar arrives with real figures (30/12/4) — pre-checked
 *     and persisted.
 *
 * Drives the same flow as the sales template: /reports/new?clientId= →
 * input-pdf-import → POST /api/reports/import-pdf → consent dialog → Apply →
 * create form submit → PUT /sections/marketing.
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import) —
 * the same harness as the #3830/#3852 templates.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  {
    pretendToBeVisual: true,
    url: "http://localhost/reports/new?clientId=client-3858",
  },
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
// The initial-import handler builds a multipart body from the chosen file.
(globalThis as any).File = dom.window.File;
(globalThis as any).FileList = (dom.window as any).FileList;
(globalThis as any).Blob = dom.window.Blob;
(globalThis as any).FormData = dom.window.FormData;
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
  id: "user-3858",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

const clientFixture = {
  id: "client-3858",
  firmName: "Marketing First Upload Firm",
  contactName: "Test Contact",
  products: [],
  hideOtherLeads: false,
  terminology: null,
};

const ZERO_LQ = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

// First-ever PDF parse for this client — the three marketing shapes (header):
//  • googleAds ALL-ZERO with NO evidence (the parser's defaulted composite —
//    a fabricated shape that must default UNCHECKED and never be applied)
//  • lsa 7 leads / $1,400 WITH evidence (real parsed composite)
//  • webinar 30 reg / 12 att / 4 HT WITH evidence (real parsed composite)
const initialImportParsed = {
  reportMonth: "2026-07",
  clientName: "Marketing First Upload Firm",
  marketing: {
    totalLeads: 0,
    leadQuality: { ...ZERO_LQ },
    gbpLocations: [],
    googleAds: { uniqueLeads: 0, adSpend: 0, leadQuality: { ...ZERO_LQ } },
    lsa: {
      uniqueLeads: 7,
      adSpend: 1400,
      leadQuality: { good: 5, notQuotable: 1, missedCalls: 1, noData: 0 },
    },
    webinar: {
      registrants: 30,
      attendees: 12,
      hotTransfers: 4,
      leads: 4,
      leadQuality: { good: 3, notQuotable: 1, missedCalls: 0, noData: 0 },
    },
    reviewGeneration: { listContacted: 0, listReviews: 0, webinarReviews: 0, otherCount: 0, totalReviews: 0 },
    otherLeads: { total: 0, socialMedia: 0, directCalls: 0, referrals: 0, leadQuality: { ...ZERO_LQ } },
  },
  fieldConfidence: {
    "marketing.lsa": { confidence: "high", source: "LSA leads and spend labels" },
    "marketing.lsa.leadQuality": { confidence: "high", source: "LSA quality table" },
    "marketing.webinar": { confidence: "high", source: "Webinar summary labels" },
    "marketing.webinar.leadQuality": { confidence: "high", source: "Webinar quality table" },
  },
};

// Captured POST /api/reports/import-pdf calls.
const importPdfCalls: Array<any> = [];
// Captured POST /api/reports (create) bodies.
const createReportCalls: Array<any> = [];
// Captured PUT /api/reports/report-3858/sections/<key> bodies, in order.
const sectionSaves: Array<{ sectionKey: string; body: any }> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "POST",
      path: "/api/reports/import-pdf",
      respond: ({ init }: any) => {
        importPdfCalls.push(init?.body ?? null);
        return { status: 200, json: initialImportParsed };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-3858\/sections\/([^/?]+)$/,
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
      method: "POST",
      path: "/api/reports",
      respond: ({ init }: any) => {
        createReportCalls.push(JSON.parse(init?.body ?? "{}"));
        return {
          status: 200,
          json: {
            id: "report-3858",
            clientId: "client-3858",
            reportMonth: "2026-07",
            status: "draft",
          },
        };
      },
    },
    {
      test: (url: string) => /^\/api\/reports\/report-3858$/.test(url),
      json: {
        id: "report-3858",
        clientId: "client-3858",
        reportMonth: "2026-07",
        status: "draft",
        shareToken: null,
        privacyMode: false,
        hideLeadQuality: false,
        webhookImportLogId: null,
        hasStoredPdfUrl: false,
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
    { path: "/api/clients", json: [clientFixture] },
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
// Mount the real ReportForm on the CREATE screen (/reports/new?clientId=...).
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
        React.createElement(Route as any, { path: "/reports/new", component: ReportForm }),
      ),
    ),
  );
});
await flush();

// ===========================================================================
// Step 1 — fill the report month, then choose a PDF in the initial-import
// input (input-pdf-import → POST /api/reports/import-pdf).
// ===========================================================================
const monthInput = $("input-report-month") as HTMLInputElement | null;
assert(monthInput, "input-report-month must render on the create screen (/reports/new)");
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLInputElement.prototype,
  "value",
)!.set!;
await act(async () => {
  nativeValueSetter.call(monthInput, "2026-07");
  monthInput!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  monthInput!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
});
await flush(2);

const pdfInput = $("input-pdf-import") as HTMLInputElement | null;
assert(pdfInput, "input-pdf-import (the initial 'Upload PDF Report' input) must render");
const pdfFile = new dom.window.File(["%PDF-1.4 test"], "first-marketing-report.pdf", {
  type: "application/pdf",
});
Object.defineProperty(pdfInput, "files", { value: [pdfFile], configurable: true });
await act(async () => {
  pdfInput!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  pdfInput!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
});
await flush(6);

assert(
  importPdfCalls.length === 1,
  `choosing a PDF on the create screen must POST /api/reports/import-pdf ` +
    `exactly once, got ${importPdfCalls.length} calls`,
);

// ===========================================================================
// Step 2 — dialog contents: the evidence-less all-zero Google Ads composite
// starts UNCHECKED and shows "Not detected"; the evidence-backed LSA and
// Webinar composites are pre-checked with their full values visible.
// ===========================================================================
const dialog = $("dialog-import-review");
assert(dialog, "the import-review consent dialog must open after the initial-import parse");

// 2a. The FABRICATED composite (marketing.googleAds — every sub-value a
// parser-defaulted 0, no evidence anywhere under the key). Before Task #3858
// its nested leadQuality object made hasFieldValue truthy, so the all-zero
// composite rendered PRE-CHECKED — defaulting first uploads into stamping
// fabricated $0 spend / 0 leads. It must now render NO selectable
// row/checkbox at all and land in the collapsed "Not found in PDF" line of
// the Marketing section instead.
assert(
  !$("import-field-marketing.googleAds") && !$("checkbox-marketing.googleAds"),
  "marketing.googleAds (evidence-less all-zero composite) must NOT render " +
    "as a selectable row in the initial-import dialog — offering it " +
    "pre-checked ships fabricated marketing zeros on first uploads",
);
const marketingSection = $("import-section-marketing");
assert(marketingSection, "the Marketing section must render in the review dialog");
assert(
  /Not found in PDF:/.test(marketingSection!.textContent || "") &&
    (marketingSection!.textContent || "").includes("Google Ads ("),
  `the evidence-less marketing.googleAds composite must be listed in the ` +
    `"Not found in PDF" line of the Marketing section, got: ` +
    `${JSON.stringify(marketingSection!.textContent)}`,
);

// 2b. The evidence-backed LSA composite is pre-checked AND its full value
// (leads and spend) is visible in the row — checked marketing rows are
// explicit consent because the operator sees every sub-number before Apply.
const lsaCheckbox = $("checkbox-marketing.lsa");
assert(lsaCheckbox, "checkbox-marketing.lsa must render");
assert(
  lsaCheckbox!.getAttribute("data-state") === "checked",
  `marketing.lsa (parsed 7 leads / $1,400 with evidence) must be ` +
    `PRE-checked on the initial import, got data-state=` +
    `"${lsaCheckbox!.getAttribute("data-state")}"`,
);
const lsaValue = $("new-value-marketing.lsa");
assert(
  lsaValue && /7\s/.test(lsaValue.textContent || "") && /1,400/.test(lsaValue.textContent || ""),
  `the LSA row must render BOTH sub-values (7 leads and $1,400) so applying ` +
    `is informed consent, got ${JSON.stringify(lsaValue?.textContent)}`,
);

// 2c. The evidence-backed webinar composite is pre-checked too.
const webinarCheckbox = $("checkbox-marketing.webinar");
assert(webinarCheckbox, "checkbox-marketing.webinar must render");
assert(
  webinarCheckbox!.getAttribute("data-state") === "checked",
  `marketing.webinar (parsed 30/12/4 with evidence) must be PRE-checked on ` +
    `the initial import, got data-state=` +
    `"${webinarCheckbox!.getAttribute("data-state")}"`,
);

// ===========================================================================
// Step 3 — apply the selected fields, then submit the create form
// (Start Building Report → POST /api/reports → section PUTs).
// ===========================================================================
await clickEl($("button-apply-import")!);
assert(
  !$("dialog-import-review"),
  "the consent dialog must close after Apply Selected Fields",
);

const createButton = $("button-create-report") as HTMLButtonElement | null;
assert(createButton, "button-create-report (Start Building Report) must render");
assert(
  !createButton!.disabled,
  "button-create-report must be enabled after the client (?clientId=) and " +
    "report month are set and the import was applied",
);
const createForm = createButton!.closest("form");
assert(createForm, "button-create-report must live inside the create <form>");
await act(async () => {
  createForm!.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
});
await flush(8);

assert(
  createReportCalls.length === 1,
  `submitting the create form must POST /api/reports exactly once, ` +
    `got ${createReportCalls.length} calls`,
);

// ===========================================================================
// Step 4 — the persisted marketing section: the applied evidence-backed
// composites land with their real values; the unchecked fabricated Google
// Ads composite persists only the untouched form defaults (all zeros) —
// i.e. the apply path never wrote the evidence-less parse shape.
// ===========================================================================
const marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
assert(
  marketingSaves.length > 0,
  `creating the report with imported data must PUT ` +
    `/api/reports/report-3858/sections/marketing ` +
    `(captured section saves: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedMarketing = marketingSaves[marketingSaves.length - 1].body?.data ?? {};

assert(
  savedMarketing.lsa?.uniqueLeads === 7 && savedMarketing.lsa?.adSpend === 1400,
  `the applied evidence-backed LSA composite must land: 7 leads / $1,400, ` +
    `got ${JSON.stringify(savedMarketing.lsa)}`,
);
assert(
  savedMarketing.webinar?.registrants === 30 &&
    savedMarketing.webinar?.attendees === 12 &&
    savedMarketing.webinar?.hotTransfers === 4,
  `the applied evidence-backed webinar composite must land: 30 reg / 12 att ` +
    `/ 4 HT, got ${JSON.stringify(savedMarketing.webinar)}`,
);
assert(
  (savedMarketing.googleAds?.uniqueLeads ?? 0) === 0 &&
    (savedMarketing.googleAds?.adSpend ?? 0) === 0,
  `the UNCHECKED fabricated googleAds composite persists only the untouched ` +
    `form defaults (0 leads / $0) — the apply path must not have written the ` +
    `evidence-less parse shape, got ${JSON.stringify(savedMarketing.googleAds)}`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-initial-import-marketing-fabricated-zero.test.tsx",
);

console.log(
  "report-initial-import-marketing-fabricated-zero.test.tsx: PASS — the " +
    "INITIAL 'Upload PDF Report' flow hides the evidence-less all-zero " +
    "Google Ads composite (no selectable row; listed under Not found in " +
    "PDF), pre-checks the evidence-backed LSA/webinar " +
    "composites with their full values visible, and the create-flow " +
    "marketing section PUT persists the applied real values while the " +
    "unchecked fabricated composite stays at untouched form defaults",
);
process.exit(0);
