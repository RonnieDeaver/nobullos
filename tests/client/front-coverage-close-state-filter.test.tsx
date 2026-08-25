/* test-registration
{
  "name": "Coverage table close-state filter + badges (Task #2139)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-close-state-filter-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2139 — Frontend regression test for the Front Analytics coverage
 * table's close-state filter + per-row close-state badge (added by
 * Task #2088).
 *
 * Task #2088 added:
 *   - a close-state filter row (`filter-fa-close-state`) with four buttons
 *     `button-fa-close-state-filter-{all,open,parked,dedupe_closed}`, and
 *   - a per-row close-state cell that renders exactly one of:
 *       badge-fa-close-state-parked-${month}   (month in
 *                                                autoClosureStatus.parkedWindows)
 *       badge-fa-close-state-dedupe-${month}    (closedVia === "webhook_dedupe")
 *       badge-fa-close-state-open-${month}      (neither)
 *
 * There was no render test that the filter actually narrows the rows or that
 * each row shows the correct badge. This locks the UI contract:
 *
 *   1. With the default "all" filter every month renders, and each row shows
 *      the close-state badge that matches its source signal — parked is driven
 *      by the *live* `autoClosureStatus.parkedWindows` map, dedupe is driven by
 *      the *persisted* per-row `closedVia === "webhook_dedupe"`.
 *   2. Clicking "Open" leaves only the open months.
 *   3. Clicking "Parked" leaves only the parked month.
 *   4. Clicking "Webhook-dedupe-closed" leaves only the dedupe-closed month.
 *   5. Clicking back to "All" restores every month.
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. Unlike the
 * sibling completeness-badge test, this one serves a non-empty
 * `/api/admin/front/auto-closure/status` payload so a month can be "parked".
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2088 (close-state column + filter — the surface under test), #2091 /
 *   #2087 (the sibling jsdom panel-mount badge test this copies), #2058 /
 *   #2021 (this panel-mount harness pattern), #1837 / #1974 (per-direction
 *   coverage + denominator semantics behind each row).
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
// wouter's useLocation (reached via the real use-auth hook once @clerk/react is
// stubbed) reads the global `location`/`history` and subscribes to navigation
// events — bind them to this suite's jsdom window before react-dom evaluates.
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ADMIN_USER = {
  id: "admin-2139",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// A clean "covered, no error" row so the close-state cell is the only
// interesting thing per row. `closedVia` is overridden per month.
function coverageMonth(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    frontTotalMessages: 1000,
    fetchedIntoNobull: 1000,
    appliedIntoNobull: 1000,
    ingestGap: 0,
    applyGap: 0,
    fetchedCoveragePct: 100,
    appliedCoveragePct: 100,
    messagesInboundCoveragePct: 100,
    messagesOutboundCoveragePct: 100,
    unitsComparable: true,
    frontAnalyticsStatus: "ok",
    frontAnalyticsError: null,
    reasonHuman: null,
    needsReconnect: false,
    unrecoverable: false,
    pulledAt: "2026-04-01T00:00:00.000Z",
    denominatorSource: "analytics_reports",
    denominatorUnit: "inbound_messages",
    completenessStatus: "covered",
    completenessReason: "Finalized month, no material gap.",
    isFinalizedMonth: true,
    closedVia: null,
    ...overrides,
  };
}

// Two open months, one parked (via autoClosureStatus.parkedWindows), one
// webhook-dedupe-closed (via closedVia). The parked month carries
// closedVia: null so we know the parked badge wins from the *live* signal,
// not from a persisted column.
const PARKED_MONTH = "2026-02";

const MONTHS = [
  coverageMonth({ month: "2026-01" }), // open
  coverageMonth({ month: PARKED_MONTH }), // parked (live signal)
  coverageMonth({ month: "2026-03", closedVia: "webhook_dedupe" }), // dedupe
  coverageMonth({ month: "2026-04" }), // open
];

const ALL_MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04"];
const OPEN_MONTHS = ["2026-01", "2026-04"];
const PARKED_MONTHS = ["2026-02"];
const DEDUPE_MONTHS = ["2026-03"];

function makeFetchHandler(opts: { user: any }): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", json: {} },
      {
        path: "/api/auth/user",
        respond: () => (opts.user ? { status: 200, json: opts.user } : { status: 401, json: {} }),
      },
      { path: "/api/integrations/all-status", json: { front: { connected: true } } },
      {
        path: /\/api\/admin\/front\/analytics-coverage$/,
        json: {
          adoptionDate: "2025-01-01",
          lastRefreshedAt: "2026-05-29T00:00:00.000Z",
          thresholds: { monthFloorPct: 95 },
          allTime: {
            appliedCoveragePct: 100,
            fetchedCoveragePct: 100,
            appliedIntoNobull: 0,
            fetchedIntoNobull: 0,
            frontTotalMessages: 0,
            ingestGap: 0,
            applyGap: 0,
          },
          months: MONTHS,
        },
      },
      // Non-empty auto-closure status so PARKED_MONTH is in parkedWindows.
      {
        path: /\/api\/admin\/front\/auto-closure\/status$/,
        json: {
          enabled: true,
          currentMode: "daytime",
          parkedWindows: { [PARKED_MONTH]: { parkedAt: "2026-05-01T00:00:00.000Z" } },
          reArmDrains: {},
        },
      },
      {
        path: /\/analytics-coverage\/outbound-gap-status$/,
        json: { config: { enabled: false, paused: false }, lastRun: null, gapMonths: [] },
      },
      // Benign empty payloads for incidental requests the panel makes.
      { path: /\/historical-recovery\/jobs/, json: { jobs: [] } },
      { path: /\/historical-recovery\/coverage/, json: { windows: [] } },
      {
        path: /\/historical-recovery\/sweep-status/,
        json: {
          running: false,
          inFlight: false,
          intervalMs: 60000,
          lastSweepAt: null,
          lastPrunedCount: 0,
          lastError: null,
        },
      },
      { path: /\/historical-recovery\/manual-sweep-history/, json: { entries: [] } },
    ],
    defaultJson: {},
  });
}

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const { FrontHistoricalRecoveryPanel } = await import(
  "../../client/src/components/admin/FrontHistoricalRecoveryPanel"
);

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

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

function visibleMonths(): string[] {
  return ALL_MONTHS.filter((m) => $(`row-fa-month-${m}`) !== null);
}

async function clickFilter(key: "all" | "open" | "parked" | "dedupe_closed"): Promise<void> {
  const btn = $(`button-fa-close-state-filter-${key}`);
  assert(btn !== null, `filter button "${key}" must render`);
  await act(async () => {
    btn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mountPanel(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(FrontHistoricalRecoveryPanel as any),
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
}

function sortedEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    assert(
      $("table-front-analytics-monthly") !== null,
      "the monthly analytics coverage table must render for an admin with Front connected",
    );
    assert(
      $("filter-fa-close-state") !== null,
      "the close-state filter row must render",
    );

    // --- 1. Default "all": every month + correct per-row badge --------------
    console.log("\n— default filter: all —");
    assert(
      sortedEq(visibleMonths(), ALL_MONTHS),
      `default filter must show every month — got ${JSON.stringify(visibleMonths())}`,
    );
    // Open months → open badge only.
    for (const m of OPEN_MONTHS) {
      assert($(`badge-fa-close-state-open-${m}`) !== null, `${m} must show the open badge`);
      assert($(`badge-fa-close-state-parked-${m}`) === null, `${m} must not show the parked badge`);
      assert($(`badge-fa-close-state-dedupe-${m}`) === null, `${m} must not show the dedupe badge`);
    }
    // Parked month → parked badge only (driven by the live auto-closure map,
    // even though its persisted closedVia is null).
    for (const m of PARKED_MONTHS) {
      assert($(`badge-fa-close-state-parked-${m}`) !== null, `${m} must show the parked badge`);
      assert($(`badge-fa-close-state-open-${m}`) === null, `${m} must not show the open badge`);
      assert($(`badge-fa-close-state-dedupe-${m}`) === null, `${m} must not show the dedupe badge`);
    }
    // Dedupe month → dedupe badge only (driven by persisted closedVia).
    for (const m of DEDUPE_MONTHS) {
      assert($(`badge-fa-close-state-dedupe-${m}`) !== null, `${m} must show the dedupe badge`);
      assert($(`badge-fa-close-state-open-${m}`) === null, `${m} must not show the open badge`);
      assert($(`badge-fa-close-state-parked-${m}`) === null, `${m} must not show the parked badge`);
    }
    console.log(`  ✓ all ${ALL_MONTHS.length} rows render with the correct badge`);

    // --- 2. "Open" filter ---------------------------------------------------
    console.log("\n— filter: open —");
    await clickFilter("open");
    assert(
      sortedEq(visibleMonths(), OPEN_MONTHS),
      `open filter must show only ${JSON.stringify(OPEN_MONTHS)} — got ${JSON.stringify(visibleMonths())}`,
    );
    for (const m of OPEN_MONTHS) {
      assert($(`badge-fa-close-state-open-${m}`) !== null, `${m} open badge must remain under the open filter`);
    }
    console.log(`  ✓ open filter narrows to ${JSON.stringify(OPEN_MONTHS)}`);

    // --- 3. "Parked" filter -------------------------------------------------
    console.log("\n— filter: parked —");
    await clickFilter("parked");
    assert(
      sortedEq(visibleMonths(), PARKED_MONTHS),
      `parked filter must show only ${JSON.stringify(PARKED_MONTHS)} — got ${JSON.stringify(visibleMonths())}`,
    );
    for (const m of PARKED_MONTHS) {
      assert($(`badge-fa-close-state-parked-${m}`) !== null, `${m} parked badge must remain under the parked filter`);
    }
    console.log(`  ✓ parked filter narrows to ${JSON.stringify(PARKED_MONTHS)}`);

    // --- 4. "Webhook-dedupe-closed" filter ----------------------------------
    console.log("\n— filter: dedupe_closed —");
    await clickFilter("dedupe_closed");
    assert(
      sortedEq(visibleMonths(), DEDUPE_MONTHS),
      `dedupe filter must show only ${JSON.stringify(DEDUPE_MONTHS)} — got ${JSON.stringify(visibleMonths())}`,
    );
    for (const m of DEDUPE_MONTHS) {
      assert($(`badge-fa-close-state-dedupe-${m}`) !== null, `${m} dedupe badge must remain under the dedupe filter`);
    }
    console.log(`  ✓ dedupe filter narrows to ${JSON.stringify(DEDUPE_MONTHS)}`);

    // --- 5. Back to "All" restores everything -------------------------------
    console.log("\n— filter: back to all —");
    await clickFilter("all");
    assert(
      sortedEq(visibleMonths(), ALL_MONTHS),
      `returning to "all" must restore every month — got ${JSON.stringify(visibleMonths())}`,
    );
    console.log(`  ✓ all filter restores ${ALL_MONTHS.length} rows`);

    console.log("\nfront-coverage-close-state-filter: all DOM cases passed");
  } finally {
    await unmount(root);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
