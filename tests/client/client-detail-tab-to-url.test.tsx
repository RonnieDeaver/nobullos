/* test-registration
{
  "name": "ClientDetail tab click rewrites ?tab= URL (Task #2552)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/client-detail-tab-to-url-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2552 — Regression test for ClientDetail's `?tab=` URL *write* path.
 *
 * Task #2517 proved the *read* half of the round-trip: ClientDetail opens the
 * correct tab when it receives a `?tab=` deep link. This test pins the other
 * half — when a user *clicks* a tab, `handleTabChange` rewrites the URL's
 * `?tab=` param via `history.replaceState` so the link stays shareable and
 * survives a refresh. If that regresses, copying the URL or refreshing would
 * silently drop the viewer back on the default (command-panel) tab.
 *
 * It mounts the REAL `ClientDetail` page inside a wouter `Route`, dispatches a
 * left-button `mousedown` on a non-default Radix <TabsTrigger> (Radix activates
 * tabs on mousedown in automatic mode), and asserts `window.location.search`
 * became `?tab=<value>`:
 *
 *   1. click `tab-reports`  → `?tab=reports`.
 *   2. click `tab-billing`  → `?tab=billing` (a second, distinct tab proves the
 *      handler is not hardcoded to one value).
 *   3. Task #5010: the header "Reports" quick action (a plain Button — it
 *      activates on click, not mousedown) sets `?tab=reports` AND activates
 *      the Reports tab, so the one-click path can't silently regress into the
 *      old two-click Performance → Reports detour. Same mount also pins the
 *      Overview empty-state hint (no reports → link toward report creation).
 *   4. Task #5010: with a report in the summary payload, the Overview
 *      latest-report card renders (Preview deep link for a non-final report)
 *      and its "See all reports" jump also rewrites the URL to `?tab=reports`.
 *
 * ClientDetail statically imports many heavy feature panels (CommandPanel is
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

const CLIENT_ID = "client-tab-write-1";

const testUser = {
  id: "user-2552",
  email: "viewer@test.local",
  firstName: "Tab",
  lastName: "Writer",
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

// Task #5010 — scenarios 1-3 run with an empty reports list (exercises the
// Overview card's no-reports hint); scenario 4 flips `summaryReports` to a
// single non-final report to exercise the latest-report quick-access card.
const testReport = {
  id: "report-5010",
  clientId: CLIENT_ID,
  reportMonth: "2026-07",
  status: "draft",
  shareToken: null,
  presentedAt: null,
};

let summaryReports: Array<typeof testReport> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      test: (url: string) =>
        url.includes("/api/clients/") && url.includes("/summary"),
      json: () => ({
        client: testClient,
        reports: summaryReports,
        dataAccess: [],
        contacts: [],
      }),
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

// Radix Tabs activate on a left-button mousedown (automatic activation mode).
// Dispatch a bubbling mousedown so React's delegated handler on the root fires.
async function clickTab(value: string): Promise<void> {
  const trigger = document.querySelector(
    `[data-testid="tab-${value}"]`,
  ) as HTMLElement | null;
  assert(!!trigger, `tab trigger 'tab-${value}' must be rendered`);
  await act(async () => {
    trigger!.dispatchEvent(
      new dom.window.MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
  await flush(5);
}

// Task #5010 — plain (non-Radix) buttons activate on a bubbling click.
async function clickButton(testId: string): Promise<void> {
  const el = document.querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLElement | null;
  assert(!!el, `element '${testId}' must be rendered`);
  await act(async () => {
    el!.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
  await flush(5);
}

// ---------------------------------------------------------------------------
// Scenario 1: clicking Reports rewrites the URL to ?tab=reports.
// ---------------------------------------------------------------------------

async function scenarioClickReports(): Promise<void> {
  console.log("\n— Scenario 1: click Reports tab → ?tab=reports —");
  setLocation(`/clients/${CLIENT_ID}`);
  const root = await mountAt();
  try {
    // Sanity: with no ?tab the URL starts clean.
    assert(
      !dom.window.location.search.includes("tab="),
      `URL must start without a ?tab param (got '${dom.window.location.search}')`,
    );
    await clickTab("reports");
    assert(
      dom.window.location.search === "?tab=reports",
      `clicking Reports must set ?tab=reports (got '${dom.window.location.search}')`,
    );
    console.log(`  ✓ window.location.search → ${dom.window.location.search}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: clicking Billing rewrites the URL to ?tab=billing.
// Proves the handler reflects the clicked tab, not a hardcoded value.
// ---------------------------------------------------------------------------

async function scenarioClickBilling(): Promise<void> {
  console.log("\n— Scenario 2: click Billing tab → ?tab=billing —");
  setLocation(`/clients/${CLIENT_ID}`);
  const root = await mountAt();
  try {
    await clickTab("billing");
    assert(
      dom.window.location.search === "?tab=billing",
      `clicking Billing must set ?tab=billing (got '${dom.window.location.search}')`,
    );
    console.log(`  ✓ window.location.search → ${dom.window.location.search}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 (Task #5010): the header "Reports" quick action activates the
// Reports tab in ONE click and rewrites the URL to ?tab=reports. Also pins
// the Overview quick-access element's empty state (summary has no reports).
// ---------------------------------------------------------------------------

async function scenarioHeaderQuickLink(): Promise<void> {
  console.log("\n— Scenario 3: header Reports quick action → ?tab=reports —");
  setLocation(`/clients/${CLIENT_ID}`);
  const root = await mountAt();
  try {
    // Default view, no reports in the summary: the Overview quick-access card
    // renders the low-key creation hint instead of a dead card.
    assert(
      !!document.querySelector('[data-testid="text-no-reports-hint"]'),
      "Overview must show the no-reports hint when the summary has no reports",
    );
    const createLink = document.querySelector(
      '[data-testid="link-create-first-report"]',
    ) as HTMLElement | null;
    assert(!!createLink, "no-reports hint must link toward report creation");
    const createHref = createLink!.getAttribute("href") ?? "";
    assert(
      createHref.includes(`/reports/new?clientId=${CLIENT_ID}`),
      `create-first-report link must target /reports/new?clientId=${CLIENT_ID} (got '${createHref}')`,
    );

    await clickButton("button-quick-reports");
    assert(
      dom.window.location.search === "?tab=reports",
      `header quick link must set ?tab=reports (got '${dom.window.location.search}')`,
    );
    const trigger = document.querySelector('[data-testid="tab-reports"]');
    assert(
      trigger?.getAttribute("data-state") === "active",
      "Reports leaf tab must be active after the header quick link",
    );
    assert(
      !!document.querySelector('[data-testid="card-reports"]'),
      "Reports tab content (Monthly Reports card) must be rendered",
    );
    console.log(
      `  ✓ header quick link → ${dom.window.location.search} + Reports tab active`,
    );
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4 (Task #5010): with a report in the summary, the Overview
// latest-report card renders a direct Preview deep link (non-final report)
// and its "See all reports" jump also lands on ?tab=reports.
// ---------------------------------------------------------------------------

async function scenarioLatestReportCard(): Promise<void> {
  console.log("\n— Scenario 4: latest-report card + see-all jump —");
  summaryReports = [testReport];
  setLocation(`/clients/${CLIENT_ID}`);
  const root = await mountAt();
  try {
    const card = document.querySelector('[data-testid="card-latest-report"]');
    assert(!!card, "latest-report quick-access card must render on the default view");
    assert(
      (card!.textContent || "").includes("July 2026"),
      `card must name the most recent report month (got '${card!.textContent}')`,
    );
    const viewLink = document.querySelector(
      '[data-testid="button-view-latest-report"]',
    ) as HTMLElement | null;
    assert(!!viewLink, "latest-report card must expose a direct View/Preview link");
    const href = viewLink!.getAttribute("href") ?? "";
    assert(
      href.includes(`/preview/${testReport.id}`),
      `non-final report must deep-link to its preview (got '${href}')`,
    );
    assert(
      (viewLink!.textContent || "").includes("Preview"),
      "non-final report link must be labeled Preview",
    );

    await clickButton("button-see-all-reports");
    assert(
      dom.window.location.search === "?tab=reports",
      `see-all jump must set ?tab=reports (got '${dom.window.location.search}')`,
    );
    const trigger = document.querySelector('[data-testid="tab-reports"]');
    assert(
      trigger?.getAttribute("data-state") === "active",
      "Reports leaf tab must be active after the see-all jump",
    );
    console.log("  ✓ latest-report card renders + see-all jump lands on Reports");
  } finally {
    summaryReports = [];
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioClickReports();
  await scenarioClickBilling();
  await scenarioHeaderQuickLink();
  await scenarioLatestReportCard();
  console.log("\nclient-detail-tab-to-url: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
