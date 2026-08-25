/* test-registration
{
  "name": "RIS Setup global auto-source mappings editor \u2014 manager edit/configure + non-manager gating (Task #2551)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
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
 * Task #2551 — Frontend regression test for the manager-only RIS Setup
 * *global* auto-source mappings editor (`MappingsPanel` / `MappingEditor` in
 * `client/src/pages/RisDashboard.tsx`).
 *
 * Task #2516 covers the sibling per-client BigQuery binding panel; this guards
 * the global mappings editor that decides how every auto-sourced check pulls
 * its value from BigQuery and whether it is enabled. A regression there (Save
 * hitting the wrong endpoint, the comparator/enabled state not persisting)
 * would silently break auto-pull for every client.
 *
 * It mounts the real `RisDashboard` page against the production
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`, and an
 * in-memory "server" mappings store the PUT writes mutate and the GET reads
 * back, so we can prove values round-trip (persist on re-fetch). It exercises:
 *
 *   1. Manager edits an existing mapping: a CEO opens RIS Setup (?area=setup),
 *      opens a configured mapping, changes its value column, SQL template and
 *      comparator and toggles Enabled off, then saves. Exactly one
 *      PUT /api/ris/auto-mappings/:autoSource fires carrying the edited fields;
 *      the in-memory server persists it, the mappings query re-fetches on
 *      invalidate, and the row's badge flips enabled → disabled.
 *
 *   2. Manager configures a not-yet-mapped source: opening an "unmapped"
 *      source, filling it in, enabling it and saving issues
 *      PUT /api/ris/auto-mappings/:autoSource; the server promotes it from
 *      `unmapped` to `mappings`, and after re-fetch the row's badge reads
 *      "enabled" (was "not configured").
 *
 *   3. Manager gating: a non-manager (account_manager) who navigates to
 *      ?area=setup is bounced to the Overview portfolio — the mappings panel
 *      is never rendered.
 *
 * The Radix Select primitive is shimmed (see `ris-setup-select-shim.mjs`,
 * wired via `ris-setup-bigquery-mock-setup.mjs`) because it never portals into
 * the raw jsdom harness; the shim renders items inline and forwards
 * onValueChange so the comparator <Select> is actually drivable.
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
  id: "ceo-2551",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
  authorityLevel: "ceo",
};

const NON_MANAGER_USER = {
  id: "am-2551",
  email: "am@example.com",
  firstName: "Anne",
  lastName: "Manager",
  role: "account_manager",
  authorityLevel: "associate",
};

const CLIENT = { id: "client-2551", firmName: "Acme Law" };

type ServerMapping = {
  id: string;
  autoSource: string;
  label: string;
  enabled: boolean;
  sqlTemplate: string | null;
  valueColumn: string;
  comparator: string;
  threshold: string | null;
  unitLabel: string | null;
  bqLocation: string | null;
  description: string | null;
};

const CONFIGURED_SOURCE = "consult_bookings";
const UNMAPPED_SOURCE = "sales_revenue";

function freshConfiguredMapping(): ServerMapping {
  return {
    id: "map-bookings",
    autoSource: CONFIGURED_SOURCE,
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
}

// Mutable so each scenario picks which account is "logged in".
let currentUser: any = MANAGER_USER;

// In-memory "server" mappings store the PUT writes mutate and the GET reads
// back — lets us prove values round-trip (persist on re-fetch) and that a
// freshly-configured source is promoted from `unmapped` → `mappings`.
let serverMappings: ServerMapping[];
let serverUnmapped: string[];

function resetServer(): void {
  serverMappings = [freshConfiguredMapping()];
  serverUnmapped = [UNMAPPED_SOURCE];
}

type RecordedCall = { method: string; url: string; body: any };
let calls: RecordedCall[] = [];
// Count GET re-fetches of the global mappings so we can prove a save
// invalidates + refetches (rather than only updating local state).
let mappingsGetCount = 0;

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
    // Global auto-source mapping write (PUT /api/ris/auto-mappings/:autoSource).
    {
      method: "PUT",
      path: /\/api\/ris\/auto-mappings\/([^/?]+)$/,
      respond: (ctx: any) => {
        let body: any = null;
        try {
          body = ctx.init?.body ? JSON.parse(String(ctx.init.body)) : null;
        } catch {
          body = null;
        }
        const mappingMatch = ctx.url.match(/\/api\/ris\/auto-mappings\/([^/?]+)$/);
        const autoSource = decodeURIComponent(mappingMatch[1]);
        const idx = serverMappings.findIndex((m) => m.autoSource === autoSource);
        const base: ServerMapping =
          idx >= 0
            ? serverMappings[idx]
            : {
                id: `map-${autoSource}`,
                autoSource,
                label: autoSource,
                enabled: false,
                sqlTemplate: null,
                valueColumn: "value",
                comparator: "none",
                threshold: null,
                unitLabel: null,
                bqLocation: null,
                description: null,
              };
        const merged: ServerMapping = {
          ...base,
          label: body?.label ?? base.label,
          enabled: body?.enabled ?? base.enabled,
          sqlTemplate: body?.sqlTemplate ?? null,
          valueColumn: body?.valueColumn ?? base.valueColumn,
          comparator: body?.comparator ?? base.comparator,
          threshold: body?.threshold ?? null,
          unitLabel: body?.unitLabel ?? null,
          bqLocation: body?.bqLocation ?? null,
        };
        if (idx >= 0) serverMappings[idx] = merged;
        else serverMappings.push(merged);
        serverUnmapped = serverUnmapped.filter((s) => s !== autoSource);
        return { status: 200, json: merged };
      },
    },
    // Global auto-source mappings read.
    {
      method: "GET",
      path: /\/api\/ris\/auto-mappings$/,
      json: () => {
        mappingsGetCount++;
        return {
          mappings: serverMappings.map((m) => ({ ...m })),
          unmapped: [...serverUnmapped],
        };
      },
    },
    { path: "/api/auth/user", json: () => currentUser },
    { path: "/api/ris/checks", json: [] },
    // Per-client binding read (the sibling panel also lives on the Setup view).
    {
      method: "GET",
      path: /\/api\/ris\/client-bindings\/[^/]+$/,
      json: {
        clientId: CLIENT.id,
        firmName: CLIENT.firmName,
        bigQueryClientKey: null,
        overrides: [],
      },
    },
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

// Toggle a native checkbox via a real click so React's onChange fires.
async function toggleCheckbox(testId: string): Promise<void> {
  const el = $(testId) as HTMLInputElement | null;
  assert(el !== null, `expected checkbox [data-testid="${testId}"] to exist`);
  await clickEl(el!);
}

// Pick a value in the shimmed <Select> by clicking its inline option.
async function selectOption(value: string): Promise<void> {
  const opt = document.querySelector(
    `[data-select-value="${value}"]`,
  ) as HTMLElement | null;
  assert(opt !== null, `expected a select option for "${value}"`);
  await clickEl(opt!);
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

function mappingPuts(source: string): RecordedCall[] {
  return calls.filter(
    (c) =>
      c.method === "PUT" &&
      new RegExp(`/api/ris/auto-mappings/${source}$`).test(c.url),
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_managerEditsExistingMapping(): Promise<void> {
  console.log("\n— Scenario 1: manager edits a configured mapping, save round-trips, badge flips —");
  currentUser = MANAGER_USER;
  resetServer();
  const root = await mountPage();
  try {
    assert($("card-auto-mappings") !== null, "manager must see the global mappings panel");
    const source = CONFIGURED_SOURCE;
    assert($(`mapping-${source}`) !== null, "the configured mapping row must render");
    assert(
      $(`mapping-${source}`)!.textContent!.includes("enabled"),
      "configured mapping starts as 'enabled'",
    );
    // Editor controls are hidden until the row is opened.
    assert(
      $(`input-mapping-valuecol-${source}`) === null,
      "mapping fields hidden until the row is opened",
    );

    await clickById(`button-edit-mapping-${source}`);
    assert(
      $(`input-mapping-valuecol-${source}`) !== null,
      "opening the row reveals the value-column input",
    );

    const getsBeforeSave = mappingsGetCount;
    await typeInto(`input-mapping-valuecol-${source}`, "booking_count");
    await typeInto(
      `input-mapping-sql-${source}`,
      "SELECT count(1) AS booking_count FROM bookings",
    );
    // Change the comparator via the shimmed <Select>.
    await selectOption("lte");
    // Turn Enabled off.
    await toggleCheckbox(`checkbox-mapping-enabled-${source}`);

    await clickById(`button-save-mapping-${source}`);

    const puts = mappingPuts(source);
    assert(puts.length === 1, `exactly one auto-mappings PUT expected — got ${puts.length}: ${JSON.stringify(puts)}`);
    assert(
      new RegExp(`/api/ris/auto-mappings/${source}$`).test(puts[0].url),
      `the PUT must hit the global auto-mappings route — got ${puts[0].url}`,
    );
    assert(
      puts[0].body?.valueColumn === "booking_count",
      `PUT must carry the edited value column — got ${JSON.stringify(puts[0].body)}`,
    );
    assert(
      puts[0].body?.sqlTemplate === "SELECT count(1) AS booking_count FROM bookings",
      `PUT must carry the edited SQL template — got ${JSON.stringify(puts[0].body)}`,
    );
    assert(
      puts[0].body?.comparator === "lte",
      `PUT must carry the edited comparator — got ${JSON.stringify(puts[0].body)}`,
    );
    assert(
      puts[0].body?.enabled === false,
      `PUT must carry the toggled-off enabled flag — got ${JSON.stringify(puts[0].body)}`,
    );

    // Persisted: the store kept the edits.
    const stored = serverMappings.find((m) => m.autoSource === source)!;
    assert(stored.valueColumn === "booking_count", `server must persist value column — got ${stored.valueColumn}`);
    assert(stored.comparator === "lte", `server must persist comparator — got ${stored.comparator}`);
    assert(stored.enabled === false, `server must persist enabled=false — got ${stored.enabled}`);

    // Saving must invalidate + re-fetch the mappings (not merely local state).
    assert(
      mappingsGetCount > getsBeforeSave,
      `saving must trigger a mappings re-fetch — GETs before=${getsBeforeSave}, after=${mappingsGetCount}`,
    );

    // UI reflects the saved state: editor closed, badge flipped to 'disabled'.
    assert(
      $(`input-mapping-valuecol-${source}`) === null,
      "the editor must close after a successful save",
    );
    assert(
      $(`mapping-${source}`)!.textContent!.includes("disabled"),
      "the row badge must read 'disabled' after toggling Enabled off and saving",
    );

    console.log("  ✓ one PUT with the edited fields; persisted, re-fetched, badge enabled → disabled");
  } finally {
    await unmount(root);
  }
}

async function scenario2_managerConfiguresUnmappedSource(): Promise<void> {
  console.log("\n— Scenario 2: manager configures a not-yet-mapped source; it promotes to enabled —");
  currentUser = MANAGER_USER;
  resetServer();
  const root = await mountPage();
  try {
    const source = UNMAPPED_SOURCE;
    assert($(`mapping-${source}`) !== null, "the unmapped source row must render");
    assert(
      $(`mapping-${source}`)!.textContent!.includes("not configured"),
      "an unmapped source starts as 'not configured'",
    );

    await clickById(`button-edit-mapping-${source}`);
    await typeInto(`input-mapping-valuecol-${source}`, "revenue");
    await typeInto(`input-mapping-sql-${source}`, "SELECT sum(amount) AS revenue FROM sales");
    await selectOption("gte");
    await typeInto(`input-mapping-threshold-${source}`, "1000");
    await toggleCheckbox(`checkbox-mapping-enabled-${source}`);

    await clickById(`button-save-mapping-${source}`);

    const puts = mappingPuts(source);
    assert(puts.length === 1, `exactly one auto-mappings PUT expected — got ${puts.length}`);
    assert(puts[0].body?.enabled === true, `PUT must enable the new mapping — got ${JSON.stringify(puts[0].body)}`);
    assert(
      puts[0].body?.valueColumn === "revenue",
      `PUT must carry the configured value column — got ${JSON.stringify(puts[0].body)}`,
    );
    assert(
      puts[0].body?.threshold === "1000",
      `PUT must carry the configured threshold — got ${JSON.stringify(puts[0].body)}`,
    );

    // Server promotes it out of `unmapped` and into `mappings`.
    assert(
      !serverUnmapped.includes(source),
      "server must drop the source from the unmapped list after configuring it",
    );
    assert(
      serverMappings.some((m) => m.autoSource === source && m.enabled),
      "server must hold the newly configured + enabled mapping",
    );

    // After re-fetch the row reads 'enabled' (no longer 'not configured').
    assert(
      $(`mapping-${source}`)!.textContent!.includes("enabled"),
      "after configuring + saving, the row badge must read 'enabled'",
    );
    assert(
      !$(`mapping-${source}`)!.textContent!.includes("not configured"),
      "the row must no longer read 'not configured'",
    );

    console.log("  ✓ configuring an unmapped source PUTs it enabled and promotes the badge to 'enabled'");
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
      $("card-auto-mappings") === null,
      "a non-manager must NOT see the global mappings panel",
    );
    assert(
      $("ris-setup-view") === null,
      "a non-manager must not land on the Setup view even with ?area=setup",
    );
    assert($("text-ris-title") !== null, "a non-manager falls back to the Overview portfolio");

    console.log("  ✓ non-manager is gated out of Setup and shown the Overview");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_managerEditsExistingMapping();
  await scenario2_managerConfiguresUnmappedSource();
  await scenario3_nonManagerCannotReachPanel();
  console.log("\nris-setup-auto-mappings: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
