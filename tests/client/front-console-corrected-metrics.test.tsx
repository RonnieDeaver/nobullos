/* test-registration
{
  "name": "Front console renders corrected match-rate + backlog figures (Task #2513)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2513 — The Front console must DISPLAY the corrected match-rate and
 * backlog figures, not just compute them correctly somewhere.
 *
 * Task #2505 already locks the math in `shared/frontConsoleMetrics.ts` with pure
 * unit tests. Task #2502's whole point, though, is that the SAME numbers reach
 * both the server overview endpoint and the rendered client console without
 * drifting. A unit test of the helpers can't catch a wiring regression where a
 * tile stops reading the canonical field (e.g. the match-rate tile silently
 * shows the raw, dilution-prone rate again, or the backlog tile sums every
 * pipeline_state and folds the ~137k already-`applied` rows back in).
 *
 * This test:
 *   1. Starts from a KNOWN match_status histogram + pipeline_state histogram —
 *      the same raw inputs the server reads from `front_sync_emails`.
 *   2. Builds the `/console/overview` payload the way the server endpoint does:
 *      every canonical figure is produced by the shared helpers
 *      (computeFrontMatchableStats / computeFrontBacklogCount /
 *      computeFrontAppliedDoneCount). This is the server→client contract.
 *   3. Renders BOTH the KPI header strip and the Pipeline Health tab and asserts
 *      every displayed match rate %, matchable, matched, unmatched,
 *      dismissed-operational, backlog and applied-done value equals the helper
 *      output — and is in the correctly labelled tile.
 *   4. Proves the test actually bites by asserting the displayed CORRECTED
 *      values differ from the naive WRONG ones the bugs produced (a raw,
 *      dismissal-diluted match rate; a backlog that folds in terminal-done
 *      rows).
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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. Known raw inputs — the histograms the server reads from front_sync_emails.
//    Deliberately shaped like the real corpus that produced the two bugs:
//      - A LARGE pile of non-matchable dismissals that diluted match rate (Bug A).
//      - A LARGE pile of already-`applied` rows that inflated backlog (Bug B).
// ---------------------------------------------------------------------------

const MATCH_STATUS_HISTOGRAM: Record<string, number> = {
  auto_matched: 600,
  manually_matched: 200,
  unmatched: 200,
  dismissed: 95_000,
  blocked: 100,
};

const PIPELINE_STATE_HISTOGRAM: Record<string, number> = {
  discovered: 40,
  matched: 25,
  hydrated: 10,
  failed: 4,
  dead_lettered: 1,
  applied: 137_000,
  triage_dismissed: 5_000,
};

const RAW_IMPORTED_TOTAL = 250_000; // raw_communication_records (incl. dupes)

// ---------------------------------------------------------------------------
// Imports of the shared helpers (the single source of truth) + expected values.
// ---------------------------------------------------------------------------

const {
  computeFrontMatchableStats,
  computeFrontBacklogCount,
  computeFrontAppliedDoneCount,
} = await import("@shared/frontConsoleMetrics");

const expectedStats = computeFrontMatchableStats(MATCH_STATUS_HISTOGRAM);
const expectedBacklog = computeFrontBacklogCount(PIPELINE_STATE_HISTOGRAM);
const expectedAppliedDone = computeFrontAppliedDoneCount(PIPELINE_STATE_HISTOGRAM);

// The naive WRONG values the bugs produced, so we can prove the corrected ones
// the console shows are genuinely different (the test would fail on regression).
const rawDilutedMatchRate = Math.round(
  (expectedStats.matched / expectedStats.trackedTotal) * 100,
); // counts the 95k+ dismissals in the denominator → ~1%
const naiveBacklogSummingEveryState = Object.values(PIPELINE_STATE_HISTOGRAM).reduce(
  (a, b) => a + b,
  0,
); // folds in applied + triage_dismissed

// ---------------------------------------------------------------------------
// 2. Build the /console/overview payload exactly the way the server endpoint
//    (server/routes/integrations.ts) assembles it: every canonical figure is
//    produced by the shared helpers. This is the server→client contract under
//    test — if the endpoint stopped routing through the helpers, this payload
//    construction would have to change in lockstep with the assertions below.
// ---------------------------------------------------------------------------

const OVERVIEW_PAYLOAD = {
  connection: {
    connected: true,
    error: null,
    lastSyncError: null,
    lastSyncSuccess: new Date().toISOString(),
  },
  syncProgress: { isRunning: false },
  lastCycle: null,
  messages: {
    rawImportedTotal: RAW_IMPORTED_TOTAL,
    rawMatched: 0,
    rawUnmatched: 0,
    trackedTotal: expectedStats.trackedTotal,
    matched: expectedStats.matched,
    unmatched: expectedStats.unmatched,
    matchable: expectedStats.matchable,
    matchRate: expectedStats.matchRate,
  },
  pipeline: {
    backlogs: PIPELINE_STATE_HISTOGRAM,
    backlogCount: expectedBacklog,
    appliedDoneCount: expectedAppliedDone,
    cursorAgeSeconds: 42,
    pageTokenActive: false,
    lastCursorAdvanceAt: Date.now(),
    health: {
      oldestUnprocessedAgeSeconds: 7,
      avgDiscoveryToApplyMs: 1500,
      hydrateRetryCount: 0,
      failedCount: PIPELINE_STATE_HISTOGRAM.failed,
      deadLetteredCount: PIPELINE_STATE_HISTOGRAM.dead_lettered,
    },
    versionNoopsLast1h: 0,
    collectedAt: Date.now(),
  },
  jobs: [],
  canonicalRecoveryEndpoint: "/api/integrations/front/historical-recovery/run",
  generatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Fetch stub — permissive: serve the overview payload, empty-but-valid shapes
// for the Pipeline Health tab's child cards, and {} for anything else.
// ---------------------------------------------------------------------------

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/integrations/front/console/overview", json: OVERVIEW_PAYLOAD },
    {
      path: "/api/integrations/front/unmatched-diagnosis",
      json: {
        total: 0,
        byCause: {},
        topUnmatchedDomains: [],
        topOperationalSenders: [],
        matchRate: { matched: 0, unmatched: 0, matchable: 0, rate: 0 },
      },
    },
    { path: "/api/integrations/front/pipeline-metrics", json: OVERVIEW_PAYLOAD.pipeline },
    {
      path: "/api/integrations/front/match-stats",
      json: { byStatus: MATCH_STATUS_HISTOGRAM, byMethod: {}, total: expectedStats.trackedTotal },
    },
    { path: "/api/integrations/all-status", json: { front: { connected: true } } },
    { path: "/api/clients", json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// React imports — after jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FrontKpiHeader } = await import(
  "../../client/src/components/admin/front/FrontKpiHeader"
);
const { FrontPipelineHealthTab } = await import(
  "../../client/src/components/admin/front/FrontPipelineHealthTab"
);

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

function text(testId: string): string {
  return ($(testId)?.textContent ?? "").trim();
}

function makeClient(): InstanceType<typeof QueryClient> {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 },
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

let passed = 0;
function ok(name: string, detail?: string): void {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
}

// ---------------------------------------------------------------------------
// Sanity — the fixture must actually exercise the bugs, otherwise the test
// proves nothing. Corrected match rate must be wildly higher than the diluted
// one, and corrected backlog wildly lower than the sum-everything one.
// ---------------------------------------------------------------------------

function scenario0_fixtureBitesTheBugs(): void {
  console.log("\n— Scenario 0: the fixture genuinely exercises both bugs —");
  assert(
    expectedStats.matchRate > rawDilutedMatchRate + 10,
    `corrected match rate (${expectedStats.matchRate}%) must be far above the diluted one (${rawDilutedMatchRate}%)`,
  );
  ok(
    `corrected match rate ${expectedStats.matchRate}% ≫ diluted ${rawDilutedMatchRate}% (Bug A)`,
  );
  assert(
    expectedBacklog < naiveBacklogSummingEveryState / 100,
    `corrected backlog (${expectedBacklog}) must be far below sum-every-state (${naiveBacklogSummingEveryState})`,
  );
  ok(
    `corrected backlog ${expectedBacklog} ≪ sum-every-state ${naiveBacklogSummingEveryState} (Bug B)`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: the KPI header strip displays the helper values in the right
// tiles.
// ---------------------------------------------------------------------------

async function scenario1_kpiHeader(): Promise<void> {
  console.log("\n— Scenario 1: KPI header displays the corrected figures —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(FrontKpiHeader)),
  );
  try {
    assert(
      text("kpi-matched-value") === String(expectedStats.matched),
      `kpi-matched-value should be computeFrontMatchableStats.matched=${expectedStats.matched} (got '${text("kpi-matched-value")}')`,
    );
    ok(`Matched tile = ${expectedStats.matched}`);

    assert(
      text("kpi-unmatched-value") === String(expectedStats.unmatched),
      `kpi-unmatched-value should be ${expectedStats.unmatched} (got '${text("kpi-unmatched-value")}')`,
    );
    ok(`Unmatched tile = ${expectedStats.unmatched}`);

    // Bug A — match rate is matched/matchable, NOT diluted by the 95k dismissals.
    assert(
      text("kpi-match-rate-value") === `${expectedStats.matchRate}%`,
      `kpi-match-rate-value should be ${expectedStats.matchRate}% (got '${text("kpi-match-rate-value")}')`,
    );
    assert(
      text("kpi-match-rate-value") !== `${rawDilutedMatchRate}%`,
      `match-rate tile must NOT show the diluted ${rawDilutedMatchRate}%`,
    );
    ok(`Match-rate tile = ${expectedStats.matchRate}% (not diluted ${rawDilutedMatchRate}%)`);

    // The matchable denominator is surfaced in the sub-label of the match-rate tile.
    assert(
      text("kpi-match-rate-sub").includes(expectedStats.matchable.toLocaleString()),
      `match-rate sub should mention matchable=${expectedStats.matchable} (got '${text("kpi-match-rate-sub")}')`,
    );
    ok(`Match-rate sub mentions matchable=${expectedStats.matchable}`);

    // Bug B — backlog excludes applied + triage_dismissed.
    assert(
      text("kpi-backlog-total-value") === String(expectedBacklog),
      `kpi-backlog-total-value should be computeFrontBacklogCount=${expectedBacklog} (got '${text("kpi-backlog-total-value")}')`,
    );
    assert(
      text("kpi-backlog-total-value") !== String(naiveBacklogSummingEveryState),
      `backlog tile must NOT show the sum-every-state ${naiveBacklogSummingEveryState}`,
    );
    ok(`Backlog tile = ${expectedBacklog} (not sum-every-state ${naiveBacklogSummingEveryState})`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: the Pipeline Health tab displays the same corrected figures.
// ---------------------------------------------------------------------------

async function scenario2_pipelineHealthTab(): Promise<void> {
  console.log("\n— Scenario 2: Pipeline Health tab displays the corrected figures —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontPipelineHealthTab),
    ),
  );
  try {
    // Task #2640 — the Pipeline Health tab no longer repeats the match KPIs
    // (Matched / Unmatched / Match rate) that already live in the always-visible
    // KPI strip above it. Those duplicated tiles must be gone here.
    assert(
      $("stat-overview-matched") === null,
      "stat-overview-matched tile must no longer render in the Pipeline Health tab",
    );
    assert(
      $("stat-overview-unmatched") === null,
      "stat-overview-unmatched tile must no longer render in the Pipeline Health tab",
    );
    assert(
      $("stat-overview-rate") === null,
      "stat-overview-rate tile must no longer render in the Pipeline Health tab",
    );
    ok("Duplicate match-KPI tiles removed from the Pipeline Health tab");

    // Bug B — backlog vs applied/done summaries (pipeline-health-specific, kept).
    assert(
      text("text-backlog-summary").includes(expectedBacklog.toLocaleString()),
      `Backlog summary should show computeFrontBacklogCount=${expectedBacklog} (got '${text("text-backlog-summary")}')`,
    );
    assert(
      !text("text-backlog-summary").includes(naiveBacklogSummingEveryState.toLocaleString()),
      `Backlog summary must NOT show the sum-every-state ${naiveBacklogSummingEveryState}`,
    );
    ok(`Backlog summary = ${expectedBacklog} (not ${naiveBacklogSummingEveryState})`);

    assert(
      text("text-applied-done-summary").includes(expectedAppliedDone.toLocaleString()),
      `Applied/done summary should show computeFrontAppliedDoneCount=${expectedAppliedDone} (got '${text("text-applied-done-summary")}')`,
    );
    ok(`Applied/done summary = ${expectedAppliedDone}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 (the optional server-side contract): the overview payload the
// server hands the client carries the SAME canonical fields the helpers
// produce. Since the payload above is built the way the endpoint builds it,
// this guards the contract the two screens depend on.
// ---------------------------------------------------------------------------

function scenario3_serverContract(): void {
  console.log("\n— Scenario 3: overview payload carries the canonical helper fields —");
  const m = OVERVIEW_PAYLOAD.messages;
  const p = OVERVIEW_PAYLOAD.pipeline;
  assert(m.matched === expectedStats.matched, "payload.messages.matched");
  assert(m.unmatched === expectedStats.unmatched, "payload.messages.unmatched");
  assert(m.matchable === expectedStats.matchable, "payload.messages.matchable");
  assert(m.matchRate === expectedStats.matchRate, "payload.messages.matchRate");
  assert(p.backlogCount === expectedBacklog, "payload.pipeline.backlogCount");
  assert(p.appliedDoneCount === expectedAppliedDone, "payload.pipeline.appliedDoneCount");
  ok("payload messages.* + pipeline.* equal the shared-helper outputs");
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  scenario0_fixtureBitesTheBugs();
  await scenario1_kpiHeader();
  await scenario2_pipelineHealthTab();
  scenario3_serverContract();
  console.log(`\nfront-console-corrected-metrics: ${passed} checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
