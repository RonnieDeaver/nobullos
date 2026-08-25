/* test-registration
{
  "name": "RIS Setup BigQuery-binding panel — destructive toasts when key/override save or remove fails (Task #2550)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2550: the RIS Setup BigQuery-binding panel's failure branches guard a silent-failure class (a manager believing a key/override saved when the write 404'd/500'd). Gate it so the destructive-toast handling can't rot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ris-setup-bigquery-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2550 — Frontend regression test for the FAILURE branches of the
 * manager-only RIS Setup per-client BigQuery binding panel in
 * `client/src/pages/RisDashboard.tsx`.
 *
 * Task #2516 covered only the happy paths (save succeeds). The panel also
 * raises destructive "Save failed" / "Remove failed" toasts when the underlying
 * write returns a non-OK response (`apiRequest` throws → the mutation's
 * `onError` fires). If that error-handling regressed, a manager could think a
 * key/override saved when it didn't — exactly the silent-failure class this
 * panel was built to avoid. This guards those branches:
 *
 *   1. BigQuery-key PUT fails: typing a key and saving raises a *destructive*
 *      "Save failed" toast (not the success toast), the in-memory server never
 *      persists the key, and the panel does not re-fetch the binding (no false
 *      "saved" round-trip).
 *
 *   2. Override PUT fails: editing + saving an override raises a *destructive*
 *      "Save failed" toast, the server never gains the override, and the row
 *      stays "inherits global".
 *
 *   3. Override DELETE fails: removing an existing override raises a
 *      *destructive* "Remove failed" toast, the server keeps the override, and
 *      the row stays "overridden".
 *
 * Reuses the ToastRecorder pattern from
 * `tests/client/client-edit-data-access-save.test.tsx` to read the most-recent
 * toast, and the same Radix Select shim wiring as the #2516 sibling test (see
 * `ris-setup-bigquery-mock-setup.mjs`).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/ris?area=setup" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
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

// A failure toast description must read like plain English a manager can act
// on — never the raw `${status}: ${text}` string apiRequest throws (e.g.
// "500: {\"error\":\"...\"}"), and never a raw JSON blob.
function assertHumanReadableDescription(label: string): void {
  const desc = String(lastToast?.description ?? "");
  assert(desc.length > 0, `${label}: a failure toast must include a description`);
  assert(
    !/^\d{3}:/.test(desc),
    `${label}: description must not start with a raw "<status>:" prefix — got "${desc}"`,
  );
  assert(
    !desc.includes("{") && !desc.includes("}"),
    `${label}: description must not contain a raw JSON blob — got "${desc}"`,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MANAGER_USER = {
  id: "ceo-2550",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
  authorityLevel: "ceo",
};

const CLIENT = { id: "client-2550", firmName: "Acme Law" };

const AUTO_MAPPING = {
  id: "map-bookings",
  autoSource: "consult_bookings",
  label: "Consult bookings",
  enabled: true,
  sqlTemplate: "SELECT count(*) AS value FROM t",
  valueColumn: "value",
  comparator: "gte",
  threshold: "10",
  unitLabel: null,
  bqLocation: null,
  description: null,
};

// In-memory "server" binding store. PUT/DELETE writes mutate it; GET reads it
// back — so a failed write that leaves the store untouched proves nothing was
// silently persisted.
type ServerOverride = {
  id: string;
  clientId: string;
  autoSource: string;
  sqlTemplate: string | null;
  valueColumn: string | null;
  comparator: string | null;
  threshold: string | null;
  bqLocation: string | null;
  filterValue: string | null;
};
let serverBinding: {
  clientId: string;
  firmName: string;
  bigQueryClientKey: string | null;
  overrides: ServerOverride[];
};

function resetServer(): void {
  serverBinding = {
    clientId: CLIENT.id,
    firmName: CLIENT.firmName,
    bigQueryClientKey: null,
    overrides: [],
  };
}

function seedOverride(): ServerOverride {
  const ovr: ServerOverride = {
    id: `ovr-${AUTO_MAPPING.autoSource}`,
    clientId: CLIENT.id,
    autoSource: AUTO_MAPPING.autoSource,
    sqlTemplate: null,
    valueColumn: "seeded_value",
    comparator: null,
    threshold: null,
    bqLocation: null,
    filterValue: null,
  };
  serverBinding.overrides = [ovr];
  return ovr;
}

// Per-scenario failure switches: when set, the matching write returns a non-OK
// response AND does not mutate the store.
let failKeyPut = false;
let failOverridePut = false;
let failOverrideDelete = false;

type RecordedCall = { method: string; url: string; body: any };
let calls: RecordedCall[] = [];
let bindingGetCount = 0;

function parseBody(init: any): any {
  try {
    return init?.body ? JSON.parse(String(init.body)) : null;
  } catch {
    return null;
  }
}

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  onCall: ({ url, method, init }: any) => {
    if (method !== "GET") calls.push({ method, url, body: parseBody(init) });
  },
  routes: [
    // Per-client override write.
    {
      method: "PUT",
      path: /\/api\/ris\/client-bindings\/([^/]+)\/overrides\/([^/?]+)$/,
      respond: ({ url, init, jsonResponse }: any) => {
        const overrideMatch = url.match(
          /\/api\/ris\/client-bindings\/([^/]+)\/overrides\/([^/?]+)$/,
        );
        const autoSource = decodeURIComponent(overrideMatch[2]);
        if (failOverridePut) {
          return jsonResponse(500, { error: "override write failed" });
        }
        const body = parseBody(init);
        const existing = serverBinding.overrides.find((o) => o.autoSource === autoSource);
        const next: ServerOverride = {
          id: existing?.id ?? `ovr-${autoSource}`,
          clientId: CLIENT.id,
          autoSource,
          sqlTemplate: body?.sqlTemplate ?? null,
          valueColumn: body?.valueColumn ?? null,
          comparator: body?.comparator ?? null,
          threshold: body?.threshold ?? null,
          bqLocation: body?.bqLocation ?? null,
          filterValue: body?.filterValue ?? null,
        };
        serverBinding.overrides = serverBinding.overrides
          .filter((o) => o.autoSource !== autoSource)
          .concat(next);
        return jsonResponse(200, next);
      },
    },
    // Per-client override delete.
    {
      method: "DELETE",
      path: /\/api\/ris\/client-bindings\/([^/]+)\/overrides\/([^/?]+)$/,
      respond: ({ url, jsonResponse }: any) => {
        const overrideMatch = url.match(
          /\/api\/ris\/client-bindings\/([^/]+)\/overrides\/([^/?]+)$/,
        );
        const autoSource = decodeURIComponent(overrideMatch[2]);
        if (failOverrideDelete) {
          return jsonResponse(500, { error: "override delete failed" });
        }
        serverBinding.overrides = serverBinding.overrides.filter(
          (o) => o.autoSource !== autoSource,
        );
        return jsonResponse(200, { ok: true });
      },
    },
    // BigQuery client-key write.
    {
      method: "PUT",
      path: /\/api\/ris\/client-bindings\/([^/]+)\/bigquery-key$/,
      respond: ({ init, jsonResponse }: any) => {
        if (failKeyPut) {
          return jsonResponse(500, { error: "key write failed" });
        }
        const body = parseBody(init);
        serverBinding.bigQueryClientKey = body?.bigQueryClientKey ?? null;
        return jsonResponse(200, { ...serverBinding });
      },
    },
    // Per-client binding read.
    {
      method: "GET",
      path: /\/api\/ris\/client-bindings\/[^/]+$/,
      respond: ({ jsonResponse }: any) => {
        bindingGetCount++;
        return jsonResponse(200, { ...serverBinding });
      },
    },
    { path: "/api/auth/user", json: MANAGER_USER },
    { path: "/api/ris/auto-mappings", json: { mappings: [AUTO_MAPPING], unmapped: [] } },
    { path: "/api/ris/checks", json: [] },
    {
      path: "/api/ris/portfolio",
      json: {
        totals: {
          completionPct: 0,
          dueThisWeek: 0,
          dueThisMonth: 0,
          launchDue: 0,
          openFails: 0,
          openBlocked: 0,
          needsReview: 0,
          untouched: 0,
        },
        clients: [],
      },
    },
    { path: "/api/clients", json: [CLIENT] },
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
const RisDashboard = (await import("../../client/src/pages/RisDashboard")).default;
const { useToast } = await import("../../client/src/hooks/use-toast");

// The save/remove paths surface success/failure as toasts. The toast store is a
// module-level singleton (TOAST_LIMIT = 1), so a tiny recorder component that
// subscribes via useToast() reads the most-recent toast without mounting the
// Radix <Toaster /> (which never portals into the jsdom harness).
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

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function typeInto(testId: string, value: string): Promise<void> {
  const el = $(testId) as HTMLInputElement | null;
  assert(el !== null, `expected input [data-testid="${testId}"] to exist`);
  const proto =
    el!.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
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
        React.createElement(RisDashboard as any),
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
  calls = [];
  lastToast = null;
}

// Pick a client in the shimmed <Select> by clicking its inline option.
async function selectClient(clientId: string): Promise<void> {
  const opt = document.querySelector(
    `[data-select-value="${clientId}"]`,
  ) as HTMLElement | null;
  assert(opt !== null, `expected a client option for "${clientId}" in the picker`);
  await clickEl(opt!);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_keySaveFailureRaisesDestructiveToast(): Promise<void> {
  console.log("\n— Scenario 1: a failed BigQuery-key PUT raises a destructive 'Save failed' toast —");
  resetServer();
  failKeyPut = true;
  failOverridePut = false;
  failOverrideDelete = false;
  const root = await mountPage();
  try {
    await selectClient(CLIENT.id);
    assert(
      $("input-binding-bigquery-key") !== null,
      "the BigQuery key input must render once a client is selected",
    );

    await flush(); // let any binding refetch settle so the count is stable
    const getsBeforeSave = bindingGetCount;
    await typeInto("input-binding-bigquery-key", "acme-bq-key");
    await clickById("button-save-bigquery-key");

    // The write was attempted, exactly once, as a PUT.
    const keyPuts = calls.filter((c) =>
      /\/api\/ris\/client-bindings\/[^/]+\/bigquery-key$/.test(c.url),
    );
    assert(
      keyPuts.length === 1,
      `exactly one bigquery-key write expected — got ${keyPuts.length}: ${JSON.stringify(keyPuts)}`,
    );

    // A DESTRUCTIVE toast — not a success toast.
    assert(lastToast !== null, "a toast must be raised after a failed key save");
    assert(
      lastToast!.variant === "destructive",
      `a failed key save must raise a destructive toast — got variant "${lastToast!.variant}"`,
    );
    assert(
      String(lastToast!.title || "").toLowerCase().includes("failed"),
      `failed key save toast must read like "Save failed" — got "${lastToast!.title}"`,
    );
    assertHumanReadableDescription("failed key save");

    // Nothing was silently persisted, and the panel did not re-fetch (no false
    // round-trip claiming the value saved).
    assert(
      serverBinding.bigQueryClientKey === null,
      `a failed save must NOT persist the key — got ${serverBinding.bigQueryClientKey}`,
    );
    assert(
      bindingGetCount === getsBeforeSave,
      `a failed save must NOT invalidate/re-fetch the binding — GETs before=${getsBeforeSave}, after=${bindingGetCount}`,
    );

    console.log("  ✓ failed key PUT → destructive 'Save failed' toast, nothing persisted, no re-fetch");
  } finally {
    failKeyPut = false;
    await unmount(root);
  }
}

async function scenario2_overrideSaveFailureRaisesDestructiveToast(): Promise<void> {
  console.log("\n— Scenario 2: a failed override PUT raises a destructive 'Save failed' toast —");
  resetServer();
  failKeyPut = false;
  failOverridePut = true;
  failOverrideDelete = false;
  const root = await mountPage();
  try {
    await selectClient(CLIENT.id);
    const source = AUTO_MAPPING.autoSource;
    assert($(`override-${source}`) !== null, "the auto-source override row must render");
    assert(
      $(`override-${source}`)!.textContent!.includes("inherits global"),
      "override row starts as 'inherits global'",
    );

    await clickById(`button-edit-override-${source}`);
    await typeInto(`input-override-valuecol-${source}`, "custom_value");
    await clickById(`button-save-override-${source}`);

    // The write was attempted as a PUT.
    const overridePuts = calls.filter(
      (c) =>
        c.method === "PUT" &&
        new RegExp(`/api/ris/client-bindings/${CLIENT.id}/overrides/${source}$`).test(c.url),
    );
    assert(
      overridePuts.length === 1,
      `exactly one override PUT expected — got ${overridePuts.length}`,
    );

    // A DESTRUCTIVE toast — not a success toast.
    assert(lastToast !== null, "a toast must be raised after a failed override save");
    assert(
      lastToast!.variant === "destructive",
      `a failed override save must raise a destructive toast — got variant "${lastToast!.variant}"`,
    );
    assert(
      String(lastToast!.title || "").toLowerCase().includes("failed"),
      `failed override save toast must read like "Save failed" — got "${lastToast!.title}"`,
    );
    assertHumanReadableDescription("failed override save");

    // Nothing persisted, and the row still shows it inherits the global mapping
    // (the unsaved override is NOT shown as applied).
    assert(
      serverBinding.overrides.every((o) => o.autoSource !== source),
      "a failed override save must NOT persist the override",
    );
    assert(
      $(`override-${source}`)!.textContent!.includes("inherits global"),
      "after a failed save, the row must still read 'inherits global', not 'overridden'",
    );

    console.log("  ✓ failed override PUT → destructive 'Save failed' toast, nothing persisted, row unchanged");
  } finally {
    failOverridePut = false;
    await unmount(root);
  }
}

async function scenario3_overrideRemoveFailureRaisesDestructiveToast(): Promise<void> {
  console.log("\n— Scenario 3: a failed override DELETE raises a destructive 'Remove failed' toast —");
  resetServer();
  seedOverride();
  failKeyPut = false;
  failOverridePut = false;
  failOverrideDelete = true;
  const root = await mountPage();
  try {
    await selectClient(CLIENT.id);
    const source = AUTO_MAPPING.autoSource;
    assert($(`override-${source}`) !== null, "the auto-source override row must render");
    assert(
      $(`override-${source}`)!.textContent!.includes("overridden"),
      "the seeded override row must start as 'overridden'",
    );

    await clickById(`button-edit-override-${source}`);
    assert(
      $(`button-remove-override-${source}`) !== null,
      "an overridden row must offer 'Remove override'",
    );
    await clickById(`button-remove-override-${source}`);

    // The delete was attempted.
    const deletes = calls.filter(
      (c) =>
        c.method === "DELETE" &&
        new RegExp(`/api/ris/client-bindings/${CLIENT.id}/overrides/${source}$`).test(c.url),
    );
    assert(deletes.length === 1, `exactly one override DELETE expected — got ${deletes.length}`);

    // A DESTRUCTIVE toast — not a success toast.
    assert(lastToast !== null, "a toast must be raised after a failed override remove");
    assert(
      lastToast!.variant === "destructive",
      `a failed override remove must raise a destructive toast — got variant "${lastToast!.variant}"`,
    );
    assert(
      String(lastToast!.title || "").toLowerCase().includes("failed"),
      `failed override remove toast must read like "Remove failed" — got "${lastToast!.title}"`,
    );
    assertHumanReadableDescription("failed override remove");

    // The override is still on the server, and the row still reads "overridden"
    // (the failed removal is NOT shown as reverted).
    assert(
      serverBinding.overrides.some((o) => o.autoSource === source),
      "a failed remove must NOT drop the override from the server",
    );
    assert(
      $(`override-${source}`)!.textContent!.includes("overridden"),
      "after a failed remove, the row must still read 'overridden', not 'inherits global'",
    );

    console.log("  ✓ failed override DELETE → destructive 'Remove failed' toast, override kept, row unchanged");
  } finally {
    failOverrideDelete = false;
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_keySaveFailureRaisesDestructiveToast();
  await scenario2_overrideSaveFailureRaisesDestructiveToast();
  await scenario3_overrideRemoveFailureRaisesDestructiveToast();
  console.log("\nris-setup-bigquery-binding-save-failure: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
