/* test-registration
{
  "name": "Client edit Data Access save path \u2014 PUT per category + partial-failure toast (Task #2431)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
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
 * Task #2431 — Frontend regression test guarding the client-edit Data Access
 * save path on `client/src/pages/admin/ClientManagement.tsx`.
 *
 * Task #2430 fixed a bug where editing a client's Data Access options sent the
 * wrong HTTP method (POST instead of PUT) to the per-category route, so the
 * writes 404'd, were swallowed, and a false "updated successfully" toast still
 * appeared. This test locks the corrected behaviour in:
 *
 *   1. Happy path: editing a client and saving issues exactly one
 *      PUT /api/clients/:clientId/data-access/:category per Data Access
 *      category, each carrying the status the edit form loaded. The fetch
 *      stub persists those PUTs into an in-memory server map, and re-opening
 *      the editor re-reads them via GET /api/clients/:id/data-access — proving
 *      the values round-trip (persist on reload). A wrong method/route would
 *      change the recorded calls and fail this test.
 *
 *   2. Failure path: when some per-category writes return a non-OK response,
 *      the save raises a single *destructive* toast that names the failed
 *      categories ("Client saved, but some Data Access changes didn't save")
 *      instead of an unconditional success toast.
 *
 * Mounts the real `ClientManagement` page (as a CEO) against the production
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The Radix
 * Dialog + Select primitives are shimmed (see
 * `tests/client-edit-data-access-mock-setup.mjs`) because neither portals into
 * the raw jsdom harness.
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
  id: "ceo-2431",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const CLIENT = {
  id: "client-2431",
  clientCode: "C-2431",
  firmName: "Acme Law",
  contactName: "Pat Partner",
  contactEmail: "pat@acme.law",
  contactPhone: null,
  consultType: "free",
  practiceAreas: [],
  products: ["gbp"],
  ownerId: null,
  initialLeads: 0,
  initialReviews: 0,
  initialCases: 0,
  isArchived: false,
  clientStartDate: null,
};

const DATA_ACCESS_CATEGORIES = [
  "consult_bookings",
  "sales_conversions",
  "sales_transcripts",
  "no_show_rate",
  "follow_up_touches",
];

// The Data Access values the editor loads for this client. The save must
// re-issue these exact statuses, one PUT per category.
const INITIAL_ACCESS: Record<string, string> = {
  consult_bookings: "available",
  sales_conversions: "pending",
  sales_transcripts: "refused",
  no_show_rate: "unknown",
  follow_up_touches: "available",
};

// In-memory "server" Data Access store the PUTs write to and the GETs read
// from — lets us prove values round-trip (persist on reload).
let accessStore: Record<string, string> = { ...INITIAL_ACCESS };

type AccessPutCall = { url: string; method: string; category: string; status: string };
let accessPutCalls: AccessPutCall[] = [];

// Categories whose PUT should be forced to fail (failure scenario).
let failCategories = new Set<string>();

const jsonResponse = createJsonResponse(dom.window.Headers) as (status: number, body: any) => Response;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    // Per-category Data Access write — the path the regression guards.
    {
      test: (url: string) => /\/api\/clients\/([^/]+)\/data-access\/([^/?]+)$/.test(url),
      respond: ({ url, method, init }: any) => {
        const category = url.match(/\/api\/clients\/([^/]+)\/data-access\/([^/?]+)$/)![2];
        let parsed: any = null;
        try {
          parsed = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          parsed = null;
        }
        accessPutCalls.push({ url, method, category, status: parsed?.status });
        if (failCategories.has(category)) {
          return jsonResponse(404, { error: "not found" });
        }
        accessStore[category] = parsed?.status;
        return jsonResponse(200, { ok: true });
      },
    },
    // Bulk Data Access read — used by handleEdit to hydrate the form.
    {
      test: (url: string) => /\/api\/clients\/([^/]+)\/data-access$/.test(url),
      json: () =>
        Object.entries(accessStore).map(([category, status]) => ({ category, status })),
    },
    // Client update (PATCH /api/clients/:id) precedes the access writes.
    {
      method: "PATCH",
      test: (url: string) => /\/api\/clients\/[^/]+$/.test(url),
      json: () => ({ ...CLIENT }),
    },
    { path: "/api/auth/user", json: CEO_USER },
    { test: (url: string) => /\/api\/clients\/[^/]+\/locations$/.test(url), json: [] },
    { path: "/api/admin/clients/invalid-products", json: { scanned: 1, offenders: [] } },
    { path: "/api/clients", json: () => [CLIENT] },
    { path: "/api/users", json: () => [CEO_USER] },
    { path: "/api/notifications", json: [] },
    // Missing-budget summaries list — ClientListWithHistory .filter()s this,
    // so it must be an array (the defaultJson {} crashes the render).
    { path: "/api/command-panel-summaries", json: [] },
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

// The save path surfaces success/failure as toasts. The toast store is a
// module-level singleton (TOAST_LIMIT = 1), so a tiny recorder component that
// subscribes via useToast() lets us read the most-recent toast without
// mounting the Radix <Toaster /> (which never portals into the jsdom harness).
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
  accessPutCalls = [];
  lastToast = null;
}

// Submitting the form directly mirrors clicking "Update Client" — the submit
// button lives inside the (shimmed) dialog form, and a real submit event is
// what drives handleSubmit → updateMutation.
async function submitEditForm(): Promise<void> {
  const submitBtn = $("button-submit-client");
  assert(submitBtn !== null, "expected the dialog submit button to be present after opening edit");
  const form = submitBtn!.closest("form");
  assert(form !== null, "expected the submit button to live inside the edit form");
  await act(async () => {
    form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_happyPathPutsEachCategory(): Promise<void> {
  console.log(
    "\n— Scenario 1: editing a client PUTs each Data Access category and values round-trip —",
  );
  accessStore = { ...INITIAL_ACCESS };
  failCategories = new Set();
  const root = await mountPage();
  try {
    await clickById(`button-edit-client-${CLIENT.id}`);

    // The editor hydrated the per-category selects from the bulk GET.
    assert(
      $(`select-access-consult_bookings`) !== null,
      "the edit dialog's Data Access controls must render after opening edit",
    );

    await submitEditForm();

    // Exactly one write per category, all PUT, all to the per-category route.
    assert(
      accessPutCalls.length === DATA_ACCESS_CATEGORIES.length,
      `expected ${DATA_ACCESS_CATEGORIES.length} Data Access writes, got ${accessPutCalls.length}: ${JSON.stringify(accessPutCalls)}`,
    );
    for (const call of accessPutCalls) {
      assert(
        call.method === "PUT",
        `Data Access write must use PUT (the POST bug regressed) — got ${call.method} for ${call.category}`,
      );
      assert(
        new RegExp(`/api/clients/${CLIENT.id}/data-access/${call.category}$`).test(call.url),
        `Data Access write must hit the per-category route — got ${call.url}`,
      );
    }
    for (const category of DATA_ACCESS_CATEGORIES) {
      const call = accessPutCalls.find((c) => c.category === category);
      assert(call !== undefined, `expected a PUT for category "${category}"`);
      assert(
        call!.status === INITIAL_ACCESS[category],
        `PUT for "${category}" must carry loaded status "${INITIAL_ACCESS[category]}" — got "${call!.status}"`,
      );
    }

    // Success toast (not the destructive failure variant).
    assert(lastToast !== null, "a toast must be raised after a successful save");
    assert(
      lastToast!.variant !== "destructive",
      `a fully-successful save must not raise a destructive toast — got variant "${lastToast!.variant}"`,
    );
    assert(
      String(lastToast!.title || "").toLowerCase().includes("updated"),
      `success toast must read like "Client updated successfully" — got "${lastToast!.title}"`,
    );

    // Values persist on reload: the store the PUTs wrote now backs the GET.
    for (const category of DATA_ACCESS_CATEGORIES) {
      assert(
        accessStore[category] === INITIAL_ACCESS[category],
        `persisted store must keep "${category}" = "${INITIAL_ACCESS[category]}" — got "${accessStore[category]}"`,
      );
    }

    // Re-open the editor — handleEdit re-reads the bulk GET, proving round-trip.
    accessPutCalls = [];
    lastToast = null;
    await clickById(`button-edit-client-${CLIENT.id}`);
    await submitEditForm();
    for (const category of DATA_ACCESS_CATEGORIES) {
      const call = accessPutCalls.find((c) => c.category === category);
      assert(
        call !== undefined && call.status === INITIAL_ACCESS[category],
        `on reload, "${category}" must re-load + re-save as "${INITIAL_ACCESS[category]}" — got "${call?.status}"`,
      );
    }

    console.log(
      "  ✓ each category PUT to its per-category route with the loaded status, success toast, values round-trip",
    );
  } finally {
    await unmount(root);
  }
}

async function scenario2_partialFailureWarnsNamingCategories(): Promise<void> {
  console.log(
    "\n— Scenario 2: some Data Access writes fail → destructive toast naming the failed categories —",
  );
  accessStore = { ...INITIAL_ACCESS };
  failCategories = new Set(["sales_transcripts", "no_show_rate"]);
  const root = await mountPage();
  try {
    await clickById(`button-edit-client-${CLIENT.id}`);
    await submitEditForm();

    // Every category is still attempted (PUT), even those that fail.
    assert(
      accessPutCalls.length === DATA_ACCESS_CATEGORIES.length,
      `all categories must still be attempted — got ${accessPutCalls.length}`,
    );

    // The toast must be destructive and name BOTH failed categories — not a
    // bare "updated successfully".
    assert(lastToast !== null, "a toast must be raised after a partially-failed save");
    assert(
      lastToast!.variant === "destructive",
      `a partial failure must raise a destructive toast — got variant "${lastToast!.variant}"`,
    );
    assert(
      !String(lastToast!.title || "").toLowerCase().includes("successfully"),
      `partial-failure toast must NOT claim success — got title "${lastToast!.title}"`,
    );
    const desc = String(lastToast!.description || "");
    for (const failed of failCategories) {
      assert(
        desc.includes(failed),
        `failure toast description must name failed category "${failed}" — got "${desc}"`,
      );
    }
    // It must not falsely blame a category that actually saved.
    assert(
      !desc.includes("consult_bookings"),
      `failure toast must not name a category that saved fine — got "${desc}"`,
    );

    console.log("  ✓ partial failure → destructive toast naming exactly the failed categories");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_happyPathPutsEachCategory();
  await scenario2_partialFailureWarnsNamingCategories();
  console.log("\nclient-edit-data-access-save: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
