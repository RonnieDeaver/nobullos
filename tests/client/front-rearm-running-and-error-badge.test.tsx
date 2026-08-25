/* test-registration
{
  "name": "Re-arm running + failed badge states (Task #2242)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-rearm-running-and-error-badge-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2242 — Re-arm "running" + "failed" badge client coverage.
 *
 * Task #2208 covered the *finished* re-arm badge branches (amber
 * "No more to recover" vs. green "Re-arm done"). The same badge area in
 * `FrontHistoricalRecoveryPanel` has two other render branches with no
 * client coverage:
 *
 *   - the RUNNING indicator
 *     (`badge-fa-rearm-drain-running-${month}` and
 *      `badge-fa-rearm-all-drain-running`) shown while a drain is in flight
 *     (`drain.running === true`), blue styling with "Re-arming…" /
 *     "Re-arming all…" wording, and
 *   - the ERROR badge ("Re-arm failed" / "Re-arm all failed", red styling)
 *     shown when `drain.error` is set on a finished drain.
 *
 * A refactor could silently regress either — e.g. showing a finished badge
 * while a drain is still running, or hiding the failure wording.
 *
 * This mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` that
 * serves an auto-closure status with a parked window, a per-window drain
 * (`reArmDrains[month]`), and an all-windows drain (`allReArmDrain`).
 * Two scenarios:
 *
 *   1. Both drains `running:true` ⇒ the blue running badges
 *      (`badge-fa-rearm-drain-running-${month}` /
 *       `badge-fa-rearm-all-drain-running`) render with "Re-arming…" /
 *      "Re-arming all…" text + blue styling (`bg-blue-100` / `text-blue-700`),
 *      and the FINISHED badges do NOT render.
 *
 *   2. Both drains finished with `error` set ⇒ the finished badges render
 *      the red "Re-arm failed" / "Re-arm all failed" wording with red
 *      styling (`bg-red-100` / `text-red-700`), and the running badges do
 *      NOT render.
 *
 * Usage: tsx --import ./tests/client/setup-mocks.mjs \
 *            tests/client/front-rearm-running-and-error-badge.test.tsx
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

const ADMIN_USER = {
  id: "admin-2242",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// ---------------------------------------------------------------------------
// Auto-closure status payload builder.
//
// `month` is parked. `state` selects the drain shape applied to BOTH the
// per-window drain (`reArmDrains[month]`) and the all-windows drain
// (`allReArmDrain`):
//   - "running": running:true (no finishedAt) → running indicator branch.
//   - "error":   running:false + error set    → finished/failed branch.
// ---------------------------------------------------------------------------

function drainForState(state: "running" | "error"): any {
  if (state === "running") {
    return {
      running: true,
      startedAt: "2026-05-02T00:00:00.000Z",
      finishedAt: null,
      totalAtStart: 4,
      processed: 1,
      lastOutcomeKind: null,
      progress: "1/4",
      error: null,
    };
  }
  return {
    running: false,
    startedAt: "2026-05-02T00:00:00.000Z",
    finishedAt: "2026-05-02T00:05:00.000Z",
    totalAtStart: 4,
    processed: 2,
    lastOutcomeKind: null,
    progress: "2/4",
    error: "search strategy raised 500 mid-drain",
  };
}

function buildAutoClosureStatus(opts: {
  month: string;
  state: "running" | "error";
}): any {
  const { month, state } = opts;
  return {
    enabled: true,
    currentMode: "daytime",
    lastSummary: null,
    parkedWindows: {
      [month]: {
        parkedAt: "2026-05-01T00:00:00.000Z",
        reason: "dead_run_streak:3_runs",
        deadRuns: 3,
        lastCheckpointAt: "2026-05-01T00:00:00.000Z",
      },
    },
    reArmDrains: {
      [month]: drainForState(state),
    },
    allReArmDrain: drainForState(state),
  };
}

function makeHandler(status: any): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { test: (_url, method) => method !== "GET", json: {} },
      { path: "/api/auth/user", json: ADMIN_USER },
      { path: "/api/integrations/all-status", json: { front: { connected: true } } },
      { path: /\/api\/admin\/front\/auto-closure\/status/, json: status },
      { path: /\/api\/admin\/front\/auto-closure\/overnight/, json: {} },
      { path: /\/api\/admin\/front\/auto-closure\/regression-alert-status/, json: {} },
      {
        path: /\/historical-recovery\/sweep-status/,
        json: {
          running: false,
          inFlight: false,
          intervalMs: 60_000,
          lastSweepAt: null,
          lastPrunedCount: 0,
          lastError: null,
        },
      },
      { path: /\/historical-recovery\/jobs/, json: { jobs: [] } },
      {
        path: /\/historical-recovery\/auto-continue-max-attempts/,
        respond: ({ url }) =>
          url.endsWith("/history")
            ? { json: { history: [] } }
            : {
                json: {
                  maxAttempts: 5,
                  defaultAttempts: 5,
                  minAttempts: 1,
                  maxAttemptsAllowed: 20,
                },
              },
      },
      {
        path: /\/historical-recovery\/max-age$/,
        json: {
          maxAgeDays: 30,
          defaultDays: 30,
          minDays: 1,
          maxDays: 365,
          lastEdited: null,
        },
      },
      { path: /\/historical-recovery\/max-age\/history$/, json: { history: [] } },
      {
        path: /\/historical-recovery\/prune-interval$/,
        json: {
          intervalMinutes: 60,
          defaultMinutes: 60,
          minMinutes: 5,
          maxMinutes: 1440,
          lastEdited: null,
        },
      },
      { path: /\/historical-recovery\/prune-interval\/history$/, json: { history: [] } },
      { path: /\/historical-recovery\/manual-sweep-history/, json: { entries: [] } },
      { path: /\/historical-recovery\/coverage/, json: { windows: [] } },
    ],
    defaultJson: {},
  });
}

let activeFetchHandler: (url: string, init?: any) => Promise<Response> = async () => {
  throw new Error("no fetch handler set");
};
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return activeFetchHandler(url, init);
};

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const { FrontHistoricalRecoveryPanel } = await import(
  "../../client/src/components/admin/FrontHistoricalRecoveryPanel"
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

const MONTH = "2026-03";

// ---------------------------------------------------------------------------
// Scenario 1 — running drains ⇒ blue "Re-arming…" running badges,
// and the finished badges must NOT render.
// ---------------------------------------------------------------------------

async function scenarioRunning(): Promise<void> {
  console.log(
    "\n— Scenario 1: running drains → blue 'Re-arming…' / 'Re-arming all…' running badges —",
  );
  activeFetchHandler = makeHandler(
    buildAutoClosureStatus({ month: MONTH, state: "running" }),
  );
  document.getElementById("root")!.innerHTML = "";
  const root = await mountPanel();
  try {
    // Per-window running badge.
    const perBadge = $(`badge-fa-rearm-drain-running-${MONTH}`);
    assert(
      perBadge !== null,
      `per-window running badge (badge-fa-rearm-drain-running-${MONTH}) must render`,
    );
    assert(
      (perBadge!.textContent ?? "").includes("Re-arming…"),
      `per-window running badge must read "Re-arming…" — got "${perBadge!.textContent}"`,
    );
    const perCls = perBadge!.className;
    assert(
      perCls.includes("bg-blue-100") && perCls.includes("text-blue-700"),
      `per-window running badge must use blue styling — got className "${perCls}"`,
    );
    // The finished badge must NOT be present while running.
    assert(
      $(`badge-fa-rearm-drain-finished-${MONTH}`) === null,
      "per-window finished badge must NOT render while the drain is running",
    );

    // All-windows running badge.
    const allBadge = $("badge-fa-rearm-all-drain-running");
    assert(
      allBadge !== null,
      "all-windows running badge (badge-fa-rearm-all-drain-running) must render",
    );
    assert(
      (allBadge!.textContent ?? "").includes("Re-arming all…"),
      `all-windows running badge must read "Re-arming all…" — got "${allBadge!.textContent}"`,
    );
    const allCls = allBadge!.className;
    assert(
      allCls.includes("bg-blue-100") && allCls.includes("text-blue-700"),
      `all-windows running badge must use blue styling — got className "${allCls}"`,
    );
    // The finished badge must NOT be present while running.
    assert(
      $("badge-fa-rearm-all-drain-finished") === null,
      "all-windows finished badge must NOT render while the drain is running",
    );
    console.log(
      "  ✓ both per-window and all-windows running badges render; finished badges absent",
    );
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — finished drains with error set ⇒ red "Re-arm failed" /
// "Re-arm all failed" badges, and the running badges must NOT render.
// ---------------------------------------------------------------------------

async function scenarioError(): Promise<void> {
  console.log(
    "\n— Scenario 2: finished drains with error set → red 'Re-arm failed' / 'Re-arm all failed' badges —",
  );
  activeFetchHandler = makeHandler(
    buildAutoClosureStatus({ month: MONTH, state: "error" }),
  );
  document.getElementById("root")!.innerHTML = "";
  const root = await mountPanel();
  try {
    // Per-window finished badge — red "Re-arm failed".
    const perBadge = $(`badge-fa-rearm-drain-finished-${MONTH}`);
    assert(
      perBadge !== null,
      `per-window finished badge (badge-fa-rearm-drain-finished-${MONTH}) must render`,
    );
    assert(
      (perBadge!.textContent ?? "").includes("Re-arm failed"),
      `per-window error badge must read "Re-arm failed" — got "${perBadge!.textContent}"`,
    );
    assert(
      !(perBadge!.textContent ?? "").includes("Re-arm done") &&
        !(perBadge!.textContent ?? "").includes("No more to recover"),
      "per-window error badge must NOT use the done / still_empty wording",
    );
    const perCls = perBadge!.className;
    assert(
      perCls.includes("bg-red-100") && perCls.includes("text-red-700"),
      `per-window error badge must use red styling — got className "${perCls}"`,
    );
    assert(
      !perCls.includes("bg-green-100") && !perCls.includes("bg-amber-100"),
      "per-window error badge must NOT use green or amber styling",
    );
    // The running badge must NOT be present once finished.
    assert(
      $(`badge-fa-rearm-drain-running-${MONTH}`) === null,
      "per-window running badge must NOT render once the drain has finished",
    );

    // All-windows finished badge — red "Re-arm all failed".
    const allBadge = $("badge-fa-rearm-all-drain-finished");
    assert(
      allBadge !== null,
      "all-windows finished badge (badge-fa-rearm-all-drain-finished) must render",
    );
    assert(
      (allBadge!.textContent ?? "").includes("Re-arm all failed"),
      `all-windows error badge must read "Re-arm all failed" — got "${allBadge!.textContent}"`,
    );
    assert(
      !(allBadge!.textContent ?? "").includes("Re-arm all done") &&
        !(allBadge!.textContent ?? "").includes("No more to recover"),
      "all-windows error badge must NOT use the done / still_empty wording",
    );
    const allCls = allBadge!.className;
    assert(
      allCls.includes("bg-red-100") && allCls.includes("text-red-700"),
      `all-windows error badge must use red styling — got className "${allCls}"`,
    );
    assert(
      !allCls.includes("bg-green-100") && !allCls.includes("bg-amber-100"),
      "all-windows error badge must NOT use green or amber styling",
    );
    // The running badge must NOT be present once finished.
    assert(
      $("badge-fa-rearm-all-drain-running") === null,
      "all-windows running badge must NOT render once the drain has finished",
    );
    console.log(
      "  ✓ both per-window and all-windows error badges render in red; running badges absent",
    );
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioRunning();
  await scenarioError();
  console.log(
    "\nfront-rearm-running-and-error-badge: all badge cases passed",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
