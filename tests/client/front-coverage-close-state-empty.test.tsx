/* test-registration
{
  "name": "Coverage table close-state empty message (Task #2183)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-close-state-empty-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2183 — Frontend regression test for the Front Analytics coverage
 * table's close-state filter EMPTY-STATE branch (added by Task #2088, sibling
 * to the happy-path filter test added by Task #2139).
 *
 * Task #2088's close-state filter has an empty-state branch in the coverage
 * table body: when the active filter (open / parked / dedupe_closed) matches
 * zero months it renders a single full-width cell reading
 *   "No months match this close-state filter."
 * and when the filter is "all" and there are simply no monthly rows it reads
 *   "No monthly rows yet."
 *
 * Task #2139 covered the happy path (filter narrows to the right rows + the
 * correct per-row badge) but did NOT cover this empty-state branch. A future
 * refactor could break the empty message or the full-width colSpan layout
 * without any test catching it. This locks that contract:
 *
 *   1. With months that are ALL open (none parked, none dedupe-closed),
 *      clicking "Parked" and then "Webhook-dedupe-closed" each leaves the
 *      table body with NO row-fa-month-* rows and shows the single
 *      "No months match this close-state filter." cell spanning every column.
 *   2. With an EMPTY months payload, the default "all" filter shows the single
 *      "No monthly rows yet." cell (not the close-state-filter message).
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`, exactly like
 * the sibling Task #2139 test — the only differences are the months payload
 * (all-open vs empty) and that we assert the empty branch instead of rows.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2088 (close-state column + filter + empty branch — the surface under
 *   test), #2139 (the happy-path filter test this copies its harness from),
 *   #2091 / #2087 / #2058 / #2021 (the panel-mount jsdom harness pattern).
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
(globalThis as any).HTMLTableCellElement = dom.window.HTMLTableCellElement;
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
  id: "admin-2183",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// A clean "covered, no error" row. Every month here is OPEN: closedVia null
// and (in the all-open payload below) not present in parkedWindows.
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

// All three months are OPEN — none parked, none dedupe-closed — so the
// "Parked" and "Webhook-dedupe-closed" filters both match zero rows.
const ALL_OPEN_MONTHS = [
  coverageMonth({ month: "2026-01" }),
  coverageMonth({ month: "2026-02" }),
  coverageMonth({ month: "2026-03" }),
];
const ALL_OPEN_MONTH_KEYS = ["2026-01", "2026-02", "2026-03"];

const EXPECTED_EMPTY_COLSPAN = 15;

// `months` is supplied per-mount so we can serve an all-open payload for the
// close-state-filter empty branch and an empty payload for the "all" branch.
function makeFetchHandler(opts: { user: any; months: any[] }): (url: string, init?: any) => Promise<Response> {
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
          months: opts.months,
        },
      },
      // Empty auto-closure status so NO month is parked.
      {
        path: /\/api\/admin\/front\/auto-closure\/status$/,
        json: {
          enabled: true,
          currentMode: "daytime",
          parkedWindows: {},
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
  return ALL_OPEN_MONTH_KEYS.filter((m) => $(`row-fa-month-${m}`) !== null);
}

// The empty branch renders a single <tr><td colSpan=15>…</td></tr> in the
// table body. Returns that cell, or null when rows are present instead.
function emptyCell(): HTMLTableCellElement | null {
  const table = $("table-front-analytics-monthly");
  if (!table) return null;
  const tbody = table.querySelector("tbody");
  if (!tbody) return null;
  // When the empty branch renders there is exactly one row with one cell and
  // no row-fa-month-* rows. Find a td that carries a colSpan.
  const cells = Array.from(tbody.querySelectorAll("td")) as HTMLTableCellElement[];
  const spanning = cells.find((c) => c.colSpan && c.colSpan > 1);
  return spanning ?? null;
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

// --- Case 1: filter matches zero months → close-state-filter empty message --
async function testCloseStateFilterEmpty(): Promise<void> {
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER, months: ALL_OPEN_MONTHS });
  const root = await mountPanel();
  try {
    assert(
      $("table-front-analytics-monthly") !== null,
      "the monthly analytics coverage table must render for an admin with Front connected",
    );
    assert($("filter-fa-close-state") !== null, "the close-state filter row must render");

    // Sanity: with the default "all" filter every (open) month renders and the
    // empty branch is NOT showing.
    console.log("\n— default filter: all (all-open months) —");
    assert(
      sortedEq(visibleMonths(), ALL_OPEN_MONTH_KEYS),
      `default filter must show every open month — got ${JSON.stringify(visibleMonths())}`,
    );
    assert(emptyCell() === null, "the empty cell must NOT render while rows are present");
    console.log(`  ✓ all ${ALL_OPEN_MONTH_KEYS.length} open rows render under "all"`);

    // "Parked" matches zero rows → empty message + no month rows.
    console.log("\n— filter: parked (matches zero) —");
    await clickFilter("parked");
    assert(
      visibleMonths().length === 0,
      `parked filter must hide every row — still saw ${JSON.stringify(visibleMonths())}`,
    );
    const parkedCell = emptyCell();
    assert(parkedCell !== null, "parked filter with zero matches must render the empty cell");
    assert(
      (parkedCell!.textContent || "").trim() === "No months match this close-state filter.",
      `parked empty cell text must be the close-state-filter message — got ${JSON.stringify(
        (parkedCell!.textContent || "").trim(),
      )}`,
    );
    assert(
      parkedCell!.colSpan === EXPECTED_EMPTY_COLSPAN,
      `parked empty cell must span all ${EXPECTED_EMPTY_COLSPAN} columns — got ${parkedCell!.colSpan}`,
    );
    console.log("  ✓ parked filter shows the full-width close-state-filter empty message");

    // "Webhook-dedupe-closed" also matches zero rows → same message.
    console.log("\n— filter: dedupe_closed (matches zero) —");
    await clickFilter("dedupe_closed");
    assert(
      visibleMonths().length === 0,
      `dedupe filter must hide every row — still saw ${JSON.stringify(visibleMonths())}`,
    );
    const dedupeCell = emptyCell();
    assert(dedupeCell !== null, "dedupe filter with zero matches must render the empty cell");
    assert(
      (dedupeCell!.textContent || "").trim() === "No months match this close-state filter.",
      `dedupe empty cell text must be the close-state-filter message — got ${JSON.stringify(
        (dedupeCell!.textContent || "").trim(),
      )}`,
    );
    assert(
      dedupeCell!.colSpan === EXPECTED_EMPTY_COLSPAN,
      `dedupe empty cell must span all ${EXPECTED_EMPTY_COLSPAN} columns — got ${dedupeCell!.colSpan}`,
    );
    console.log("  ✓ dedupe filter shows the full-width close-state-filter empty message");

    // Back to "all" restores all rows and clears the empty cell.
    console.log("\n— filter: back to all —");
    await clickFilter("all");
    assert(
      sortedEq(visibleMonths(), ALL_OPEN_MONTH_KEYS),
      `returning to "all" must restore every open month — got ${JSON.stringify(visibleMonths())}`,
    );
    assert(emptyCell() === null, "returning to all must clear the empty cell");
    console.log("  ✓ returning to all restores every row");
  } finally {
    await unmount(root);
  }
}

// --- Case 2: empty months payload under "all" → "No monthly rows yet." -------
async function testAllFilterNoRows(): Promise<void> {
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER, months: [] });
  const root = await mountPanel();
  try {
    console.log("\n— empty months payload, default filter: all —");
    assert(
      $("table-front-analytics-monthly") !== null,
      "the monthly analytics coverage table must still render with an empty months payload",
    );
    assert(visibleMonths().length === 0, "an empty months payload must render no month rows");
    const cell = emptyCell();
    assert(cell !== null, '"all" with no rows must render the empty cell');
    assert(
      (cell!.textContent || "").trim() === "No monthly rows yet.",
      `"all" empty cell text must be the no-rows message — got ${JSON.stringify(
        (cell!.textContent || "").trim(),
      )}`,
    );
    assert(
      cell!.colSpan === EXPECTED_EMPTY_COLSPAN,
      `"all" empty cell must span all ${EXPECTED_EMPTY_COLSPAN} columns — got ${cell!.colSpan}`,
    );
    console.log('  ✓ empty payload under "all" shows the full-width "No monthly rows yet." message');
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  await testCloseStateFilterEmpty();
  await testAllFilterNoRows();

  console.log("\nfront-coverage-close-state-empty: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
