/* test-registration
{
  "name": "Front console KPI + Pipeline Health are message-grain only \u2014 no conversation terms in text or tooltips (Task #2603)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2603 — The Front console must read as MESSAGE-GRAIN ONLY. The sibling
 * test `front-console-corrected-metrics.test.tsx` (Task #2513) already proves the
 * KPI header strip and Pipeline Health tab render the correct NUMBERS. This test
 * guards the complementary requirement: that NO conversation vocabulary survives
 * on those two surfaces — not in visible text, and crucially not hidden in the
 * tooltip `title` attributes that previously pulled conversation-grain strings
 * from the server-owned `FRONT_CONSOLE_METRIC_DEFINITIONS`.
 *
 * It renders the REAL `FrontKpiHeader` and `FrontPipelineHealthTab` against an
 * overview payload, then:
 *   1. Asserts the conversation-laden server definitions are STILL present in the
 *      shared module (so the "must not leak" scan genuinely bites — if someone
 *      reworded the backend strings the guard would otherwise pass vacuously).
 *   2. Scans the entire rendered DOM — textContent AND every `title` attribute —
 *      for `conversation` / `convo`, asserting none appear.
 *   3. Spot-checks that the message-grain tooltips and labels DID render (so we
 *      know the components mounted and the tooltips are wired, not just absent).
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
// Shared helpers + the server-owned definitions we expect NOT to leak.
// ---------------------------------------------------------------------------

const {
  computeFrontMatchableStats,
  computeFrontBacklogCount,
  computeFrontAppliedDoneCount,
  FRONT_CONSOLE_METRIC_DEFINITIONS,
} = await import("@shared/frontConsoleMetrics");

const MATCH_STATUS_HISTOGRAM: Record<string, number> = {
  auto_matched: 600,
  manually_matched: 200,
  unmatched: 200,
  dismissed: 50,
  blocked: 25,
};
const PIPELINE_STATE_HISTOGRAM: Record<string, number> = {
  discovered: 40,
  matched: 25,
  hydrated: 10,
  failed: 4,
  dead_lettered: 1,
  applied: 5_000,
  triage_dismissed: 200,
};
const RAW_IMPORTED_TOTAL = 9_000;

const expectedStats = computeFrontMatchableStats(MATCH_STATUS_HISTOGRAM);
const expectedBacklog = computeFrontBacklogCount(PIPELINE_STATE_HISTOGRAM);
const expectedAppliedDone = computeFrontAppliedDoneCount(PIPELINE_STATE_HISTOGRAM);

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

/**
 * Collect every piece of user-facing copy in the rendered subtree: the visible
 * text AND every `title` tooltip attribute (the exact place the conversation
 * vocabulary used to hide).
 */
function collectSurface(): { text: string; titles: string[] } {
  const root = document.getElementById("root")!;
  const titles: string[] = [];
  root.querySelectorAll("[title]").forEach((el) => {
    const t = el.getAttribute("title");
    if (t) titles.push(t);
  });
  return { text: root.textContent ?? "", titles };
}

let passed = 0;
function ok(name: string, detail?: string): void {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
}

// ---------------------------------------------------------------------------
// Scenario 0 — the server definitions we are guarding against STILL contain the
// conversation vocabulary, so the "must not leak" scan below genuinely bites.
// ---------------------------------------------------------------------------

function scenario0_guardBites(): void {
  console.log("\n— Scenario 0: the server metric definitions still speak conversation-grain —");
  const conversationLadenKeys = (
    Object.entries(FRONT_CONSOLE_METRIC_DEFINITIONS) as Array<[string, string]>
  ).filter(([, v]) => /conversation/i.test(v));
  assert(
    conversationLadenKeys.length >= 3,
    `the server definitions must still describe ≥3 metrics in conversation terms for the leak scan to bite (got ${conversationLadenKeys.length})`,
  );
  ok(
    `server still describes ${conversationLadenKeys.length} metrics in conversation terms`,
    conversationLadenKeys.map(([k]) => k).join(", "),
  );
}

// ---------------------------------------------------------------------------
// Scenario 1 — KPI header: no conversation terminology in text OR titles.
// ---------------------------------------------------------------------------

async function scenario1_kpiHeaderMessageGrainOnly(): Promise<void> {
  console.log("\n— Scenario 1: KPI header is message-grain only —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(FrontKpiHeader)),
  );
  try {
    const { text, titles } = collectSurface();
    const all = [text, ...titles].join("\n");
    assert(!/conversation/i.test(all), "KPI header must contain NO 'conversation' terminology (text or title)");
    assert(!/\bconvos?\b/i.test(all), "KPI header must contain NO 'convo' shorthand (text or title)");
    ok("no conversation/convo in KPI header text or tooltips");

    assert(/Tracked emails/i.test(text), "KPI header should show the message-grain 'Tracked emails' label");
    assert(/Match rate/i.test(text), "KPI header should show a plain 'Match rate' label");
    assert(
      titles.some((t) => /matchable emails/i.test(t)),
      "KPI header tooltips should restate match rate in 'matchable emails' (message-grain)",
    );
    ok("message-grain labels + tooltips rendered");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — Pipeline Health tab: no conversation terminology, no caption.
// ---------------------------------------------------------------------------

async function scenario2_pipelineHealthMessageGrainOnly(): Promise<void> {
  console.log("\n— Scenario 2: Pipeline Health tab is message-grain only —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontPipelineHealthTab),
    ),
  );
  try {
    const { text, titles } = collectSurface();
    const all = [text, ...titles].join("\n");
    assert(!/conversation/i.test(all), "Pipeline Health must contain NO 'conversation' terminology (text or title)");
    assert(!/\bconvos?\b/i.test(all), "Pipeline Health must contain NO 'convo' shorthand (text or title)");
    ok("no conversation/convo in Pipeline Health text or tooltips");

    // The conversations-vs-messages caption is gone.
    assert(
      !/Pipeline Health measures de-duplicated/i.test(all),
      "the conversations-vs-messages caption must be removed",
    );
    ok("conversations-vs-messages caption removed");

    // Task #2640 collapsed the duplicate match-KPI tiles (Raw imported, Tracked
    // emails, Matched, Unmatched, Match rate) off the Pipeline Health tab —
    // those numbers now live ONLY on the always-visible KPI header strip (see
    // Scenario 1). So the "Tracked emails" label and the "matchable emails"
    // tooltip are intentionally absent here; assert they did NOT migrate back.
    assert(
      !/Tracked emails/i.test(text),
      "Pipeline Health must no longer duplicate the 'Tracked emails' match-KPI tile (moved to the KPI strip, Task #2640)",
    );
    assert(
      !titles.some((t) => /matchable emails/i.test(t)),
      "Pipeline Health must no longer duplicate the 'matchable emails' match-rate tooltip (moved to the KPI strip, Task #2640)",
    );
    ok("duplicate match-KPI tiles/tooltips removed (live only on the KPI strip)");

    // Spot-check the tab actually mounted and still renders its retained,
    // message-grain content (so the guard is not passing vacuously on an empty
    // render). "Pipeline by state" / "Backlog" are the kept, message-grain rows.
    assert(/Pipeline by state/i.test(text), "Pipeline Health should still render the 'Pipeline by state' breakdown");
    assert(/Backlog/i.test(text), "Pipeline Health should still render the message-grain 'Backlog' summary");
    ok("message-grain pipeline content rendered");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  console.log("Task #2603 — Front Console KPI + Pipeline Health message-grain-only screen test\n");
  scenario0_guardBites();
  await scenario1_kpiHeaderMessageGrainOnly();
  await scenario2_pipelineHealthMessageGrainOnly();
  console.log(`\nfront-console-message-grain-only: ${passed} checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
