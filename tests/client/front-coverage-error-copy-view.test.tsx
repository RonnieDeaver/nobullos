/* test-registration
{
  "name": "Coverage error cell Copy + View/Hide controls (Task #2218)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-error-copy-view-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Frontend interaction test for the Front Analytics coverage table's
 * error-detail column (`FrontAnalyticsErrorCell`, testid
 * `text-fa-error-${month}`). Task #2182 locked the *render* of the
 * plain-English reason + raw error body (see the sibling test
 * tests/client/front-coverage-error-reason.test.tsx). This test closes
 * the remaining gap by exercising the cell's two interactive controls:
 *
 *   1. The "View / Hide" toggle (`button-fa-error-toggle-${month}`)
 *      expands the truncated raw error in place. Clicking it must:
 *        - flip the body styling between truncated (`truncate`, with a
 *          `max-w-[280px]`) and expanded (`whitespace-pre-wrap`), and
 *        - flip the toggle label between "View" and "Hide".
 *   2. The "Copy" button (`button-fa-error-copy-${month}`) writes the
 *      raw (unmodified) error string to the clipboard via
 *      navigator.clipboard.writeText. We stub navigator.clipboard and
 *      assert the exact argument.
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` that
 * serves a single error month. Harness copied from
 * tests/client/front-coverage-error-reason.test.tsx (Task #2182).
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2182 (the error-reason render test + jsdom panel-mount harness this
 *   copies), #1767 (the View toggle + Copy button this cell shipped),
 *   #1974 (reasonHuman / explainFrontAnalyticsError — plain-English
 *   reason first, raw error behind Copy / View), #2138 (sibling
 *   Status-cell pills test that established the panel-mount pattern).
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

// Stub navigator.clipboard so the Copy button's preferred path
// (navigator.clipboard.writeText) is exercised. jsdom's navigator has no
// clipboard by default; define a configurable writeText spy.
const clipboardCalls: string[] = [];
Object.defineProperty(dom.window.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      clipboardCalls.push(text);
    },
  },
});

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ADMIN_USER = {
  id: "admin-2218",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

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
    closedVia: null,
    ...overrides,
  };
}

const RAW_ERROR =
  "Front API returned 401 Unauthorized (token expired).\nbody: {\"_error\":{\"status\":401}}";
const HUMAN_REASON =
  "Front disconnected — reconnect Front in Integrations, then re-run this month.";

const MONTHS = [
  coverageMonth({
    month: "2026-06",
    frontAnalyticsStatus: "error",
    frontAnalyticsError: RAW_ERROR,
    reasonHuman: HUMAN_REASON,
    needsReconnect: true,
    completenessStatus: "apply-gap",
    completenessReason: "Fetched but not yet applied.",
    isFinalizedMonth: true,
  }),
];

function makeFetchHandler(opts: { user: any }): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", json: {} },
      {
        path: "/api/auth/user",
        respond: () =>
          opts.user ? { status: 200, json: opts.user } : { status: 401, json: {} },
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
      {
        path: /\/analytics-coverage\/outbound-gap-status$/,
        json: { config: { enabled: false, paused: false }, lastRun: null, gapMonths: [] },
      },
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

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(2);
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

    // --- View / Hide toggle ------------------------------------------------
    console.log("\n— View / Hide expand toggle (2026-06) —");
    {
      const toggle = $("button-fa-error-toggle-2026-06");
      assert(toggle !== null, "the View/Hide toggle must render for an error month");
      const body = $("text-fa-error-body-2026-06");
      assert(body !== null, "the raw error body must render for an error month");

      // Initial (collapsed) state: truncated, label "View".
      assert(
        body!.className.includes("truncate"),
        `collapsed body must use the truncate class — got "${body!.className}"`,
      );
      assert(
        body!.className.includes("max-w-[280px]"),
        `collapsed body must be width-capped — got "${body!.className}"`,
      );
      assert(
        !body!.className.includes("whitespace-pre-wrap"),
        "collapsed body must NOT be whitespace-pre-wrap",
      );
      assert(
        (toggle!.textContent || "").trim() === "View",
        `collapsed toggle label must be "View" — got "${toggle!.textContent}"`,
      );
      console.log("  ✓ initial collapsed: truncate + label View");

      // Expand.
      await click(toggle!);
      const bodyExpanded = $("text-fa-error-body-2026-06")!;
      const toggleExpanded = $("button-fa-error-toggle-2026-06")!;
      assert(
        bodyExpanded.className.includes("whitespace-pre-wrap"),
        `expanded body must use whitespace-pre-wrap — got "${bodyExpanded.className}"`,
      );
      assert(
        !bodyExpanded.className.includes("truncate"),
        "expanded body must NOT be truncated",
      );
      assert(
        (toggleExpanded.textContent || "").trim() === "Hide",
        `expanded toggle label must flip to "Hide" — got "${toggleExpanded.textContent}"`,
      );
      console.log("  ✓ after expand: whitespace-pre-wrap + label Hide");

      // Collapse again.
      await click(toggleExpanded);
      const bodyCollapsed = $("text-fa-error-body-2026-06")!;
      const toggleCollapsed = $("button-fa-error-toggle-2026-06")!;
      assert(
        bodyCollapsed.className.includes("truncate") &&
          !bodyCollapsed.className.includes("whitespace-pre-wrap"),
        `re-collapsed body must be truncated again — got "${bodyCollapsed.className}"`,
      );
      assert(
        (toggleCollapsed.textContent || "").trim() === "View",
        `re-collapsed toggle label must flip back to "View" — got "${toggleCollapsed.textContent}"`,
      );
      console.log("  ✓ after re-collapse: truncate + label View");
    }

    // --- Copy button -------------------------------------------------------
    console.log("\n— Copy button writes raw error to clipboard (2026-06) —");
    {
      const copyBtn = $("button-fa-error-copy-2026-06");
      assert(copyBtn !== null, "the Copy button must render for an error month");

      clipboardCalls.length = 0;
      await click(copyBtn!);

      assert(
        clipboardCalls.length === 1,
        `Copy must call navigator.clipboard.writeText exactly once — got ${clipboardCalls.length}`,
      );
      assert(
        clipboardCalls[0] === RAW_ERROR,
        `Copy must write the unmodified raw error string — got "${clipboardCalls[0]}"`,
      );
      console.log("  ✓ navigator.clipboard.writeText called with raw error");
    }

    console.log("\nfront-coverage-error-copy-view: all interaction cases passed");
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
