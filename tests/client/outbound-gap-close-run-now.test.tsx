/* test-registration
{
  "name": "Outbound gap closer Run now button (Task #2058)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~4.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/outbound-gap-close-run-now-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2058 — Frontend regression test for the outbound gap closer
 * "Run now" button inside the Front historical-recovery panel's
 * `section-front-outbound-gap-close` readout (button + gates added by
 * Task #2025; readout added by Task #2021 over the Task #1984 driver).
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` that
 * serves the auth / integration-status / outbound-gap-status payloads
 * and records every POST.
 *
 * Asserts:
 *
 *   1. For each gate the route returns a calm 503 for, the button
 *      `button-run-outbound-gap-close` is disabled and
 *      `text-outbound-gap-run-disabled-reason` shows the matching
 *      reason:
 *        - closer disabled            → "Outbound gap closer is disabled"
 *        - queue paused               → "Queue is paused"
 *        - per-message materialization → "Per-message materialization is OFF (hard gap)"
 *
 *   2. When all gates are clear the button is enabled, no disabled-reason
 *      paragraph renders, and clicking it POSTs to
 *      /api/admin/front/analytics-coverage/close-outbound-gap and
 *      invalidates the outbound-gap-status query on success.
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
// Configurable fetch stub + POST recorder
// ---------------------------------------------------------------------------

type PostCall = { url: string; body: any };
let postCalls: PostCall[] = [];

// When set, the close-outbound-gap POST resolves with this status/body
// instead of the default 200 "enqueued" payload. Used to exercise the
// mutation's onError title-mapping (kill switch, queue paused, etc.).
let outboundGapPostResponse: { status: number; body: any } | null = null;

const ADMIN_USER = {
  id: "admin-2058",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// The config block the panel reads to decide the "Run now" gate. Each
// scenario overrides the relevant flags via `currentGapConfig`.
let currentGapConfig: Record<string, unknown> = {
  enabled: true,
  paused: false,
  materializationEnabled: true,
  materializationSwitch: "front_per_message_materialization_enabled",
  maxMonthsPerTick: 2,
};

function outboundGapStatusPayload() {
  return {
    config: currentGapConfig,
    lastRun: null,
    gapMonths: [],
  };
}

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
            if (outboundGapPostResponse) {
              return {
                status: outboundGapPostResponse.status,
                json: outboundGapPostResponse.body,
              };
            }
            return { status: 200, json: { status: "enqueued", jobId: "job-2058" } };
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
const { useToast } = await import("../../client/src/hooks/use-toast");

// The panel surfaces server rejections as toasts. The toast store is a
// module-level singleton (TOAST_LIMIT = 1), so a tiny recorder component
// that subscribes via useToast() lets us read the most-recent toast's
// title/description after a failed "Run now" without mounting the Radix
// <Toaster /> (which never portals into the raw jsdom harness).
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
  invalidateCalls = [];
  outboundGapPostResponse = null;
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
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioDisabledGate(
  label: string,
  config: Record<string, unknown>,
  expectedReason: string,
): Promise<void> {
  console.log(`\n— Gate: ${label} → Run now disabled with reason —`);
  currentGapConfig = config;
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    assert(
      $("section-front-outbound-gap-close") !== null,
      "outbound gap-close section must render for admin with Front connected",
    );

    const btn = $("button-run-outbound-gap-close") as HTMLButtonElement | null;
    assert(btn !== null, "Run now button must render");
    assert(btn!.disabled, `Run now must be disabled when ${label}`);

    const reasonEl = $("text-outbound-gap-run-disabled-reason");
    assert(reasonEl !== null, "disabled-reason paragraph must render when a gate is active");
    assert(
      (reasonEl!.textContent || "").includes(expectedReason),
      `disabled reason must include "${expectedReason}" — got "${reasonEl!.textContent}"`,
    );

    // A disabled button must never fire the POST even if clicked.
    postCalls = [];
    await clickById("button-run-outbound-gap-close");
    const posts = postCalls.filter((c) =>
      c.url.endsWith("/analytics-coverage/close-outbound-gap"),
    );
    assert(
      posts.length === 0,
      `disabled Run now must not POST close-outbound-gap (got ${JSON.stringify(posts)})`,
    );
    console.log(`  ✓ disabled with reason "${expectedReason}"; no POST fired`);
  } finally {
    await unmount(root);
  }
}

async function scenarioEnabledRunNow(): Promise<void> {
  console.log("\n— All gates clear → Run now POSTs and invalidates status query —");
  currentGapConfig = {
    enabled: true,
    paused: false,
    materializationEnabled: true,
    materializationSwitch: "front_per_message_materialization_enabled",
    maxMonthsPerTick: 2,
  };
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    const btn = $("button-run-outbound-gap-close") as HTMLButtonElement | null;
    assert(btn !== null, "Run now button must render");
    assert(!btn!.disabled, "Run now must be enabled when no gate is active");
    assert(
      $("text-outbound-gap-run-disabled-reason") === null,
      "disabled-reason paragraph must NOT render when no gate is active",
    );

    postCalls = [];
    invalidateCalls = [];
    await clickById("button-run-outbound-gap-close");

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
    console.log("  ✓ POST /analytics-coverage/close-outbound-gap fired and status query invalidated");
  } finally {
    await unmount(root);
  }
}

async function scenarioServerRejection(
  label: string,
  errorBody: any,
  expectedTitle: string,
  expectedDescription?: string,
): Promise<void> {
  console.log(`\n— Server 503 (${label}) → destructive toast "${expectedTitle}" —`);
  // All client-side gates clear so the button is enabled and the POST
  // actually fires; the server then rejects with the given 503 body.
  currentGapConfig = {
    enabled: true,
    paused: false,
    materializationEnabled: true,
    materializationSwitch: "front_per_message_materialization_enabled",
    maxMonthsPerTick: 2,
  };
  outboundGapPostResponse = { status: 503, body: errorBody };
  activeFetchHandler = makeFetchHandler({ user: ADMIN_USER });
  const root = await mountPanel();
  try {
    const btn = $("button-run-outbound-gap-close") as HTMLButtonElement | null;
    assert(btn !== null, "Run now button must render");
    assert(
      !btn!.disabled,
      "Run now must be enabled (no client-side gate) so the kill-switch 503 can be reached",
    );

    postCalls = [];
    lastToast = null;
    await clickById("button-run-outbound-gap-close");

    const posts = postCalls.filter((c) =>
      c.url.endsWith("/analytics-coverage/close-outbound-gap"),
    );
    assert(
      posts.length === 1,
      `expected exactly 1 POST to close-outbound-gap, got ${posts.length}`,
    );

    assert(
      lastToast !== null,
      "a destructive toast must be raised when the POST is rejected",
    );
    assert(
      lastToast!.variant === "destructive",
      `rejection toast must be destructive — got "${lastToast!.variant}"`,
    );
    assert(
      lastToast!.title === expectedTitle,
      `toast title must be "${expectedTitle}" — got "${lastToast!.title}"`,
    );
    // Task #2135 — when the route returns a plain-English `reason`, the
    // toast description must surface it (not the raw machine error).
    if (expectedDescription !== undefined) {
      assert(
        String(lastToast!.description ?? "").includes(expectedDescription),
        `toast description must include "${expectedDescription}" — got "${lastToast!.description}"`,
      );
    }
    console.log(`  ✓ toast title "${expectedTitle}" (destructive)`);
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  await scenarioDisabledGate(
    "closer disabled",
    {
      enabled: false,
      paused: false,
      materializationEnabled: true,
      materializationSwitch: "front_per_message_materialization_enabled",
      maxMonthsPerTick: 2,
    },
    "Outbound gap closer is disabled",
  );
  await scenarioDisabledGate(
    "queue paused",
    {
      enabled: true,
      paused: true,
      materializationEnabled: true,
      materializationSwitch: "front_per_message_materialization_enabled",
      maxMonthsPerTick: 2,
    },
    "Queue is paused",
  );
  await scenarioDisabledGate(
    "per-message materialization OFF",
    {
      enabled: true,
      paused: false,
      materializationEnabled: false,
      materializationSwitch: "front_per_message_materialization_enabled",
      maxMonthsPerTick: 2,
    },
    "Per-message materialization is OFF (hard gap)",
  );
  // Task #2081 — the non-critical-sweeps kill switch now has a client-side
  // disable gate too, so the admin sees a calm reason instead of clicking
  // into a 503.
  await scenarioDisabledGate(
    "non-critical sweeps kill switch ON",
    {
      enabled: true,
      paused: false,
      materializationEnabled: true,
      killSwitchNonCriticalSweeps: true,
      materializationSwitch: "front_per_message_materialization_enabled",
      maxMonthsPerTick: 2,
    },
    "Non-critical sweeps kill switch is ON",
  );
  await scenarioEnabledRunNow();

  // Task #2071 / #2081 — the kill switch now has a client-side disable gate
  // (covered above), but this scenario forces all client-side gates clear so
  // the POST actually fires and reaches the route's defense-in-depth 503,
  // verifying the onError toast title. Plus the other raw-message branches.
  await scenarioServerRejection(
    "KILL_SWITCH_NON_CRITICAL_SWEEPS",
    {
      error: "KILL_SWITCH_NON_CRITICAL_SWEEPS=true",
      reason:
        "Non-critical sweeps are paused by a kill switch, so nothing was run. Turn the KILL_SWITCH_NON_CRITICAL_SWEEPS kill switch off to enable it.",
    },
    "Blocked: non-critical sweeps kill switch",
    "Non-critical sweeps are paused by a kill switch",
  );
  await scenarioServerRejection(
    "front_outbound_gap_close_enabled=false",
    {
      error: "front_outbound_gap_close_enabled=false",
      reason:
        'The outbound gap closer is turned off, so nothing was run. Turn on the "front_outbound_gap_close_enabled" setting to enable it.',
    },
    "Blocked: outbound gap closer is disabled",
    "The outbound gap closer is turned off",
  );
  await scenarioServerRejection(
    "queue paused",
    {
      error: "queue paused via queue_drain_state",
      reason:
        'The outbound gap-close queue is paused, so nothing was run. Resume the "front_outbound_gap_close" queue in queue-drain controls to enable it.',
    },
    "Blocked: queue paused",
    "The outbound gap-close queue is paused",
  );
  await scenarioServerRejection(
    "per-message materialization disabled",
    {
      error:
        "per-message materialization disabled — flip front_per_message_materialization_enabled ON first",
      reason:
        'Per-message materialization is off, so a gap-close run can\'t help yet. Turn on the "front_per_message_materialization_enabled" switch first.',
    },
    "Blocked: per-message materialization is OFF",
    "Per-message materialization is off",
  );

  console.log("\noutbound-gap-close-run-now: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
