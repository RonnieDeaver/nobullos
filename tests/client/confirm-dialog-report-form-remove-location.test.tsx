/* test-registration
{
  "name": "ReportForm remove-GBP-location ConfirmActionDialog — trigger opens only, cancel keeps the row, confirm removes it without any network write (Task #4754)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4754: Task #4621 swapped ReportForm's remove-GBP-location window.confirm() for the trigger-wrapped shared ConfirmActionDialog, and no test clicked the converted button — a per-surface wiring mistake (removing the row on trigger/cancel, or confirm never removing it) would silently drop or keep a location's metrics in the report editor. This mounts the REAL ReportForm editor in jsdom (same harness as the hide-Other import suites) on an existing draft whose GBP rows auto-seed from the client's command-panel locations, and pins: trigger click removes nothing, cancel removes nothing, confirm removes exactly the targeted row — and NO network write fires at any point (this action is local report state; the old confirm() path was too). DB-free, deterministic; generous wall-clock because tsx transpiles the large ReportForm graph cold.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/client/report-reimport-hide-other-consent-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4754 — the trigger-wrapped ConfirmActionDialog conversion (Task #4621)
 * on ReportForm's per-row "Remove" GBP-location button actually gates the
 * state change:
 *
 *   (A) the remove trigger button renders on a seeded GBP-location row and
 *       clicking it removes NOTHING (the old window.confirm() path removed
 *       the row straight from this click);
 *   (B) clicking the dialog's Cancel button removes NOTHING;
 *   (C) clicking the dialog's confirm button removes exactly the targeted
 *       row (the sibling row survives).
 *
 * Unlike the other converted surfaces this action mutates LOCAL report state
 * (setMarketingData) rather than an endpoint — the old confirm() path did
 * too — so the test additionally pins that NO non-GET request fires at any
 * point in the flow.
 *
 * Harness: reuses report-reimport-hide-other-consent-setup.mjs (heavy leaf
 * stubs + Radix dialog/alert-dialog shims + Clerk seam); the
 * ConfirmActionDialog wiring and the row-removal handler are the real code.
 * Mounted on an existing draft report (/reports/:id) — the /reports/new
 * screen is only a client/month picker, so the GBP rows never render there;
 * the draft's empty gbpLocations auto-seed from the command-panel locations.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const CLIENT_ID = "client-4754-rf";
const REPORT_ID = "report-4754-rf";

// Mount the editor on an EXISTING draft report (the /reports/new screen is
// only a client/month picker — the tabs + GBP rows render after a report
// exists). The draft has no saved sections, so its empty gbpLocations
// auto-seed from the client's command-panel locations (seeding case 2).
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  {
    pretendToBeVisual: true,
    url: `http://localhost/reports/${REPORT_ID}`,
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
(globalThis as any).SVGElement = dom.window.SVGElement;
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
(globalThis as any).File = dom.window.File;
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
  observe() {} unobserve() {} disconnect() {}
  takeRecords() { return []; }
}
(globalThis as any).IntersectionObserver = IntersectionObserverStub;
(dom.window as any).IntersectionObserver = IntersectionObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
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

// ---------------------------------------------------------------------------
// Fixtures + fetch stub with a write recorder
// ---------------------------------------------------------------------------

const testUser = {
  id: "user-4754",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

const gbpClient = {
  id: CLIENT_ID,
  firmName: "GBP Firm",
  contactName: "Test Contact",
  products: ["gbp"],
  hideOtherLeads: false,
  terminology: null,
};

// Two command-panel locations so the empty draft seeds TWO gbpLocations
// rows — confirm must remove exactly one and leave the sibling.
const commandPanelLocations = [
  { id: "loc-a", name: "Downtown Office" },
  { id: "loc-b", name: "Uptown Office" },
];

// The remove action is pure local state; NO write may fire anywhere in the
// trigger → cancel → confirm flow.
const writeCalls: Array<{ method: string; url: string }> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      test: (_url: string, method: string) => method !== "GET",
      respond: ({ url, method, jsonResponse }: any) => {
        writeCalls.push({ method, url });
        return jsonResponse(200, { ok: true });
      },
    },
    { path: "/api/auth/user", json: testUser },
    {
      test: (url: string) => new RegExp(`^/api/reports/${REPORT_ID}$`).test(url),
      json: {
        id: REPORT_ID,
        clientId: CLIENT_ID,
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
    { path: "/api/clients", json: [gbpClient] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Mount the real ReportForm on the CREATE screen (/reports/new?clientId=...)
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router, Route } = await import("wouter");
const ReportForm = (await import("../../client/src/pages/ReportForm")).default;

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(4);
}

async function main(): Promise<void> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
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

  // Both seeded rows render (command-panel ids, index-suffixed testids).
  assert($("row-gbp-location-loc-a-0"), "seeded GBP row for Downtown Office (loc-a) must render");
  assert($("row-gbp-location-loc-b-1"), "seeded GBP row for Uptown Office (loc-b) must render");

  // ── A. trigger renders; clicking it removes nothing ───────────────────────
  const trigger = $("button-remove-gbp-location-loc-a");
  assert(trigger, "A: remove-location trigger button renders on the loc-a row");
  await click(trigger!);
  assert(
    $("row-gbp-location-loc-a-0") !== null,
    "A: clicking the trigger must NOT remove the row (old confirm() path removed it here)",
  );
  console.log("  ✓ A: trigger click opens the dialog without removing the row");

  // ── B. cancel removes nothing ──────────────────────────────────────────────
  const cancel = $("dialog-confirm-remove-gbp-location-loc-a-cancel");
  assert(cancel, "B: dialog cancel button is queryable");
  await click(cancel!);
  assert(
    $("row-gbp-location-loc-a-0") !== null,
    "B: Cancel must NOT remove the row",
  );
  console.log("  ✓ B: cancel keeps the row");

  // ── C. confirm removes exactly the targeted row ────────────────────────────
  const confirm = $("dialog-confirm-remove-gbp-location-loc-a-confirm");
  assert(confirm, "C: dialog confirm button is queryable");
  await click(confirm!);
  assert(
    document.querySelector('[data-testid^="row-gbp-location-loc-a-"]') === null,
    "C: confirm must remove the loc-a row",
  );
  // The sibling shifts to index 0 after the filter — it must survive.
  assert(
    document.querySelector('[data-testid^="row-gbp-location-loc-b-"]') !== null,
    "C: the sibling loc-b row must survive the removal",
  );
  console.log("  ✓ C: confirm removes exactly the targeted row");

  // ── D. the whole flow is local state — no network write may have fired ────
  assert(
    writeCalls.length === 0,
    `D: the remove flow must fire NO network write (local report state only) — got ${JSON.stringify(writeCalls)}`,
  );
  console.log("  ✓ D: no network write fired anywhere in the flow");

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-report-form-remove-location: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
