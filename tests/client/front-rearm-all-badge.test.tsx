/* test-registration
{
  "name": "Re-arm all progress badge \u2014 null / running / finished (Task #2193)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-rearm-all-badge-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2193 — All-windows "Re-arm all (search strategy)" progress badge
 * on the Front Historical Recovery panel.
 *
 * Task #2168 added server-side coverage for the `allReArmDrain` field on
 * `getFrontAutoClosureStatus()` (see
 * `tests/front-rearm-all-drain-progress.test.ts`). This file pins the
 * CLIENT projection of that field into the running/finished badge rendered
 * by `FrontHistoricalRecoveryPanel` (the `allDrain` logic around lines 447
 * and 2666). It asserts the three states a regression could silently
 * break:
 *
 *   (a) `allReArmDrain` null → no badge (running or finished) renders.
 *   (b) running=true → the running/in-progress badge renders with
 *       processed/totalAtStart progress.
 *   (c) finished (running=false, finishedAt set, lastOutcomeKind) → the
 *       terminal badge renders with the final outcome tally.
 *
 * Mirrors the harness used by `tests/client/front-autoheal-banner.test.tsx`
 * (JSDOM + real component graph, fetch handler stub,
 * `--import ./tests/client/setup-mocks.mjs`,
 * `TSX_TSCONFIG_PATH=./tsconfig.tests.json`, registered in run-all.ts).
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
  id: "admin-2193",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// A parked window so the parked-windows section (which hosts the badge)
// renders at all.
const PARKED_WINDOWS = {
  "2031-01": {
    parkedAt: "2031-01-01T00:00:00Z",
    reason: "dead_run_streak:3_runs",
    deadRuns: 3,
    lastCheckpointAt: "2031-01-01T00:00:00Z",
  },
};

function makeAutoClosureStatus(allReArmDrain: any): any {
  return {
    enabled: true,
    currentMode: "daytime",
    lastSummary: null,
    parkedWindows: PARKED_WINDOWS,
    allReArmDrain,
  };
}

function makeHandler(allReArmDrain: any): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { test: (_url, method) => method !== "GET", json: {} },
      { path: "/api/auth/user", json: ADMIN_USER },
      { path: "/api/integrations/all-status", json: { front: { connected: true } } },
      { path: /\/auto-closure\/status/, json: makeAutoClosureStatus(allReArmDrain) },
      { path: /\/auto-closure\/overnight/, json: { config: null } },
      { path: /\/auto-closure\/regression-alert-status/, json: {} },
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
        json: { maxAgeDays: 30, defaultDays: 30, minDays: 1, maxDays: 365, lastEdited: null },
      },
      { path: /\/historical-recovery\/max-age\/history$/, json: { history: [] } },
      {
        path: /\/historical-recovery\/prune-interval$/,
        json: { intervalMinutes: 60, defaultMinutes: 60, minMinutes: 5, maxMinutes: 1440, lastEdited: null },
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
}

async function runScenario(
  name: string,
  allReArmDrain: any,
  check: () => void,
): Promise<void> {
  console.log(`\n— Re-arm all badge scenario: ${name} —`);
  activeFetchHandler = makeHandler(allReArmDrain);
  document.getElementById("root")!.innerHTML = "";
  const root = await mountPanel();
  try {
    // Sanity: the parked-windows section (badge host) must always render.
    assert(
      $("section-fa-auto-closure-parked") !== null,
      "parked-windows section must render",
    );
    check();
  } finally {
    await unmount(root);
  }
}

// ── (a) null → no badge. ───────────────────────────────────────────────
await runScenario("allReArmDrain null → no badge", null, () => {
  assert(
    $("badge-fa-rearm-all-drain-running") === null,
    "running badge must NOT render when allReArmDrain is null",
  );
  assert(
    $("badge-fa-rearm-all-drain-finished") === null,
    "finished badge must NOT render when allReArmDrain is null",
  );
  // Task #2226 — with no drain running, the "Re-arm all" button must be
  // clickable and read its default label.
  const btn = $("button-fa-rearm-all") as HTMLButtonElement | null;
  assert(btn !== null, "re-arm all button must render");
  assert(
    (btn as HTMLButtonElement).disabled === false,
    "re-arm all button must be ENABLED when no drain is running",
  );
  const label = (btn!.textContent ?? "").trim();
  assert(
    label === "Re-arm all (search strategy)",
    `re-arm all button must read its default label, got "${label}"`,
  );
});

// ── (b) running=true → running badge with progress. ────────────────────
await runScenario(
  "running → in-progress badge with processed/total",
  {
    running: true,
    finishedAt: null,
    processed: 1,
    totalAtStart: 3,
    progress: "Re-arming all parked windows… 1/3",
    startedAt: new Date().toISOString(),
  },
  () => {
    const running = $("badge-fa-rearm-all-drain-running");
    assert(running !== null, "running badge must render when running=true");
    assert(
      $("badge-fa-rearm-all-drain-finished") === null,
      "finished badge must NOT render while running",
    );
    const txt = running!.textContent ?? "";
    assert(
      txt.includes("1/3"),
      `running badge must show processed/total progress, got "${txt}"`,
    );
    // Task #2226 — while the drain is running, the "Re-arm all" button must
    // disable itself (so an operator can't double-start a drain) and read
    // its in-progress label.
    const btn = $("button-fa-rearm-all") as HTMLButtonElement | null;
    assert(btn !== null, "re-arm all button must render");
    assert(
      (btn as HTMLButtonElement).disabled === true,
      "re-arm all button must be DISABLED while a drain is running",
    );
    const label = (btn!.textContent ?? "").trim();
    assert(
      label === "Re-arming all…",
      `re-arm all button must read its in-progress label, got "${label}"`,
    );
  },
);

// ── (c) finished → terminal badge with outcome tally. ──────────────────
await runScenario(
  "finished → terminal badge with outcome",
  {
    running: false,
    finishedAt: new Date().toISOString(),
    processed: 3,
    totalAtStart: 3,
    lastOutcomeKind: "still_empty",
    progress: "Re-arm all done",
  },
  () => {
    const finished = $("badge-fa-rearm-all-drain-finished");
    assert(finished !== null, "finished badge must render when running=false");
    assert(
      $("badge-fa-rearm-all-drain-running") === null,
      "running badge must NOT render once finished",
    );
    const txt = finished!.textContent ?? "";
    assert(
      txt.includes("3/3"),
      `finished badge must show processed/total tally, got "${txt}"`,
    );
    // still_empty maps to the "No more to recover" terminal phrasing.
    assert(
      txt.includes("No more to recover"),
      `finished badge must surface the still_empty terminal outcome, got "${txt}"`,
    );
  },
);

// ── (d) finished (success) → green badge with "Re-arm all done". ───────
// Task #2227 — a non-still_empty outcome must render the SUCCESS variant
// (green styling + "Re-arm all done: x/y · <kind>"), NOT the amber
// "No more to recover" exhausted phrasing.
await runScenario(
  "finished (success) → green 'Re-arm all done' badge",
  {
    running: false,
    finishedAt: new Date().toISOString(),
    processed: 2,
    totalAtStart: 3,
    lastOutcomeKind: "recovered",
    progress: "Re-arm all done",
  },
  () => {
    const finished = $("badge-fa-rearm-all-drain-finished");
    assert(finished !== null, "finished badge must render when running=false");
    assert(
      $("badge-fa-rearm-all-drain-running") === null,
      "running badge must NOT render once finished",
    );
    const txt = finished!.textContent ?? "";
    // Success phrasing — must use "Re-arm all done", not the exhausted
    // "No more to recover" phrasing and not the "Re-arm all failed" error.
    assert(
      txt.includes("Re-arm all done"),
      `success badge must show "Re-arm all done" phrasing, got "${txt}"`,
    );
    assert(
      !txt.includes("No more to recover"),
      `success badge must NOT show the exhausted "No more to recover" phrasing, got "${txt}"`,
    );
    assert(
      !txt.includes("Re-arm all failed"),
      `success badge must NOT show the error "Re-arm all failed" phrasing, got "${txt}"`,
    );
    // Outcome tally + kind suffix.
    assert(
      txt.includes("2/3"),
      `success badge must show processed/total tally, got "${txt}"`,
    );
    assert(
      txt.includes("recovered"),
      `success badge must append the outcome kind, got "${txt}"`,
    );
    // Success styling — green, not amber (exhausted) or red (error).
    const cls = finished!.className;
    assert(
      cls.includes("bg-green-100") && cls.includes("text-green-700"),
      `success badge must use green styling, got "${cls}"`,
    );
    assert(
      !cls.includes("bg-amber-100") && !cls.includes("bg-red-100"),
      `success badge must NOT use amber/red styling, got "${cls}"`,
    );
  },
);

// ── (e) finished (error) → red badge with "Re-arm all failed". ─────────
// Task #2227 — when allDrain.error is set the finished badge must render
// the ERROR variant (red styling + "Re-arm all failed").
await runScenario(
  "finished (error) → red 'Re-arm all failed' badge",
  {
    running: false,
    finishedAt: new Date().toISOString(),
    processed: 1,
    totalAtStart: 3,
    lastOutcomeKind: "recovered",
    error: "search strategy aborted: upstream 500",
    progress: "Re-arm all done",
  },
  () => {
    const finished = $("badge-fa-rearm-all-drain-finished");
    assert(finished !== null, "finished badge must render when running=false");
    const txt = finished!.textContent ?? "";
    // Error phrasing wins over both success and exhausted.
    assert(
      txt.includes("Re-arm all failed"),
      `error badge must show "Re-arm all failed" phrasing, got "${txt}"`,
    );
    assert(
      !txt.includes("Re-arm all done"),
      `error badge must NOT show the success "Re-arm all done" phrasing, got "${txt}"`,
    );
    assert(
      !txt.includes("No more to recover"),
      `error badge must NOT show the exhausted "No more to recover" phrasing, got "${txt}"`,
    );
    // Error styling — red, not green (success) or amber (exhausted).
    const cls = finished!.className;
    assert(
      cls.includes("bg-red-100") && cls.includes("text-red-700"),
      `error badge must use red styling, got "${cls}"`,
    );
    assert(
      !cls.includes("bg-green-100") && !cls.includes("bg-amber-100"),
      `error badge must NOT use green/amber styling, got "${cls}"`,
    );
  },
);

console.log(
  "\nfront-rearm-all-badge: null / running / finished (exhausted/success/error) badge states render correctly.",
);
