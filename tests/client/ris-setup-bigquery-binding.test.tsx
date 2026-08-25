/* test-registration
{
  "name": "RIS Setup BigQuery-binding panel \u2014 manager save/override + non-manager gating (Task #2516)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
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
 * Task #2516 — Frontend regression test for the manager-only RIS Setup
 * per-client BigQuery binding panel in `client/src/pages/RisDashboard.tsx`.
 *
 * Task #2491 covered the binding HTTP routes; this guards the Setup panel the
 * managers actually use. It mounts the real `RisDashboard` page against the
 * production `client/src/lib/queryClient` with a stubbed `globalThis.fetch`,
 * and exercises:
 *
 *   1. Manager save path: a CEO opens RIS Setup (?area=setup), picks a client,
 *      types a BigQuery client key and saves. Exactly one
 *      PUT /api/ris/client-bindings/:clientId/bigquery-key fires carrying the
 *      typed key; the in-memory "server" persists it, the binding query
 *      re-fetches on invalidate, and the key input reflects the saved value.
 *
 *   2. Override edit + revert-to-global flow: opening an inherited override,
 *      saving it issues PUT .../overrides/:autoSource; then the now-overridden
 *      row's "Remove override" issues DELETE .../overrides/:autoSource and the
 *      row reverts to "inherits global".
 *
 *   3. Manager gating: a non-manager (account_manager) who navigates to
 *      ?area=setup is bounced to the Overview portfolio — the binding panel is
 *      never rendered.
 *
 * The Radix Select primitive is shimmed (see `ris-setup-select-shim.mjs`,
 * wired via `ris-setup-bigquery-mock-setup.mjs`) because it never portals into
 * the raw jsdom harness; the shim renders items inline and forwards
 * onValueChange so the client picker is actually drivable.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MANAGER_USER = {
  id: "ceo-2516",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
  authorityLevel: "ceo",
};

const NON_MANAGER_USER = {
  id: "am-2516",
  email: "am@example.com",
  firstName: "Anne",
  lastName: "Manager",
  role: "account_manager",
  authorityLevel: "associate",
};

const CLIENT = { id: "client-2516", firmName: "Acme Law" };

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

// Mutable so each scenario picks which account is "logged in".
let currentUser: any = MANAGER_USER;

// In-memory "server" binding store the PUT/DELETE writes mutate and the GET
// reads back — lets us prove values round-trip (persist on re-fetch).
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

type RecordedCall = { method: string; url: string; body: any };
let calls: RecordedCall[] = [];
// Count GET re-fetches of the per-client binding so we can prove a save
// invalidates + refetches (rather than only updating local state).
let bindingGetCount = 0;

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  onCall: (ctx: any) => {
    if (ctx.method !== "GET") {
      let body: any = null;
      try {
        body = ctx.init?.body ? JSON.parse(String(ctx.init.body)) : null;
      } catch {
        body = null;
      }
      calls.push({ method: ctx.method, url: ctx.url, body });
    }
  },
  routes: [
    // Per-client override write.
    {
      method: "PUT",
      path: /\/api\/ris\/client-bindings\/([^/]+)\/overrides\/([^/?]+)$/,
      respond: (ctx: any) => {
        let body: any = null;
        try {
          body = ctx.init?.body ? JSON.parse(String(ctx.init.body)) : null;
        } catch {
          body = null;
        }
        const overrideMatch = ctx.url.match(
          /\/api\/ris\/client-bindings\/([^/]+)\/overrides\/([^/?]+)$/,
        );
        const autoSource = decodeURIComponent(overrideMatch[2]);
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
        return { status: 200, json: next };
      },
    },
    // Per-client override delete.
    {
      method: "DELETE",
      path: /\/api\/ris\/client-bindings\/([^/]+)\/overrides\/([^/?]+)$/,
      respond: (ctx: any) => {
        const overrideMatch = ctx.url.match(
          /\/api\/ris\/client-bindings\/([^/]+)\/overrides\/([^/?]+)$/,
        );
        const autoSource = decodeURIComponent(overrideMatch[2]);
        serverBinding.overrides = serverBinding.overrides.filter(
          (o) => o.autoSource !== autoSource,
        );
        return { status: 200, json: { ok: true } };
      },
    },
    // BigQuery client-key write.
    {
      method: "PUT",
      path: /\/api\/ris\/client-bindings\/([^/]+)\/bigquery-key$/,
      respond: (ctx: any) => {
        let body: any = null;
        try {
          body = ctx.init?.body ? JSON.parse(String(ctx.init.body)) : null;
        } catch {
          body = null;
        }
        serverBinding.bigQueryClientKey = body?.bigQueryClientKey ?? null;
        return { status: 200, json: { ...serverBinding } };
      },
    },
    // Per-client binding read.
    {
      method: "GET",
      path: /\/api\/ris\/client-bindings\/[^/]+$/,
      json: () => {
        bindingGetCount++;
        return { ...serverBinding };
      },
    },
    { path: "/api/auth/user", json: () => currentUser },
    {
      path: "/api/ris/auto-mappings",
      json: { mappings: [AUTO_MAPPING], unmapped: [] },
    },
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

async function scenario1_managerSavesBigQueryKey(): Promise<void> {
  console.log("\n— Scenario 1: manager picks a client, saves a BigQuery key, UI reflects it —");
  currentUser = MANAGER_USER;
  resetServer();
  const root = await mountPage();
  try {
    assert($("card-client-bindings") !== null, "manager must see the per-client binding panel");
    // Before a client is picked, the key input is not shown.
    assert($("input-binding-bigquery-key") === null, "key input hidden until a client is selected");

    await selectClient(CLIENT.id);
    assert(
      $("input-binding-bigquery-key") !== null,
      "the BigQuery key input must render once a client is selected",
    );

    const getsBeforeSave = bindingGetCount;
    await typeInto("input-binding-bigquery-key", "acme-bq-key");
    await clickById("button-save-bigquery-key");

    const keyPuts = calls.filter((c) =>
      /\/api\/ris\/client-bindings\/[^/]+\/bigquery-key$/.test(c.url),
    );
    assert(
      keyPuts.length === 1,
      `exactly one bigquery-key write expected — got ${keyPuts.length}: ${JSON.stringify(keyPuts)}`,
    );
    assert(keyPuts[0].method === "PUT", `bigquery-key write must use PUT — got ${keyPuts[0].method}`);
    assert(
      new RegExp(`/api/ris/client-bindings/${CLIENT.id}/bigquery-key$`).test(keyPuts[0].url),
      `bigquery-key write must hit the per-client route — got ${keyPuts[0].url}`,
    );
    assert(
      keyPuts[0].body?.bigQueryClientKey === "acme-bq-key",
      `the PUT must carry the typed key — got ${JSON.stringify(keyPuts[0].body)}`,
    );

    // Persisted + reflected: the store kept it and the input re-reads it.
    assert(
      serverBinding.bigQueryClientKey === "acme-bq-key",
      `server must persist the key — got ${serverBinding.bigQueryClientKey}`,
    );
    const keyInput = $("input-binding-bigquery-key") as HTMLInputElement;
    assert(
      keyInput.value === "acme-bq-key",
      `the key input must reflect the saved value after re-fetch — got "${keyInput.value}"`,
    );

    // Saving must invalidate + re-fetch the per-client binding (not merely keep
    // local state), so the displayed value is the authoritative server value.
    assert(
      bindingGetCount > getsBeforeSave,
      `saving the key must trigger a binding re-fetch — GETs before=${getsBeforeSave}, after=${bindingGetCount}`,
    );

    console.log("  ✓ one PUT carrying the typed key, persisted + re-fetched + reflected in the input");
  } finally {
    await unmount(root);
  }
}

async function scenario2_overrideSaveThenRevert(): Promise<void> {
  console.log("\n— Scenario 2: edit an override, then revert it to the global mapping —");
  currentUser = MANAGER_USER;
  resetServer();
  const root = await mountPage();
  try {
    await selectClient(CLIENT.id);

    const source = AUTO_MAPPING.autoSource;
    assert($(`override-${source}`) !== null, "the auto-source override row must render");

    // Inherits global to start.
    assert(
      $(`override-${source}`)!.textContent!.includes("inherits global"),
      "override row starts as 'inherits global'",
    );

    // Open + save an override.
    await clickById(`button-edit-override-${source}`);
    await typeInto(`input-override-valuecol-${source}`, "custom_value");
    await clickById(`button-save-override-${source}`);

    const overridePuts = calls.filter(
      (c) =>
        c.method === "PUT" &&
        new RegExp(`/api/ris/client-bindings/${CLIENT.id}/overrides/${source}$`).test(c.url),
    );
    assert(
      overridePuts.length === 1,
      `exactly one override PUT expected — got ${overridePuts.length}`,
    );
    assert(
      overridePuts[0].body?.valueColumn === "custom_value",
      `override PUT must carry the edited value column — got ${JSON.stringify(overridePuts[0].body)}`,
    );
    assert(
      serverBinding.overrides.some((o) => o.autoSource === source),
      "server must now hold the override",
    );

    // After re-fetch the row shows as overridden.
    assert(
      $(`override-${source}`)!.textContent!.includes("overridden"),
      "after saving, the override row must show 'overridden'",
    );

    // Revert to global: open the (now overridden) row and remove it.
    calls = [];
    await clickById(`button-edit-override-${source}`);
    assert(
      $(`button-remove-override-${source}`) !== null,
      "an overridden row must offer 'Remove override'",
    );
    await clickById(`button-remove-override-${source}`);

    const deletes = calls.filter(
      (c) =>
        c.method === "DELETE" &&
        new RegExp(`/api/ris/client-bindings/${CLIENT.id}/overrides/${source}$`).test(c.url),
    );
    assert(deletes.length === 1, `exactly one override DELETE expected — got ${deletes.length}`);
    assert(
      serverBinding.overrides.every((o) => o.autoSource !== source),
      "server must drop the override after delete",
    );
    assert(
      $(`override-${source}`)!.textContent!.includes("inherits global"),
      "after removing, the row must revert to 'inherits global'",
    );

    console.log("  ✓ override PUT then DELETE round-trip; row toggles overridden → inherits global");
  } finally {
    await unmount(root);
  }
}

async function scenario3_nonManagerCannotReachPanel(): Promise<void> {
  console.log("\n— Scenario 3: a non-manager at ?area=setup is bounced to Overview (no panel) —");
  currentUser = NON_MANAGER_USER;
  resetServer();
  const root = await mountPage();
  try {
    assert(
      $("card-client-bindings") === null,
      "a non-manager must NOT see the per-client binding panel",
    );
    assert(
      $("ris-setup-view") === null,
      "a non-manager must not land on the Setup view even with ?area=setup",
    );
    // They land on the portfolio overview instead.
    assert($("text-ris-title") !== null, "a non-manager falls back to the Overview portfolio");

    console.log("  ✓ non-manager is gated out of Setup and shown the Overview");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_managerSavesBigQueryKey();
  await scenario2_overrideSaveThenRevert();
  await scenario3_nonManagerCannotReachPanel();
  console.log("\nris-setup-bigquery-binding: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
