/* test-registration
{
  "name": "ClientDetail delete-report ConfirmActionDialog — trigger opens only, cancel fires nothing, confirm DELETEs /api/reports/:id (Task #4754)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4754: Task #4621 swapped ClientDetail's Reports-tab delete button window.confirm() for the trigger-wrapped shared ConfirmActionDialog, and no test clicked the converted button on THIS surface (Task #4636 only covered the Dashboard instance) — a per-surface wiring mistake (deleting on trigger/cancel, or never firing the mutation on confirm) would ship unnoticed. This mounts the REAL ClientDetail page in jsdom with a fully stubbed fetch and pins: trigger click fires no DELETE, cancel fires no DELETE, confirm fires exactly one DELETE /api/reports/:id (the old confirm() endpoint). Fast, DB-free, deterministic.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-client-detail-delete-report-setup.mjs"
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
 * on ClientDetail's Reports-tab delete button actually gates the mutation:
 *
 *   (A) the delete trigger button renders for a team_lead and clicking it
 *       fires NO DELETE (the old window.confirm() path deleted straight from
 *       this click);
 *   (B) clicking the dialog's Cancel button fires NO DELETE;
 *   (C) clicking the dialog's confirm button fires exactly ONE
 *       DELETE /api/reports/:id — the same endpoint the old confirm() path
 *       used.
 *
 * Harness: the heavy feature panels are stubbed and the Radix AlertDialog is
 * shimmed (see the setup file); the ConfirmActionDialog wiring, the role gate,
 * and the deleteReportMutation are the real code. Mounted inside a wouter
 * Route at /clients/:id?tab=reports (same harness as
 * client-detail-tab-from-url.test.tsx).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
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
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures + fetch stub with a DELETE recorder
// ---------------------------------------------------------------------------

const CLIENT_ID = "client-4754-detail";
const REPORT_ID = "report-4754";

const TEST_USER = {
  id: "user-4754",
  email: "lead@test.local",
  firstName: "Lead",
  lastName: "User",
  role: "team_lead", // report deletion is team-lead+ (Task #4644)
};

const TEST_CLIENT = {
  id: CLIENT_ID,
  clientCode: "TC-4754",
  firmName: "Test Firm LLP",
  contactName: "Jane Doe",
  contactEmail: "jane@test.local",
  contactPhone: null,
  consultType: "free",
  practiceAreas: [],
  products: [],
  ownerId: null,
  averageCaseValue: null,
  initialLeads: null,
  initialReviews: null,
  initialCases: null,
  stripeCustomerId: null,
  isArchived: false,
  clientStartDate: null,
  hasPostConsultReviewAccess: false,
  hasPostCaseClosedReviewAccess: false,
  terminology: null,
  emailDomains: [],
};

const REPORT = {
  id: REPORT_ID,
  clientId: CLIENT_ID,
  reportMonth: "2026-07",
  status: "draft",
  shareToken: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const deleteCalls: string[] = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "DELETE",
      respond: ({ url, jsonResponse }: any) => {
        deleteCalls.push(url);
        return jsonResponse(200, {});
      },
    },
    { path: "/api/auth/user", json: TEST_USER },
    {
      test: (url: string) => url.includes("/api/clients/") && url.includes("/summary"),
      json: { client: TEST_CLIENT, reports: [REPORT], dataAccess: [], contacts: [] },
    },
    { path: "/api/users", json: [] },
    { path: "/api/audit-history", json: {} },
    { path: /\/communications/, json: [] },
    { path: /\/command-panel/, json: [] },
    { path: "/api/clients", json: [] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Mount at /clients/:id?tab=reports
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router, Route } = await import("wouter");
const ClientDetail = (await import("../../client/src/pages/ClientDetail")).default;

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 25): Promise<void> {
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
  dom.window.history.replaceState({}, "", `/clients/${CLIENT_ID}?tab=reports`);
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
          React.createElement(Route as any, { path: "/clients/:id", component: ClientDetail }),
        ),
      ),
    );
  });
  await flush();

  // ── A. trigger renders; clicking it fires no DELETE ───────────────────────
  const trigger = $(`button-delete-report-${REPORT_ID}`);
  assert(trigger, "A: delete-report trigger button renders for a team_lead on the Reports tab");
  await click(trigger!);
  assert(
    deleteCalls.length === 0,
    `A: clicking the trigger must fire NO DELETE (old confirm() path deleted here) — got ${JSON.stringify(deleteCalls)}`,
  );
  console.log("  ✓ A: trigger click opens the dialog without firing a DELETE");

  // ── B. cancel fires nothing ────────────────────────────────────────────────
  const cancel = $(`dialog-confirm-delete-report-${REPORT_ID}-cancel`);
  assert(cancel, "B: dialog cancel button is queryable");
  await click(cancel!);
  assert(
    deleteCalls.length === 0,
    `B: Cancel must fire NO DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  console.log("  ✓ B: cancel fires nothing");

  // ── C. confirm fires exactly one DELETE to the old confirm() endpoint ─────
  const confirm = $(`dialog-confirm-delete-report-${REPORT_ID}-confirm`);
  assert(confirm, "C: dialog confirm button is queryable");
  await click(confirm!);
  assert(
    deleteCalls.length === 1,
    `C: confirm must fire exactly ONE DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    deleteCalls[0].endsWith(`/api/reports/${REPORT_ID}`),
    `C: DELETE must hit /api/reports/${REPORT_ID} (the pre-#4621 confirm() endpoint) — got ${deleteCalls[0]}`,
  );
  console.log(`  ✓ C: confirm fires exactly one DELETE /api/reports/${REPORT_ID}`);

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-client-detail-delete-report: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
