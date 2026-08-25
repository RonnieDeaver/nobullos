/* test-registration
{
  "name": "RIS Overview/Setup area switcher + manage gating (Task #2478)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ris-area-switch-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2478 — Regression test for the RIS Overview / Setup area switcher.
 *
 * Task #2462 added an Overview vs Setup area switcher to the RIS dashboard
 * (`RisDashboard.tsx`). It is:
 *   - gated behind manage permission (`canManage` — role ceo / team_lead or
 *     authorityLevel lead / director / ceo), and
 *   - reflected in the URL as `?area=setup` so the view is linkable / refresh-
 *     safe.
 *
 * There was no frontend component coverage for this navigation, so a refactor
 * of the gating or the URL sync could silently regress it — most dangerously by
 * letting a non-admin reach the Setup configuration cards. These scenarios mount
 * the REAL `RisDashboard` page inside a wouter `Route` (so `useParams` /
 * `useLocation` resolve from the jsdom location) and assert on the rendered DOM:
 *
 *   1. Admin (canManage) on `/ris` sees the area tabs
 *      (`switcher-ris-area` / `tab-area-setup`); clicking Setup renders the
 *      Setup view (`ris-setup-view`) and pushes `?area=setup` into the URL.
 *   2. Non-admin on `/ris?area=setup` never sees the Setup tab and falls back to
 *      the Overview portfolio (`text-ris-title`, no `ris-setup-view`).
 *   3. The per-client deep dive (`/ris/:clientId`) is unaffected — it renders
 *      the client checklist (`text-client-name`) with the layer switcher
 *      (`switcher-ris-layer`) and shows no area tabs at all.
 *
 * `RisDashboard` pulls in only lucide-react + local UI components (no
 * `@uppy/*` / `maplibre-gl` side-effects), so unlike the report-editor test it
 * needs no module-resolution loader — just the jsdom + fetch shim below.
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Stub fetch — answers the endpoints RisDashboard's views hit on mount.
// `currentUser` is swapped per scenario to drive the canManage gate.
// ---------------------------------------------------------------------------

const adminUser = {
  id: "user-admin-2478",
  email: "admin@test.local",
  firstName: "Ada",
  lastName: "Admin",
  role: "ceo",
  authorityLevel: "ceo",
};

const plainUser = {
  id: "user-plain-2478",
  email: "sales@test.local",
  firstName: "Sam",
  lastName: "Sales",
  role: "account_manager",
  authorityLevel: "core",
};

let currentUser: any = adminUser;

const zeroRollup = {
  totalDue: 0,
  completed: 0,
  completionPct: 0,
  pass: 0,
  fail: 0,
  na: 0,
  blocked: 0,
  needsReview: 0,
  untouched: 0,
  openFails: 0,
  openBlocked: 0,
  topSeverity: null,
  dueThisWeek: 0,
  dueThisMonth: 0,
  launchDue: 0,
};

const DEEP_DIVE_CLIENT_ID = "client-deep-dive-2478";

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      path: "/api/auth/user",
      respond: () =>
        currentUser ? { status: 200, json: currentUser } : { status: 401, json: {} },
    },
    // Per-client deep dive checklist.
    {
      path: `/api/ris/clients/${DEEP_DIVE_CLIENT_ID}`,
      json: {
        client: { id: DEEP_DIVE_CLIENT_ID, firmName: "Deep Dive Firm" },
        period: "2026-06",
        rollup: zeroRollup,
        instances: [],
      },
    },
    // Portfolio overview rollup.
    {
      path: "/api/ris/portfolio",
      json: { period: "2026-06", clients: [], totals: zeroRollup },
    },
    { path: "/api/ris/performance", json: { period: "2026-06", clients: [] } },
    // Setup-view sub-panels (catalog / mappings / binding client list).
    { path: "/api/ris/checks", json: [] },
    { path: "/api/ris/auto-mappings", json: { mappings: [], unmapped: [] } },
    { path: "/api/ris/client-bindings", json: {} },
    // Binding panel's client picker pulls the global client list.
    {
      test: (url: string) =>
        url === "/api/clients" || url.startsWith("/api/clients?"),
      json: [],
    },
    { path: "/api/notifications", json: [] },
  ],
  // Default: empty 200 so incidental requests don't error the page.
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router, Route } = await import("wouter");
const RisDashboard = (await import("../../client/src/pages/RisDashboard")).default;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

function setLocation(path: string): void {
  dom.window.history.replaceState({}, "", path);
}

async function mountAt(routePath: string): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  const qc = makeClient();
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(
          Router as any,
          null,
          React.createElement(Route as any, { path: routePath, component: RisDashboard }),
        ),
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
  dom.window.localStorage.clear();
}

// ---------------------------------------------------------------------------
// Scenario 1: admin sees the area tabs and can switch to Setup (URL syncs).
// ---------------------------------------------------------------------------

async function scenarioAdminSwitchToSetup(): Promise<void> {
  console.log("\n— Scenario 1: admin /ris → area tabs + click Setup → ris-setup-view + ?area=setup —");

  currentUser = adminUser;
  setLocation("/ris");
  const root = await mountAt("/ris");
  try {
    assert($("switcher-ris-area") !== null, "admin must see the area switcher");
    assert($("tab-area-setup") !== null, "admin must see the Setup tab");
    assert($("tab-area-overview") !== null, "admin must see the Overview tab");
    assert($("ris-setup-view") === null, "Setup view must not show before the tab is clicked");
    assert($("text-ris-title") !== null, "Overview portfolio title shows by default");

    await act(async () => {
      ($("tab-area-setup") as HTMLButtonElement).click();
    });
    await flush();

    assert($("ris-setup-view") !== null, "clicking Setup must render the Setup view");
    assert(
      dom.window.location.search.includes("area=setup"),
      `URL must carry ?area=setup after clicking Setup (got '${dom.window.location.search}')`,
    );
    // The configuration cards live inside the Setup view.
    assert($("card-auto-mappings") !== null, "Setup view shows the auto-mappings card");
    console.log(`  ✓ Setup view rendered; URL search = ${dom.window.location.search}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: non-admin never sees Setup and ?area=setup falls back to Overview.
// ---------------------------------------------------------------------------

async function scenarioNonAdminGatedOut(): Promise<void> {
  console.log("\n— Scenario 2: non-admin /ris?area=setup → no Setup tab, falls back to Overview —");

  currentUser = plainUser;
  setLocation("/ris?area=setup");
  const root = await mountAt("/ris");
  try {
    assert($("switcher-ris-area") === null, "non-admin must NOT see the area switcher");
    assert($("tab-area-setup") === null, "non-admin must NOT see the Setup tab");
    assert(
      $("ris-setup-view") === null,
      "non-admin must NOT reach the Setup view even with ?area=setup",
    );
    assert(
      $("text-ris-title") !== null,
      "non-admin with ?area=setup falls back to the Overview portfolio",
    );
    console.log("  ✓ Setup gated out; Overview rendered for non-admin");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: per-client deep dive is unaffected (checklist + layer switcher,
// no area tabs).
// ---------------------------------------------------------------------------

async function scenarioDeepDiveUnaffected(): Promise<void> {
  console.log("\n— Scenario 3: /ris/:clientId deep dive → checklist + layer switcher, no area tabs —");

  currentUser = adminUser;
  setLocation(`/ris/${DEEP_DIVE_CLIENT_ID}`);
  const root = await mountAt("/ris/:clientId");
  try {
    assert($("text-client-name") !== null, "deep dive must render the client checklist header");
    assert(
      $("switcher-ris-layer") !== null,
      "deep dive keeps the layer switcher",
    );
    assert(
      $("switcher-ris-area") === null,
      "deep dive must NOT show the Overview/Setup area tabs",
    );
    assert($("ris-setup-view") === null, "deep dive must not render the Setup view");
    console.log("  ✓ Deep dive renders checklist + layer switcher, no area tabs");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioAdminSwitchToSetup();
  await scenarioNonAdminGatedOut();
  await scenarioDeepDiveUnaffected();
  console.log("\nris-area-switch: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
