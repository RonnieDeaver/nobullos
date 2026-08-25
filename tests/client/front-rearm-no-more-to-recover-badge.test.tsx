/* test-registration
{
  "name": "Re-arm 'No more to recover' vs 'Re-arm done' badge (Task #2208)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-rearm-no-more-to-recover-badge-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2208 — Re-arm "No more to recover" badge client coverage.
 *
 * The admin Front recovery panel renders a distinct amber
 * "No more to recover" badge (instead of the generic green
 * "Re-arm done" / "Re-arm all done" badge) when a *finished* re-arm
 * drain's dominant outcome is `still_empty`. The server-side projection
 * that computes `lastOutcomeKind` has direct tests
 * (`tests/front-rearm-badge.test.ts`), but the client rendering branch
 * in `FrontHistoricalRecoveryPanel` that picks the badge text / colour /
 * tooltip from `lastOutcomeKind` had no coverage, so a future refactor
 * could silently flip the still_empty case back to the green wording.
 *
 * This mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` that
 * serves an auto-closure status whose:
 *   - parked window (`parkedWindows[month]`),
 *   - per-window drain (`reArmDrains[month]`), and
 *   - all-windows drain (`allReArmDrain`)
 * are all finished. Two scenarios:
 *
 *   1. `lastOutcomeKind === "still_empty"` ⇒ both the per-window badge
 *      (`badge-fa-rearm-drain-finished-${month}`) and the all-windows
 *      badge (`badge-fa-rearm-all-drain-finished`) show the amber
 *      "No more to recover" text + amber styling
 *      (`bg-amber-100` / `text-amber-800` / `border-amber-300`).
 *
 *   2. `lastOutcomeKind` of `re_armed` (per-window) / `ingested`
 *      (all-windows) ⇒ the green "Re-arm done" / "Re-arm all done"
 *      badge with green styling (`bg-green-100` / `text-green-700`).
 *
 * Usage: tsx --import ./tests/client/setup-mocks.mjs \
 *            tests/client/front-rearm-no-more-to-recover-badge.test.tsx
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
  id: "admin-2208",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// ---------------------------------------------------------------------------
// Auto-closure status payload builder.
//
// `month` is parked, has a finished per-window drain, and the all-windows
// drain is finished too. `kind` drives the per-window drain's
// `lastOutcomeKind`; `allKind` drives the all-windows drain's. Both drains
// have `running:false` + a `finishedAt` so the FINISHED badge branch
// renders (not the running indicator).
// ---------------------------------------------------------------------------

function buildAutoClosureStatus(opts: {
  month: string;
  kind: string;
  allKind: string;
}): any {
  const { month, kind, allKind } = opts;
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
      [month]: {
        running: false,
        startedAt: "2026-05-02T00:00:00.000Z",
        finishedAt: "2026-05-02T00:05:00.000Z",
        totalAtStart: 1,
        processed: 1,
        lastOutcomeKind: kind,
        progress: "1/1",
        error: null,
      },
    },
    allReArmDrain: {
      running: false,
      startedAt: "2026-05-02T00:00:00.000Z",
      finishedAt: "2026-05-02T00:05:00.000Z",
      totalAtStart: 1,
      processed: 1,
      lastOutcomeKind: allKind,
      progress: "1/1",
      error: null,
    },
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
// Scenario 1 — still_empty ⇒ amber "No more to recover" on both badges.
// ---------------------------------------------------------------------------

async function scenarioStillEmpty(): Promise<void> {
  console.log(
    "\n— Scenario 1: finished drains with lastOutcomeKind=still_empty → amber 'No more to recover' —",
  );
  activeFetchHandler = makeHandler(
    buildAutoClosureStatus({
      month: MONTH,
      kind: "still_empty",
      allKind: "still_empty",
    }),
  );
  document.getElementById("root")!.innerHTML = "";
  const root = await mountPanel();
  try {
    // Per-window finished badge.
    const perBadge = $(`badge-fa-rearm-drain-finished-${MONTH}`);
    assert(
      perBadge !== null,
      `per-window finished badge (badge-fa-rearm-drain-finished-${MONTH}) must render`,
    );
    assert(
      (perBadge!.textContent ?? "").includes("No more to recover"),
      `per-window badge must read "No more to recover" for still_empty — got "${perBadge!.textContent}"`,
    );
    assert(
      !(perBadge!.textContent ?? "").includes("Re-arm done"),
      "per-window still_empty badge must NOT use the green 'Re-arm done' wording",
    );
    const perCls = perBadge!.className;
    assert(
      perCls.includes("bg-amber-100") &&
        perCls.includes("text-amber-800") &&
        perCls.includes("border-amber-300"),
      `per-window still_empty badge must use amber styling — got className "${perCls}"`,
    );
    assert(
      !perCls.includes("bg-green-100"),
      "per-window still_empty badge must NOT use green styling",
    );

    // All-windows finished badge.
    const allBadge = $("badge-fa-rearm-all-drain-finished");
    assert(
      allBadge !== null,
      "all-windows finished badge (badge-fa-rearm-all-drain-finished) must render",
    );
    assert(
      (allBadge!.textContent ?? "").includes("No more to recover"),
      `all-windows badge must read "No more to recover" for still_empty — got "${allBadge!.textContent}"`,
    );
    assert(
      !(allBadge!.textContent ?? "").includes("Re-arm all done"),
      "all-windows still_empty badge must NOT use the green 'Re-arm all done' wording",
    );
    const allCls = allBadge!.className;
    assert(
      allCls.includes("bg-amber-100") &&
        allCls.includes("text-amber-800") &&
        allCls.includes("border-amber-300"),
      `all-windows still_empty badge must use amber styling — got className "${allCls}"`,
    );
    assert(
      !allCls.includes("bg-green-100"),
      "all-windows still_empty badge must NOT use green styling",
    );
    console.log(
      "  ✓ both per-window and all-windows badges show amber 'No more to recover'",
    );
  } finally {
    await unmount(root);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — re_armed / ingested ⇒ green "Re-arm done" / "Re-arm all done".
// ---------------------------------------------------------------------------

async function scenarioReArmed(): Promise<void> {
  console.log(
    "\n— Scenario 2: finished drains with lastOutcomeKind=re_armed/ingested → green 'Re-arm done' —",
  );
  activeFetchHandler = makeHandler(
    buildAutoClosureStatus({
      month: MONTH,
      kind: "re_armed",
      allKind: "ingested",
    }),
  );
  document.getElementById("root")!.innerHTML = "";
  const root = await mountPanel();
  try {
    // Per-window finished badge — green "Re-arm done".
    const perBadge = $(`badge-fa-rearm-drain-finished-${MONTH}`);
    assert(
      perBadge !== null,
      `per-window finished badge (badge-fa-rearm-drain-finished-${MONTH}) must render`,
    );
    assert(
      (perBadge!.textContent ?? "").includes("Re-arm done"),
      `per-window badge must read "Re-arm done" for re_armed — got "${perBadge!.textContent}"`,
    );
    assert(
      !(perBadge!.textContent ?? "").includes("No more to recover"),
      "per-window re_armed badge must NOT use the amber 'No more to recover' wording",
    );
    const perCls = perBadge!.className;
    assert(
      perCls.includes("bg-green-100") && perCls.includes("text-green-700"),
      `per-window re_armed badge must use green styling — got className "${perCls}"`,
    );
    assert(
      !perCls.includes("bg-amber-100"),
      "per-window re_armed badge must NOT use amber styling",
    );

    // All-windows finished badge — green "Re-arm all done".
    const allBadge = $("badge-fa-rearm-all-drain-finished");
    assert(
      allBadge !== null,
      "all-windows finished badge (badge-fa-rearm-all-drain-finished) must render",
    );
    assert(
      (allBadge!.textContent ?? "").includes("Re-arm all done"),
      `all-windows badge must read "Re-arm all done" for ingested — got "${allBadge!.textContent}"`,
    );
    assert(
      !(allBadge!.textContent ?? "").includes("No more to recover"),
      "all-windows ingested badge must NOT use the amber 'No more to recover' wording",
    );
    const allCls = allBadge!.className;
    assert(
      allCls.includes("bg-green-100") && allCls.includes("text-green-700"),
      `all-windows ingested badge must use green styling — got className "${allCls}"`,
    );
    assert(
      !allCls.includes("bg-amber-100"),
      "all-windows ingested badge must NOT use amber styling",
    );
    console.log(
      "  ✓ both per-window and all-windows badges show green 'Re-arm done' / 'Re-arm all done'",
    );
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenarioStillEmpty();
  await scenarioReArmed();
  console.log(
    "\nfront-rearm-no-more-to-recover-badge: all badge cases passed",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
