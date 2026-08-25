/* test-registration
{
  "name": "RIS layer switcher (QA / Performance / Engagement) \u2014 portfolio + deep dive (Task #2541)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ris-layer-switch-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2541 — Regression test for the RIS layer switcher
 * (QA / Performance / Engagement).
 *
 * Task #2371 added a Performance layer and Task #2388 an Engagement layer to the
 * RIS dashboard (`RisDashboard.tsx`), reached through the LayerSwitcher
 * (`switcher-ris-layer` / `tab-layer-*`). Each layer changes BOTH which endpoint
 * the view loads and how status is presented:
 *
 *   - QA          → the standard checklist / portfolio rollup (Pass / Fail / …)
 *   - Performance → Product Health Cards (`card-product-health-*` /
 *                   `badge-perf-*`) backed by `/api/ris/performance/*`
 *   - Engagement  → the SAME checklist endpoint as QA but status is mapped onto
 *                   the Green / Yellow / Red traffic light
 *                   (`ENGAGEMENT_STATUS_LABELS`).
 *
 * Task #2478's `ris-area-switch.test.tsx` only asserts the layer switcher is
 * *present* — it never clicks a layer, so a regression in the layer gating (e.g.
 * the `layer === "performance"` branch, or the engagement label mapping) could
 * ship unnoticed. These scenarios mount the REAL `RisDashboard` page inside a
 * wouter `Route` and assert that clicking each `tab-layer-*` swaps the rendered
 * content, on BOTH the portfolio (`/ris`) and a per-client deep dive
 * (`/ris/:clientId`):
 *
 *   1. Portfolio: QA shows the rollup (`stat-completion`); Performance swaps to
 *      the performance summary (`stat-perf-green` + `badge-perf-*`) and drops the
 *      rollup; Engagement returns to the rollup and fires the
 *      `layer=engagement` query.
 *   2. Deep dive: QA shows the checklist with the QA status label ("Pass");
 *      Performance swaps to Product Health Cards (`card-product-health-*` +
 *      `badge-perf-*`); Engagement shows the checklist with the traffic-light
 *      label ("Green") for the identical underlying status.
 *
 * `RisDashboard` pulls in only lucide-react + local UI components (no
 * `@uppy/*` / `maplibre-gl` side-effects), so it needs no module-resolution
 * loader — just the jsdom + fetch shim below (mirrors `ris-area-switch`).
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
// Stub fetch — answers the endpoints each RIS layer hits on mount. The portfolio
// + checklist endpoints carry `?layer=` (QA / Engagement share them); the
// Performance layer hits the dedicated `/api/ris/performance/*` endpoints.
// `fetchedUrls` records every request so a scenario can prove the layer swap
// changed the data source, not just the presentation.
// ---------------------------------------------------------------------------

const adminUser = {
  id: "user-admin-2541",
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

const DEEP_DIVE_CLIENT_ID = "client-deep-dive-2541";

// One checklist instance, reused for QA + Engagement deep dives. The SAME
// underlying `status: "pass"` renders "Pass" under QA and "Green" under
// Engagement — that mapping is exactly what this test guards.
const checklistInstance = {
  checkId: "chk-engagement-1",
  key: "engagement-touch",
  label: "Outbound touches",
  description: null,
  product: "universal",
  category: "client_engagement",
  frequency: "monthly",
  locationSpecific: false,
  autoSource: null,
  defaultSeverity: "medium",
  effectiveSeverity: "medium",
  defaultOwnerFunction: null,
  locationId: null,
  locationName: null,
  period: "2026-06",
  dueBucket: "month",
  resultId: "res-1",
  status: "pass",
  observedValue: null,
  notes: null,
  evidenceUrl: null,
  failureReason: null,
  correctiveAction: null,
  source: "manual",
  checkedBy: null,
  checkedByName: null,
  checkedAt: null,
  autoError: null,
  confirmedAt: null,
  confirmedBy: null,
  confirmedByName: null,
  cadence: null,
};

const perfMetric = {
  checkId: "m1",
  key: "ads-spend",
  label: "Spend",
  description: null,
  product: "google_ads",
  category: "spend_delivery",
  metricType: "cost",
  defaultSeverity: "medium",
  effectiveSeverity: "medium",
  defaultOwnerFunction: null,
  period: "2026-06",
  resultId: "r1",
  status: "green",
  observedValue: null,
  currentValue: "$100",
  previousValue: "$90",
  targetValue: null,
  changePct: "11.1",
  notes: null,
  source: "manual",
  autoError: null,
  checkedAt: null,
  confirmedAt: null,
};

const perfCounts = { green: 1, yellow: 0, red: 0, gray: 0, na: 0 };

const fetchedUrls: string[] = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  onCall: (ctx: any) => {
    fetchedUrls.push(ctx.url);
  },
  routes: [
    { path: "/api/auth/user", json: adminUser },
    // Per-client Performance layer — Product Health Cards.
    {
      path: `/api/ris/performance/clients/${DEEP_DIVE_CLIENT_ID}`,
      json: {
        client: { id: DEEP_DIVE_CLIENT_ID, firmName: "Deep Dive Firm" },
        products: ["google_ads"],
        period: "2026-06",
        cards: [
          {
            product: "google_ads",
            status: "green",
            counts: perfCounts,
            topSeverity: null,
            metrics: [perfMetric],
          },
        ],
      },
    },
    // Portfolio Performance layer.
    {
      path: "/api/ris/performance/portfolio",
      json: {
        period: "2026-06",
        clients: [
          {
            clientId: DEEP_DIVE_CLIENT_ID,
            firmName: "Deep Dive Firm",
            products: ["google_ads"],
            status: "green",
            counts: perfCounts,
            topSeverity: null,
          },
        ],
        totals: perfCounts,
      },
    },
    // Per-client deep dive checklist (QA + Engagement share this; layer in query).
    {
      path: `/api/ris/clients/${DEEP_DIVE_CLIENT_ID}`,
      json: {
        client: { id: DEEP_DIVE_CLIENT_ID, firmName: "Deep Dive Firm" },
        products: ["universal"],
        period: "2026-06",
        rollup: { ...zeroRollup, completionPct: 100, completed: 1, totalDue: 1, pass: 1 },
        instances: [checklistInstance],
      },
    },
    // Portfolio rollup (QA + Engagement share this; layer in query).
    {
      path: "/api/ris/portfolio",
      json: { period: "2026-06", clients: [], totals: zeroRollup },
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

async function clickLayer(layer: "qa" | "performance" | "engagement"): Promise<void> {
  const tab = $(`tab-layer-${layer}`) as HTMLButtonElement | null;
  assert(tab !== null, `layer tab '${layer}' must be present`);
  await act(async () => {
    tab!.click();
  });
  await flush();
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
// Scenario 1: portfolio layer switch — QA rollup → Performance cards → back to
// QA-style rollup under Engagement (with the layer=engagement query firing).
// ---------------------------------------------------------------------------

async function scenarioPortfolioLayerSwitch(): Promise<void> {
  console.log("\n— Scenario 1: /ris portfolio QA → Performance → Engagement —");

  setLocation("/ris");
  const root = await mountAt("/ris");
  try {
    // Default QA: the standard portfolio rollup.
    assert($("text-ris-title") !== null, "QA portfolio shows the RIS title");
    assert($("stat-completion") !== null, "QA portfolio shows the rollup completion stat");
    assert($("stat-perf-green") === null, "QA portfolio must NOT show the performance summary");
    assert(
      fetchedUrls.some((u) => u.includes("/api/ris/portfolio") && u.includes("layer=qa")),
      "QA portfolio must query the rollup endpoint with layer=qa",
    );

    // Performance: swaps to the performance summary + perf status badges.
    await clickLayer("performance");
    assert($("stat-perf-green") !== null, "Performance portfolio shows the perf summary stat");
    assert($("badge-perf-green") !== null, "Performance portfolio shows a perf status badge");
    assert(
      $("stat-completion") === null,
      "Performance portfolio must drop the QA rollup completion stat",
    );
    assert(
      fetchedUrls.some((u) => u.startsWith("/api/ris/performance/portfolio")),
      "Performance portfolio must query /api/ris/performance/portfolio",
    );

    // Engagement: returns to the rollup presentation, fired with layer=engagement.
    await clickLayer("engagement");
    assert(
      $("stat-completion") !== null,
      "Engagement portfolio returns to the rollup completion stat",
    );
    assert(
      $("stat-perf-green") === null,
      "Engagement portfolio must NOT show the performance summary",
    );
    assert(
      fetchedUrls.some(
        (u) => u.includes("/api/ris/portfolio") && u.includes("layer=engagement"),
      ),
      "Engagement portfolio must query the rollup endpoint with layer=engagement",
    );
    console.log("  ✓ Portfolio QA / Performance / Engagement all switched");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: deep dive layer switch — QA "Pass" label → Performance Product
// Health Cards → Engagement "Green" traffic-light label (same status).
// ---------------------------------------------------------------------------

async function scenarioDeepDiveLayerSwitch(): Promise<void> {
  console.log("\n— Scenario 2: /ris/:clientId deep dive QA → Performance → Engagement —");

  setLocation(`/ris/${DEEP_DIVE_CLIENT_ID}`);
  const root = await mountAt("/ris/:clientId");
  try {
    // Default QA: the checklist with the QA status label.
    assert($("text-client-name") !== null, "QA deep dive shows the client checklist header");
    const qaStatus = $("status-engagement-touch");
    assert(qaStatus !== null, "QA deep dive shows the instance status pill");
    assert(
      (qaStatus!.textContent ?? "").includes("Pass"),
      `QA deep dive labels status 'Pass' (got '${qaStatus!.textContent}')`,
    );
    assert(
      $("card-product-health-google_ads") === null,
      "QA deep dive must NOT show Product Health Cards",
    );

    // Performance: Product Health Cards with a perf badge.
    await clickLayer("performance");
    assert(
      $("card-product-health-google_ads") !== null,
      "Performance deep dive shows a Product Health Card",
    );
    assert($("badge-perf-green") !== null, "Performance deep dive shows a perf status badge");
    assert(
      $("status-engagement-touch") === null,
      "Performance deep dive must NOT show the QA checklist instance",
    );
    assert(
      fetchedUrls.some((u) =>
        u.startsWith(`/api/ris/performance/clients/${DEEP_DIVE_CLIENT_ID}`),
      ),
      "Performance deep dive must query the performance client endpoint",
    );

    // Engagement: SAME checklist, but the identical 'pass' status now reads
    // "Green" via the traffic-light mapping.
    await clickLayer("engagement");
    const engStatus = $("status-engagement-touch");
    assert(engStatus !== null, "Engagement deep dive shows the instance status pill again");
    assert(
      (engStatus!.textContent ?? "").includes("Green"),
      `Engagement deep dive labels status 'Green' (got '${engStatus!.textContent}')`,
    );
    assert(
      $("card-product-health-google_ads") === null,
      "Engagement deep dive must NOT show Product Health Cards",
    );
    assert(
      fetchedUrls.some(
        (u) =>
          u.startsWith(`/api/ris/clients/${DEEP_DIVE_CLIENT_ID}`) &&
          u.includes("layer=engagement"),
      ),
      "Engagement deep dive must query the checklist endpoint with layer=engagement",
    );
    console.log("  ✓ Deep dive QA 'Pass' / Performance cards / Engagement 'Green' all switched");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioPortfolioLayerSwitch();
  await scenarioDeepDiveLayerSwitch();
  console.log("\nris-layer-switch: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
