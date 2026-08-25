/* test-registration
{
  "name": "CommandPanel delete-GBP-location ConfirmActionDialog — trigger opens only, cancel fires nothing, confirm DELETEs /api/clients/:id/locations/:locId (Task #4754)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4754: Task #4621 swapped CommandPanel's delete-GBP-location window.confirm() for the trigger-wrapped shared ConfirmActionDialog, and no test clicked the converted button — a per-surface wiring mistake (deleting on trigger/cancel, or never firing the mutation on confirm) would ship unnoticed. This mounts the REAL CommandPanel in jsdom (same harness as command-panel-gbp-location-error.test.tsx), enters Products edit mode, and pins: trigger click fires no DELETE, cancel fires no DELETE, confirm fires exactly one DELETE /api/clients/:id/locations/:locId (the old confirm() endpoint). DB-free, deterministic; generous wall-clock because tsx transpiles the large CommandPanel graph cold.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/command-panel-gbp-setup.mjs"
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
 * on CommandPanel's delete-GBP-location button actually gates the mutation:
 *
 *   (A) the delete trigger button renders in Products edit mode and clicking
 *       it fires NO DELETE (the old window.confirm() path deleted straight
 *       from this click);
 *   (B) clicking the dialog's Cancel button fires NO DELETE;
 *   (C) clicking the dialog's confirm button fires exactly ONE
 *       DELETE /api/clients/:id/locations/:locId — the same endpoint the old
 *       confirm() path used.
 *
 * Reuses tests/command-panel-gbp-setup.mjs (heavy leaf stubs + Radix
 * dialog/select/alert-dialog shims); the ConfirmActionDialog wiring and the
 * deleteGbpLocationMutation are the real code.
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
// Fixtures + fetch stub with a DELETE recorder (mirrors
// command-panel-gbp-location-error.test.tsx)
// ---------------------------------------------------------------------------

const CLIENT_ID = "client-4754-cp";

const CEO_USER = {
  id: "ceo-4754",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const PANEL_DATA = {
  id: "panel-4754",
  clientId: CLIENT_ID,
  productTypes: ["gbp"],
  productStatusNotes: null,
  currentBottleneck: null,
  budgetPosture: null,
  googleAdsBudget: null,
  webinarBudget: null,
  lsaBudget: null,
  googleAdsTargetAreas: [],
  googleAdsTargetingMethod: null,
  googleAdsExcludedAreas: [],
  googleAdsGeoNotes: null,
  webinarTargetAreas: [],
  webinarGeoNotes: null,
};

const EXISTING_LOCATION = { id: 10, name: "Downtown Office", address: "1 Old St, Dallas, TX" };

const CLIENT = {
  id: CLIENT_ID,
  firmName: "Acme Law",
  ownerId: CEO_USER.id,
  terminology: {},
  practiceAreas: [],
  productTypes: ["gbp"],
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
    { path: `/api/clients/${CLIENT_ID}/command-panel/unmatched-zoom`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/command-panel/history`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/command-panel/key-calls`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/command-panel/rer-recordings`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/command-panel`, json: PANEL_DATA },
    { path: `/api/clients/${CLIENT_ID}/locations/audit`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/locations`, json: [EXISTING_LOCATION] },
    { path: `/api/clients/${CLIENT_ID}/contacts/audit`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/contacts`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/communications`, json: [] },
    { path: "/api/import-suggestions", json: { items: [] } },
    { path: `/api/clients/${CLIENT_ID}/data-access`, json: [] },
    { path: `/api/clients/${CLIENT_ID}/pandadoc-documents`, json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const CommandPanel = (await import("../../client/src/components/CommandPanel")).default;

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 16): Promise<void> {
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(CommandPanel as any, {
          clientId: CLIENT_ID,
          client: CLIENT,
          currentUser: CEO_USER,
          allUsers: [CEO_USER],
          primaryReady: true,
        }),
      ),
    );
  });
  await flush();

  // Enter edit mode for the Products section, revealing the GBP locations list.
  assert(
    $("card-products-budgets-standalone"),
    "the Products & Budget card must render for a CEO once the panel loads",
  );
  await click($("button-edit-products")!);
  assert(
    $("gbp-locations-section"),
    "the GBP Locations section must render in edit mode when productTypes includes 'gbp'",
  );

  // ── A. trigger renders; clicking it fires no DELETE ───────────────────────
  const trigger = $(`button-delete-gbp-location-${EXISTING_LOCATION.id}`);
  assert(trigger, "A: delete-GBP-location trigger button renders on the existing row");
  await click(trigger!);
  assert(
    deleteCalls.length === 0,
    `A: clicking the trigger must fire NO DELETE (old confirm() path deleted here) — got ${JSON.stringify(deleteCalls)}`,
  );
  console.log("  ✓ A: trigger click opens the dialog without firing a DELETE");

  // ── B. cancel fires nothing ────────────────────────────────────────────────
  const cancel = $(`dialog-confirm-delete-gbp-location-${EXISTING_LOCATION.id}-cancel`);
  assert(cancel, "B: dialog cancel button is queryable");
  await click(cancel!);
  assert(
    deleteCalls.length === 0,
    `B: Cancel must fire NO DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  console.log("  ✓ B: cancel fires nothing");

  // ── C. confirm fires exactly one DELETE to the old confirm() endpoint ─────
  const confirm = $(`dialog-confirm-delete-gbp-location-${EXISTING_LOCATION.id}-confirm`);
  assert(confirm, "C: dialog confirm button is queryable");
  await click(confirm!);
  assert(
    deleteCalls.length === 1,
    `C: confirm must fire exactly ONE DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    deleteCalls[0].endsWith(`/api/clients/${CLIENT_ID}/locations/${EXISTING_LOCATION.id}`),
    `C: DELETE must hit /api/clients/${CLIENT_ID}/locations/${EXISTING_LOCATION.id} (the pre-#4621 confirm() endpoint) — got ${deleteCalls[0]}`,
  );
  console.log(
    `  ✓ C: confirm fires exactly one DELETE /api/clients/${CLIENT_ID}/locations/${EXISTING_LOCATION.id}`,
  );

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-command-panel-delete-location: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
