/* test-registration
{
  "name": "RIS notification deep-links land on the right client/month/layer (Task #2542)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ris-deep-link-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2542 — Regression test for RIS escalation-notification deep-links.
 *
 * RIS escalation notifications deep-link into
 *   /ris?clientId=<id>&period=YYYY-MM   (optionally &layer=<qa|performance|engagement>)
 * `RisDashboard` parses these from the query string (qsClientId / qsPeriod /
 * qsLayer) so the notification lands on the RIGHT client checklist at the RIGHT
 * month and layer instead of silently defaulting to the current period / QA
 * layer. That parsing had no frontend coverage, so a refactor could quietly
 * route users to the wrong client or month. These scenarios mount the REAL
 * `RisDashboard` page inside a wouter `Route` (so `useParams` / `useLocation`
 * resolve from the jsdom location) and assert on both the rendered DOM and the
 * exact period the client-checklist endpoint is queried with:
 *
 *   1. /ris?clientId=<id>&period=2026-04 → the per-client deep dive renders
 *      (`text-client-name` for that client) AND the checklist is fetched with
 *      `period=2026-04`, not the current month.
 *   2. /ris?clientId=<id>&period=not-a-date → an invalid period is ignored and
 *      the deep dive falls back to the CURRENT period (the checklist is fetched
 *      with `period=<currentPeriod()>`), still rendering the right client.
 *   3. /ris?clientId=<id>&layer=performance → the Performance layer is selected
 *      on load: the performance body renders (`text-client-name-perf`), the
 *      Performance tab is active, and the performance endpoint is hit (not the
 *      QA checklist).
 *
 * `RisDashboard` pulls in only lucide-react + local UI components (no
 * `@uppy/*` / `maplibre-gl` side-effects), so it needs no module-resolution
 * loader — just the jsdom + fetch shim below.
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

// Mirror RisDashboard.currentPeriod() so the fallback assertion is date-stable
// regardless of when the suite runs.
function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Stub fetch — answers the endpoints the per-client deep dive hits on mount and
// records the period each checklist / performance request carried so we can
// prove the deep-linked (or fallback) period actually reached the query.
// ---------------------------------------------------------------------------

const adminUser = {
  id: "user-admin-2542",
  email: "admin@test.local",
  firstName: "Ada",
  lastName: "Admin",
  role: "ceo",
  authorityLevel: "ceo",
};

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

const DEEP_DIVE_CLIENT_ID = "client-deep-dive-2542";
const DEEP_DIVE_FIRM = "Deep Dive Firm 2542";

// Records the `period` query param for each endpoint the deep dive calls.
let checklistPeriods: string[] = [];
let performancePeriods: string[] = [];

function periodFromUrl(url: string): string | null {
  const q = url.indexOf("?");
  if (q < 0) return null;
  return new URLSearchParams(url.slice(q + 1)).get("period");
}

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: adminUser },
    // Performance layer per-client pull.
    {
      path: `/api/ris/performance/clients/${DEEP_DIVE_CLIENT_ID}`,
      respond: (ctx: any) => {
        const p = periodFromUrl(ctx.url);
        if (p) performancePeriods.push(p);
        return {
          status: 200,
          json: {
            client: { id: DEEP_DIVE_CLIENT_ID, firmName: DEEP_DIVE_FIRM },
            period: p ?? currentPeriod(),
            products: [],
            cards: [],
          },
        };
      },
    },
    // QA / engagement per-client checklist pull.
    {
      path: `/api/ris/clients/${DEEP_DIVE_CLIENT_ID}`,
      respond: (ctx: any) => {
        const p = periodFromUrl(ctx.url);
        if (p) checklistPeriods.push(p);
        return {
          status: 200,
          json: {
            client: { id: DEEP_DIVE_CLIENT_ID, firmName: DEEP_DIVE_FIRM },
            period: p ?? currentPeriod(),
            rollup: zeroRollup,
            instances: [],
          },
        };
      },
    },
    {
      path: "/api/ris/portfolio",
      json: () => ({ period: currentPeriod(), clients: [], totals: zeroRollup }),
    },
    {
      path: "/api/ris/performance",
      json: () => ({ period: currentPeriod(), clients: [] }),
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

// The deep dive resolves its clientId from the `?clientId=` query string, so
// every scenario mounts the bare `/ris` route and varies window.location.search.
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
// Scenario 1: valid deep-link period lands on the right client AND month.
// ---------------------------------------------------------------------------

async function scenarioValidPeriod(): Promise<void> {
  console.log("\n— Scenario 1: /ris?clientId=…&period=2026-04 → deep dive at that client + month —");

  checklistPeriods = [];
  const deepLinkPeriod = "2026-04";
  // Pick a period that is NOT the current month so a regression to the default
  // would be caught.
  assert(deepLinkPeriod !== currentPeriod(), "fixture period must differ from current");

  setLocation(`/ris?clientId=${DEEP_DIVE_CLIENT_ID}&period=${deepLinkPeriod}`);
  const root = await mountAt("/ris");
  try {
    const nameEl = $("text-client-name");
    assert(nameEl !== null, "deep link must render the per-client deep dive");
    assert(
      nameEl!.textContent?.includes(DEEP_DIVE_FIRM),
      `deep dive must show the deep-linked client (got '${nameEl!.textContent}')`,
    );
    assert(
      checklistPeriods.includes(deepLinkPeriod),
      `checklist must be fetched with the deep-linked period (saw ${JSON.stringify(checklistPeriods)})`,
    );
    assert(
      !checklistPeriods.includes(currentPeriod()),
      `checklist must NOT fall back to the current period (saw ${JSON.stringify(checklistPeriods)})`,
    );
    console.log(`  ✓ Deep dive rendered for ${DEEP_DIVE_FIRM} at period ${deepLinkPeriod}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: an invalid period is ignored → falls back to the current period.
// ---------------------------------------------------------------------------

async function scenarioInvalidPeriodFallsBack(): Promise<void> {
  console.log("\n— Scenario 2: /ris?clientId=…&period=not-a-date → falls back to current period —");

  checklistPeriods = [];
  setLocation(`/ris?clientId=${DEEP_DIVE_CLIENT_ID}&period=not-a-date`);
  const root = await mountAt("/ris");
  try {
    const nameEl = $("text-client-name");
    assert(nameEl !== null, "invalid period must still render the deep dive client");
    assert(
      checklistPeriods.includes(currentPeriod()),
      `invalid period must fall back to the current period (saw ${JSON.stringify(checklistPeriods)})`,
    );
    assert(
      !checklistPeriods.includes("not-a-date"),
      `the bogus period must never reach the query (saw ${JSON.stringify(checklistPeriods)})`,
    );
    console.log(`  ✓ Invalid period ignored; fell back to ${currentPeriod()}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: ?layer=performance selects the Performance layer on load.
// ---------------------------------------------------------------------------

async function scenarioLayerDeepLink(): Promise<void> {
  console.log("\n— Scenario 3: /ris?clientId=…&layer=performance → Performance layer on load —");

  checklistPeriods = [];
  performancePeriods = [];
  setLocation(`/ris?clientId=${DEEP_DIVE_CLIENT_ID}&layer=performance`);
  const root = await mountAt("/ris");
  try {
    assert(
      $("text-client-name-perf") !== null,
      "?layer=performance must render the performance body on load",
    );
    assert(
      performancePeriods.length > 0,
      `?layer=performance must hit the performance endpoint (saw ${JSON.stringify(performancePeriods)})`,
    );
    assert(
      checklistPeriods.length === 0,
      `?layer=performance must NOT hit the QA checklist endpoint (saw ${JSON.stringify(checklistPeriods)})`,
    );
    // The Performance tab is the active one in the layer switcher.
    const perfTab = $("tab-layer-performance");
    assert(perfTab !== null, "the layer switcher renders a Performance tab");
    assert(
      // Task #4662 moved the active-layer tab from bg-white to the bg-card token.
      (perfTab!.className || "").includes("bg-card"),
      `the Performance tab must be the active layer (className='${perfTab!.className}')`,
    );
    const qaTab = $("tab-layer-qa");
    assert(
      qaTab !== null && !(qaTab.className || "").includes("bg-card"),
      "the QA tab must NOT be active when ?layer=performance",
    );
    console.log("  ✓ Performance layer selected from the ?layer= deep link");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioValidPeriod();
  await scenarioInvalidPeriodFallsBack();
  await scenarioLayerDeepLink();
  console.log("\nris-deep-link: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
