/* test-registration
{
  "name": "INITIAL PDF import keeps RAW totals for hide-Other clients WITH the GBP product (Task #2816)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2816: the fourth and final cell of the hide-Other guard matrix — the INITIAL \"Upload PDF Report\" entry point for a client WITH the GBP product. This is the only gate that drives the hasGbpProduct === true branch of calculatedTotalLeads through the create-flow write path AND the GBP-location merge (mergeImportedGbpLocations) on a brand-new report's seeded command-panel rows. A regression confined to that combination (e.g. dropping Other from the total when GBP locations are present on first import) keeps the #2790/#2799/#2810 gates green. Same deterministic jsdom render profile — no DB, fully stubbed fetch.",
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
 * Task #2816 — Hidden Other leads must survive the VERY FIRST PDF import for
 * hide-Other clients WITH the "gbp" product.
 *
 * This is the fourth cell of the hide-Other raw-totals guard matrix:
 *   - Task #2790: reimport WITH GBP
 *   - Task #2799: reimport WITHOUT GBP
 *   - Task #2810: initial import WITHOUT GBP
 *   - THIS test:  initial import WITH GBP
 *
 * The initial "Upload PDF Report" path (handlePdfImport → POST
 * /api/reports/import-pdf → consent dialog → createReportMutation.onSuccess →
 * PUT /api/reports/:id/sections/marketing with totalLeads:
 * calculatedTotalLeads) exercises the hasGbpProduct === true branch of
 * calculatedTotalLeads — the raw total is the GBP-locations sum PLUS Other —
 * AND the GBP-location merge (mergeImportedGbpLocations) against a BRAND-NEW
 * report whose gbpLocations were just seeded from the client's Command Panel.
 * A regression confined to that combination (e.g. dropping Other from the
 * total when GBP locations are present on first import, or the merge
 * resetting Other while folding in GBP rows) keeps all three existing gates
 * green.
 *
 * hideOtherLeads is a DISPLAY-TIME flag (Tasks #2758 / #2760 / #2766 / #2769 /
 * #2777): persisted marketing sections always carry the RAW totals, and every
 * report surface subtracts Other at render time.
 *
 * This test mounts the REAL ReportForm on the CREATE screen (/reports/new)
 * for a hide-Other client WITH "gbp" in products and drives the real
 * initial-import flow end to end in jsdom:
 *
 *   1. Preselect the client via ?clientId= and type the report month.
 *      Client fixture: hideOtherLeads: true, products: ["gbp"], with TWO
 *      Command Panel locations (Downtown Office / Uptown Office) so the
 *      create screen seeds gbpLocations rows with the command-panel ids.
 *   2. Choose a file in input-pdf-import → stubbed POST
 *      /api/reports/import-pdf returns parsed RAW totals:
 *      110 = 65 GBP (Downtown 40 + Uptown 25) + 45 Other.
 *   3. The consent dialog must pre-check BOTH parsed fields
 *      (marketing.gbpLocations and marketing.otherLeads — the initial path
 *      pre-checks any field the parser returned a value for).
 *   4. Click button-apply-import, then submit the create form
 *      (button-create-report) and assert the PUT /sections/marketing body:
 *      data.totalLeads === 110 (never the Other-suppressed 65),
 *      data.otherLeads.count === 45 (never 0), and gbp.locations carries
 *      BOTH imported locations merged onto the seeded command-panel rows
 *      (stable command-panel ids, no fresh-UUID ghosts, no dropped rows).
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import) —
 * the same harness as the #2790 / #2799 / #2810 templates.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

// Task #2829 — fail loudly if ANY rendered list in the report editor logs
// React's missing-key warning (redraw/flicker risk, see Task #2813). Scoped
// to the key warning only; jsdom/recharts SVG casing noise is untouched.
const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  {
    pretendToBeVisual: true,
    url: "http://localhost/reports/new?clientId=client-2816",
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
  id: "user-2816",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

// A hide-Other client WITH the GBP product: calculatedTotalLeads includes the
// GBP-locations sum (hasGbpProduct === true) and the raw total is
// GBP + Other. Persisted sections must still carry RAW totals.
const hideOtherGbpClient = {
  id: "client-2816",
  firmName: "GBP Firm",
  contactName: "Test Contact",
  products: ["gbp"],
  hideOtherLeads: true,
  terminology: null,
};

// The client's Command Panel locations. On the create screen these seed
// marketingData.gbpLocations (uniqueLeads 0) BEFORE the import, so the
// GBP-location merge must resolve the imported rows onto these ids rather
// than minting fresh-UUID ghosts.
const commandPanelLocations = [
  { id: "loc-downtown", name: "Downtown Office" },
  { id: "loc-uptown", name: "Uptown Office" },
];

// First-ever PDF for this client (initial import parse result): RAW
// 110 = 65 GBP (Downtown 40 + Uptown 25) + 45 Other. The parsed
// marketing.totalLeads (110) is the raw PDF headline — reference-only in the
// dialog; the editor recomputes totalLeads from the applied sources through
// the hasGbpProduct === true branch (GBP-locations sum + Other).
const initialImportParsed = {
  reportMonth: "2026-06",
  clientName: "GBP Firm",
  marketing: {
    totalLeads: 110,
    gbpLocations: [
      {
        name: "Downtown Office",
        uniqueLeads: 40,
        reviewsGenerated: 0,
        reviewsRespondedTo: 0,
        postsQaCount: 0,
        leadQuality: { good: 30, notQuotable: 10, missedCalls: 0, noData: 0 },
      },
      {
        name: "Uptown Office",
        uniqueLeads: 25,
        reviewsGenerated: 0,
        reviewsRespondedTo: 0,
        postsQaCount: 0,
        leadQuality: { good: 20, notQuotable: 5, missedCalls: 0, noData: 0 },
      },
    ],
    otherLeads: { total: 45, socialMedia: 45, directCalls: 0, referrals: 0 },
  },
};

// Captured POST /api/reports/import-pdf calls.
const importPdfCalls: Array<any> = [];
// Captured POST /api/reports (create) bodies.
const createReportCalls: Array<any> = [];
// Captured PUT /api/reports/report-2816/sections/<key> bodies, in order.
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
      path: /^\/api\/reports\/report-2816\/sections\/([^/?]+)$/,
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
            id: "report-2816",
            clientId: "client-2816",
            reportMonth: "2026-06",
            status: "draft",
          },
        };
      },
    },
    {
      test: (url: string) => /^\/api\/reports\/report-2816$/.test(url),
      json: {
        id: "report-2816",
        clientId: "client-2816",
        reportMonth: "2026-06",
        status: "draft",
        shareToken: null,
        privacyMode: false,
        hideLeadQuality: false,
        webhookImportLogId: null,
        hasStoredPdfUrl: false,
        sections: [],
      },
    },
    // The client's Command Panel locations — MUST return the two real rows so
    // the create screen seeds gbpLocations and the merge resolves onto them.
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/locations"),
      json: commandPanelLocations,
    },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access/detection"),
      json: {},
    },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/command-panel"),
      json: null,
    },
    { path: "/api/clients", json: [hideOtherGbpClient] },
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
  nativeValueSetter.call(monthInput, "2026-06");
  monthInput!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  monthInput!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
});
await flush(2);

const pdfInput = $("input-pdf-import") as HTMLInputElement | null;
assert(pdfInput, "input-pdf-import (the initial 'Upload PDF Report' input) must render");
const pdfFile = new dom.window.File(["%PDF-1.4 test"], "first-report.pdf", {
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
// Step 2 — the consent dialog opens with BOTH parsed fields pre-checked
// (initial-import policy pre-checks every field the parser returned a value
// for): the GBP locations row AND the Other leads row.
// ===========================================================================
const dialog = $("dialog-import-review");
assert(dialog, "the import-review consent dialog must open after the initial-import parse");

const gbpCheckbox = $("checkbox-marketing.gbpLocations");
assert(gbpCheckbox, "checkbox-marketing.gbpLocations must render in the consent dialog");
assert(
  gbpCheckbox!.getAttribute("data-state") === "checked",
  `marketing.gbpLocations (65 parsed GBP leads across 2 locations) must be ` +
    `PRE-checked on the initial import, ` +
    `got data-state="${gbpCheckbox!.getAttribute("data-state")}"`,
);

const otherCheckbox = $("checkbox-marketing.otherLeads");
assert(otherCheckbox, "checkbox-marketing.otherLeads must render in the consent dialog");
assert(
  otherCheckbox!.getAttribute("data-state") === "checked",
  `marketing.otherLeads (45 parsed) must be PRE-checked on the initial import — ` +
    `an unchecked default here is the "silently drop the hidden Other leads on ` +
    `the very first import" failure mode for hide-Other clients; ` +
    `got data-state="${otherCheckbox!.getAttribute("data-state")}"`,
);

// The parser returned no Google Ads data for this GBP-only client, so no
// googleAds row should be checkable.
assert(
  !$("checkbox-marketing.googleAds"),
  "checkbox-marketing.googleAds must NOT render — the parsed first PDF for " +
    "this GBP-only client returned no googleAds data, so the field belongs " +
    'in the "Not found in PDF" list, not the checkable rows',
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
// Step 4 — the persisted marketing section carries the RAW totals through
// the hasGbpProduct === true branch of calculatedTotalLeads, with the
// imported GBP rows merged onto the seeded command-panel ids.
// ===========================================================================
const marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
assert(
  marketingSaves.length > 0,
  `creating the report with imported data must PUT ` +
    `/api/reports/report-2816/sections/marketing ` +
    `(captured section saves: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedMarketing = marketingSaves[marketingSaves.length - 1].body?.data ?? {};

assert(
  savedMarketing.totalLeads !== 65,
  `the persisted marketing.totalLeads must NEVER be the Other-suppressed 65 on ` +
    `the very first import for a hide-Other client WITH the GBP product — ` +
    `hideOtherLeads is display-time only; the raw total was dropped from ` +
    `persistence on the initial-import write path ` +
    `(got ${JSON.stringify(savedMarketing.totalLeads)})`,
);
assert(
  savedMarketing.totalLeads === 110,
  `the persisted marketing.totalLeads must be the RAW 110 (65 GBP + 45 Other) ` +
    `computed through the hasGbpProduct === true branch, ` +
    `got ${JSON.stringify(savedMarketing.totalLeads)}`,
);
assert(
  savedMarketing.otherLeads?.count === 45,
  `the persisted marketing.otherLeads.count must be the imported 45 (never 0), ` +
    `got ${JSON.stringify(savedMarketing.otherLeads?.count)}`,
);

// The imported GBP rows must have merged onto the SEEDED command-panel rows:
// stable command-panel ids, both rows present, imported lead counts applied.
const savedLocations: any[] = savedMarketing.gbp?.locations ?? [];
assert(
  savedLocations.length === 2,
  `the persisted gbp.locations must carry exactly the 2 merged locations, ` +
    `got ${JSON.stringify(savedLocations.map((l) => l?.name))}`,
);
const downtown = savedLocations.find((l) => l?.name === "Downtown Office");
const uptown = savedLocations.find((l) => l?.name === "Uptown Office");
assert(downtown, "the persisted gbp.locations must include Downtown Office");
assert(uptown, "the persisted gbp.locations must include Uptown Office");
assert(
  downtown!.id === "loc-downtown" && uptown!.id === "loc-uptown",
  `merged GBP rows must keep the seeded command-panel ids (no fresh-UUID ` +
    `ghosts on first import), got ` +
    `${JSON.stringify(savedLocations.map((l) => ({ id: l?.id, name: l?.name })))}`,
);
assert(
  downtown!.uniqueLeads === 40 && uptown!.uniqueLeads === 25,
  `merged GBP rows must carry the imported lead counts (Downtown 40 / ` +
    `Uptown 25), got ` +
    `${JSON.stringify(savedLocations.map((l) => ({ name: l?.name, uniqueLeads: l?.uniqueLeads })))}`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-initial-import-hide-other-with-gbp.test.tsx",
);

console.log(
  "report-initial-import-hide-other-with-gbp.test.tsx: PASS — for a " +
    "hide-Other client WITH the GBP product, the very first PDF import " +
    "(create screen → /api/reports/import-pdf → consent dialog) pre-checks " +
    "gbpLocations + otherLeads, merges the imported GBP rows onto the seeded " +
    "command-panel ids, and creating the report persists RAW totalLeads 110 " +
    "with otherLeads.count 45 (never the Other-suppressed 65) through the " +
    "initial-import write path",
);
process.exit(0);
