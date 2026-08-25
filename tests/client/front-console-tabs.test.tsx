/* test-registration
{
  "name": "Front console tabs shell + KPI header (Task #1619)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2523: the Front admin console shell renders the largest, most refactor-prone client surface (5 tabs + KPI header + every tab child's mount-time query). It silently rotted for months because it was flagged `regression: true` but never selected by the gate — a KPI-header refactor changed the overview payload shape and nothing caught it. Gate it so any future shape/contract drift on the Front console fails fast. It is a fast, deterministic jsdom render (no DB, fully stubbed fetch).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-console-tabs-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #1619 — UI regression tests for the new Front admin console shell.
 *
 * After the 3,990-line FrontIntegration.tsx was refactored into a tabbed shell
 * with five tabs + a KPI header strip, three things must keep working:
 *
 *   1. Tab triggers `tab-front-{messages,filters,pipeline,recovery,jobs}` all
 *      render, and clicking each one swaps the visible `tabpanel-front-*`.
 *
 *   2. `?tab=<valid>` on load preselects the right tab; an unknown value falls
 *      back to Messages and a missing `?tab=` also lands on Messages.
 *
 *   3. The `FrontKpiHeader` renders all six `kpi-*` tiles (`kpi-total`,
 *      `kpi-matched`, `kpi-unmatched`, `kpi-match-rate`, `kpi-cursor-age`,
 *      `kpi-backlog-total`) when the `/console/overview` query resolves with
 *      a populated payload.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/front" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(dom.window.HTMLElement.prototype as any).hasPointerCapture =
  (dom.window.HTMLElement.prototype as any).hasPointerCapture || function () { return false; };
(dom.window.HTMLElement.prototype as any).releasePointerCapture =
  (dom.window.HTMLElement.prototype as any).releasePointerCapture || function () {};
(dom.window.HTMLElement.prototype as any).setPointerCapture =
  (dom.window.HTMLElement.prototype as any).setPointerCapture || function () {};
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
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
(globalThis as any).confirm = () => true;
(dom.window as any).confirm = () => true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fetch stub — returns minimal-but-valid payloads for every endpoint each
// tab's children may probe on mount. Unknown endpoints return `{}` (200) so
// that we never throw inside a sub-component during the smoke render.
// ---------------------------------------------------------------------------

const ADMIN_USER = {
  id: "admin-1619",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

const OVERVIEW_PAYLOAD = {
  connection: {
    connected: true,
    error: null,
    lastSyncError: null,
    lastSyncSuccess: new Date().toISOString(),
  },
  syncProgress: {
    isRunning: false,
    currentPage: 0,
    conversationsScanned: 0,
    conversationsKept: 0,
    conversationsFiltered: 0,
    startedAt: null,
  },
  lastCycle: null,
  messages: {
    rawImportedTotal: 1234,
    rawMatched: 1000,
    rawUnmatched: 234,
    trackedTotal: 1234,
    matched: 1000,
    unmatched: 234,
    matchable: 1234,
    matchRate: 81,
  },
  pipeline: {
    backlogs: { discovered: 5, hydrated: 3, applied: 0 },
    backlogCount: 8,
    appliedDoneCount: 1226,
    cursorAgeSeconds: 42,
    pageTokenActive: false,
    lastCursorAdvanceAt: Date.now(),
    health: {
      oldestUnprocessedAgeSeconds: 7,
      avgDiscoveryToApplyMs: 1500,
      hydrateRetryCount: 0,
      failedCount: 2,
      deadLetteredCount: 1,
    },
    versionNoopsLast1h: 0,
    collectedAt: Date.now(),
  },
  jobs: [],
  canonicalRecoveryEndpoint: "/api/integrations/front/historical-recovery/run",
  generatedAt: new Date().toISOString(),
};

const UNMATCHED_DIAGNOSIS_PAYLOAD = {
  total: 234,
  byCause: {
    wouldMatchNow: 10,
    sharedEmail: 5,
    sharedDomain: 4,
    probableOperational: 20,
    companyOnly: 15,
    noExternalSignal: 30,
    noClientData: 150,
  },
  topUnmatchedDomains: [],
  topOperationalSenders: [],
  matchRate: { matched: 1000, unmatched: 234, matchable: 1234, rate: 81 },
};

const MESSAGE_FEED_PAYLOAD = {
  messages: [],
  filteredStats: { total: 0, matched: 0, unmatched: 0, matchRate: 0 },
  globalStats: { total: 0, matched: 0, unmatched: 0, matchRate: 0 },
  pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
};

let overviewOverride: any = OVERVIEW_PAYLOAD;

// Task #2691 — payload for the simplified "Bring it to 100%" default card.
// matched/unmatched/dismissed = 600/300/100 → 60.0 / 30.0 / 10.0 % of the
// classified total (1000). dismissed must render as "Dismissed (by rules)".
let bringTo100Override: any = {
  target: {
    frontTotal: 1000,
    applied: 800,
    fetched: 850,
    loggedPct: 80,
    reachableApplied: 950,
    reachableTargetPct: 95,
    reachableRemainingWork: 150,
    applyGap: 50,
    reachableIngestGap: 100,
    planLimitedRemainder: 50,
    planLimitedRemainderPct: 5,
    atReachableTarget: false,
  },
  classification: {
    total: 1000,
    matched: 600,
    unmatched: 300,
    dismissed: 100,
    matchRate: 67,
  },
  status: "work_remaining",
  statusDetail: "Recovery available — press the button to close the gap.",
  blocked: false,
  queuePaused: false,
  pauseReason: null,
  generatedAt: new Date().toISOString(),
};

const fetchCalls: string[] = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  onCall: ({ url }: any) => {
    fetchCalls.push(url);
  },
  routes: [
    { path: "/api/auth/user", json: ADMIN_USER },
    { path: "/api/users", json: [ADMIN_USER] },
    { path: "/api/integrations/front/console/overview", json: () => overviewOverride },
    { path: "/api/integrations/front/messages", json: MESSAGE_FEED_PAYLOAD },
    { path: "/api/integrations/front/inboxes", json: [] },
    { path: "/api/integrations/front/filter-rules/apply-jobs/active", json: { byRuleId: {} } },
    { path: "/api/integrations/front/filter-rules", json: { rules: [] } },
    { path: "/api/integrations/front/unmatched-diagnosis", json: UNMATCHED_DIAGNOSIS_PAYLOAD },
    { path: "/api/integrations/all-status", json: { front: { connected: true } } },
    { path: "/api/integrations/front/historical-recovery/coverage", json: { gaps: [] } },
    { path: "/api/integrations/front/historical-recovery/jobs", json: { jobs: [] } },
    { path: "/api/integrations/front/historical-recovery/max-age", json: { maxAgeDays: 90, min: 1, max: 365, history: [] } },
    { path: "/api/integrations/front/historical-recovery/prune-interval", json: { intervalMinutes: 60, min: 1, max: 1440, history: [] } },
    { path: "/api/integrations/front/historical-recovery/sweep-status", json: {} },
    { path: "/api/integrations/front/historical-recovery/auto-continue-max-attempts", json: { maxAttempts: 3, history: [] } },
    { path: "/api/integrations/front/historical-recovery/retry-alert", json: {} },
    { path: "/api/integrations/front/historical-recovery/manual-sweep-history", json: { history: [] } },
    { path: "/api/integrations/front/console/bring-to-100", json: () => bringTo100Override },
    { path: "/api/clients", json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — after jsdom globals + fetch shim are set up
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const FrontIntegrationMod = await import("../../client/src/pages/admin/FrontIntegration");
const FrontIntegration = FrontIntegrationMod.default as any;
const { FrontKpiHeader } = await import(
  "../../client/src/components/admin/front/FrontKpiHeader"
);
const { FrontBringTo100 } = await import(
  "../../client/src/components/admin/front/FrontBringTo100"
);
const { getFrontConsoleMetric } = await import("@shared/frontConsoleMetrics");
const { getQueryFn } = await import("../../client/src/lib/queryClient");

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

function makeClient(): InstanceType<typeof QueryClient> {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 },
    },
  });
}

// A client WITH the app's default queryFn, for components (e.g. FrontBringTo100)
// that rely on it. Kept separate from makeClient() because the full-page mount
// scenarios deliberately leave most queries pending.
function makeClientWithQueryFn(): InstanceType<typeof QueryClient> {
  return new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: getQueryFn({ on401: "throw" }) as any,
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 5 * 60 * 1000,
      },
    },
  });
}

async function mount(node: any): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

function setLocation(search: string): void {
  dom.window.history.replaceState({}, "", `/admin/front${search}`);
}

// ---------------------------------------------------------------------------
// Scenario 1: every tab trigger renders, and clicking each one swaps
// the visible tabpanel.
// ---------------------------------------------------------------------------

const TABS: Array<{ id: string; trigger: string; panel: string }> = [
  { id: "messages", trigger: "tab-front-messages", panel: "tabpanel-front-messages" },
  { id: "filters", trigger: "tab-front-filters", panel: "tabpanel-front-filters" },
  { id: "pipeline", trigger: "tab-front-pipeline", panel: "tabpanel-front-pipeline" },
  { id: "recovery", trigger: "tab-front-recovery", panel: "tabpanel-front-recovery" },
  { id: "jobs", trigger: "tab-front-jobs", panel: "tabpanel-front-jobs" },
];

// Task #2691 — the operator tabs are now demoted behind an "Advanced operator
// tools" Collapsible that is closed by default (and auto-opened when the URL
// deep-links a non-default ?tab=). This helper opens it idempotently so the
// tab-routing assertions still exercise the same triggers/panels. Radix's
// CollapsibleContent does not mount its children while closed, so the
// `tabs-front-console` shell is the tell for whether it is already open.
async function openAdvanced(): Promise<void> {
  if ($("tabs-front-console")) return; // already expanded (e.g. ?tab= deep-link)
  const toggle = $("button-toggle-advanced");
  assert(toggle !== null, "Advanced operator tools toggle must render");
  await act(async () => {
    toggle!.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    toggle!.dispatchEvent(
      new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
    );
    toggle!.click();
  });
  await flush(8);
}

async function scenario1_tabSwitching(): Promise<void> {
  console.log("\n— Scenario 1: each tab trigger renders + clicking swaps the visible panel —");

  setLocation("");
  const qc = makeClient();
  const root = await mount(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(FrontIntegration)),
  );
  try {
    await openAdvanced();
    for (const t of TABS) {
      assert($(t.trigger) !== null, `tab trigger ${t.trigger} must render`);
    }
    console.log("  ✓ all 5 tab triggers present");

    for (const t of TABS) {
      const trigger = $(t.trigger)!;
      // Radix TabsTrigger activates on mousedown (button 0), not on click —
      // dispatch both so React's synthetic-event tree sees the same gesture
      // a real user would produce.
      await act(async () => {
        trigger.dispatchEvent(
          new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
        );
        trigger.dispatchEvent(
          new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
        );
        trigger.click();
      });
      await flush(8);

      const panel = $(t.panel);
      assert(panel !== null, `clicking ${t.trigger} must mount ${t.panel}`);
      // Radix Tabs marks the active panel `data-state="active"` and the
      // others get `data-state="inactive"` (or are unmounted).
      const state = panel!.getAttribute("data-state");
      assert(
        state === "active",
        `clicking ${t.trigger} must mark ${t.panel} data-state="active" (got '${state}')`,
      );

      // Every other panel must NOT be the active one.
      for (const other of TABS) {
        if (other.id === t.id) continue;
        const otherPanel = $(other.panel);
        if (otherPanel) {
          const otherState = otherPanel.getAttribute("data-state");
          assert(
            otherState !== "active",
            `panel ${other.panel} must not also be active when ${t.trigger} is selected (got '${otherState}')`,
          );
        }
      }
    }
    console.log("  ✓ clicking each trigger flips the active panel to the matching tabpanel-front-*");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: `?tab=<value>` deep-link parsing + invalid-fallback.
// ---------------------------------------------------------------------------

async function assertActiveTab(expectedPanelTestId: string, label: string): Promise<void> {
  const panel = $(expectedPanelTestId);
  assert(panel !== null, `[${label}] ${expectedPanelTestId} must render`);
  const state = panel!.getAttribute("data-state");
  assert(
    state === "active",
    `[${label}] ${expectedPanelTestId} must be data-state="active" (got '${state}')`,
  );
}

async function scenario2_deepLinkParsing(): Promise<void> {
  console.log("\n— Scenario 2: ?tab=<value> deep-link parsing —");

  const cases: Array<{ search: string; expectPanel: string; note: string }> = [
    { search: "?tab=jobs", expectPanel: "tabpanel-front-jobs", note: "valid: jobs" },
    { search: "?tab=filters", expectPanel: "tabpanel-front-filters", note: "valid: filters" },
    { search: "?tab=pipeline", expectPanel: "tabpanel-front-pipeline", note: "valid: pipeline" },
    { search: "?tab=recovery", expectPanel: "tabpanel-front-recovery", note: "valid: recovery" },
    { search: "?tab=messages", expectPanel: "tabpanel-front-messages", note: "valid: messages" },
    {
      search: "?tab=bogus",
      expectPanel: "tabpanel-front-messages",
      note: "invalid value → fallback to Messages",
    },
    {
      search: "",
      expectPanel: "tabpanel-front-messages",
      note: "missing ?tab= → default Messages",
    },
  ];

  for (const c of cases) {
    setLocation(c.search);
    const qc = makeClient();
    const root = await mount(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(FrontIntegration),
      ),
    );
    try {
      await openAdvanced();
      await assertActiveTab(c.expectPanel, c.note);
      console.log(`  ✓ ${c.note}`);
    } finally {
      await unmount(root);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: FrontKpiHeader renders all five tiles against the mocked
// /console/overview payload. Task #2640 collapsed the duplicate "Raw imported"
// tile (it was always identical to "Tracked emails"), so the strip is 5 tiles.
// ---------------------------------------------------------------------------

const REQUIRED_KPI_TILES = [
  "kpi-tracked",
  "kpi-matched",
  "kpi-unmatched",
  "kpi-match-rate",
  "kpi-backlog-total",
];

// Task #2685 — every KPI tile (Lens 1, the processing pipeline) must be sourced
// from the metric registry via a `data-metric-id`, so its lens/grain/source
// definition can't drift from a relabel. testid → expected registry id.
const KPI_TILE_METRIC_IDS: Record<string, string> = {
  "kpi-tracked": "front.pipeline.tracked_total",
  "kpi-matched": "front.pipeline.matched",
  "kpi-unmatched": "front.pipeline.unmatched",
  "kpi-match-rate": "front.pipeline.match_rate",
  "kpi-backlog-total": "front.pipeline.backlog",
};

async function scenario3_kpiHeaderTiles(): Promise<void> {
  console.log("\n— Scenario 3: KPI strip renders all 5 tiles against a populated overview —");

  overviewOverride = OVERVIEW_PAYLOAD;
  const qc = makeClient();
  const root = await mount(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(FrontKpiHeader)),
  );
  try {
    for (const tile of REQUIRED_KPI_TILES) {
      assert($(tile) !== null, `KPI tile ${tile} must render`);
    }
    console.log(`  ✓ all 5 tiles present: ${REQUIRED_KPI_TILES.join(", ")}`);

    // Task #2685 — each tile must carry a registry-sourced data-metric-id whose
    // id (a) resolves in the registry and (b) is the expected Lens-1 pipeline
    // metric. This makes the registry the render source-of-truth for the KPI strip.
    for (const [tile, expectedId] of Object.entries(KPI_TILE_METRIC_IDS)) {
      const el = $(tile);
      const metricId = el?.getAttribute("data-metric-id") ?? "";
      assert(
        metricId === expectedId,
        `KPI tile ${tile} must carry data-metric-id '${expectedId}' (got '${metricId}')`,
      );
      const d = getFrontConsoleMetric(metricId); // throws if unknown id
      assert(d.lens === 1, `KPI tile ${tile} metric must be Lens 1 (got lens ${d.lens})`);
    }
    console.log("  ✓ all 5 tiles sourced from the registry (Lens-1 data-metric-id)");

    // Task #2640 — the redundant "Raw imported" tile is gone; only the
    // de-duplicated "Tracked emails" count remains.
    assert(
      $("kpi-raw-imported") === null,
      "kpi-raw-imported tile must no longer render after the collapse",
    );

    // Spot-check the rendered values to confirm the tiles are wired to the
    // payload (not just rendered as empty placeholders).
    const trackedValue = $("kpi-tracked-value");
    assert(
      trackedValue !== null && trackedValue.textContent?.trim() === "1234",
      `kpi-tracked-value must render the payload's messages.trackedTotal (got '${trackedValue?.textContent}')`,
    );
    const matchRateValue = $("kpi-match-rate-value");
    assert(
      matchRateValue !== null && matchRateValue.textContent?.trim() === "81%",
      `kpi-match-rate-value must render '${"81%"}' (got '${matchRateValue?.textContent}')`,
    );
    const backlogValue = $("kpi-backlog-total-value");
    // Server-computed backlogCount (8) from the OVERVIEW_PAYLOAD pipeline.
    assert(
      backlogValue !== null && backlogValue.textContent?.trim() === "8",
      `kpi-backlog-total-value must render the server backlogCount '8' (got '${backlogValue?.textContent}')`,
    );
    console.log("  ✓ tile values are wired through from the overview payload");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario 4 (Task #2691): the simplified "Bring it to 100%" default card
// renders matched/unmatched/dismissed COUNTS *and* per-bucket percentages
// (against the classified total), and the dismissed label reads
// "Dismissed (by rules)". This locks the CEO-facing classification contract.
// ---------------------------------------------------------------------------

async function scenario4_bringTo100Classification(): Promise<void> {
  console.log("\n— Scenario 4: Bring-it-to-100 card shows counts + per-bucket % + 'Dismissed (by rules)' —");

  const qc = makeClientWithQueryFn();
  const root = await mount(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(FrontBringTo100)),
  );
  try {
    const card = $("card-bring100");
    assert(card !== null, "the Bring-it-to-100 card must render (not loading/error)");

    // Counts.
    assert($("stat-bring100-matched")?.textContent?.includes("600") === true, "matched count 600 must render");
    assert($("stat-bring100-unmatched")?.textContent?.includes("300") === true, "unmatched count 300 must render");
    assert($("stat-bring100-dismissed")?.textContent?.includes("100") === true, "dismissed count 100 must render");
    console.log("  ✓ matched/unmatched/dismissed counts render");

    // Per-bucket percentages of the classified total (600/300/100 of 1000).
    const matchedPct = $("text-bring100-matched-pct")?.textContent?.trim();
    const unmatchedPct = $("text-bring100-unmatched-pct")?.textContent?.trim();
    const dismissedPct = $("text-bring100-dismissed-pct")?.textContent?.trim();
    assert(matchedPct === "60.0%", `matched % must be 60.0% (got '${matchedPct}')`);
    assert(unmatchedPct === "30.0%", `unmatched % must be 30.0% (got '${unmatchedPct}')`);
    assert(dismissedPct === "10.0%", `dismissed % must be 10.0% (got '${dismissedPct}')`);
    console.log("  ✓ per-bucket percentages render (60.0 / 30.0 / 10.0)");

    // Required copy: "Dismissed (by rules)".
    assert(
      $("stat-bring100-dismissed")?.textContent?.includes("Dismissed (by rules)") === true,
      "dismissed label must read 'Dismissed (by rules)'",
    );
    console.log("  ✓ dismissed label reads 'Dismissed (by rules)'");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 5 — Task #4367 (audit P1-5): an out-of-range stored ratio (the
// "903.6%" bug) must render as the explicit "needs recount" data-quality
// state — never as a raw impossible number — while the counts caption keeps
// naming the numerator/denominator and the progress bar stays clamped.
// ---------------------------------------------------------------------------
async function scenario5_outOfRangeCoverageFlag(): Promise<void> {
  console.log(
    "\n— Scenario 5: out-of-range coverage ratio renders 'needs recount', never 903.6% —",
  );

  const saved = bringTo100Override;
  bringTo100Override = {
    ...saved,
    target: { ...saved.target, loggedPct: 903.6 },
  };
  try {
    const qc = makeClientWithQueryFn();
    const root = await mount(
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(FrontBringTo100)),
    );
    try {
      const hero = $("text-bring100-logged-pct");
      assert(hero !== null, "hero metric node must render");
      const heroText = hero?.textContent ?? "";
      assert(
        !heroText.includes("903"),
        `hero must NOT render the raw impossible number (got '${heroText}')`,
      );
      assert(
        heroText.toLowerCase().includes("needs recount"),
        `hero must show the needs-recount state (got '${heroText}')`,
      );
      assert(
        hero?.getAttribute("title")?.includes("903.6") === true,
        "the raw value must remain available in the hero tooltip",
      );
      console.log("  ✓ hero renders 'needs recount' with the raw value in the tooltip");

      const note = $("text-bring100-out-of-range-note");
      assert(note !== null, "the data-quality explanation note must render");
      assert(
        note?.textContent?.includes("903.6") === true,
        "note must cite the raw stored ratio",
      );
      console.log("  ✓ explanation note renders and cites the raw ratio");

      const counts = $("text-bring100-counts");
      assert(
        counts?.textContent?.includes("in-window") === true,
        "caption must name the in-window denominator",
      );
      assert(
        counts?.textContent?.includes("800") === true,
        "caption keeps the numerator count (raw counts are facts)",
      );
      assert(
        counts?.textContent?.includes("1,000") === true,
        "caption keeps the denominator count",
      );
      console.log("  ✓ counts caption still names 'X of Y in-window Front messages'");

      const bar = $("progress-bring100");
      const valueNow = bar?.getAttribute("aria-valuenow");
      assert(
        valueNow === "0" || valueNow === null,
        `progress bar must not overflow with the impossible value (aria-valuenow='${valueNow}')`,
      );
      console.log("  ✓ progress bar stays clamped (no 903.6% overflow)");
    } finally {
      await unmount(root);
    }

    // Normal-path guard: an in-range ratio (scenario 4's 80.0% fixture) keeps
    // the classic plain-percentage rendering and shows no data-quality note.
    bringTo100Override = saved;
    const qc2 = makeClientWithQueryFn();
    const root2 = await mount(
      React.createElement(QueryClientProvider, { client: qc2 }, React.createElement(FrontBringTo100)),
    );
    try {
      const heroText2 = $("text-bring100-logged-pct")?.textContent?.trim();
      assert(
        heroText2 === "80.0%",
        `in-range hero must render '80.0%' (got '${heroText2}')`,
      );
      assert(
        $("text-bring100-out-of-range-note") === null,
        "no data-quality note for an in-range ratio",
      );
      console.log("  ✓ in-range ratio still renders the plain percentage (80.0%)");
    } finally {
      await unmount(root2);
    }
  } finally {
    bringTo100Override = saved;
  }
}

async function main(): Promise<void> {
  await scenario1_tabSwitching();
  await scenario2_deepLinkParsing();
  await scenario3_kpiHeaderTiles();
  await scenario4_bringTo100Classification();
  await scenario5_outOfRangeCoverageFlag();
  console.log("\nfront-console-tabs: all scenarios passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
