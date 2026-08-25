/* test-registration
{
  "name": "INITIAL PDF import never applies fabricated zeros (Task #3830)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3830: Task #3781 gated the REIMPORT entry point of the import review dialog, but the INITIAL 'Upload PDF Report' flow (create screen → handlePdfImport → /api/reports/import-pdf → dialog → createReportMutation section PUTs) reaches the same dialog through a DIFFERENT selection-default branch and a DIFFERENT persistence path. A regression confined to that branch (e.g. dropping the importMetricNotFound override from the initial-import selections) would ship fabricated zeros on first imports without failing the reimport gate. Deterministic jsdom render of the real ReportForm — no DB, fully stubbed fetch.",
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
 * Task #3830 — fabricated (evidence-less) parse zeros must be caught on the
 * VERY FIRST PDF upload too, not just on reimport.
 *
 * tests/client/report-import-fabricated-zero-dialog.test.tsx (Task #3781)
 * gates the reimport entry point. This test drives the INITIAL import flow:
 * /reports/new?clientId= → input-pdf-import → POST /api/reports/import-pdf →
 * consent dialog → Apply → create form submit → PUT /sections/intake, with a
 * parsed payload containing all three intake shapes:
 *
 *   • intake.avgTimeToAnswer = 8.45 WITH parse evidence  (evidence-backed value)
 *   • intake.totalConsults   = 0    WITH parse evidence  (evidence-backed 0 —
 *     a real parsed zero that MUST stay a selectable row)
 *   • intake.qualityScore    = 0    with NO evidence     (fabricated 0 — the
 *     parser's default; on a fresh report every current value is 0, so only
 *     the importMetricNotFound override keeps it out of the dialog and turns
 *     it into an honest No-Data flag at apply time)
 *
 * Asserts:
 *   1. The fabricated-0 metric renders NO selectable row/checkbox and lands
 *      in the collapsed "Not found in PDF" line of the Intake section.
 *   2. The evidence-backed 0 IS offered as a selectable row (the operator can
 *      check and apply it), and the evidence-backed value row is pre-checked
 *      (initial-import policy pre-checks parsed non-zero values).
 *   3. Creating the report persists an intake section PUT where the
 *      fabricated metric carries an honest No-Data flag
 *      (noDataFlags.qualityScore === true) instead of an unflagged fabricated
 *      0, while the applied fields (8.45, 0) land with their flags clear.
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import) —
 * the same harness as the #2810 / #3781 templates.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  {
    pretendToBeVisual: true,
    url: "http://localhost/reports/new?clientId=client-3830",
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
  id: "user-3830",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

const clientFixture = {
  id: "client-3830",
  firmName: "First Upload Firm",
  contactName: "Test Contact",
  products: [],
  hideOtherLeads: false,
  terminology: null,
};

// First-ever PDF parse for this client — three intake shapes (see header):
//  • avgTimeToAnswer 8.45 WITH evidence (real parsed value)
//  • totalConsults 0 WITH evidence (real parsed zero)
//  • qualityScore 0 with NO evidence (FABRICATED zero — parser default)
const initialImportParsed = {
  reportMonth: "2026-07",
  clientName: "First Upload Firm",
  intake: {
    totalConsults: 0,
    missedCallRate: 0,
    avgTimeToAnswer: 8.45,
    qualityScore: 0,
    commonIssues: "",
  },
  fieldConfidence: {
    "intake.avgTimeToAnswer": { confidence: "high", source: "Time to Human Answer" },
    "intake.totalConsults": { confidence: "high", source: "Total Consults" },
  },
};

// Captured POST /api/reports/import-pdf calls.
const importPdfCalls: Array<any> = [];
// Captured POST /api/reports (create) bodies.
const createReportCalls: Array<any> = [];
// Captured PUT /api/reports/report-3830/sections/<key> bodies, in order.
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
      path: /^\/api\/reports\/report-3830\/sections\/([^/?]+)$/,
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
            id: "report-3830",
            clientId: "client-3830",
            reportMonth: "2026-07",
            status: "draft",
          },
        };
      },
    },
    {
      test: (url: string) => /^\/api\/reports\/report-3830$/.test(url),
      json: {
        id: "report-3830",
        clientId: "client-3830",
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
// Step 2 — dialog contents: fabricated 0 hidden, evidence-backed rows offered.
// ===========================================================================
const dialog = $("dialog-import-review");
assert(dialog, "the import-review consent dialog must open after the initial-import parse");

// 2a. The FABRICATED zero (intake.qualityScore, no parse evidence) must NOT
// render as a selectable row on the INITIAL import either — offering it here
// would let a first upload stamp an unflagged fabricated 0.
assert(
  !$("import-field-intake.qualityScore") && !$("checkbox-intake.qualityScore"),
  "intake.qualityScore (evidence-less defaulted 0) must NOT render as a " +
    "selectable row in the initial-import dialog — offering it re-ships the " +
    "fabricated-zero bug Task #3772 fixed, this time on first uploads",
);
// ...it lands in the collapsed "Not found in PDF" line instead.
const intakeSection = $("import-section-intake");
assert(intakeSection, "the Intake section must render in the review dialog");
assert(
  /Not found in PDF:/.test(intakeSection!.textContent || "") &&
    (intakeSection!.textContent || "").includes("Intake Raw Quality Score"),
  `the evidence-less intake.qualityScore must be listed in the "Not found in ` +
    `PDF" line of the Intake section, got: ${JSON.stringify(intakeSection!.textContent)}`,
);

// 2b. The evidence-backed ZERO (intake.totalConsults, parsed 0 WITH a
// fieldConfidence entry) IS a selectable row. Initial-import policy defaults
// zero-valued fields unchecked (hasFieldValue is false for 0), so check it
// explicitly — the operator applying a real parsed zero must work.
const consultsCheckbox = $("checkbox-intake.totalConsults");
assert(
  consultsCheckbox,
  "checkbox-intake.totalConsults must render — a parsed 0 WITH evidence is a " +
    "real value the operator may apply on the first upload",
);
if (consultsCheckbox!.getAttribute("data-state") !== "checked") {
  await clickEl(consultsCheckbox!);
}
assert(
  consultsCheckbox!.getAttribute("data-state") === "checked" ||
    $("checkbox-intake.totalConsults")?.getAttribute("data-state") === "checked",
  `intake.totalConsults (evidence-backed 0) must be selectable — clicking its ` +
    `checkbox must check it, got data-state=` +
    `"${$("checkbox-intake.totalConsults")?.getAttribute("data-state")}"`,
);

// 2c. The evidence-backed VALUE (8.45) is rendered + pre-checked (the initial
// path pre-checks every field the parser returned a real value for).
const attaCheckbox = $("checkbox-intake.avgTimeToAnswer");
assert(attaCheckbox, "checkbox-intake.avgTimeToAnswer must render");
assert(
  attaCheckbox!.getAttribute("data-state") === "checked",
  `intake.avgTimeToAnswer (parsed 8.45 with evidence) must be PRE-checked on ` +
    `the initial import, got data-state="${attaCheckbox!.getAttribute("data-state")}"`,
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
// Step 4 — the persisted intake section: the fabricated metric carries an
// HONEST No-Data flag; the applied evidence-backed fields land unflagged.
// ===========================================================================
const intakeSaves = sectionSaves.filter((s) => s.sectionKey === "intake");
assert(
  intakeSaves.length > 0,
  `creating the report with imported data must PUT ` +
    `/api/reports/report-3830/sections/intake ` +
    `(captured section saves: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedIntake = intakeSaves[intakeSaves.length - 1].body?.data ?? {};

assert(
  savedIntake.noDataFlags?.qualityScore === true,
  `the persisted intake noDataFlags.qualityScore must be TRUE — the parser ` +
    `found no evidence for it and the fresh form holds no real value, so the ` +
    `first-import write path must persist an honest No-Data flag instead of ` +
    `an unflagged fabricated 0, ` +
    `got ${JSON.stringify(savedIntake.noDataFlags?.qualityScore)}`,
);
assert(
  savedIntake.qualityScore === 0,
  `the persisted intake.qualityScore value stays 0 (nothing was applied), ` +
    `got ${JSON.stringify(savedIntake.qualityScore)}`,
);

assert(
  savedIntake.avgTimeToAnswer === 8.45,
  `the applied evidence-backed value must land: intake.avgTimeToAnswer 8.45, ` +
    `got ${JSON.stringify(savedIntake.avgTimeToAnswer)}`,
);
assert(
  savedIntake.noDataFlags?.avgTimeToAnswer === false,
  `noDataFlags.avgTimeToAnswer must be false (cleared) for the applied value, ` +
    `got ${JSON.stringify(savedIntake.noDataFlags?.avgTimeToAnswer)}`,
);

assert(
  savedIntake.totalConsults === 0,
  `the applied evidence-backed ZERO must land: intake.totalConsults 0, ` +
    `got ${JSON.stringify(savedIntake.totalConsults)}`,
);
assert(
  savedIntake.noDataFlags?.totalConsults === false,
  `noDataFlags.totalConsults must be false for the applied real zero — a ` +
    `parsed 0 WITH evidence is real data, never No-Data, ` +
    `got ${JSON.stringify(savedIntake.noDataFlags?.totalConsults)}`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-initial-import-fabricated-zero.test.tsx",
);

console.log(
  "report-initial-import-fabricated-zero.test.tsx: PASS — the INITIAL " +
    "'Upload PDF Report' flow hides the evidence-less fabricated 0 (no " +
    "selectable row; listed under Not found in PDF), keeps the " +
    "evidence-backed 0 and value selectable, and the create-flow intake " +
    "section PUT persists an honest No-Data flag for the missed metric " +
    "while the applied fields (8.45, 0) land with clear flags",
);
process.exit(0);
