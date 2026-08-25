/* test-registration
{
  "name": "INITIAL PDF import never applies fabricated SALES zeros (Task #3852)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3852: the initial-import fabricated-zero gate (report-initial-import-fabricated-zero.test.tsx) covers the Intake section only. The Sales section has 8 entry-tracked metrics flowing through the same handlePdfImport selection defaults and a SEPARATE applyImportData sales branch with its own reconcileNoDataFlag calls, plus the revenue-derived averageCaseValue write that force-clears its No-Data flag. A regression confined to the sales branch (dropping a reconcileNoDataFlag call or mishandling the derived flag clear) would ship unflagged fabricated sales zeros on first imports without failing the intake gate. Deterministic jsdom render of the real ReportForm — no DB, fully stubbed fetch.",
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
 * Task #3852 — fabricated (evidence-less) parse zeros must be caught on the
 * VERY FIRST PDF upload for the SALES section too, not just Intake.
 *
 * Mirrors tests/client/report-initial-import-fabricated-zero.test.tsx (Task
 * #3830, intake) but drives the sales shapes through the same flow:
 * /reports/new?clientId= → input-pdf-import → POST /api/reports/import-pdf →
 * consent dialog → Apply → create form submit → PUT /sections/sales, with a
 * parsed payload containing:
 *
 *   • sales.totalCases  = 12 WITH parse evidence (evidence-backed value —
 *     pre-checked on the initial import)
 *   • sales.noShowRate  = 0  WITH parse evidence (evidence-backed 0 — a real
 *     parsed zero that MUST stay a selectable row)
 *   • sales.qualityScore = 0 with NO evidence    (fabricated 0 — the parser's
 *     default; must be hidden from the dialog and turn into an honest
 *     No-Data flag at apply time)
 *   • sales.revenue = 24000 WITH evidence, while sales.averageCaseValue is an
 *     evidence-less 0 — exercises the sales-specific wrinkle: applying
 *     revenue derives averageCaseValue (revenue / totalCases) and must
 *     force-CLEAR its No-Data flag (real derived data, not a fabrication).
 *
 * Asserts:
 *   1. The fabricated-0 metrics (sales.qualityScore, sales.averageCaseValue)
 *      render NO selectable row/checkbox and land in the collapsed "Not
 *      found in PDF" line of the Sales section.
 *   2. The evidence-backed 0 (noShowRate) IS offered as a selectable row and
 *      the evidence-backed value row (totalCases) is pre-checked.
 *   3. Creating the report persists a sales section PUT where:
 *      - noDataFlags.qualityScore === true (honest No-Data, value stays 0);
 *      - averageCaseValue === 2000 (revenue-derived) with
 *        noDataFlags.averageCaseValue === false (the derived write clears it);
 *      - the applied fields (12, 0) land with their flags clear;
 *      - avgFollowUps (absent from the parse entirely) is flagged No-Data.
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import) —
 * the same harness as the #3830 template.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  {
    pretendToBeVisual: true,
    url: "http://localhost/reports/new?clientId=client-3852",
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
  id: "user-3852",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

const clientFixture = {
  id: "client-3852",
  firmName: "Sales First Upload Firm",
  contactName: "Test Contact",
  products: [],
  hideOtherLeads: false,
  terminology: null,
};

// First-ever PDF parse for this client — the four sales shapes (see header):
//  • totalCases 12 WITH evidence (real parsed value)
//  • noShowRate 0 WITH evidence (real parsed zero)
//  • qualityScore 0 with NO evidence (FABRICATED zero — parser default)
//  • revenue 24000 WITH evidence + averageCaseValue evidence-less 0
//    (exercises the revenue-derived averageCaseValue flag clear)
const initialImportParsed = {
  reportMonth: "2026-07",
  clientName: "Sales First Upload Firm",
  sales: {
    totalCases: 12,
    averageCaseValue: 0,
    revenue: 24000,
    noShowRate: 0,
    qualityScore: 0,
    dealTouchDensity: 0,
    avgAgeOpenMatters: 0,
    pipelineMomentumScore: 0,
    commonIssues: "",
  },
  fieldConfidence: {
    "sales.totalCases": { confidence: "high", source: "Total Cases" },
    "sales.noShowRate": { confidence: "high", source: "No-Show Rate" },
    "sales.revenue": { confidence: "high", source: "Top-Line Revenue" },
  },
};

// Captured POST /api/reports/import-pdf calls.
const importPdfCalls: Array<any> = [];
// Captured POST /api/reports (create) bodies.
const createReportCalls: Array<any> = [];
// Captured PUT /api/reports/report-3852/sections/<key> bodies, in order.
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
      path: /^\/api\/reports\/report-3852\/sections\/([^/?]+)$/,
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
            id: "report-3852",
            clientId: "client-3852",
            reportMonth: "2026-07",
            status: "draft",
          },
        };
      },
    },
    {
      test: (url: string) => /^\/api\/reports\/report-3852$/.test(url),
      json: {
        id: "report-3852",
        clientId: "client-3852",
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
const pdfFile = new dom.window.File(["%PDF-1.4 test"], "first-sales-report.pdf", {
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
// Step 2 — dialog contents: fabricated sales 0s hidden, evidence-backed rows
// offered.
// ===========================================================================
const dialog = $("dialog-import-review");
assert(dialog, "the import-review consent dialog must open after the initial-import parse");

// 2a. The FABRICATED zeros (sales.qualityScore and sales.averageCaseValue,
// no parse evidence) must NOT render as selectable rows on the INITIAL
// import — offering them would let a first upload stamp unflagged fabricated
// sales 0s.
assert(
  !$("import-field-sales.qualityScore") && !$("checkbox-sales.qualityScore"),
  "sales.qualityScore (evidence-less defaulted 0) must NOT render as a " +
    "selectable row in the initial-import dialog — offering it ships the " +
    "fabricated-zero bug on first uploads via the SALES branch",
);
assert(
  !$("import-field-sales.averageCaseValue") && !$("checkbox-sales.averageCaseValue"),
  "sales.averageCaseValue (evidence-less defaulted 0) must NOT render as a " +
    "selectable row — its value arrives only via the revenue-derived write",
);
// ...they land in the collapsed "Not found in PDF" line instead.
const salesSection = $("import-section-sales");
assert(salesSection, "the Sales section must render in the review dialog");
assert(
  /Not found in PDF:/.test(salesSection!.textContent || "") &&
    (salesSection!.textContent || "").includes("Sales Raw Quality Score"),
  `the evidence-less sales.qualityScore must be listed in the "Not found in ` +
    `PDF" line of the Sales section, got: ${JSON.stringify(salesSection!.textContent)}`,
);

// 2b. The evidence-backed ZERO (sales.noShowRate, parsed 0 WITH a
// fieldConfidence entry) IS a selectable row. Initial-import policy defaults
// zero-valued fields unchecked, so check it explicitly — the operator
// applying a real parsed sales zero must work.
const noShowCheckbox = $("checkbox-sales.noShowRate");
assert(
  noShowCheckbox,
  "checkbox-sales.noShowRate must render — a parsed 0 WITH evidence is a " +
    "real value the operator may apply on the first upload",
);
if (noShowCheckbox!.getAttribute("data-state") !== "checked") {
  await clickEl(noShowCheckbox!);
}
assert(
  noShowCheckbox!.getAttribute("data-state") === "checked" ||
    $("checkbox-sales.noShowRate")?.getAttribute("data-state") === "checked",
  `sales.noShowRate (evidence-backed 0) must be selectable — clicking its ` +
    `checkbox must check it, got data-state=` +
    `"${$("checkbox-sales.noShowRate")?.getAttribute("data-state")}"`,
);

// 2c. The evidence-backed VALUES (totalCases 12, revenue 24000) are rendered
// + pre-checked (the initial path pre-checks every field the parser returned
// a real value for).
const casesCheckbox = $("checkbox-sales.totalCases");
assert(casesCheckbox, "checkbox-sales.totalCases must render");
assert(
  casesCheckbox!.getAttribute("data-state") === "checked",
  `sales.totalCases (parsed 12 with evidence) must be PRE-checked on the ` +
    `initial import, got data-state="${casesCheckbox!.getAttribute("data-state")}"`,
);
const revenueCheckbox = $("checkbox-sales.revenue");
assert(revenueCheckbox, "checkbox-sales.revenue must render");
assert(
  revenueCheckbox!.getAttribute("data-state") === "checked",
  `sales.revenue (parsed 24000 with evidence) must be PRE-checked on the ` +
    `initial import, got data-state="${revenueCheckbox!.getAttribute("data-state")}"`,
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
// Step 4 — the persisted sales section: the fabricated metric carries an
// HONEST No-Data flag, the revenue-derived averageCaseValue lands with a
// CLEARED flag, and the applied evidence-backed fields land unflagged.
// ===========================================================================
const salesSaves = sectionSaves.filter((s) => s.sectionKey === "sales");
assert(
  salesSaves.length > 0,
  `creating the report with imported data must PUT ` +
    `/api/reports/report-3852/sections/sales ` +
    `(captured section saves: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedSales = salesSaves[salesSaves.length - 1].body?.data ?? {};

assert(
  savedSales.noDataFlags?.qualityScore === true,
  `the persisted sales noDataFlags.qualityScore must be TRUE — the parser ` +
    `found no evidence for it and the fresh form holds no real value, so the ` +
    `first-import SALES write path must persist an honest No-Data flag ` +
    `instead of an unflagged fabricated 0, ` +
    `got ${JSON.stringify(savedSales.noDataFlags?.qualityScore)}`,
);
assert(
  savedSales.qualityScore === 0,
  `the persisted sales.qualityScore value stays 0 (nothing was applied), ` +
    `got ${JSON.stringify(savedSales.qualityScore)}`,
);

// avgFollowUps never appears in the parse at all — same honest-flag rule.
assert(
  savedSales.noDataFlags?.avgFollowUps === true,
  `noDataFlags.avgFollowUps must be TRUE — the metric is absent from the ` +
    `parse entirely and the fresh form holds no real value, ` +
    `got ${JSON.stringify(savedSales.noDataFlags?.avgFollowUps)}`,
);

// The revenue-derived averageCaseValue write: 24000 / 12 = 2000, and the
// derived write must force-CLEAR the No-Data flag (real parsed data), even
// though sales.averageCaseValue itself had no parse evidence.
assert(
  savedSales.averageCaseValue === 2000,
  `applying sales.revenue (24000) with totalCases 12 must derive ` +
    `averageCaseValue 2000, got ${JSON.stringify(savedSales.averageCaseValue)}`,
);
assert(
  savedSales.noDataFlags?.averageCaseValue === false,
  `noDataFlags.averageCaseValue must be FALSE — the revenue-derived write is ` +
    `real parsed data and must clear the flag the evidence-less parse would ` +
    `otherwise set, got ${JSON.stringify(savedSales.noDataFlags?.averageCaseValue)}`,
);

assert(
  savedSales.totalCases === 12,
  `the applied evidence-backed value must land: sales.totalCases 12, ` +
    `got ${JSON.stringify(savedSales.totalCases)}`,
);
assert(
  savedSales.noDataFlags?.totalCases === false,
  `noDataFlags.totalCases must be false (cleared) for the applied value, ` +
    `got ${JSON.stringify(savedSales.noDataFlags?.totalCases)}`,
);

assert(
  savedSales.noShowRate === 0,
  `the applied evidence-backed ZERO must land: sales.noShowRate 0, ` +
    `got ${JSON.stringify(savedSales.noShowRate)}`,
);
assert(
  savedSales.noDataFlags?.noShowRate === false,
  `noDataFlags.noShowRate must be false for the applied real zero — a ` +
    `parsed 0 WITH evidence is real data, never No-Data, ` +
    `got ${JSON.stringify(savedSales.noDataFlags?.noShowRate)}`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-initial-import-sales-fabricated-zero.test.tsx",
);

console.log(
  "report-initial-import-sales-fabricated-zero.test.tsx: PASS — the INITIAL " +
    "'Upload PDF Report' flow hides the evidence-less fabricated sales 0s " +
    "(no selectable rows; listed under Not found in PDF), keeps the " +
    "evidence-backed 0 and values selectable, and the create-flow sales " +
    "section PUT persists honest No-Data flags for the missed metrics while " +
    "the applied fields (12, 0) and the revenue-derived averageCaseValue " +
    "(2000, flag cleared) land correctly",
);
process.exit(0);
