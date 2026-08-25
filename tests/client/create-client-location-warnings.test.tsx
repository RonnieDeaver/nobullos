/* test-registration
{
  "name": "Create-client locationWarnings surface in the UI toast (Task #2527)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client-edit-data-access-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2527 — Frontend regression test guarding the create-client
 * `locationWarnings` rendering on
 * `client/src/pages/admin/ClientManagement.tsx`.
 *
 * Task #2490 (see `tests/create-client-locations-route.test.ts`) locked the
 * SERVER contract: `POST /api/clients` still creates the client (201) when a
 * draft location has a bad/too-short/unfindable address, and reports each
 * rejected location back in a `locationWarnings: { name, reason }[]` array
 * instead of silently dropping it. But the CLIENT-side rendering of those
 * warnings — what the operator actually sees after creating a client — had no
 * automated coverage. A refactor that stopped surfacing them (silently hiding
 * which locations failed) would go unnoticed.
 *
 * This pins the UI contract end-to-end through the real create form:
 *
 *   1. Some locations fail: the operator opens "Add Client", types a firm name,
 *      adds three draft locations (one good, two bad), and submits. The POST
 *      stub mirrors the #2490 server — it persists the client (201) and returns
 *      a `locationWarnings` entry for each bad location. The UI must raise a
 *      DESTRUCTIVE toast whose copy names EVERY failed location AND its reason,
 *      and must NOT claim a clean "created successfully".
 *
 *   2. No failures: an all-valid create returns a body with no
 *      `locationWarnings` key. The UI must raise the plain (non-destructive)
 *      "Client created successfully" toast and surface NO warning text — nothing
 *      extra when nothing failed.
 *
 * Mounts the real `ClientManagement` page (as a CEO) against the production
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The Radix
 * Dialog + Select primitives are shimmed (via
 * `tests/client-edit-data-access-mock-setup.mjs`) because neither portals into
 * the raw jsdom harness. The toast is read through a tiny recorder that
 * subscribes to the real `useToast()` store (the Radix `<Toaster />` likewise
 * never portals here). Harness pattern mirrors the #2431 data-access test.
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
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).HTMLFormElement = dom.window.HTMLFormElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).FocusEvent = dom.window.FocusEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).DOMRect = dom.window.DOMRect;
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
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CEO_USER = {
  id: "ceo-2527",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const NEW_CLIENT_ID = "client-2527";

// The draft locations the operator adds. Two are deliberately un-geocodable so
// the server returns a per-location warning for each; one is good. The bad
// reasons mirror the operator-correctable vs. system wording the #2490 route
// produces.
const GOOD_LOC = { name: "Good Dallas", address: "123 Main St, Dallas, TX 75201" };
const BAD_LOC_1 = {
  name: "Nowhere Office",
  address: "999 Nowhere St, Nulltown, ZZ 00000",
  reason: "We couldn't find that address — please double-check it.",
};
const BAD_LOC_2 = {
  name: "Provider Fault",
  address: "500 Fault Ave, Faulton, TX 75000",
  reason: "There was a system issue (not your address) — try again later.",
};

// Drives the POST /api/clients response per scenario. When non-empty, the
// stub echoes these back as the create body's `locationWarnings` array; when
// empty the key is OMITTED entirely (the all-valid contract).
let warningsToReturn: { name: string; reason: string }[] = [];
// Every body the page POSTed to /api/clients — lets us prove the operator's
// draft locations actually reached the request.
let createBodies: any[] = [];

const jsonResponse = createJsonResponse(dom.window.Headers) as (status: number, body: any) => Response;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    // Create-client POST — the path the regression guards. Mirror #2490: the
    // client is created (201) and any rejected locations come back in
    // `locationWarnings` (key omitted entirely when nothing failed).
    {
      method: "POST",
      test: (url: string) => /\/api\/clients$/.test(url),
      respond: ({ init }: any) => {
        let parsed: any = null;
        try {
          parsed = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          parsed = null;
        }
        createBodies.push(parsed);
        const body: any = { id: NEW_CLIENT_ID, firmName: parsed?.firmName ?? null };
        if (warningsToReturn.length > 0) body.locationWarnings = warningsToReturn;
        return jsonResponse(201, body);
      },
    },
    // Per-category Data Access writes the create flow fires after the client is
    // created — succeed silently so they never affect the toast under test.
    {
      method: "PUT",
      test: (url: string) => /\/api\/clients\/[^/]+\/data-access\/[^/?]+$/.test(url),
      json: { ok: true },
    },
    { path: "/api/auth/user", json: CEO_USER },
    { test: (url: string) => /\/api\/clients\/[^/]+\/locations$/.test(url), json: [] },
    { path: "/api/admin/clients/invalid-products", json: { scanned: 0, offenders: [] } },
    { path: "/api/clients", json: [] },
    { path: "/api/users", json: [CEO_USER] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const ClientManagement = (
  await import("../../client/src/pages/admin/ClientManagement")
).default;
const { useToast } = await import("../../client/src/hooks/use-toast");

// The create path surfaces success/failure as a toast. The toast store is a
// module-level singleton (TOAST_LIMIT = 1), so a tiny recorder that subscribes
// via useToast() lets us read the most-recent toast without mounting the Radix
// <Toaster /> (which never portals into the jsdom harness).
let lastToast: { title?: any; description?: any; variant?: any } | null = null;
function ToastRecorder(): null {
  const { toasts } = (useToast as any)();
  if (Array.isArray(toasts) && toasts.length > 0) {
    lastToast = toasts[0];
  }
  return null;
}

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected [data-testid="${testId}"] to exist before click`);
  await act(async () => {
    el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setInputValue(testId: string, value: string): Promise<void> {
  const el = $(testId) as HTMLInputElement | null;
  assert(el !== null, `input [data-testid="${testId}"] must be in the DOM`);
  await act(async () => {
    const proto = Object.getPrototypeOf(el!);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else (el as any).value = value;
    el!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    el!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await flush(2);
}

// Add one draft location through the real form controls (name + address, then
// the "Add Location" button), exactly as an operator would.
async function addDraftLocation(name: string, address: string): Promise<void> {
  await setInputValue("input-draft-location", name);
  await setInputValue("input-draft-location-address", address);
  await clickById("button-add-draft-location");
}

async function mountPage(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ClientManagement as any),
        React.createElement(ToastRecorder as any),
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
  createBodies = [];
  lastToast = null;
}

// Submitting the form mirrors clicking "Create Client" — the submit button
// lives inside the (shimmed) dialog form, and a real submit event is what
// drives handleSubmit → createMutation. `gbp` is selected by default so the
// product gate is satisfied without touching the checkboxes.
async function submitCreateForm(): Promise<void> {
  const submitBtn = $("button-submit-client");
  assert(submitBtn !== null, "expected the dialog submit button after opening Add Client");
  const form = submitBtn!.closest("form");
  assert(form !== null, "expected the submit button to live inside the create form");
  await act(async () => {
    form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_failedLocationsSurfaceInToast(): Promise<void> {
  console.log(
    "\n— Scenario 1: failed locations → destructive toast naming each location + reason —",
  );
  warningsToReturn = [
    { name: BAD_LOC_1.name, reason: BAD_LOC_1.reason },
    { name: BAD_LOC_2.name, reason: BAD_LOC_2.reason },
  ];
  const root = await mountPage();
  try {
    await clickById("button-add-client");
    assert(
      $("input-firm-name") !== null,
      "the Add Client dialog's form must render after opening",
    );

    await setInputValue("input-firm-name", "NoBull Mixed Law");
    await addDraftLocation(GOOD_LOC.name, GOOD_LOC.address);
    await addDraftLocation(BAD_LOC_1.name, BAD_LOC_1.address);
    await addDraftLocation(BAD_LOC_2.name, BAD_LOC_2.address);

    // Sanity: all three drafts staged in the UI before submit.
    assert($("draft-location-0") !== null, "first draft location must be staged");
    assert($("draft-location-1") !== null, "second draft location must be staged");
    assert($("draft-location-2") !== null, "third draft location must be staged");

    await submitCreateForm();

    // The operator's draft locations actually reached the POST body.
    assert(createBodies.length === 1, `expected exactly one create POST, got ${createBodies.length}`);
    const sent = createBodies[0];
    assert(
      Array.isArray(sent?.locations) && sent.locations.length === 3,
      `create POST must carry the 3 draft locations — got ${JSON.stringify(sent?.locations)}`,
    );

    // A toast must be raised, and it must be the DESTRUCTIVE variant (failures
    // are not a clean success).
    assert(lastToast !== null, "creating with failed locations must raise a toast");
    assert(
      lastToast!.variant === "destructive",
      `failed-location toast must be the destructive variant — got "${lastToast!.variant}"`,
    );
    // It must NOT pretend everything went fine.
    assert(
      !String(lastToast!.title || "").toLowerCase().includes("created successfully"),
      `failed-location toast must NOT claim a clean success — got title "${lastToast!.title}"`,
    );

    // Crucially: every failed location's NAME and its REASON must be surfaced
    // to the operator (this is the whole point — don't silently hide failures).
    const copy = `${String(lastToast!.title ?? "")}\n${String(lastToast!.description ?? "")}`;
    for (const bad of [BAD_LOC_1, BAD_LOC_2]) {
      assert(
        copy.includes(bad.name),
        `toast must name failed location "${bad.name}" — got "${copy}"`,
      );
      assert(
        copy.includes(bad.reason),
        `toast must surface the reason for "${bad.name}" — got "${copy}"`,
      );
    }
    // The good location must NOT be reported as a failure.
    assert(
      !copy.includes(GOOD_LOC.name),
      `toast must not name the location that succeeded ("${GOOD_LOC.name}") — got "${copy}"`,
    );

    console.log(
      "  ✓ destructive toast names each failed location + reason, omits the one that saved",
    );
  } finally {
    await unmount(root);
  }
}

async function scenario2_noFailuresPlainSuccessNoWarnings(): Promise<void> {
  console.log(
    "\n— Scenario 2: all-valid create → plain success toast, no warning text —",
  );
  warningsToReturn = []; // → POST body omits locationWarnings entirely.
  const root = await mountPage();
  try {
    await clickById("button-add-client");
    await setInputValue("input-firm-name", "NoBull Clean Law");
    await addDraftLocation(GOOD_LOC.name, GOOD_LOC.address);
    await submitCreateForm();

    assert(createBodies.length === 1, `expected exactly one create POST, got ${createBodies.length}`);

    assert(lastToast !== null, "a successful create must raise a toast");
    assert(
      lastToast!.variant !== "destructive",
      `a clean create must NOT raise a destructive toast — got variant "${lastToast!.variant}"`,
    );
    assert(
      String(lastToast!.title || "").toLowerCase().includes("created successfully"),
      `clean-create toast must read like "Client created successfully" — got "${lastToast!.title}"`,
    );
    // Nothing extra: no warning headline and no per-location reason leaks.
    const copy = `${String(lastToast!.title ?? "")}\n${String(lastToast!.description ?? "")}`;
    assert(
      !copy.toLowerCase().includes("weren't added") &&
        !copy.includes(BAD_LOC_1.reason) &&
        !copy.includes(BAD_LOC_2.reason),
      `clean-create toast must surface no warning text — got "${copy}"`,
    );

    console.log("  ✓ plain success toast, nothing extra when no location failed");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_failedLocationsSurfaceInToast();
  await scenario2_noFailuresPlainSuccessNoWarnings();
  console.log("\ncreate-client-location-warnings: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
