/* test-registration
{
  "name": "Front trigger blocked-reason reaches operator toast \u2014 refresh/reprobe/recompute (Task #2251)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-trigger-blocked-reasons-toast-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2251 — Verify the plain-English "blocked" reason actually reaches
 * the operator's toast for the three Front analytics-coverage trigger
 * buttons (refresh-month / reprobe-month / recompute).
 *
 * The server test (tests/front-analytics-trigger-blocked-reasons.test.ts)
 * confirms each route returns BOTH the machine `error` AND a plain-English
 * `reason` in its 503 body. This client DOM test closes the loop: it
 * mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`, presses
 * each trigger button, makes the route reject with a 503 `{ error, reason }`
 * body, and asserts the resulting destructive toast's *description* is the
 * friendly `reason` sentence — proving the panel's `extractBlockedReason`
 * helper pulls it out of the thrown `apiRequest` message ("<status>: <body>")
 * rather than dropping it and showing the raw machine code.
 *
 * Mirrors the harness in tests/client/outbound-gap-close-run-now.test.tsx.
 *
 * For each of the three routes we exercise all three shared gates:
 *   1. master refresh setting OFF → `front_analytics_refresh_enabled=false`
 *   2. queue paused               → `queue paused via queue_drain_state`
 *   3. KILL_SWITCH_NON_CRITICAL_SWEEPS ON
 * and assert both the route-specific title mapping AND that the toast
 * description equals the plain-English reason (not the raw error).
 */

import { JSDOM } from "jsdom";
import { installJsdomGlobals } from "../helpers/installJsdomGlobals";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
installJsdomGlobals(dom);

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Configurable fetch stub
// ---------------------------------------------------------------------------

type PostCall = { url: string; body: any };
let postCalls: PostCall[] = [];

// Keyed by route suffix; when set the matching POST resolves with this
// status/body instead of a default 200 so we can drive each trigger
// mutation's onError handler.
let postResponses: Record<string, { status: number; body: any }> = {};

const ADMIN_USER = {
  id: "admin-2251",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// A single coverage month whose denominator came from the search
// fallback so BOTH the per-row Retry (refresh-month) and Re-probe
// (reprobe-month) buttons render. The Recompute button lives in the
// section header and always renders once an adoption date is set.
const COVERAGE_MONTH = "2025-03";

function analyticsCoveragePayload() {
  return {
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
    months: [
      {
        month: COVERAGE_MONTH,
        frontTotalMessages: 100,
        fetchedIntoNobull: 100,
        appliedIntoNobull: 100,
        ingestGap: 0,
        applyGap: 0,
        fetchedCoveragePct: 100,
        appliedCoveragePct: 100,
        unitsComparable: true,
        frontAnalyticsStatus: "ok",
        frontAnalyticsError: null,
        // search-sourced → renders both Retry and Re-probe Analytics buttons
        denominatorSource: "search_conversations",
        denominatorUnit: "conversations_all",
        pulledAt: "2026-05-29T00:00:00.000Z",
      },
    ],
  };
}

function makeFetchHandler(opts: { user: any }): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        method: "POST",
        respond: ({ url, init }) => {
          let parsed: any = null;
          try {
            parsed = init?.body ? JSON.parse(String(init.body)) : null;
          } catch {
            parsed = init?.body ?? null;
          }
          postCalls.push({ url, body: parsed });
          for (const suffix of Object.keys(postResponses)) {
            if (url.endsWith(suffix)) {
              const r = postResponses[suffix];
              return { status: r.status, json: r.body };
            }
          }
          return { status: 200, json: {} };
        },
      },
      {
        path: "/api/auth/user",
        respond: () =>
          opts.user ? { status: 200, json: opts.user } : { status: 401, json: {} },
      },
      { path: "/api/integrations/all-status", json: { front: { connected: true } } },
      { path: /\/api\/admin\/front\/analytics-coverage$/, json: () => analyticsCoveragePayload() },
      {
        path: /\/analytics-coverage\/outbound-gap-status$/,
        json: { config: {}, lastRun: null, gapMonths: [] },
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
    // Everything else (auto-closure status/overnight, alert configs, etc.)
    // — benign empty payloads so the panel renders without incidental errors.
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
const { useToast } = await import("../../client/src/hooks/use-toast");

// The panel surfaces server rejections as toasts. The toast store is a
// module-level singleton (TOAST_LIMIT = 1), so a tiny recorder component
// that subscribes via useToast() lets us read the most-recent toast's
// title/description without mounting the Radix <Toaster /> (which never
// portals into the raw jsdom harness).
let lastToast: { title?: any; description?: any; variant?: any } | null = null;
function ToastRecorder(): null {
  const { toasts } = (useToast as any)();
  if (Array.isArray(toasts) && toasts.length > 0) {
    lastToast = toasts[0];
  }
  return null;
}

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

async function flush(times = 10): Promise<void> {
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
        React.createElement(ToastRecorder as any),
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
  postCalls = [];
  postResponses = {};
  lastToast = null;
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected element [data-testid="${testId}"] to exist before click`);
  await act(async () => {
    el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

// ---------------------------------------------------------------------------
// Plain-English reason builders — mirror server/services/frontTriggerBlockedReasons.ts
// (the exact strings the three routes emit). Kept local so this client
// test doesn't import server code, but byte-identical to the source.
// ---------------------------------------------------------------------------

const SETTING = "front_analytics_refresh_enabled";
const QUEUE = "front_analytics_coverage_refresh";

const GATES = {
  refreshDisabled: {
    label: "master refresh setting OFF",
    body: {
      error: `${SETTING}=false`,
      reason: `Front analytics refresh is turned off, so nothing was run. Turn on the "${SETTING}" setting to enable it.`,
    },
  },
  queuePaused: {
    label: "queue paused",
    body: {
      error: "queue paused via queue_drain_state",
      reason: `The "${QUEUE}" queue is paused, so nothing was run. Resume it in queue-drain controls to enable it.`,
    },
  },
  killSwitch: {
    label: "non-critical sweeps kill switch ON",
    body: {
      error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
      reason:
        "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off to enable it.",
    },
  },
} as const;

type GateKey = keyof typeof GATES;

// ---------------------------------------------------------------------------
// One scenario: press a trigger button, route 503s with { error, reason },
// assert the destructive toast title + that its description IS the friendly
// reason (and not the raw machine error / wrapped "503:" message).
// ---------------------------------------------------------------------------

async function scenario(opts: {
  routeSuffix: string;
  buttonTestId: string;
  gate: GateKey;
  expectedTitle: string;
}): Promise<void> {
  const { routeSuffix, buttonTestId, gate, expectedTitle } = opts;
  const { label, body } = GATES[gate];
  console.log(`\n— ${routeSuffix} / ${label} → toast "${expectedTitle}" w/ friendly reason —`);

  postResponses = { [routeSuffix]: { status: 503, body } };
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    const btn = $(buttonTestId) as HTMLButtonElement | null;
    assert(btn !== null, `button [data-testid="${buttonTestId}"] must render`);
    assert(!btn!.disabled, `button "${buttonTestId}" must be enabled so the POST fires`);

    postCalls = [];
    lastToast = null;
    await clickById(buttonTestId);

    const posts = postCalls.filter((c) => c.url.endsWith(routeSuffix));
    assert(
      posts.length === 1,
      `expected exactly 1 POST to ${routeSuffix}, got ${posts.length} (all: ${JSON.stringify(postCalls)})`,
    );

    assert(lastToast !== null, "a toast must be raised when the POST is rejected");
    assert(
      lastToast!.variant === "destructive",
      `rejection toast must be destructive — got "${lastToast!.variant}"`,
    );
    assert(
      lastToast!.title === expectedTitle,
      `toast title must be "${expectedTitle}" — got "${lastToast!.title}"`,
    );

    // The core assertion of this task: the toast DESCRIPTION must be the
    // plain-English reason pulled out of the thrown apiRequest message,
    // NOT the raw machine error or the wrapped "503: {...}" string.
    const desc = String(lastToast!.description ?? "");
    assert(
      desc === body.reason,
      `toast description must equal the plain-English reason — expected "${body.reason}", got "${desc}"`,
    );
    assert(
      !desc.includes("503:") && !desc.trim().startsWith("{"),
      `toast description must not leak the raw "503: {...}" message — got "${desc}"`,
    );
    assert(
      desc !== body.error,
      `toast description must not be the raw machine error code — got "${desc}"`,
    );
    console.log(`  ✓ title "${expectedTitle}"; description is the friendly reason`);
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  // refresh-month (per-row "Retry" / "Retry (search)" button)
  await scenario({
    routeSuffix: "/analytics-coverage/refresh-month",
    buttonTestId: `button-fa-retry-${COVERAGE_MONTH}`,
    gate: "refreshDisabled",
    expectedTitle: "Retry blocked: Front analytics refresh is disabled",
  });
  await scenario({
    routeSuffix: "/analytics-coverage/refresh-month",
    buttonTestId: `button-fa-retry-${COVERAGE_MONTH}`,
    gate: "queuePaused",
    expectedTitle: "Retry blocked: queue paused",
  });
  await scenario({
    routeSuffix: "/analytics-coverage/refresh-month",
    buttonTestId: `button-fa-retry-${COVERAGE_MONTH}`,
    gate: "killSwitch",
    expectedTitle: "Retry blocked: non-critical sweeps kill switch",
  });

  // reprobe-month (per-row "Re-probe Analytics" button)
  await scenario({
    routeSuffix: "/analytics-coverage/reprobe-month",
    buttonTestId: `button-fa-reprobe-${COVERAGE_MONTH}`,
    gate: "refreshDisabled",
    expectedTitle: "Re-probe blocked: Front analytics refresh is disabled",
  });
  await scenario({
    routeSuffix: "/analytics-coverage/reprobe-month",
    buttonTestId: `button-fa-reprobe-${COVERAGE_MONTH}`,
    gate: "queuePaused",
    expectedTitle: "Re-probe blocked: queue paused",
  });
  await scenario({
    routeSuffix: "/analytics-coverage/reprobe-month",
    buttonTestId: `button-fa-reprobe-${COVERAGE_MONTH}`,
    gate: "killSwitch",
    expectedTitle: "Re-probe blocked: non-critical sweeps kill switch",
  });

  // recompute (section-header "Recompute units" button)
  await scenario({
    routeSuffix: "/analytics-coverage/recompute",
    buttonTestId: "button-front-analytics-recompute-units",
    gate: "refreshDisabled",
    expectedTitle: "Recompute blocked: refresh disabled",
  });
  await scenario({
    routeSuffix: "/analytics-coverage/recompute",
    buttonTestId: "button-front-analytics-recompute-units",
    gate: "queuePaused",
    expectedTitle: "Recompute blocked: queue paused",
  });
  await scenario({
    routeSuffix: "/analytics-coverage/recompute",
    buttonTestId: "button-front-analytics-recompute-units",
    gate: "killSwitch",
    expectedTitle: "Recompute blocked: non-critical sweeps kill switch",
  });

  console.log("\nfront-trigger-blocked-reasons-toast: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
