/* test-registration
{
  "name": "Outbound gap closer per-row Run button (Task #2294)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/outbound-gap-close-run-row-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2294 — Frontend regression test for the per-month "Run" action on
 * the outbound gap-months table (Task #2057) inside the Front
 * historical-recovery panel's `section-front-outbound-gap-close` readout.
 *
 * The existing sibling test (tests/client/outbound-gap-close-run-now.test.tsx,
 * Task #2058) only pins the header "Run now" all-months button. This test
 * pins the per-row buttons (`button-run-outbound-gap-<month>`):
 *
 *   1. Pressing a per-row Run button POSTs { month } (the row's month, NOT
 *      an empty body) to /api/admin/front/analytics-coverage/close-outbound-gap
 *      and invalidates the outbound-gap-status query on success.
 *
 *   2. Per-row Run buttons are disabled (for the same gating reasons as the
 *      header button) when the closer is disabled / queue paused /
 *      per-message materialization is OFF — and a disabled row button never
 *      fires the POST.
 *
 *   3. While a single-month run is pending, only the pressed row shows
 *      "Running…"; the other rows stay on "Run".
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`.
 */

import { JSDOM } from "jsdom";
import { installJsdomGlobals } from "../helpers/installJsdomGlobals";
import { createFetchStub, createJsonResponse } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
installJsdomGlobals(dom);

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Configurable fetch stub + POST recorder
// ---------------------------------------------------------------------------

type PostCall = { url: string; body: any };
let postCalls: PostCall[] = [];

// When set, the close-outbound-gap POST does not resolve immediately; instead
// it parks on a promise whose resolver is captured here. This lets the test
// observe the in-flight "Running…" state on exactly the pressed row before
// releasing the response. Call releaseOutboundGapPost() to finish the POST.
let pendingOutboundGapResolve: ((value: Response) => void) | null = null;
let deferOutboundGapPost = false;

function releaseOutboundGapPost(): void {
  const resolve = pendingOutboundGapResolve;
  pendingOutboundGapResolve = null;
  if (resolve) {
    resolve(jsonResponse(200, { status: "enqueued", jobId: "job-2294", month: null }));
  }
}

const ADMIN_USER = {
  id: "admin-2294",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// The config block the panel reads to decide the per-row Run gate. Each
// scenario overrides the relevant flags via `currentGapConfig`.
let currentGapConfig: Record<string, unknown> = {
  enabled: true,
  paused: false,
  materializationEnabled: true,
  materializationSwitch: "front_per_message_materialization_enabled",
  maxMonthsPerTick: 2,
};

// A few months with an outbound gap so the gap-months table renders rows.
let currentGapMonths: any[] = [
  {
    month: "2025-03",
    messagesOutboundFront: 1200,
    messagesOutboundLocal: 800,
    messagesOutboundGap: 400,
  },
  {
    month: "2025-02",
    messagesOutboundFront: 900,
    messagesOutboundLocal: 700,
    messagesOutboundGap: 200,
  },
  {
    month: "2025-01",
    messagesOutboundFront: 600,
    messagesOutboundLocal: 550,
    messagesOutboundGap: 50,
  },
];

function outboundGapStatusPayload() {
  return {
    config: currentGapConfig,
    lastRun: null,
    gapMonths: currentGapMonths,
  };
}

const jsonResponse = createJsonResponse(dom.window.Headers) as (
  status: number,
  body: any,
) => Response;

function makeFetchHandler(opts: { user: any }): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        method: "POST",
        respond: (ctx: any) => {
          let parsed: any = null;
          try {
            parsed = ctx.init?.body ? JSON.parse(String(ctx.init.body)) : null;
          } catch {
            parsed = ctx.init?.body ?? null;
          }
          postCalls.push({ url: ctx.url, body: parsed });
          if (ctx.url.endsWith("/analytics-coverage/close-outbound-gap")) {
            if (deferOutboundGapPost) {
              return new Promise<Response>((resolve) => {
                pendingOutboundGapResolve = resolve;
              });
            }
            return {
              status: 200,
              json: {
                status: "enqueued",
                jobId: "job-2294",
                month: parsed?.month ?? null,
              },
            };
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
      {
        path: /\/analytics-coverage\/outbound-gap-status$/,
        json: () => outboundGapStatusPayload(),
      },
      // The outbound gap section only renders once analytics coverage has a
      // resolved adoption date (otherwise the panel shows the "set adoption
      // date" branch instead). Serve a minimal-but-complete coverage payload.
      {
        path: /\/api\/admin\/front\/analytics-coverage$/,
        json: {
          adoptionDate: "2025-01-01",
          lastRefreshedAt: "2026-05-29T00:00:00.000Z",
          allTime: {
            appliedCoveragePct: 100,
            fetchedCoveragePct: 100,
            appliedIntoNobull: 0,
            fetchedIntoNobull: 0,
            frontTotalMessages: 0,
            ingestGap: 0,
            applyGap: 0,
          },
          months: [],
        },
      },
      // Everything else (jobs list, coverage, sweep status, auto-closure,
      // etc.) — return benign empty payloads so the panel doesn't error on
      // incidental requests we don't care about for this test.
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

// Spy on invalidateQueries so we can assert the success path refreshes
// the outbound-gap-status readout. The component resolves its client via
// useQueryClient(), which returns this same provider instance.
const realInvalidate = queryClient.invalidateQueries.bind(queryClient);
let invalidateCalls: any[] = [];
(queryClient as any).invalidateQueries = (...args: any[]) => {
  invalidateCalls.push(args[0]);
  return (realInvalidate as any)(...args);
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
  invalidateCalls = [];
  pendingOutboundGapResolve = null;
  deferOutboundGapPost = false;
}

async function clickById(testId: string): Promise<void> {
  const el = $(testId);
  assert(el !== null, `expected element [data-testid="${testId}"] to exist before click`);
  await act(async () => {
    el!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

const ENABLED_CONFIG = {
  enabled: true,
  paused: false,
  materializationEnabled: true,
  materializationSwitch: "front_per_message_materialization_enabled",
  maxMonthsPerTick: 2,
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioPerRowRunPostsMonth(): Promise<void> {
  console.log("\n— Per-row Run POSTs { month } and invalidates status query —");
  currentGapConfig = { ...ENABLED_CONFIG };
  currentGapMonths = [
    {
      month: "2025-03",
      messagesOutboundFront: 1200,
      messagesOutboundLocal: 800,
      messagesOutboundGap: 400,
    },
    {
      month: "2025-02",
      messagesOutboundFront: 900,
      messagesOutboundLocal: 700,
      messagesOutboundGap: 200,
    },
  ];
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    assert(
      $("section-front-outbound-gap-close") !== null,
      "outbound gap-close section must render for admin with Front connected",
    );
    assert(
      $("table-outbound-gap-months") !== null,
      "gap-months table must render when there are gap months",
    );

    const targetMonth = "2025-02";
    const rowBtn = $(`button-run-outbound-gap-${targetMonth}`) as HTMLButtonElement | null;
    assert(rowBtn !== null, `per-row Run button for ${targetMonth} must render`);
    assert(!rowBtn!.disabled, "per-row Run must be enabled when no gate is active");

    postCalls = [];
    invalidateCalls = [];
    await clickById(`button-run-outbound-gap-${targetMonth}`);

    const posts = postCalls.filter((c) =>
      c.url.endsWith("/analytics-coverage/close-outbound-gap"),
    );
    assert(
      posts.length === 1,
      `expected exactly 1 POST to close-outbound-gap, got ${posts.length} (all: ${JSON.stringify(postCalls)})`,
    );
    assert(
      posts[0].url === "/api/admin/front/analytics-coverage/close-outbound-gap",
      `POST must target the close-outbound-gap route — got "${posts[0].url}"`,
    );
    assert(
      posts[0].body && posts[0].body.month === targetMonth,
      `per-row Run must POST { month: "${targetMonth}" } — got body ${JSON.stringify(posts[0].body)}`,
    );

    const invalidatedStatus = invalidateCalls.some((arg) => {
      const key = arg?.queryKey;
      return (
        Array.isArray(key) &&
        key[0] === "/api/admin/front/analytics-coverage/outbound-gap-status"
      );
    });
    assert(
      invalidatedStatus,
      `success must invalidate the outbound-gap-status query — invalidate calls: ${JSON.stringify(invalidateCalls)}`,
    );
    console.log(`  ✓ per-row Run POSTed { month: "${targetMonth}" } and invalidated status query`);
  } finally {
    await unmount(root);
  }
}

async function scenarioPerRowDisabledGate(
  label: string,
  config: Record<string, unknown>,
): Promise<void> {
  console.log(`\n— Gate: ${label} → per-row Run disabled, no POST —`);
  currentGapConfig = config;
  currentGapMonths = [
    {
      month: "2025-03",
      messagesOutboundFront: 1200,
      messagesOutboundLocal: 800,
      messagesOutboundGap: 400,
    },
    {
      month: "2025-02",
      messagesOutboundFront: 900,
      messagesOutboundLocal: 700,
      messagesOutboundGap: 200,
    },
  ];
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    assert(
      $("table-outbound-gap-months") !== null,
      "gap-months table must render when there are gap months",
    );

    for (const m of currentGapMonths) {
      const rowBtn = $(`button-run-outbound-gap-${m.month}`) as HTMLButtonElement | null;
      assert(rowBtn !== null, `per-row Run button for ${m.month} must render`);
      assert(
        rowBtn!.disabled,
        `per-row Run for ${m.month} must be disabled when ${label}`,
      );
    }

    // A disabled per-row button must never fire the POST even if clicked.
    postCalls = [];
    await clickById("button-run-outbound-gap-2025-02");
    const posts = postCalls.filter((c) =>
      c.url.endsWith("/analytics-coverage/close-outbound-gap"),
    );
    assert(
      posts.length === 0,
      `disabled per-row Run must not POST close-outbound-gap (got ${JSON.stringify(posts)})`,
    );
    console.log(`  ✓ all per-row Run buttons disabled when ${label}; no POST fired`);
  } finally {
    await unmount(root);
  }
}

async function scenarioOnlyPressedRowRunning(): Promise<void> {
  console.log("\n— Only the pressed row shows \"Running…\" while pending —");
  currentGapConfig = { ...ENABLED_CONFIG };
  currentGapMonths = [
    {
      month: "2025-03",
      messagesOutboundFront: 1200,
      messagesOutboundLocal: 800,
      messagesOutboundGap: 400,
    },
    {
      month: "2025-02",
      messagesOutboundFront: 900,
      messagesOutboundLocal: 700,
      messagesOutboundGap: 200,
    },
    {
      month: "2025-01",
      messagesOutboundFront: 600,
      messagesOutboundLocal: 550,
      messagesOutboundGap: 50,
    },
  ];
  deferOutboundGapPost = true;
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    const pressedMonth = "2025-02";
    await clickById(`button-run-outbound-gap-${pressedMonth}`);

    // The POST is parked (deferred), so the mutation is mid-flight here.
    const pressedBtn = $(`button-run-outbound-gap-${pressedMonth}`) as HTMLButtonElement;
    assert(
      (pressedBtn.textContent || "").includes("Running…"),
      `pressed row ${pressedMonth} must read "Running…" while pending — got "${pressedBtn.textContent}"`,
    );

    for (const other of ["2025-03", "2025-01"]) {
      const otherBtn = $(`button-run-outbound-gap-${other}`) as HTMLButtonElement;
      assert(
        !(otherBtn.textContent || "").includes("Running…"),
        `non-pressed row ${other} must NOT read "Running…" — got "${otherBtn.textContent}"`,
      );
      assert(
        (otherBtn.textContent || "").includes("Run"),
        `non-pressed row ${other} must still read "Run" — got "${otherBtn.textContent}"`,
      );
      // Other rows are disabled while a run is in flight (shared isPending
      // gate), but they must not be stuck on "Running…".
      assert(
        otherBtn.disabled,
        `non-pressed row ${other} should be disabled while a run is in flight`,
      );
    }

    // Release the parked POST and let the mutation settle.
    releaseOutboundGapPost();
    await flush();

    const settledBtn = $(`button-run-outbound-gap-${pressedMonth}`) as HTMLButtonElement;
    assert(
      !(settledBtn.textContent || "").includes("Running…"),
      `pressed row ${pressedMonth} must return to "Run" after the POST settles — got "${settledBtn.textContent}"`,
    );
    console.log("  ✓ only the pressed row showed \"Running…\"; reverted after settle");
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  await scenarioPerRowRunPostsMonth();

  await scenarioPerRowDisabledGate("closer disabled", {
    enabled: false,
    paused: false,
    materializationEnabled: true,
    materializationSwitch: "front_per_message_materialization_enabled",
    maxMonthsPerTick: 2,
  });
  await scenarioPerRowDisabledGate("queue paused", {
    enabled: true,
    paused: true,
    materializationEnabled: true,
    materializationSwitch: "front_per_message_materialization_enabled",
    maxMonthsPerTick: 2,
  });
  await scenarioPerRowDisabledGate("per-message materialization OFF", {
    enabled: true,
    paused: false,
    materializationEnabled: false,
    materializationSwitch: "front_per_message_materialization_enabled",
    maxMonthsPerTick: 2,
  });

  await scenarioOnlyPressedRowRunning();

  console.log("\noutbound-gap-close-run-row: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
