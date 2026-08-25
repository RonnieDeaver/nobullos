/* test-registration
{
  "name": "Coverage table plain-English error reason column (Task #2182)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-error-reason-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Frontend regression test for the Front Analytics coverage table's dedicated
 * *error-detail* column (testid `text-fa-error-${month}`), which renders the
 * `FrontAnalyticsErrorCell` component. That cell turns a raw Front API error
 * (`frontAnalyticsError`) plus the server-derived plain-English reason
 * (`reasonHuman`, produced by explainFrontAnalyticsError) into an
 * operator-readable explanation.
 *
 * Task #2138's sibling test (tests/client/front-coverage-status-pills.test.tsx)
 * locked the Status-cell pills (error / unrecoverable / pending / search
 * source) but did NOT cover this separate error-detail column. A refactor
 * could drop or garble the human reason without any test catching it. This
 * test closes that gap:
 *
 *   1. A month with both `frontAnalyticsError` and `reasonHuman` set renders
 *      the plain-English reason (`text-fa-error-reason-${month}`) inside the
 *      error column, and the raw error stays accessible in the body
 *      (`text-fa-error-body-${month}`).
 *   2. A month with a raw error but NO `reasonHuman` renders the raw error
 *      body and no reason node.
 *   3. A clean month (no error) renders an empty error cell.
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` that serves a
 * coverage payload whose `months` exercise each case. The close-state filter
 * defaults to "all", so all rows render.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2138 (the sibling Status-cell pills render test + jsdom panel-mount
 *   harness this copies), #2091 (the completeness-badge render harness #2138
 *   itself copied), #1974 (reasonHuman / explainFrontAnalyticsError —
 *   plain-English reason surfaced first, raw error behind Copy / View),
 *   #1837 / #1974 (denominator source/unit semantics behind the row).
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
  id: "admin-2182",
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

const RAW_ERROR_WITH_REASON = "Front API returned 401 Unauthorized (token expired).";
const HUMAN_REASON =
  "Front disconnected — reconnect Front in Integrations, then re-run this month.";
const RAW_ERROR_NO_REASON = "Front API returned 500 after exhausting retries.";

const MONTHS = [
  // 1. Error WITH a server-derived plain-English reason.
  coverageMonth({
    month: "2026-06",
    frontAnalyticsStatus: "error",
    frontAnalyticsError: RAW_ERROR_WITH_REASON,
    reasonHuman: HUMAN_REASON,
    needsReconnect: true,
    completenessStatus: "apply-gap",
    completenessReason: "Fetched but not yet applied.",
    isFinalizedMonth: true,
  }),
  // 2. Error WITHOUT a human reason — raw error only.
  coverageMonth({
    month: "2026-07",
    frontAnalyticsStatus: "error",
    frontAnalyticsError: RAW_ERROR_NO_REASON,
    reasonHuman: null,
    completenessStatus: "apply-gap",
    completenessReason: "Fetched but not yet applied.",
    isFinalizedMonth: true,
  }),
  // 3. Clean month — no error at all; error cell must be empty.
  coverageMonth({
    month: "2026-08",
    frontAnalyticsStatus: "ok",
    frontAnalyticsError: null,
    reasonHuman: null,
    completenessStatus: "covered",
    completenessReason: "Finalized month, no material gap.",
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

    // 1. Error + human reason month.
    console.log("\n— error + human reason (2026-06) —");
    {
      const cell = $("text-fa-error-2026-06");
      assert(cell !== null, "the error column cell must render for a month with frontAnalyticsError");

      const reason = $("text-fa-error-reason-2026-06");
      assert(
        reason !== null,
        "the plain-English reason node must render when reasonHuman is set",
      );
      assert(
        (reason!.textContent || "").trim() === HUMAN_REASON,
        `the reason text must be the server-derived human reason — got "${reason!.textContent}"`,
      );
      // The reason must live inside the dedicated error column cell.
      assert(
        cell!.contains(reason),
        "the plain-English reason must render inside the text-fa-error column cell",
      );

      // The raw error stays accessible in the body (behind Copy / View).
      const body = $("text-fa-error-body-2026-06");
      assert(body !== null, "the raw error body must still render alongside the reason");
      assert(
        (body!.textContent || "").trim() === RAW_ERROR_WITH_REASON,
        `the raw error body must show the unmodified error — got "${body!.textContent}"`,
      );
      console.log("  ✓ plain-English reason + raw error body both present");
    }

    // 2. Error WITHOUT a human reason — raw error only.
    console.log("\n— error, no human reason (2026-07) —");
    {
      const cell = $("text-fa-error-2026-07");
      assert(cell !== null, "the error column cell must render for an error month");

      assert(
        $("text-fa-error-reason-2026-07") === null,
        "no plain-English reason node must render when reasonHuman is null",
      );

      const body = $("text-fa-error-body-2026-07");
      assert(body !== null, "the raw error body must render when only a raw error is present");
      assert(
        (body!.textContent || "").trim() === RAW_ERROR_NO_REASON,
        `the raw error body must show the raw error — got "${body!.textContent}"`,
      );
      console.log("  ✓ raw error body present, no reason node");
    }

    // 3. Clean month — empty error cell.
    console.log("\n— clean month (2026-08) —");
    {
      const cell = $("text-fa-error-2026-08");
      assert(cell !== null, "the error column cell must still render (as a <td>) for a clean month");
      assert(
        (cell!.textContent || "").trim() === "",
        `a clean month's error cell must be empty — got "${cell!.textContent}"`,
      );
      assert(
        $("text-fa-error-reason-2026-08") === null,
        "a clean month must not render a reason node",
      );
      assert(
        $("text-fa-error-body-2026-08") === null,
        "a clean month must not render an error body node",
      );
      console.log("  ✓ empty error cell, no reason/body nodes");
    }

    console.log("\nfront-coverage-error-reason: all DOM cases passed");
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
