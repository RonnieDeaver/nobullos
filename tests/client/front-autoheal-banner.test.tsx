/* test-registration
{
  "name": "Front Recovery auto-heal banner 4-state (Task #1708)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-autoheal-banner-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #1708 — Always-visible Auto-heal status banner on the Front
 * Historical Recovery panel. Asserts the banner renders in all four
 * states (gray/green/amber/red) driven by the sweep-status + jobs +
 * auto-continue payloads.
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
  id: "admin-1708",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

type Scenario = {
  sweep: any;
  jobs: any[];
  autoContinue?: any;
};

function makeHandler(s: Scenario): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { test: (_url: string, method: string) => method !== "GET", json: {} },
      { path: "/api/auth/user", json: ADMIN_USER },
      { path: "/api/integrations/all-status", json: { front: { connected: true } } },
      { test: (url: string) => url.includes("/historical-recovery/sweep-status"), json: s.sweep },
      { test: (url: string) => url.includes("/historical-recovery/jobs"), json: { jobs: s.jobs } },
      {
        test: (url: string) =>
          url.includes("/historical-recovery/auto-continue-max-attempts") && url.endsWith("/history"),
        json: { history: [] },
      },
      {
        test: (url: string) => url.includes("/historical-recovery/auto-continue-max-attempts"),
        json:
          s.autoContinue ?? {
            maxAttempts: 5,
            defaultAttempts: 5,
            minAttempts: 1,
            maxAttemptsAllowed: 20,
          },
      },
      {
        test: (url: string) => url.endsWith("/historical-recovery/max-age"),
        json: { maxAgeDays: 30, defaultDays: 30, minDays: 1, maxDays: 365, lastEdited: null },
      },
      { test: (url: string) => url.endsWith("/historical-recovery/max-age/history"), json: { history: [] } },
      {
        test: (url: string) => url.endsWith("/historical-recovery/prune-interval"),
        json: { intervalMinutes: 60, defaultMinutes: 60, minMinutes: 5, maxMinutes: 1440, lastEdited: null },
      },
      { test: (url: string) => url.endsWith("/historical-recovery/prune-interval/history"), json: { history: [] } },
      { test: (url: string) => url.includes("/historical-recovery/manual-sweep-history"), json: { entries: [] } },
      { test: (url: string) => url.includes("/historical-recovery/coverage"), json: { windows: [] } },
    ],
    defaultJson: {},
  }) as unknown as (url: string, init?: any) => Promise<Response>;
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

async function runScenario(name: string, expected: "green" | "amber" | "red" | "gray", scenario: Scenario): Promise<void> {
  console.log(`\n— Banner scenario: ${name} → ${expected} —`);
  activeFetchHandler = makeHandler(scenario);
  document.getElementById("root")!.innerHTML = "";
  const root = await mountPanel();
  try {
    const banner = $("banner-recovery-autoheal");
    assert(banner !== null, "banner-recovery-autoheal must render");
    const stateAttr = banner!.getAttribute("data-state");
    assert(
      stateAttr === expected,
      `expected banner state="${expected}", got "${stateAttr}"`,
    );
    const pill = $(`banner-recovery-autoheal-state-${expected}`);
    assert(pill !== null, `state pill for "${expected}" must render`);
    const runBtnAlways = $("button-recovery-run-sweep-now");
    // Run-sweep button lives inside the expandable details. Per Task #1720
    // the banner auto-expands when not healthy (gray/amber/red); only the
    // green state stays collapsed by default.
    if (expected === "green") {
      assert(
        runBtnAlways === null,
        "button-recovery-run-sweep-now must be hidden when healthy banner is collapsed",
      );
    } else {
      assert(
        runBtnAlways !== null,
        `button-recovery-run-sweep-now must be visible when banner auto-expands (state="${expected}")`,
      );
    }
    const expandBtn = $("button-recovery-autoheal-expand");
    assert(expandBtn !== null, "expand chevron must render in banner header");
  } finally {
    await unmount(root);
  }
}

const now = Date.now();

await runScenario("sweep off", "gray", {
  sweep: {
    running: false,
    inFlight: false,
    intervalMs: 60_000,
    lastSweepAt: null,
    lastPrunedCount: 0,
    lastError: null,
  },
  jobs: [],
});

await runScenario("healthy", "green", {
  sweep: {
    running: true,
    inFlight: false,
    intervalMs: 60_000,
    lastSweepAt: new Date(now - 30_000).toISOString(),
    lastPrunedCount: 2,
    lastAutoResumedCount: 0,
    lastSkippedCount: 0,
    lastError: null,
  },
  jobs: [],
});

await runScenario("degraded (cap=0)", "amber", {
  sweep: {
    running: true,
    inFlight: false,
    intervalMs: 60_000,
    lastSweepAt: new Date(now - 30_000).toISOString(),
    lastPrunedCount: 0,
    lastError: null,
  },
  jobs: [],
  autoContinue: {
    maxAttempts: 0,
    defaultAttempts: 5,
    minAttempts: 0,
    maxAttemptsAllowed: 20,
  },
});

await runScenario("paused via kill switch", "amber", {
  sweep: {
    running: true,
    inFlight: false,
    intervalMs: 60_000,
    lastSweepAt: new Date(now - 30_000).toISOString(),
    lastPrunedCount: 0,
    lastError: null,
    paused: true,
    pauseReasons: ["kill_switch_non_critical_sweeps"],
  },
  jobs: [],
});

await runScenario("attention needed (lastError)", "red", {
  sweep: {
    running: true,
    inFlight: false,
    intervalMs: 60_000,
    lastSweepAt: new Date(now - 30_000).toISOString(),
    lastPrunedCount: 0,
    lastError: "boom",
  },
  jobs: [],
});

console.log("\nfront-autoheal-banner: all 4 banner states render correctly.");
