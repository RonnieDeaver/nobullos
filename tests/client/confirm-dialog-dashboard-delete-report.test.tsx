/* test-registration
{
  "name": "Dashboard delete-report ConfirmActionDialog — trigger opens only, cancel fires nothing, confirm DELETEs /api/reports/:id (Task #4636)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4636: Task #4621 swapped the Dashboard delete-report window.confirm() for the trigger-wrapped shared ConfirmActionDialog. No test clicked the converted button, so a dialog that deletes on trigger/cancel or never fires the mutation on confirm would ship unnoticed. This mounts the REAL Dashboard in jsdom with a fully stubbed fetch and pins: trigger click fires no DELETE, cancel fires no DELETE, confirm fires exactly one DELETE /api/reports/:id (the old confirm() endpoint). Fast, DB-free, deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-dashboard-delete-report-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4636 — the trigger-wrapped ConfirmActionDialog conversion (Task #4621)
 * on the Dashboard's recent-reports delete button actually gates the mutation:
 *
 *   (A) the delete trigger button renders for a team_lead and clicking it
 *       fires NO DELETE (the old window.confirm() path deleted straight from
 *       this click);
 *   (B) clicking the dialog's Cancel button fires NO DELETE;
 *   (C) clicking the dialog's confirm button fires exactly ONE
 *       DELETE /api/reports/:id — the same endpoint the old confirm() path
 *       used.
 *
 * The Radix AlertDialog is shimmed (portal never mounts in this raw jsdom
 * harness — see the setup file); the ConfirmActionDialog wiring, the trigger
 * button, and the deleteReportMutation are the real code.
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
(globalThis as any).HTMLImageElement = dom.window.HTMLImageElement;
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
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures + fetch stub with a DELETE recorder
// ---------------------------------------------------------------------------

const TEST_USER = {
  id: "user-4636",
  email: "lead@example.com",
  firstName: "Lead",
  lastName: "User",
  role: "team_lead", // canDelete: team_lead or ceo (Task #4644)
  profileImageUrl: null,
};

const CLIENT_SUMMARY = {
  id: "client-4636",
  clientCode: "ACME",
  firmName: "Acme Law Firm",
  contactName: "Jane Doe",
  products: [] as string[],
  practiceAreas: [] as string[],
  clientStartDate: "2025-01-01",
  ownerId: "user-4636",
  ownerName: "Lead User",
  ownerAvatar: null,
  lastCommDate: "2026-06-01T00:00:00.000Z",
  commCount30d: 5,
  commCountTotal: 50,
  touchpointCount30d: 2,
  touchpointCountTotal: 20,
  lastTouchpointDate: "2026-06-01T00:00:00.000Z",
  judgmentStatus: "Healthy",
  relationshipHealth: "good",
  judgmentHeadline: "All good",
  judgmentDate: "2026-06-01T00:00:00.000Z",
  lastReviewedAt: "2026-06-01T00:00:00.000Z",
  budgetPosture: null,
};

const REPORT_ID = "report-4636";
const REPORT = {
  id: REPORT_ID,
  clientId: CLIENT_SUMMARY.id,
  reportMonth: "2026-07",
  status: "draft",
};

const deleteCalls: string[] = [];

globalThis.fetch = createFetchStub({
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
    { path: "/api/dashboard/client-summaries", json: [CLIENT_SUMMARY] },
    { path: "/api/dashboard/wins", json: [] },
    { method: "GET", path: /\/api\/reports(\?|$)/, json: [REPORT] },
    { path: /\/api\/tags(\?|$)/, json: { tags: [], assignments: [] } },
    { path: "/api/notifications/unread-count", json: { count: 0 } },
    { path: "/api/monthly-review-stats", json: { reviewed: 0, needsReview: 0, total: 0 } },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const Dashboard = (await import("../../client/src/pages/Dashboard")).default as any;

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
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
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Dashboard),
      ),
    );
  });
  await flush(12);

  // ── A. trigger renders; clicking it fires no DELETE ───────────────────────
  const trigger = $(`button-delete-report-${REPORT_ID}`);
  assert(trigger, "A: delete-report trigger button renders for a team_lead");
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
  queryClient.clear();

  console.log("\nconfirm-dialog-dashboard-delete-report: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
