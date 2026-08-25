/* test-registration
{
  "name": "Import review dialog never offers fabricated zeros (Task #3781)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3781: the Task #3772 predicate (importMetricNotFound) is unit-tested, but the DIALOG WIRING in ReportForm — the fieldsWithValues filter and the selection-default overrides — had no jsdom gate. A refactor there could reintroduce pre-checked fabricated-0 rows (evidence-less parse defaults offered/applied as real zeros) without failing anything. Deterministic jsdom render of the real ReportForm — no DB, fully stubbed fetch — same gate profile as the #2790 reimport peer.",
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
 * Task #3781 — the import review dialog must never offer (or apply) a
 * FABRICATED zero: a numeric metric the parser defaulted to 0 with no
 * fieldConfidence evidence (Task #3772).
 *
 * The shared predicate `importMetricNotFound` is unit-tested in
 * tests/pdf-parser-time-to-human-answer.test.ts, but the ReportForm wiring it
 * feeds — the dialog's `fieldsWithValues` filter and the selection-default
 * overrides in handleReimport/handlePdfImport, plus the `selApplied` guard in
 * applyImportData — had no jsdom coverage. This test drives the real reimport
 * consent flow end to end with a parsed payload containing all three shapes:
 *
 *   • intake.avgTimeToAnswer = 8.45 WITH parse evidence  (evidence-backed value)
 *   • intake.totalConsults   = 0    WITH parse evidence  (evidence-backed 0 —
 *     a real "5 → 0" overwrite offer that MUST stay selectable)
 *   • intake.qualityScore    = 0    with NO evidence     (fabricated 0 — saved
 *     value is 7; the pre-#3772 differs-from-current rule would pre-CHECK this
 *     row and default the operator into stamping a fabricated zero over real
 *     data)
 *
 * Asserts:
 *   1. The fabricated-0 metric renders NO selectable row/checkbox and lands in
 *      the collapsed "Not found in PDF" line instead.
 *   2. The evidence-backed 0 IS offered (rendered + pre-checked, since 5 → 0
 *      differs from current), and the evidence-backed value row is pre-checked.
 *   3. Applying with the missed metric selected-off leaves both the form value
 *      (7) and its No-Data flag (false) untouched in the persisted intake
 *      section, while the applied fields land (8.45, 0) with their flags clear.
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
  { pretendToBeVisual: true, url: "http://localhost/reports/report-3781" },
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
  id: "user-3781",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

const clientFixture = {
  id: "client-3781",
  firmName: "Fabricated Zero Firm",
  contactName: "Test Contact",
  products: [],
  hideOtherLeads: false,
  terminology: null,
};

// Existing saved report. The intake section holds REAL operator data:
// totalConsults 5, avgTimeToAnswer 3.2, qualityScore 7 — all unflagged.
const reportFixture = {
  id: "report-3781",
  clientId: "client-3781",
  reportMonth: "2026-07",
  status: "draft",
  shareToken: null,
  privacyMode: false,
  hideLeadQuality: false,
  webhookImportLogId: null,
  hasStoredPdfUrl: true,
  sections: [
    {
      sectionKey: "intake",
      updatedAt: "2026-08-01T00:00:00.000Z",
      data: {
        totalConsults: 5,
        missedCallRate: 0,
        avgTimeToAnswer: 3.2,
        qualityScore: 7,
        commonIssues: "",
        noDataFlags: {
          totalConsults: false,
          avgTimeToAnswer: false,
          qualityScore: false,
        },
      },
    },
  ],
};

// Reimport parse result — three intake shapes (see file header):
//  • avgTimeToAnswer 8.45 WITH evidence (real parsed value; differs from 3.2)
//  • totalConsults 0 WITH evidence (real parsed zero; a legit 5 → 0 overwrite)
//  • qualityScore 0 with NO evidence (FABRICATED zero; saved value is 7 — the
//    pre-#3772 differs rule would pre-check this row)
const reimportParsed = {
  reportMonth: "2026-07",
  clientName: "Fabricated Zero Firm",
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

// Captured PUT /api/reports/report-3781/sections/<key> bodies, in order.
const sectionSaves: Array<{ sectionKey: string; body: any }> = [];
const reimportCalls: Array<any> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "POST",
      path: "/api/reports/report-3781/reimport",
      respond: ({ init }: any) => {
        reimportCalls.push(init?.body ?? null);
        return {
          status: 200,
          json: { reportId: "report-3781", parsed: reimportParsed },
        };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-3781\/sections\/([^/?]+)$/,
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
      test: (url: string) => /^\/api\/reports\/report-3781$/.test(url),
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
// Step 1 — trigger the reimport (fromStoredUrl path).
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
  `clicking Re-parse from Source must POST /api/reports/report-3781/reimport ` +
    `exactly once, got ${reimportCalls.length} calls`,
);

// ===========================================================================
// Step 2 — dialog contents: fabricated 0 hidden, evidence-backed rows offered.
// ===========================================================================
const dialog = $("dialog-import-review");
assert(dialog, "the import-review consent dialog must open after the reimport parse");

// 2a. The FABRICATED zero (intake.qualityScore, no parse evidence, saved 7)
// must NOT render as a selectable row — the differs-from-current rule alone
// would have pre-checked a 7 → 0 fabricated overwrite.
assert(
  !$("import-field-intake.qualityScore") && !$("checkbox-intake.qualityScore"),
  "intake.qualityScore (evidence-less defaulted 0) must NOT render as a " +
    "selectable row — offering it re-ships the fabricated-zero bug Task #3772 fixed",
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
// fieldConfidence entry, saved 5) IS a real overwrite offer: rendered and
// pre-checked (5 → 0 differs from current).
const consultsCheckbox = $("checkbox-intake.totalConsults");
assert(
  consultsCheckbox,
  "checkbox-intake.totalConsults must render — a parsed 0 WITH evidence is a " +
    "real value the operator may apply (legit 5 → 0 overwrite)",
);
assert(
  consultsCheckbox!.getAttribute("data-state") === "checked",
  `intake.totalConsults (evidence-backed 0, saved 5) must be PRE-checked as an ` +
    `overwrite offer, got data-state="${consultsCheckbox!.getAttribute("data-state")}"`,
);

// 2c. The evidence-backed VALUE (8.45 vs saved 3.2) is rendered + pre-checked.
const attaCheckbox = $("checkbox-intake.avgTimeToAnswer");
assert(attaCheckbox, "checkbox-intake.avgTimeToAnswer must render");
assert(
  attaCheckbox!.getAttribute("data-state") === "checked",
  `intake.avgTimeToAnswer (parsed 8.45 vs saved 3.2) must be PRE-checked, ` +
    `got data-state="${attaCheckbox!.getAttribute("data-state")}"`,
);

// ===========================================================================
// Step 3 — apply, then Save (flushes the intake section PUT).
// ===========================================================================
await clickEl($("button-apply-import")!);
assert(
  !$("dialog-import-review"),
  "the consent dialog must close after Apply Selected Fields",
);

sectionSaves.length = 0;
const saveButton = $("button-save-status");
assert(saveButton, "button-save-status (Save) must render");
await clickEl(saveButton!);
await flush(6);

// ===========================================================================
// Step 4 — persisted intake section: applied fields landed, the missed metric
// (selected-off fabricated 0) left value AND No-Data flag untouched.
// ===========================================================================
const intakeSaves = sectionSaves.filter((s) => s.sectionKey === "intake");
assert(
  intakeSaves.length > 0,
  `clicking Save must flush a PUT /api/reports/report-3781/sections/intake ` +
    `(captured section saves: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedIntake = intakeSaves[intakeSaves.length - 1].body?.data ?? {};

assert(
  savedIntake.qualityScore === 7,
  `the persisted intake.qualityScore must stay the operator's saved 7 — a ` +
    `fabricated (evidence-less) parse 0 must never be applied over real data, ` +
    `got ${JSON.stringify(savedIntake.qualityScore)}`,
);
assert(
  savedIntake.noDataFlags?.qualityScore === false,
  `the persisted noDataFlags.qualityScore must stay false (untouched) — the ` +
    `form still holds a real value, so the selected-off missed metric must not ` +
    `flip its flag, got ${JSON.stringify(savedIntake.noDataFlags?.qualityScore)}`,
);

assert(
  savedIntake.avgTimeToAnswer === 8.45,
  `the applied evidence-backed value must land: intake.avgTimeToAnswer 8.45, ` +
    `got ${JSON.stringify(savedIntake.avgTimeToAnswer)}`,
);
assert(
  savedIntake.noDataFlags?.avgTimeToAnswer === false,
  `noDataFlags.avgTimeToAnswer must be cleared for the applied value, ` +
    `got ${JSON.stringify(savedIntake.noDataFlags?.avgTimeToAnswer)}`,
);

assert(
  savedIntake.totalConsults === 0,
  `the applied evidence-backed ZERO must land: intake.totalConsults 0 ` +
    `(legit 5 → 0 overwrite), got ${JSON.stringify(savedIntake.totalConsults)}`,
);
assert(
  savedIntake.noDataFlags?.totalConsults === false,
  `noDataFlags.totalConsults must stay/clear false for the applied real zero, ` +
    `got ${JSON.stringify(savedIntake.noDataFlags?.totalConsults)}`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-import-fabricated-zero-dialog.test.tsx",
);

console.log(
  "report-import-fabricated-zero-dialog.test.tsx: PASS — the import review " +
    "dialog hides the evidence-less fabricated 0 (no selectable row; listed " +
    "under Not found in PDF), still offers the evidence-backed 0 and value, " +
    "and applying leaves the missed metric's saved value 7 + No-Data flag " +
    "untouched while the applied fields (8.45, 0) land with clear flags",
);
process.exit(0);
