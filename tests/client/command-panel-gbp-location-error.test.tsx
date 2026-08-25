/* test-registration
{
  "name": "Command Panel GBP-location create/update inline error shows backend reason (Task #2488)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/command-panel-gbp-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "notes": "Task #2545: also part of the TEST_SMOKE gate (see SMOKE_FILES) so the routine validation run exercises the GBP error-reason contract, not just the standalone --regression run. CommandPanel's component graph is large and tsx must transpile it cold in the smoke child; the run-all dev-server pause keeps the dev DB quiet, but give it a generous wall-clock so it reliably finishes under load instead of SIGKILL-flaking the gate.",
  "tier": "small"
}
test-registration */
/**
 * Frontend regression test for the Command Panel's add/edit GBP-location form
 * inline error (testid `text-gbp-location-error`).
 *
 * Task #2486 fixed a contract bug: the create/update mutations read the wrong
 * field off the backend's failure response (`err.message` instead of
 * `err.error`), so every failure showed the generic "Failed to create/update
 * location" fallback instead of the specific reason the server returns
 * (`{ error: "We couldn't find that address…" }`). There was no automated test
 * covering the inline error display, so the field-read bug slipped through.
 *
 * This test locks the contract for BOTH mutation paths. It mounts the real
 * `CommandPanel` against the real `client/src/lib/queryClient`, with a stubbed
 * `globalThis.fetch` that:
 *   1. serves the panel + supporting queries so the Products section can enter
 *      edit mode and reveal the GBP Locations sub-form (productTypes ⊇ "gbp"),
 *   2. answers the create POST / update PATCH with a non-OK
 *      `{ error: "<specific reason>" }` body.
 *
 * It then asserts the inline error node shows the backend's `error` string
 * verbatim — not the generic fallback. If the mutation regresses to reading
 * `err.message` first (or drops the `err.error` read), the rendered text would
 * fall back to the generic message and these assertions fail.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2486 (the contract fix this guards — err.error first), #2182 / #2138 (the
 *   jsdom panel-mount + stubbed-fetch harness this copies), #2431 (the
 *   ClientManagement edit-form jsdom test that established the Radix
 *   select/dialog shim loader reused here).
 */

import { JSDOM } from "jsdom";
import { createFetchStub, createJsonResponse } from "../helpers/createFetchStub.mjs";

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
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const CLIENT_ID = "client-1";

const CEO_USER = {
  id: "ceo-1",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

// Specific backend reasons we expect surfaced verbatim. Deliberately distinct
// from the components' generic fallbacks ("Failed to create/update location").
const CREATE_ERROR = "We couldn't find that address — check the street and city.";
const UPDATE_ERROR = "An address is required for MCU capacity analysis.";

const PANEL_DATA = {
  id: "panel-1",
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
  ownerId: "ceo-1",
  terminology: {},
  practiceAreas: [],
  productTypes: ["gbp"],
};

const jsonResponse = createJsonResponse(dom.window.Headers) as (status: number, body: any) => Response;

// The two failure responses the mutation paths must surface. We flip these per
// phase so the create POST and the update PATCH each return their own reason.
let createResponse: () => Response = () => jsonResponse(400, { error: CREATE_ERROR });
let updateResponse: () => Response = () => jsonResponse(400, { error: UPDATE_ERROR });

// Routes are evaluated top-to-bottom, first match wins, and `path` strings match
// by exact-or-prefix — so the deeper `command-panel/*` and `locations/audit`
// routes are listed BEFORE their shallower `command-panel` / `locations`
// prefixes, preserving the original exact-path dispatch.
function makeFetchHandler(): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", path: `/api/clients/${CLIENT_ID}/locations`, respond: () => createResponse() },
      {
        method: "PATCH",
        path: `/api/clients/${CLIENT_ID}/locations/${EXISTING_LOCATION.id}`,
        respond: () => updateResponse(),
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
      // Data Access card reads an array of entries; its advisory detection map
      // reads an object — the empty default below covers detection.
      { path: `/api/clients/${CLIENT_ID}/data-access`, json: [] },
      // Contracts card maps over the PandaDoc documents array.
      { path: `/api/clients/${CLIENT_ID}/pandadoc-documents`, json: [] },
    ],
    // Benign empty payload for anything incidental.
    defaultJson: {},
  });
}

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const CommandPanel = (await import("../../client/src/components/CommandPanel")).default;

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

function click(testId: string): void {
  const el = $(testId);
  assert(el !== null, `element ${testId} must be in the DOM to click`);
  el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setInputValue(testId: string, value: string): void {
  const el = $(testId) as HTMLInputElement | null;
  assert(el !== null, `input ${testId} must be in the DOM`);
  const proto = Object.getPrototypeOf(el!);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else (el as any).value = value;
  el!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  el!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

async function mountPanel(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
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
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  activeFetchHandler = makeFetchHandler();
  const root = await mountPanel();
  try {
    // The Products & Budget card must render once the deferred panel query
    // resolves for a CEO (canEdit).
    assert(
      $("card-products-budgets-standalone") !== null,
      "the Products & Budget card must render for a CEO once the panel loads",
    );

    // Enter edit mode for the Products section, revealing the GBP sub-form.
    click("button-edit-products");
    await flush();
    assert(
      $("gbp-locations-section") !== null,
      "the GBP Locations section must render in edit mode when productTypes includes 'gbp'",
    );

    // ---- CREATE path ------------------------------------------------------
    console.log("\n— create path —");
    click("button-add-gbp-location");
    await flush();
    assert($("input-gbp-location-name") !== null, "the add-location name input must render");
    setInputValue("input-gbp-location-name", "New Office");
    setInputValue("input-gbp-location-address", "100 Main St, Dallas, TX 75201");
    await flush();

    const saveBtn = $("button-save-gbp-location") as HTMLButtonElement | null;
    assert(saveBtn !== null, "the save-location button must render");
    assert(!saveBtn!.disabled, "the save button must be enabled once name + address are filled");

    click("button-save-gbp-location");
    await flush();

    const createErr = $("text-gbp-location-error");
    assert(createErr !== null, "the inline create error must render after a failed POST");
    assert(
      (createErr!.textContent || "").trim() === CREATE_ERROR,
      `the create error must show the backend's \`error\` string verbatim — got "${createErr!.textContent}"`,
    );
    assert(
      !(createErr!.textContent || "").includes("Failed to create location"),
      "the create error must NOT fall back to the generic message",
    );
    console.log("  ✓ create path surfaces backend `error` verbatim");

    // ---- UPDATE path ------------------------------------------------------
    console.log("\n— update path —");
    // Clicking edit on the existing row closes the add form and clears the
    // shared error, then pre-fills name + address (so save is enabled).
    click(`button-edit-gbp-location-${EXISTING_LOCATION.id}`);
    await flush();
    assert(
      $(`input-edit-gbp-location-name-${EXISTING_LOCATION.id}`) !== null,
      "the edit-location name input must render after clicking the row's edit button",
    );
    assert(
      $("text-gbp-location-error") === null,
      "the shared error must clear when entering edit mode (no stale create error)",
    );

    const saveEditBtn = $(`button-save-edit-gbp-location-${EXISTING_LOCATION.id}`) as HTMLButtonElement | null;
    assert(saveEditBtn !== null, "the save-edit button must render");
    assert(!saveEditBtn!.disabled, "the save-edit button must be enabled (row pre-fills name + address)");

    click(`button-save-edit-gbp-location-${EXISTING_LOCATION.id}`);
    await flush();

    const updateErr = $("text-gbp-location-error");
    assert(updateErr !== null, "the inline update error must render after a failed PATCH");
    assert(
      (updateErr!.textContent || "").trim() === UPDATE_ERROR,
      `the update error must show the backend's \`error\` string verbatim — got "${updateErr!.textContent}"`,
    );
    assert(
      !(updateErr!.textContent || "").includes("Failed to update location"),
      "the update error must NOT fall back to the generic message",
    );
    console.log("  ✓ update path surfaces backend `error` verbatim");

    console.log("\ncommand-panel-gbp-location-error: all DOM cases passed");
  } finally {
    await unmount(root);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
