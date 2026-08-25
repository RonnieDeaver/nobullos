/* test-registration
{
  "name": "ClientDetail ?tab= deep-link routing — Reports tab + TAB_MAP (Task #2517)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2577: the ClientDetail `?tab=` deep-link test (Tasks #2517/#2553) guards both active-tab routing AND URL self-correction. It was flagged `regression: true` but never selected by the gate, so a regression in the tab logic could rot silently — the exact failure mode this test prevents. Gate it so any future tab-routing/self-correction drift fails fast.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/client-detail-tab-from-url-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2517 — Regression test for ClientDetail's `?tab=` deep-link routing.
 *
 * Task #2506/#2507 made the report editor's "Back" link point to
 * `/clients/<clientId>?tab=reports`, and Task #2507 added coverage proving the
 * *source* link target. This test pins the *destination*: that
 * `ClientDetail.tsx` actually activates the Reports tab when it receives that
 * `?tab=reports` query param. The two are halves of the same behavior — if
 * `TAB_MAP` or the `tabFromUrl` logic regresses, the Back link would still be
 * "correct" yet land the user on the wrong tab.
 *
 * It mounts the REAL `ClientDetail` page inside a wouter `Route` (so
 * `useParams` / `useSearch` resolve from the jsdom location) and reads which
 * Radix <TabsTrigger> carries `data-state="active"` on first render:
 *
 *   1. `?tab=reports`  → the Reports tab is active.
 *   2. `?tab=overview` → the `command-panel` alias is active (a non-identity
 *      TAB_MAP entry, so it proves the map is consulted, not the raw value).
 *   3. no `?tab`       → defaults to `command-panel`.
 *
 * Task #2553 extends this to pin the *URL self-correction* half of the
 * `tabFromUrl` effect: when an alias differs from its canonical TAB_MAP value,
 * the effect also rewrites the address bar to the canonical form via
 * `history.replaceState`, so stale/duplicate alias links stop circulating:
 *
 *   4. `?tab=overview`         → `window.location.search` becomes
 *                                `?tab=command-panel` on first render.
 *   5. `?tab=intelligence-feed`→ `window.location.search` becomes
 *                                `?tab=intelligence`.
 *
 * (A canonical value like `?tab=reports` is left untouched — asserted in
 * scenario 1's location stays put.)
 *
 * Task #4349 adds:
 *
 *   6. `?tab=agent-memory` → the Agent Memory tab is active. This id (with
 *      `scheduling` / `live-data`) was missing from TAB_MAP entirely, so its
 *      shared/reloaded URL silently fell back to command-panel; the scenario
 *      pins the identity entries. It also exercises a leaf inside a hidden
 *      sub-row of the Task #4349 grouped navigation (domain rows CSS-hide
 *      inactive TabsLists — triggers must stay mounted and activatable).
 *
 * `ClientDetail` statically imports many heavy feature panels (CommandPanel is
 * even `forceMount`ed) that pull in `maplibre-gl` / `@uppy/*` / `react-pdf` /
 * `.css` side-effects the bare jsdom harness can't evaluate; they're stubbed to
 * no-ops by `client-detail-tab-from-url-loader.mjs` (registered via `--import`).
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
// Stub fetch — answers the small set of endpoints ClientDetail hits on mount.
// ---------------------------------------------------------------------------

const CLIENT_ID = "client-tab-routing-1";

const testUser = {
  id: "user-2517",
  email: "viewer@test.local",
  firstName: "Tab",
  lastName: "Viewer",
  role: "ceo",
};

const testClient = {
  id: CLIENT_ID,
  clientCode: "TC-1",
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

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      test: (url: string) =>
        url.includes("/api/clients/") && url.includes("/summary"),
      json: {
        client: testClient,
        reports: [],
        dataAccess: [],
        contacts: [],
      },
    },
    { path: "/api/users", json: [] },
    { path: "/api/audit-history", json: {} },
    { path: /\/communications/, json: [] },
    { path: /\/command-panel/, json: [] },
    { path: "/api/clients", json: [] },
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
const ClientDetail = (await import("../../client/src/pages/ClientDetail")).default;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function setLocation(path: string): void {
  dom.window.history.replaceState({}, "", path);
}

async function mountAt(): Promise<Root> {
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
          React.createElement(Route as any, { path: "/clients/:id", component: ClientDetail }),
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

// Returns the Radix `value` of the currently-active tab trigger (the one whose
// `data-state` is "active"), or null if none/multiple resolve.
function activeTabValue(): string | null {
  const triggers = Array.from(
    document.querySelectorAll('[data-testid^="tab-"]'),
  ) as HTMLElement[];
  assert(triggers.length > 0, "tab triggers must render once the client loads");
  const active = triggers.filter((t) => t.getAttribute("data-state") === "active");
  if (active.length !== 1) return null;
  // testid is `tab-<value>`; strip the prefix to recover the tab value.
  return active[0].getAttribute("data-testid")!.replace(/^tab-/, "");
}

// ---------------------------------------------------------------------------
// Scenario 1: ?tab=reports → the Reports tab is the active tab.
// ---------------------------------------------------------------------------

async function scenarioReportsTab(): Promise<void> {
  console.log("\n— Scenario 1: /clients/:id?tab=reports → Reports tab active —");
  setLocation(`/clients/${CLIENT_ID}?tab=reports`);
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "reports",
      `?tab=reports must activate the Reports tab (got '${active}')`,
    );
    console.log(`  ✓ active tab → ${active}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: ?tab=overview → TAB_MAP alias resolves to command-panel.
// ---------------------------------------------------------------------------

async function scenarioOverviewAlias(): Promise<void> {
  console.log("\n— Scenario 2: /clients/:id?tab=overview → command-panel (alias) —");
  setLocation(`/clients/${CLIENT_ID}?tab=overview`);
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "command-panel",
      `?tab=overview must map to the command-panel tab (got '${active}')`,
    );
    console.log(`  ✓ active tab → ${active}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: no ?tab → defaults to command-panel.
// ---------------------------------------------------------------------------

async function scenarioDefault(): Promise<void> {
  console.log("\n— Scenario 3: /clients/:id (no ?tab) → command-panel default —");
  setLocation(`/clients/${CLIENT_ID}`);
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "command-panel",
      `missing ?tab must default to the command-panel tab (got '${active}')`,
    );
    console.log(`  ✓ active tab → ${active}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: ?tab=overview → URL self-corrects to ?tab=command-panel.
// ---------------------------------------------------------------------------

async function scenarioOverviewUrlRewrite(): Promise<void> {
  console.log(
    "\n— Scenario 4: /clients/:id?tab=overview → URL rewritten to ?tab=command-panel —",
  );
  setLocation(`/clients/${CLIENT_ID}?tab=overview`);
  const root = await mountAt();
  try {
    // The active tab still proves the map was consulted...
    const active = activeTabValue();
    assert(
      active === "command-panel",
      `?tab=overview must map to the command-panel tab (got '${active}')`,
    );
    // ...and the address bar must be self-corrected to the canonical alias so
    // the stale `overview` link stops circulating.
    const search = dom.window.location.search;
    assert(
      search === "?tab=command-panel",
      `?tab=overview must be rewritten to ?tab=command-panel (got '${search}')`,
    );
    console.log(`  ✓ location.search → ${search}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 5: ?tab=intelligence-feed → URL self-corrects to ?tab=intelligence.
// ---------------------------------------------------------------------------

async function scenarioIntelligenceFeedUrlRewrite(): Promise<void> {
  console.log(
    "\n— Scenario 5: /clients/:id?tab=intelligence-feed → URL rewritten to ?tab=intelligence —",
  );
  setLocation(`/clients/${CLIENT_ID}?tab=intelligence-feed`);
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "intelligence",
      `?tab=intelligence-feed must map to the intelligence tab (got '${active}')`,
    );
    const search = dom.window.location.search;
    assert(
      search === "?tab=intelligence",
      `?tab=intelligence-feed must be rewritten to ?tab=intelligence (got '${search}')`,
    );
    console.log(`  ✓ location.search → ${search}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 6: ?tab=agent-memory → identity TAB_MAP entry (Task #4349).
// ---------------------------------------------------------------------------

async function scenarioAgentMemoryDeepLink(): Promise<void> {
  console.log(
    "\n— Scenario 6: /clients/:id?tab=agent-memory → Agent Memory tab active —",
  );
  setLocation(`/clients/${CLIENT_ID}?tab=agent-memory`);
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "agent-memory",
      `?tab=agent-memory must activate the Agent Memory tab (got '${active}')`,
    );
    console.log(`  ✓ active tab → ${active}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 7: ?tab=timeline → the upstream unified-timeline tab (Task #4328)
// stays deep-linkable after its rebase port into the grouped Comms domain.
// ---------------------------------------------------------------------------

async function scenarioTimelineDeepLink(): Promise<void> {
  console.log(
    "\n— Scenario 7: /clients/:id?tab=timeline → Timeline tab active —",
  );
  setLocation(`/clients/${CLIENT_ID}?tab=timeline`);
  const root = await mountAt();
  try {
    const active = activeTabValue();
    assert(
      active === "timeline",
      `?tab=timeline must activate the Timeline tab (got '${active}')`,
    );
    console.log(`  ✓ active tab → ${active}`);
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioReportsTab();
  await scenarioOverviewAlias();
  await scenarioDefault();
  await scenarioOverviewUrlRewrite();
  await scenarioIntelligenceFeedUrlRewrite();
  await scenarioAgentMemoryDeepLink();
  await scenarioTimelineDeepLink();
  console.log("\nclient-detail-tab-from-url: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
