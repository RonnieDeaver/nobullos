/* test-registration
{
  "name": "Front Analytics coverage surface renders canonical coverage % + grain + gaps (Task #2554)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2554: the Front Analytics *coverage* surface (monthly coverage %, numerator/denominator grain, gap counts) is rendered by the same giant, refactor-prone FrontHistoricalRecoveryPanel. A grain-mislabel or stale/ diluted-percentage wiring regression would be invisible to lower-level math tests. Gate the rendered-screen test so coverage-surface drift fails fast (fast, deterministic jsdom render — no DB, fully stubbed fetch).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-rendered-metrics-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/admin/FrontHistoricalRecoveryPanel.tsx",
    "client/src/components/admin/front/recovery",
    "client/src/components/admin/front/FrontKpiHeader.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2603 — The Front Console (Analytics Coverage surface) must present
 * ONLY individual-message-grain metrics. Every conversation count, conversation
 * "match rate", conversation-grain row label, and the conversations-vs-messages
 * caption is removed. Coverage is shown at message grain with a LIVE
 * progress-to-100% indicator and an explicit done state.
 *
 * This is the rendered-screen guard for that contract. It builds on Task #2554's
 * coverage-render test but FLIPS the grain assertions: where #2554 asserted the
 * conversation-grain row/badge EXISTS and is labelled "conversation-grain", this
 * test asserts no conversation terminology renders anywhere, that every coverage
 * figure is presented at message grain, and that the new progress indicator +
 * done state render from the backend status payload.
 *
 * Backend coverage math is out of scope (a sibling task owns it); the fixture is
 * shaped exactly as `getFrontAnalyticsCoverageSummary` returns so this test only
 * locks the DISPLAY contract.
 *
 * This test:
 *   1. Builds a KNOWN coverage fixture in the exact server-payload shape,
 *      DELIBERATELY including a `conversations_all` month — so we prove the panel
 *      surfaces NO conversation label even when conversation-grain data is
 *      present in the payload.
 *   2. Renders the real FrontHistoricalRecoveryPanel and asserts:
 *        - the message-grain headline figures render at message grain;
 *        - the live message-grain progress indicator (% + bar) renders from the
 *          in-scope counted/total months, and the 100% done badge appears only
 *          when nothing is excluded;
 *        - per-month rows read "message-grain" / "pending message-grain", never
 *          "conversation-grain";
 *        - the conversation-grain helper label and the bare word "conversation"
 *          appear NOWHERE in the rendered surface.
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
(globalThis as any).confirm = () => true;
(dom.window as any).confirm = () => true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Canonical sources — the shared grain helpers. We import them to derive the
// strings that must NOT appear: the conversation grain word and the
// conversation-grain inline label. Deriving from the shared module (rather than
// hard-coding "conversation") means a rename of the grain vocabulary keeps this
// test honest.
// ---------------------------------------------------------------------------

const {
  FRONT_GRAIN_MESSAGES,
  FRONT_GRAIN_CONVERSATIONS,
  frontCoverageGrainLabel,
  getFrontConsoleMetric,
  FRONT_CONSOLE_METRIC_REGISTRY,
} = await import("@shared/frontConsoleMetrics");

const fs = await import("node:fs");

const CONVERSATIONS_GRAIN_LABEL = frontCoverageGrainLabel("conversations_all"); // "conversation-grain"
const CONVERSATIONS_GRAIN_WORD = FRONT_GRAIN_CONVERSATIONS; // "conversations"

// ---------------------------------------------------------------------------
// 1. Known coverage fixture — the exact CoverageSummary shape the server
//    endpoint returns. Includes a conversations_all month ON PURPOSE so the
//    "no conversation label leaks" assertions genuinely bite.
//      - all-time HEADLINE is message grain at a LOW % (the firehose denom).
//      - in-scope split: 1 of 2 months counted, 1 excluded (wrong grain) →
//        the progress indicator must read 50% and show no done badge.
// ---------------------------------------------------------------------------

const MONTH_MESSAGES = "2025-09"; // messages_all grain
const MONTH_CONVERSATIONS = "2025-08"; // conversations_all grain (still in payload)
const MONTH_DIRECTIONS = "2025-10"; // messages_all grain w/ distinct per-direction figures
const MONTH_INCOMPARABLE = "2025-11"; // numerator/denominator at INCOMPARABLE grains

function buildMonth(over: Record<string, any>): Record<string, any> {
  return {
    month: "",
    frontTotalMessages: 0,
    fetchedIntoNobull: 0,
    appliedIntoNobull: 0,
    ingestGap: 0,
    applyGap: 0,
    fetchedCoveragePct: 0,
    appliedCoveragePct: 0,
    pulledAt: "2026-06-01T00:00:00.000Z",
    isFinalizedMonth: true,
    frontAnalyticsStatus: "ok",
    frontAnalyticsError: null,
    unrecoverable: false,
    denominatorSource: null,
    denominatorUnit: null,
    numeratorUnit: null,
    analyticsMessagesInbound: null,
    unitsComparable: true,
    analyticsPlanLimitedAt: null,
    messagesInboundFront: null,
    messagesOutboundFront: null,
    messagesInboundLocal: null,
    messagesOutboundLocal: null,
    messagesInboundCoveragePct: null,
    messagesOutboundCoveragePct: null,
    messagesInboundGap: null,
    messagesOutboundGap: null,
    directionDataSource: null,
    reasonHuman: null,
    needsReconnect: false,
    completenessStatus: "covered",
    completenessReason: "",
    closedVia: null,
    coverageConvergenceAttempts: 0,
    ...over,
  };
}

const MESSAGES_MONTH = buildMonth({
  month: MONTH_MESSAGES,
  frontTotalMessages: 120_000,
  fetchedIntoNobull: 14_808,
  appliedIntoNobull: 7_800,
  ingestGap: 105_192,
  applyGap: 7_008,
  fetchedCoveragePct: 12.34,
  appliedCoveragePct: 6.5,
  denominatorSource: "analytics_reports",
  denominatorUnit: "messages_all",
  numeratorUnit: "messages_all",
});

// A conversations_all month still present in the payload — the panel must
// surface NO conversation label for it; it reads "pending message-grain".
const CONVERSATIONS_MONTH = buildMonth({
  month: MONTH_CONVERSATIONS,
  frontTotalMessages: 5_000,
  fetchedIntoNobull: 4_960,
  appliedIntoNobull: 4_955,
  ingestGap: 40,
  applyGap: 5,
  fetchedCoveragePct: 99.2,
  appliedCoveragePct: 99.1,
  denominatorSource: "search_conversations",
  denominatorUnit: "conversations_all",
  numeratorUnit: "conversations_all",
});

// A messages_all month carrying DISTINCT inbound vs outbound per-direction
// coverage figures and gaps (a separate display path from the headline).
const DIRECTIONS_MONTH = buildMonth({
  month: MONTH_DIRECTIONS,
  frontTotalMessages: 13_000,
  fetchedIntoNobull: 9_100,
  appliedIntoNobull: 8_200,
  ingestGap: 3_900,
  applyGap: 900,
  fetchedCoveragePct: 70.0,
  appliedCoveragePct: 63.08,
  denominatorSource: "analytics_reports",
  denominatorUnit: "messages_all",
  numeratorUnit: "messages_all",
  messagesInboundFront: 8_000,
  messagesInboundLocal: 7_000,
  messagesInboundCoveragePct: 87.5,
  messagesInboundGap: 1_000,
  messagesOutboundFront: 5_000,
  messagesOutboundLocal: 2_100,
  messagesOutboundCoveragePct: 42.0,
  messagesOutboundGap: 2_900,
  directionDataSource: "analytics_reports",
});

// A month whose numerator/denominator are at INCOMPARABLE grains
// (`unitsComparable: false`): the panel must suppress its % cells to "—".
const INCOMPARABLE_MONTH = buildMonth({
  month: MONTH_INCOMPARABLE,
  frontTotalMessages: 6_000,
  fetchedIntoNobull: 5_900,
  appliedIntoNobull: 5_850,
  ingestGap: 100,
  applyGap: 50,
  fetchedCoveragePct: 98.3,
  appliedCoveragePct: 97.5,
  denominatorSource: "search_conversations",
  denominatorUnit: "conversations_all",
  numeratorUnit: "messages_all",
  unitsComparable: false,
});

const COVERAGE_FIXTURE = {
  adoptionDate: "2025-07-01",
  allTime: {
    frontTotalMessages: 120_000,
    fetchedIntoNobull: 14_808,
    appliedIntoNobull: 7_800,
    ingestGap: 105_192,
    applyGap: 7_008,
    fetchedCoveragePct: 12.34,
    appliedCoveragePct: 6.5,
    totalMonths: 2,
    inScopeMonths: 2,
    includedMonths: 1, // only the messages_all month counts toward the headline
    excludedWrongGrainMonths: 1,
    excludedPreFloorMonths: 0,
    inScopeCountedMonths: 1, // progress numerator
    inScopeExcludedMonths: 1, // not yet message-grain → progress < 100%
  },
  byMonth: [DIRECTIONS_MONTH, INCOMPARABLE_MONTH, MESSAGES_MONTH, CONVERSATIONS_MONTH],
  months: [DIRECTIONS_MONTH, INCOMPARABLE_MONTH, MESSAGES_MONTH, CONVERSATIONS_MONTH],
  thresholds: { monthFloorPct: 50, dropDeltaPct: 10 },
  lastRefreshedAt: "2026-06-01T12:00:00.000Z",
  generatedAt: "2026-06-01T12:00:00.000Z",
  triggerGates: {
    refreshEnabled: true,
    queuePaused: false,
    killSwitchNonCriticalSweeps: false,
    blockedReason: null,
  },
};

// A SECOND fixture for the DONE state: every in-scope month at message grain,
// nothing excluded → progress 100% and the done badge must render.
const COMPLETE_FIXTURE = {
  ...COVERAGE_FIXTURE,
  allTime: {
    ...COVERAGE_FIXTURE.allTime,
    includedMonths: 2,
    excludedWrongGrainMonths: 0,
    inScopeCountedMonths: 2,
    inScopeExcludedMonths: 0,
  },
  byMonth: [MESSAGES_MONTH, DIRECTIONS_MONTH],
  months: [MESSAGES_MONTH, DIRECTIONS_MONTH],
};

// ---------------------------------------------------------------------------
// Expected DISPLAY values derived from the canonical payload.
// ---------------------------------------------------------------------------

const expectedHeadlineAppliedPct = `${COVERAGE_FIXTURE.allTime.appliedCoveragePct.toFixed(2)}%`; // "6.50%"
const expectedHeadlineFetchedPct = `${COVERAGE_FIXTURE.allTime.fetchedCoveragePct.toFixed(2)}%`; // "12.34%"
const expectedHeadlineIngestGap = COVERAGE_FIXTURE.allTime.ingestGap.toLocaleString();
const expectedHeadlineApplyGap = COVERAGE_FIXTURE.allTime.applyGap.toLocaleString();

const expectedMsgMonthAppliedPct = `${MESSAGES_MONTH.appliedCoveragePct.toFixed(2)}%`; // "6.50%"

// Live progress numbers: 1 of 2 in-scope months at message grain → 50%, no done.
const expectedProgressPct = Math.round(
  (COVERAGE_FIXTURE.allTime.inScopeCountedMonths /
    COVERAGE_FIXTURE.allTime.inScopeMonths) *
    100,
); // 50

// ---------------------------------------------------------------------------
// Fetch stub helper — re-stubbable so we can mount a second (complete) fixture.
// ---------------------------------------------------------------------------

const ADMIN_USER = {
  id: "admin-2603",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

function installFetch(coverage: unknown): void {
  (globalThis as any).fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/auth/user", json: ADMIN_USER },
      { path: "/api/admin/front/analytics-coverage/alerts", json: { alerts: [], armed: [] } },
      { path: "/api/admin/front/analytics-coverage", json: coverage },
      { path: "/api/integrations/all-status", json: { front: { connected: true } } },
      { path: "/api/integrations/front/historical-recovery/coverage", json: { months: [], gaps: [] } },
      { path: "/api/integrations/front/historical-recovery/jobs", json: { jobs: [] } },
      { path: "/api/integrations/front/historical-recovery/max-age", json: { maxAgeDays: 90, min: 1, max: 365, history: [] } },
      { path: "/api/integrations/front/historical-recovery/prune-interval", json: { intervalMinutes: 60, min: 1, max: 1440, history: [] } },
      { path: "/api/integrations/front/historical-recovery/tuning", json: {} },
      { path: "/api/integrations/front/historical-recovery/sweep-status", json: {} },
      { path: "/api/integrations/front/historical-recovery/auto-continue-max-attempts", json: { maxAttempts: 3, history: [] } },
      { path: "/api/integrations/front/historical-recovery/retry-alert", json: {} },
      { path: "/api/integrations/front/historical-recovery/manual-sweep-history", json: { entries: [], onlyFailed: false } },
      { path: "/api/admin/front/auto-closure", json: {} },
      { path: "/api/clients", json: [] },
    ],
    defaultJson: {},
  });
}

installFetch(COVERAGE_FIXTURE);

// ---------------------------------------------------------------------------
// React imports — after jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { getQueryFn } = await import("../../client/src/lib/queryClient");
const { FrontHistoricalRecoveryPanel } = await import(
  "../../client/src/components/admin/FrontHistoricalRecoveryPanel"
);

async function flush(times = 16): Promise<void> {
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
      queries: {
        queryFn: getQueryFn({ on401: "throw" }),
        retry: false,
        refetchOnWindowFocus: false,
        refetchInterval: false,
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

let passed = 0;
function ok(name: string, detail?: string): void {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
}

// ---------------------------------------------------------------------------
// Scenario 0 — the fixture genuinely exercises the regressions. The conversation
// grain vocabulary must be non-empty (so "must not appear" assertions bite), and
// the conversations_all month must be present in the payload.
// ---------------------------------------------------------------------------

function scenario0_fixtureBites(): void {
  console.log("\n— Scenario 0: the fixture carries conversation-grain data the panel must NOT surface —");
  assert(
    CONVERSATIONS_GRAIN_LABEL.length > 0 && /conversation/i.test(CONVERSATIONS_GRAIN_LABEL),
    `conversation-grain label must be a real conversation string (got '${CONVERSATIONS_GRAIN_LABEL}')`,
  );
  assert(
    CONVERSATIONS_GRAIN_WORD.length > 0 && /conversation/i.test(CONVERSATIONS_GRAIN_WORD),
    `conversation grain word must be a real conversation string (got '${CONVERSATIONS_GRAIN_WORD}')`,
  );
  assert(
    CONVERSATIONS_MONTH.denominatorUnit === "conversations_all",
    "a conversations_all month must be present in the payload for the no-leak test to bite",
  );
  assert(
    !/conversation/i.test(FRONT_GRAIN_MESSAGES),
    `the message grain word must itself be free of 'conversation' (got '${FRONT_GRAIN_MESSAGES}')`,
  );
  ok(`conversation vocabulary present in payload: label '${CONVERSATIONS_GRAIN_LABEL}', word '${CONVERSATIONS_GRAIN_WORD}'`);
}

// ---------------------------------------------------------------------------
// Scenario 1 — the all-time headline renders the canonical message-grain figures
// at message grain, AND the live progress-to-100% indicator renders from the
// in-scope counted/total months (no done badge while a month is excluded).
// ---------------------------------------------------------------------------

async function scenario1_headlineAndProgress(): Promise<void> {
  console.log("\n— Scenario 1: message-grain headline + live progress indicator —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontHistoricalRecoveryPanel),
    ),
  );
  try {
    assert($("section-front-analytics-coverage") !== null, "coverage section must render");
    assert(
      $("grid-front-analytics-headline") !== null,
      "coverage headline grid must render (payload resolved, not empty/loading)",
    );
    ok("coverage section + headline grid mounted");

    // Headline % figures — message grain.
    assert(
      text("text-fa-applied-pct") === expectedHeadlineAppliedPct,
      `text-fa-applied-pct should be ${expectedHeadlineAppliedPct} (got '${text("text-fa-applied-pct")}')`,
    );
    assert(
      text("text-fa-fetched-pct") === expectedHeadlineFetchedPct,
      `text-fa-fetched-pct should be ${expectedHeadlineFetchedPct} (got '${text("text-fa-fetched-pct")}')`,
    );
    ok(`Applied % = ${expectedHeadlineAppliedPct}, Fetched % = ${expectedHeadlineFetchedPct}`);

    // Grain badges are message grain, never conversation grain.
    assert(
      text("text-fa-applied-grain") === FRONT_GRAIN_MESSAGES,
      `applied grain badge should be '${FRONT_GRAIN_MESSAGES}' (got '${text("text-fa-applied-grain")}')`,
    );
    assert(
      text("text-fa-fetched-grain") === FRONT_GRAIN_MESSAGES,
      `fetched grain badge should be '${FRONT_GRAIN_MESSAGES}' (got '${text("text-fa-fetched-grain")}')`,
    );
    assert(
      !/conversation/i.test(text("text-fa-applied-grain")) &&
        !/conversation/i.test(text("text-fa-fetched-grain")),
      "headline grain badges must not contain 'conversation'",
    );
    ok(`Both headline grain badges = '${FRONT_GRAIN_MESSAGES}' (message grain)`);

    // Gaps.
    assert(
      text("text-fa-ingest-gap") === expectedHeadlineIngestGap,
      `ingest gap should be ${expectedHeadlineIngestGap} (got '${text("text-fa-ingest-gap")}')`,
    );
    assert(
      text("text-fa-apply-gap") === expectedHeadlineApplyGap,
      `apply gap should be ${expectedHeadlineApplyGap} (got '${text("text-fa-apply-gap")}')`,
    );
    ok(`Ingest gap = ${expectedHeadlineIngestGap}, Apply gap = ${expectedHeadlineApplyGap}`);

    // LIVE progress indicator — % text + bar render, no done badge (excluded > 0).
    const progressText = text("text-fa-message-grain-progress-pct");
    assert(
      $("text-fa-message-grain-progress-pct") !== null,
      "live message-grain progress % must render",
    );
    assert(
      progressText.includes(`${expectedProgressPct}%`),
      `progress text must show ${expectedProgressPct}% (got '${progressText}')`,
    );
    assert(
      progressText.includes(
        `${COVERAGE_FIXTURE.allTime.inScopeCountedMonths} of ${COVERAGE_FIXTURE.allTime.inScopeMonths}`,
      ),
      `progress text must show the counted/total split (got '${progressText}')`,
    );
    assert($("bar-fa-message-grain-progress") !== null, "progress bar track must render");
    const fill = $("bar-fa-message-grain-progress-fill");
    assert(fill !== null, "progress bar fill must render");
    assert(
      (fill!.getAttribute("style") ?? "").includes(`${expectedProgressPct}%`),
      `progress bar fill width must be ${expectedProgressPct}% (got '${fill!.getAttribute("style")}')`,
    );
    assert(
      $("badge-fa-message-grain-complete") === null,
      "100% done badge must NOT render while a month is still excluded",
    );
    ok(`Live progress = ${expectedProgressPct}% with no done badge (1 of 2 in-scope months at message grain)`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1b — the DONE state: when every in-scope month is at message grain,
// progress reads 100% and the explicit done badge renders.
// ---------------------------------------------------------------------------

async function scenario1b_doneState(): Promise<void> {
  console.log("\n— Scenario 1b: 100% done state renders the complete badge —");
  installFetch(COMPLETE_FIXTURE);
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontHistoricalRecoveryPanel),
    ),
  );
  try {
    const progressText = text("text-fa-message-grain-progress-pct");
    assert(
      progressText.includes("100%"),
      `progress must read 100% when nothing is excluded (got '${progressText}')`,
    );
    const fill = $("bar-fa-message-grain-progress-fill");
    assert(fill !== null, "progress bar fill must render in done state");
    assert(
      (fill!.getAttribute("style") ?? "").includes("100%"),
      `progress bar fill must be 100% in done state (got '${fill!.getAttribute("style")}')`,
    );
    assert(
      $("badge-fa-message-grain-complete") !== null,
      "100% done badge MUST render when no month is excluded",
    );
    ok("Done state: 100% progress + complete badge render");
  } finally {
    await unmount(root);
    installFetch(COVERAGE_FIXTURE);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — per-month rows read at message grain. The messages_all row reads
// "message-grain"; the conversations_all row reads "pending message-grain" and
// surfaces NO conversation label. Each row still shows its own canonical % + gaps.
// ---------------------------------------------------------------------------

async function scenario2_monthlyRowsMessageGrain(): Promise<void> {
  console.log("\n— Scenario 2: per-month rows are message-grain only —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontHistoricalRecoveryPanel),
    ),
  );
  try {
    assert($(`row-fa-month-${MONTH_MESSAGES}`) !== null, `messages_all row (${MONTH_MESSAGES}) must render`);
    assert(
      $(`row-fa-month-${MONTH_CONVERSATIONS}`) !== null,
      `conversations_all row (${MONTH_CONVERSATIONS}) must render`,
    );
    ok("both monthly rows mounted");

    // messages_all row — applied % canonical; source label says message-grain.
    assert(
      text(`text-fa-applied-pct-${MONTH_MESSAGES}`) === expectedMsgMonthAppliedPct,
      `${MONTH_MESSAGES} applied % should be ${expectedMsgMonthAppliedPct} (got '${text(`text-fa-applied-pct-${MONTH_MESSAGES}`)}')`,
    );
    const msgSource = text(`text-fa-front-total-source-${MONTH_MESSAGES}`);
    assert(
      msgSource.includes("message-grain"),
      `${MONTH_MESSAGES} source label must say 'message-grain' (got '${msgSource}')`,
    );
    assert(
      !/conversation/i.test(msgSource),
      `${MONTH_MESSAGES} source label must contain no 'conversation' (got '${msgSource}')`,
    );
    ok(`${MONTH_MESSAGES}: applied ${expectedMsgMonthAppliedPct}, source 'message-grain' (no conversation word)`);

    // conversations_all row — reads "pending message-grain", NOT a conversation label.
    const convSource = text(`text-fa-front-total-source-${MONTH_CONVERSATIONS}`);
    assert(
      convSource.includes("pending message-grain"),
      `${MONTH_CONVERSATIONS} source label must say 'pending message-grain' (got '${convSource}')`,
    );
    assert(
      !convSource.includes(CONVERSATIONS_GRAIN_LABEL),
      `${MONTH_CONVERSATIONS} source label must NOT include '${CONVERSATIONS_GRAIN_LABEL}' (got '${convSource}')`,
    );
    assert(
      !/conversation/i.test(convSource),
      `${MONTH_CONVERSATIONS} source label must contain no 'conversation' (got '${convSource}')`,
    );
    assert(
      !convSource.includes("conversations_all"),
      `${MONTH_CONVERSATIONS} source label must NOT leak the raw conversations_all unit (got '${convSource}')`,
    );
    ok(`${MONTH_CONVERSATIONS}: source 'pending message-grain' — no conversation label, no raw unit`);

    // Per-month gaps from the row's own fields.
    assert(
      text(`text-fa-ingest-gap-${MONTH_MESSAGES}`) === MESSAGES_MONTH.ingestGap.toLocaleString(),
      `${MONTH_MESSAGES} ingest gap should be ${MESSAGES_MONTH.ingestGap.toLocaleString()} (got '${text(`text-fa-ingest-gap-${MONTH_MESSAGES}`)}')`,
    );
    assert(
      text(`text-fa-apply-gap-${MONTH_MESSAGES}`) === MESSAGES_MONTH.applyGap.toLocaleString(),
      `${MONTH_MESSAGES} apply gap should be ${MESSAGES_MONTH.applyGap.toLocaleString()} (got '${text(`text-fa-apply-gap-${MONTH_MESSAGES}`)}')`,
    );
    ok(`${MONTH_MESSAGES}: ingest gap ${MESSAGES_MONTH.ingestGap.toLocaleString()}, apply gap ${MESSAGES_MONTH.applyGap.toLocaleString()}`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2c — a month whose numerator/denominator are at INCOMPARABLE grains
// must SUPPRESS its applied/fetched % cells (render "—"), never a misleading
// percentage. Its comparable sibling in the SAME table still shows its real %.
// ---------------------------------------------------------------------------

const SUPPRESSED_CELL = "—";
const wrongIncomparableAppliedPct = `${INCOMPARABLE_MONTH.appliedCoveragePct.toFixed(2)}%`;
const wrongIncomparableFetchedPct = `${INCOMPARABLE_MONTH.fetchedCoveragePct.toFixed(2)}%`;

async function scenario2c_incomparableGrainSuppressed(): Promise<void> {
  console.log("\n— Scenario 2c: incomparable-grain month suppresses its % cells —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontHistoricalRecoveryPanel),
    ),
  );
  try {
    assert(
      $(`row-fa-month-${MONTH_INCOMPARABLE}`) !== null,
      `incomparable-grain month row (${MONTH_INCOMPARABLE}) must render`,
    );
    assert(
      $(`row-fa-month-${MONTH_MESSAGES}`) !== null,
      `comparable sibling month row (${MONTH_MESSAGES}) must render in the same table`,
    );
    ok("incomparable-grain row and its comparable sibling both mounted");

    assert(
      wrongIncomparableAppliedPct !== SUPPRESSED_CELL &&
        /\d/.test(wrongIncomparableAppliedPct) &&
        wrongIncomparableFetchedPct !== SUPPRESSED_CELL &&
        /\d/.test(wrongIncomparableFetchedPct),
      `incomparable month's raw %s must be real numbers for the test to bite`,
    );

    const incApplied = text(`text-fa-applied-pct-${MONTH_INCOMPARABLE}`);
    const incFetched = text(`text-fa-fetched-pct-${MONTH_INCOMPARABLE}`);
    assert(incApplied === SUPPRESSED_CELL, `${MONTH_INCOMPARABLE} applied % cell must render '—' (got '${incApplied}')`);
    assert(incFetched === SUPPRESSED_CELL, `${MONTH_INCOMPARABLE} fetched % cell must render '—' (got '${incFetched}')`);
    assert(
      !/\d/.test(incApplied) && !/\d/.test(incFetched),
      `${MONTH_INCOMPARABLE} % cells must contain no digit`,
    );
    ok(`${MONTH_INCOMPARABLE}: applied/fetched % suppressed to '—'`);

    const sibApplied = text(`text-fa-applied-pct-${MONTH_MESSAGES}`);
    const sibFetched = text(`text-fa-fetched-pct-${MONTH_MESSAGES}`);
    const expectedMsgMonthFetchedPct = `${MESSAGES_MONTH.fetchedCoveragePct.toFixed(2)}%`;
    assert(
      sibApplied === expectedMsgMonthAppliedPct && sibFetched === expectedMsgMonthFetchedPct,
      `comparable sibling ${MONTH_MESSAGES} must still show real %s (got applied='${sibApplied}', fetched='${sibFetched}')`,
    );
    ok(`comparable sibling ${MONTH_MESSAGES} still shows real applied ${sibApplied} + fetched ${sibFetched} — suppression is per-row`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2b — per-DIRECTION inbound/outbound coverage cells each show their
// own direction's canonical % + counts + gap; a swap or dropped direction fails.
// ---------------------------------------------------------------------------

const expectedInboundPct = `${DIRECTIONS_MONTH.messagesInboundCoveragePct.toFixed(2)}%`;
const expectedOutboundPct = `${DIRECTIONS_MONTH.messagesOutboundCoveragePct.toFixed(2)}%`;
const expectedInboundGap = DIRECTIONS_MONTH.messagesInboundGap.toLocaleString();
const expectedOutboundGap = DIRECTIONS_MONTH.messagesOutboundGap.toLocaleString();
const expectedInboundCounts = `${DIRECTIONS_MONTH.messagesInboundLocal.toLocaleString()} / ${DIRECTIONS_MONTH.messagesInboundFront.toLocaleString()}`;
const expectedOutboundCounts = `${DIRECTIONS_MONTH.messagesOutboundLocal.toLocaleString()} / ${DIRECTIONS_MONTH.messagesOutboundFront.toLocaleString()}`;

async function scenario2b_perDirectionCells(): Promise<void> {
  console.log("\n— Scenario 2b: per-direction inbound/outbound coverage cells —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontHistoricalRecoveryPanel),
    ),
  );
  try {
    assert($(`row-fa-month-${MONTH_DIRECTIONS}`) !== null, `directions month row (${MONTH_DIRECTIONS}) must render`);
    ok("directions month row mounted");

    const inboundCell = text(`text-fa-inbound-pct-${MONTH_DIRECTIONS}`);
    const outboundCell = text(`text-fa-outbound-pct-${MONTH_DIRECTIONS}`);

    assert(expectedInboundPct !== expectedOutboundPct, "inbound/outbound %s must differ for the test to bite");
    assert(expectedInboundGap !== expectedOutboundGap, "inbound/outbound gaps must differ for the test to bite");

    assert(inboundCell.includes(expectedInboundPct), `inbound cell must show ${expectedInboundPct} (got '${inboundCell}')`);
    assert(inboundCell.includes(expectedInboundCounts), `inbound cell must show ${expectedInboundCounts} (got '${inboundCell}')`);
    assert(inboundCell.includes(`gap ${expectedInboundGap}`), `inbound cell must show gap ${expectedInboundGap} (got '${inboundCell}')`);
    assert(!inboundCell.includes(expectedOutboundPct), `inbound cell must NOT show outbound % (got '${inboundCell}')`);
    ok(`inbound cell = ${expectedInboundPct}, ${expectedInboundCounts}, gap ${expectedInboundGap}`);

    assert(outboundCell.includes(expectedOutboundPct), `outbound cell must show ${expectedOutboundPct} (got '${outboundCell}')`);
    assert(outboundCell.includes(expectedOutboundCounts), `outbound cell must show ${expectedOutboundCounts} (got '${outboundCell}')`);
    assert(outboundCell.includes(`gap ${expectedOutboundGap}`), `outbound cell must show gap ${expectedOutboundGap} (got '${outboundCell}')`);
    assert(!outboundCell.includes(expectedInboundPct), `outbound cell must NOT show inbound % (got '${outboundCell}')`);
    ok(`outbound cell = ${expectedOutboundPct}, ${expectedOutboundCounts}, gap ${expectedOutboundGap}`);

    assert(inboundCell !== outboundCell, "inbound and outbound cells must render distinct content");
    ok("inbound and outbound cells render distinct content");

    const noDataInbound = text(`text-fa-inbound-pct-${MONTH_MESSAGES}`);
    const noDataOutbound = text(`text-fa-outbound-pct-${MONTH_MESSAGES}`);
    assert(noDataInbound.includes("not yet measured"), `no-data inbound cell must read 'not yet measured' (got '${noDataInbound}')`);
    assert(noDataOutbound.includes("not yet measured"), `no-data outbound cell must read 'not yet measured' (got '${noDataOutbound}')`);
    assert(
      !noDataInbound.includes("0.00%") && !noDataOutbound.includes("0.00%"),
      `no-data cells must NOT render a fake 0.00%`,
    );
    ok(`no-direction-data month (${MONTH_MESSAGES}) renders 'not yet measured', not a fake 0%`);
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4 — the WHOLE rendered surface carries NO conversation terminology.
// This is the headline guard for Task #2603: even with a conversations_all month
// in the payload, neither the conversation grain word, the conversation-grain
// inline label, the raw conversations_all unit, nor any "match rate
// (conversations)" / "tracked conversations" phrasing appears in the DOM text.
// ---------------------------------------------------------------------------

async function scenario4_noConversationTerminology(): Promise<void> {
  console.log("\n— Scenario 4: no conversation terminology renders anywhere —");
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontHistoricalRecoveryPanel),
    ),
  );
  try {
    const surface = document.getElementById("root")!.textContent ?? "";

    // Sanity: the surface is genuinely populated (so we're not asserting over an
    // empty/loading screen and getting a false pass).
    assert(
      surface.includes(expectedHeadlineAppliedPct) && surface.length > 200,
      "rendered surface must be populated before scanning for conversation terms",
    );

    assert(
      !/conversation/i.test(surface),
      `rendered surface must contain NO 'conversation' terminology`,
    );
    assert(
      !/\bconvos?\b/i.test(surface),
      `rendered surface must contain NO 'convo' shorthand`,
    );
    assert(
      !surface.includes(CONVERSATIONS_GRAIN_LABEL),
      `rendered surface must not include the conversation-grain label '${CONVERSATIONS_GRAIN_LABEL}'`,
    );
    assert(
      !surface.includes("conversations_all"),
      `rendered surface must not leak the raw conversations_all unit`,
    );
    // The conversations-vs-messages caption is gone.
    assert(
      !/Pipeline Health measures de-duplicated/i.test(surface),
      `the conversations-vs-messages caption must be removed`,
    );
    ok("no conversation count / match rate / grain label / caption in the rendered surface");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 5 — Task #2685 registry render-traceability + unsourced-figure guard.
//
// The whole point of the metric registry is that it is the SINGLE source of
// truth for every "completeness / coverage / gap" figure the console renders.
// This scenario enforces that bidirectionally:
//   (a) DOM render-traceability — every element the panel renders with a
//       `data-metric-id` resolves to a real registry descriptor (no orphan ids),
//       AND the full Lens-2 coverage set (headline + per-month) is present, so a
//       deleted/renamed figure fails here ("golden definitions").
//   (b) Source binding — each canonical figure's `data-testid` is bound to its
//       exact registry id via `getFrontConsoleMetric("…")` in the source, so a
//       figure can't be silently re-pointed at a different metric.
//   (c) Unsourced-figure guard — any `data-testid` in the coverage/gap/recovery
//       figure FAMILIES that is rendered WITHOUT a `data-metric-id` fails the
//       build, so a future "just add another %" can't bypass the registry. The
//       families are scoped to the completeness/coverage/gap numbers this task
//       owns (applied/fetched %, ingest/apply gap, front-total, recovery
//       scanned/ingested); per-direction inbound/outbound breakdowns and the
//       in-scope month-progress indicator are deliberately out of scope.
// ---------------------------------------------------------------------------

const PANEL_PATH = "client/src/components/admin/FrontHistoricalRecoveryPanel.tsx";
const RECOVERY_DIR = "client/src/components/admin/front/recovery";
const KPI_PATH = "client/src/components/admin/front/FrontKpiHeader.tsx";

// Canonical figure families that MUST be registry-sourced wherever they render.
// `text-fa-front-total` excludes the `-source` label variant (a unit caption,
// not a figure).
const FIGURE_FAMILIES: RegExp[] = [
  /text-fa-applied-pct/,
  /text-fa-fetched-pct/,
  /text-fa-ingest-gap/,
  /text-fa-apply-gap/,
  /text-fa-front-total(?!-source)/,
  /text-recovery-scanned/,
  /text-recovery-ingested/,
];

// Exact testid → registry id bindings the panel source must declare.
const PANEL_BINDINGS: Array<[string, string]> = [
  ['data-testid="text-fa-applied-pct"', "front.coverage.applied_pct"],
  ['data-testid="text-fa-fetched-pct"', "front.coverage.fetched_pct"],
  ['data-testid="text-fa-ingest-gap"', "front.coverage.ingest_gap"],
  ['data-testid="text-fa-apply-gap"', "front.coverage.apply_gap"],
  ["data-testid={`text-fa-front-total-${m.month}`}", "front.coverage.month_front_total"],
  ["data-testid={`text-fa-ingest-gap-${m.month}`}", "front.coverage.month_ingest_gap"],
  ["data-testid={`text-fa-apply-gap-${m.month}`}", "front.coverage.month_apply_gap"],
  ["data-testid={`text-fa-fetched-pct-${m.month}`}", "front.coverage.month_fetched_pct"],
  ["data-testid={`text-fa-applied-pct-${m.month}`}", "front.coverage.month_applied_pct"],
  ['data-testid="text-recovery-scanned"', "front.recovery.scanned"],
  ['data-testid="text-recovery-ingested"', "front.recovery.ingested"],
];

// Lens-2 coverage ids that MUST appear as rendered data-metric-ids (the recovery
// run figures are Lens 3 and only render with a live job, so they're covered by
// the source scan, not the DOM scan).
const LENS2_DOM_IDS = [
  "front.coverage.applied_pct",
  "front.coverage.fetched_pct",
  "front.coverage.ingest_gap",
  "front.coverage.apply_gap",
  "front.coverage.month_front_total",
  "front.coverage.month_ingest_gap",
  "front.coverage.month_apply_gap",
  "front.coverage.month_fetched_pct",
  "front.coverage.month_applied_pct",
];

function scanUnsourcedFigures(src: string, file: string): void {
  const testidRe = /data-testid=(?:"([^"]+)"|\{`([^`]+)`\})/g;
  let m: RegExpExecArray | null;
  while ((m = testidRe.exec(src)) !== null) {
    const value = m[1] ?? m[2] ?? "";
    if (!FIGURE_FAMILIES.some((re) => re.test(value))) continue;
    // The figure's element must carry a data-metric-id within the same opening
    // tag. We bound the look-forward window to the next closing `>`-ish region;
    // a generous 260-char window covers the multi-line `<span …>` recovery case.
    const window = src.slice(m.index, m.index + 260);
    assert(
      window.includes("data-metric-id"),
      `${file}: figure '${value}' renders WITHOUT a data-metric-id — every coverage/gap/recovery figure must be sourced from the metric registry`,
    );
  }
}

async function scenario5_registryTraceability(): Promise<void> {
  console.log("\n— Scenario 5: registry render-traceability + unsourced-figure guard —");

  // (b)+(c) Source-level guards — pure file scans, no render needed.
  // F11A split the panel into a composition root + front/recovery/* section
  // modules; the figure bindings live across that tree now, so scan the
  // concatenation (root first, then sections in stable order).
  const recoverySources = fs
    .readdirSync(RECOVERY_DIR)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .sort()
    .map((f) => fs.readFileSync(`${RECOVERY_DIR}/${f}`, "utf8"));
  const panelSrc = [fs.readFileSync(PANEL_PATH, "utf8"), ...recoverySources].join("\n");
  const kpiSrc = fs.readFileSync(KPI_PATH, "utf8");

  for (const [needle, id] of PANEL_BINDINGS) {
    const idx = panelSrc.indexOf(needle);
    assert(idx >= 0, `panel source must contain figure binding for '${needle}'`);
    const window = panelSrc.slice(idx, idx + 260);
    assert(
      window.includes(`getFrontConsoleMetric("${id}")`),
      `panel figure '${needle}' must be bound to registry id '${id}' via getFrontConsoleMetric(...)`,
    );
  }
  ok(`all ${PANEL_BINDINGS.length} panel figures bound to their exact registry id`);

  // Every getFrontConsoleMetric("…") literal across both files resolves (no typo
  // / unknown id can ship — getFrontConsoleMetric throws on an unknown id).
  const litRe = /getFrontConsoleMetric\("([^"]+)"\)/g;
  let lit: RegExpExecArray | null;
  let resolved = 0;
  for (const src of [panelSrc, kpiSrc]) {
    while ((lit = litRe.exec(src)) !== null) {
      const id = lit[1];
      const d = getFrontConsoleMetric(id); // throws if unknown
      assert(d.id === id, `registry id '${id}' must resolve to itself`);
      resolved++;
    }
  }
  assert(resolved >= PANEL_BINDINGS.length, "expected at least every panel binding to resolve");
  ok(`${resolved} getFrontConsoleMetric("…") literals all resolve to real registry descriptors`);

  scanUnsourcedFigures(panelSrc, "FrontHistoricalRecoveryPanel.tsx + front/recovery/*");
  scanUnsourcedFigures(kpiSrc, "FrontKpiHeader.tsx");
  ok("no coverage/gap/recovery figure renders without a registry-backed data-metric-id");

  // (a) DOM render-traceability — mount the panel and inspect what actually rendered.
  const qc = makeClient();
  const root = await mount(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(FrontHistoricalRecoveryPanel),
    ),
  );
  try {
    const els = Array.from(
      document.querySelectorAll("[data-metric-id]"),
    ) as HTMLElement[];
    assert(els.length > 0, "panel must render at least one registry-sourced figure");

    const renderedIds = new Set<string>();
    for (const el of els) {
      const id = el.getAttribute("data-metric-id") ?? "";
      const d = getFrontConsoleMetric(id); // throws if a rendered figure has an unknown id
      assert(d.id === id, `rendered data-metric-id '${id}' must resolve in the registry`);
      renderedIds.add(id);
    }
    ok(`${els.length} rendered figures all map to a registry descriptor (no orphan ids)`);

    for (const id of LENS2_DOM_IDS) {
      assert(
        renderedIds.has(id),
        `Lens-2 figure '${id}' must render with a data-metric-id (golden-definition coverage)`,
      );
    }
    ok(`all ${LENS2_DOM_IDS.length} Lens-2 coverage figures render with their registry id`);

    // Sanity: the registry genuinely has all three lenses represented, so this
    // guard isn't passing against an empty/half-built registry.
    const lenses = new Set(FRONT_CONSOLE_METRIC_REGISTRY.map((d) => d.lens));
    assert(
      lenses.has(1) && lenses.has(2) && lenses.has(3),
      "registry must define metrics for all three lenses",
    );
    ok("registry covers all three lenses (1 pipeline, 2 coverage, 3 recovery)");
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Run all scenarios.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Task #2603 — Front Console message-grain-only rendered-screen test\n");
  scenario0_fixtureBites();
  await scenario1_headlineAndProgress();
  await scenario1b_doneState();
  await scenario2_monthlyRowsMessageGrain();
  await scenario2c_incomparableGrainSuppressed();
  await scenario2b_perDirectionCells();
  await scenario4_noConversationTerminology();
  await scenario5_registryTraceability();
  console.log(`\n✅ All ${passed} assertions passed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n❌ ${err?.message ?? err}`);
    process.exit(1);
  });
