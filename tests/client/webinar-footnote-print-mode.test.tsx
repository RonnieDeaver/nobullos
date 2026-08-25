/* test-registration
{
  "name": "Webinar Total footnote survives PRINT-mode rendering, both toggle states (Task #2809)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2809: clients read this report as a printed PDF, and the /print routes mount <PublicReport isPrintMode /> — a distinct flow (printModeActive, countdown overlay, forced Slide visibility) nothing else renders. Gate the webinar Total footnote's survival in that print-mode DOM (both hide-Other toggle states, per-state wording, absent without webinar) so a print-specific refactor can't silently drop the explanation for exactly the audience it exists for. jsdom render, no DB, fully stubbed fetch.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2809 — the webinar Total footnote SURVIVES print-mode rendering.
 *
 * Task #2803 made the "Leads by Source (Monthly)" trend chart's footnote
 * (`text-trend-total-webinar-footnote`) render for webinar clients in BOTH
 * hide-Other toggle states, with per-state wording:
 *   - toggle ON:  "webinar lead equivalents (× 1.6)" (rebuilt Total sums the
 *     drawn lines incl. the equiv series)
 *   - toggle OFF: "webinar leads" raw wording (raw persisted total carries
 *     raw webinar leads, no × 1.6 claim)
 *
 * Clients often read this report as a printed PDF, and PublicReport has a
 * distinct print flow: `/print` routes mount <PublicReport isPrintMode />
 * (PublicReportPrint.tsx), which flips `printModeActive`, starts the
 * printCountdown overlay, and forces Slide visibility for print. Nothing
 * verified the footnote survives that flow — if a print-specific refactor
 * gated the chart block or the footnote behind `!printModeActive` (or moved
 * it under a `print:hidden` wrapper element that gets pruned), the printed
 * Total line would be unexplained for exactly the audience the footnote
 * exists for.
 *
 * Investigation finding (confirmed pre-task): print mode does NOT omit the
 * chart section. The report is one stacked slideshow; `printModeActive` only
 * (a) shows the countdown overlay, (b) passes isPrintMode to
 * MarketContextSlide, and (c) forces Slide's framer-motion visibility. So the
 * footnote is expected PRESENT in the print-mode DOM — this test locks that.
 *
 * Scenarios (all rendered with the print-flow entry: isPrintMode=true, data
 * loaded, countdown engaged — asserted via the "Preparing PDF..." overlay):
 *   (P-ON)  webinar client, hideOtherLeads=true  → footnote present with the
 *           equivalents wording (× 1.6).
 *   (P-OFF) webinar client, hideOtherLeads=false → footnote present with the
 *           raw-leads wording, and NO equivalents / × 1.6 claim.
 *   (P-NEG) non-webinar client in print mode → footnote absent (proves the
 *           presence assertions aren't trivially satisfied by print mode
 *           rendering everything).
 *
 * Harness copied from tests/client/hide-other-leads-rendered.test.tsx; heavy
 * browser-only deps shimmed by review-velocity-render-loader.mjs.
 * Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json.
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
  { pretendToBeVisual: true, url: "http://localhost/share/test-token/print" },
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
// The print flow eventually calls window.print() when the countdown hits 0.
// The countdown ticks on 1000ms timers and this test only flushes 0ms, so it
// never fires — but stub it anyway so an unexpected early fire can't crash
// jsdom (jsdom's window.print throws "not implemented").
let printCalls = 0;
(dom.window as any).print = () => { printCalls++; };
(globalThis as any).print = (dom.window as any).print;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

/**
 * Webinar-client share payload (same shape the hide-other-leads rendered test
 * uses): gbp + webinar active so the trend chart draws a "Webinar (equiv.)"
 * line and the Total/card divergence exists in both toggle states.
 */
function buildWebinarFixture(hideOtherLeads: boolean, withWebinar = true) {
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
      products: withWebinar ? ["gbp", "webinar"] : ["gbp"],
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
                leadQuality: { good: 300, notQuotable: 100, missedCalls: 63, noData: 0 },
              },
            ],
          },
          otherLeads: {
            count: 544,
            description: "",
            leadQuality: { good: 200, notQuotable: 100, missedCalls: 137, noData: 0 },
          },
        },
      },
      { sectionKey: "intake", data: { totalLeads: 1007, totalConsults: 46, leadToConsultRate: 4.6 } },
      { sectionKey: "sales", data: {} },
    ],
    trendData: [
      { month: "2026-02", marketing: { totalLeads: 950, leadsBySource: { gbp: 400, webinar: 48, webinarHT: 30 } } },
      { month: "2026-03", marketing: { totalLeads: 980, leadsBySource: { gbp: 430, webinar: 51, webinarHT: 32 } } },
      { month: "2026-04", marketing: { totalLeads: 1007, leadsBySource: { gbp: 463, webinar: 56, webinarHT: 35 } } },
    ],
    dataAccess: [{ category: "consult_bookings", status: "available" }],
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

/**
 * Renders <PublicReport isPrintMode /> — the exact entry the /print routes use
 * (PublicReportPrint.tsx) — and waits for data load + the print-mode effect
 * (printModeActive=true, printCountdown=6) to settle.
 */
async function renderPrintScenario(fixture: any): Promise<Document> {
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
        React.createElement(PublicReport as any, { isPrintMode: true }),
      ),
    );
  });
  await flush(0);
  await flush(0);
  await flush(0);

  return dom.window.document;
}

/**
 * Print mode must actually be ENGAGED in the rendered DOM or the footnote
 * assertions prove nothing about the print flow. The countdown overlay
 * ("Preparing PDF...") renders only while printCountdown !== null, which the
 * isPrintMode effect sets once data loads — so its presence proves
 * printModeActive=true at assertion time.
 */
function assertPrintModeEngaged(doc: Document, label: string): void {
  const body = doc.body.textContent || "";
  assert(
    body.includes("Preparing PDF..."),
    `${label}: print countdown overlay ("Preparing PDF...") must be visible — ` +
      "without it the render is NOT in the print flow and the footnote assertions are meaningless",
  );
  assert(printCalls === 0, `${label}: window.print must not have fired during the test window`);
}

// ---------------------------------------------------------------------------
// (P-ON) print mode + webinar client + hideOtherLeads=true →
//        footnote present with the equivalents (× 1.6) wording
// ---------------------------------------------------------------------------
{
  const doc = await renderPrintScenario(buildWebinarFixture(true));
  assertPrintModeEngaged(doc, "(P-ON)");

  const footnote = doc.querySelector('[data-testid="text-trend-total-webinar-footnote"]');
  assert(
    footnote,
    "(P-ON) print mode, toggle ON, webinar active → trend webinar footnote must be present in the print-mode DOM",
  );
  assert(
    /Total line includes webinar lead equivalents/i.test(footnote!.textContent || ""),
    `(P-ON) print-mode footnote must use the equivalents wording, got "${footnote!.textContent}"`,
  );
  assert(
    /×\s*1\.6/.test(footnote!.textContent || ""),
    `(P-ON) print-mode footnote must state the × 1.6 multiplier, got "${footnote!.textContent}"`,
  );
}

// ---------------------------------------------------------------------------
// (P-OFF) print mode + webinar client + hideOtherLeads=false →
//         footnote present with the raw-leads wording (no × 1.6 claim)
// ---------------------------------------------------------------------------
{
  const doc = await renderPrintScenario(buildWebinarFixture(false));
  assertPrintModeEngaged(doc, "(P-OFF)");

  const footnote = doc.querySelector('[data-testid="text-trend-total-webinar-footnote"]');
  assert(
    footnote,
    "(P-OFF) print mode, toggle OFF, webinar active → trend webinar footnote must be present in the print-mode DOM",
  );
  assert(
    /Total line includes webinar leads/i.test(footnote!.textContent || ""),
    `(P-OFF) print-mode footnote must use the raw-leads wording, got "${footnote!.textContent}"`,
  );
  assert(
    !/equivalents|×\s*1\.6/i.test(footnote!.textContent || ""),
    `(P-OFF) print-mode footnote must NOT claim × 1.6 equivalents (raw total carries raw webinar leads), got "${footnote!.textContent}"`,
  );
}

// ---------------------------------------------------------------------------
// (P-NEG) print mode + NO webinar product → footnote absent. Guards against
//         the presence assertions passing trivially (e.g. if print mode ever
//         rendered the footnote unconditionally).
// ---------------------------------------------------------------------------
{
  const doc = await renderPrintScenario(buildWebinarFixture(false, false));
  assertPrintModeEngaged(doc, "(P-NEG)");

  assert(
    !doc.querySelector('[data-testid="text-trend-total-webinar-footnote"]'),
    "(P-NEG) print mode, no webinar product → trend webinar footnote must NOT render",
  );
}

if (activeRoot) {
  await act(async () => {
    activeRoot.unmount();
  });
  activeRoot = null;
}

// Task #2822 — zero tolerance for the React missing-key warning across every
// render this test performed (all three print-mode scenarios).
keyWarningGuard.assertNoKeyWarnings("webinar-footnote-print-mode.test.tsx");

console.log(
  "webinar-footnote-print-mode.test.tsx: PASS — " +
  "footnote survives print-mode rendering for webinar clients in both toggle states " +
  "(ON = equivalents × 1.6 wording, OFF = raw-leads wording), absent for non-webinar clients; " +
  "print flow engagement proven via the Preparing PDF overlay",
);
process.exit(0);
