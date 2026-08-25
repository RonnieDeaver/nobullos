/* test-registration
{
  "name": "All-time in-scope confirmation banner \u2014 green vs amber (Task #2474)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-in-scope-confirmation-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Frontend render test for the Front all-time coverage "in-scope
 * confirmation" banner (`FrontHistoricalRecoveryPanel`, testid
 * `text-fa-in-scope-confirmation`). Task #2439 added this banner above the
 * monthly table to tell the operator, in one line, whether every in-scope
 * month is actually counted in the all-time headline. The service-layer
 * split (inScopeMonths / inScopeCountedMonths / inScopeExcludedMonths) is
 * already covered by tests/front-analytics-coverage-inscope-confirmation.test.ts,
 * but the component branch — green (all counted) vs amber (some excluded),
 * plus the exact operator-facing copy + counts — had no test. This locks
 * both branches:
 *
 *   1. AMBER branch (inScopeExcludedMonths > 0): the banner carries the
 *      amber styling (bg-amber-50 / border-amber-200 / text-amber-800),
 *      states "<counted> of <inScope> in-scope month(s) counted" with the
 *      excluded count surfaced, and renders the
 *      `button-fa-finish-message-grain` one-step driver. The green
 *      "done" line must NOT be present.
 *   2. GREEN branch (inScopeExcludedMonths === 0): the banner flips to the
 *      emerald styling (bg-emerald-50 / border-emerald-200 /
 *      text-emerald-800) and shows the `text-fa-finish-message-grain-done`
 *      line "All <inScope> in-scope month(s) are message-grain and counted
 *      …", with no driver button and no amber styling.
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The
 * jsdom + fetch harness is copied from
 * tests/client/front-coverage-error-copy-view.test.tsx (Task #2218); the
 * only payload that varies between the two cases is `allTime`, which is
 * swapped via a module-level holder before each mount.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2439 (the banner under test — green/amber confirmation + one-step
 *   finish-message-grain driver), #2511 (`finish_front_message_grain_coverage`
 *   prod-action the button triggers), #2440 (sibling coverage-completeness
 *   banner just below it), #2218 / #2182 / #2138 (the jsdom panel-mount +
 *   stubbed-fetch harness this copies).
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
  id: "admin-2439",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// The only payload field that varies between the two cases. Each test sets
// this holder before mounting the panel.
let currentAllTime: Record<string, unknown> = {};

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
        json: () => ({
          adoptionDate: "2025-07-01",
          lastRefreshedAt: "2026-05-29T00:00:00.000Z",
          thresholds: { monthFloorPct: 95 },
          allTime: currentAllTime,
          months: [],
        }),
      },
      {
        path: /\/analytics-coverage\/finish-message-grain-status$/,
        json: {
          state: "not-needed",
          running: false,
          detail: "",
          floorMonth: null,
          excludedMonths: 0,
          months: [],
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

  // --- AMBER branch: some in-scope months still excluded -------------------
  console.log("\n— AMBER: inScopeExcludedMonths > 0 —");
  currentAllTime = {
    appliedCoveragePct: 100,
    fetchedCoveragePct: 100,
    appliedIntoNobull: 0,
    fetchedIntoNobull: 0,
    frontTotalMessages: 0,
    ingestGap: 0,
    applyGap: 0,
    inScopeMonths: 10,
    inScopeCountedMonths: 7,
    inScopeExcludedMonths: 3,
  };
  {
    const root = await mountPanel();
    try {
      const banner = $("text-fa-in-scope-confirmation");
      assert(banner !== null, "the in-scope confirmation banner must render");
      assert(
        banner!.className.includes("bg-amber-50") &&
          banner!.className.includes("border-amber-200") &&
          banner!.className.includes("text-amber-800"),
        `amber banner must use amber styling — got "${banner!.className}"`,
      );
      assert(
        !banner!.className.includes("bg-emerald-50"),
        "amber banner must NOT use emerald styling",
      );

      const text = (banner!.textContent || "").replace(/\s+/g, " ").trim();
      assert(
        text.includes("7 of 10 in-scope month(s) counted"),
        `amber copy must state counted-of-inScope — got "${text}"`,
      );
      assert(
        /\b3\b/.test(text) && text.includes("still"),
        `amber copy must surface the excluded count as still excluded — got "${text}"`,
      );

      assert(
        $("button-fa-finish-message-grain") !== null,
        "amber branch must render the one-step finish-message-grain driver button",
      );
      assert(
        $("text-fa-finish-message-grain-done") === null,
        "amber branch must NOT render the green done line",
      );
      console.log("  ✓ amber styling, counts, and finish button");
    } finally {
      await unmount(root);
    }
  }

  // --- GREEN branch: every in-scope month counted -------------------------
  console.log("\n— GREEN: inScopeExcludedMonths === 0 —");
  currentAllTime = {
    appliedCoveragePct: 100,
    fetchedCoveragePct: 100,
    appliedIntoNobull: 0,
    fetchedIntoNobull: 0,
    frontTotalMessages: 0,
    ingestGap: 0,
    applyGap: 0,
    inScopeMonths: 12,
    inScopeCountedMonths: 12,
    inScopeExcludedMonths: 0,
  };
  {
    const root = await mountPanel();
    try {
      const banner = $("text-fa-in-scope-confirmation");
      assert(banner !== null, "the in-scope confirmation banner must render");
      assert(
        banner!.className.includes("bg-emerald-50") &&
          banner!.className.includes("border-emerald-200") &&
          banner!.className.includes("text-emerald-800"),
        `green banner must use emerald styling — got "${banner!.className}"`,
      );
      assert(
        !banner!.className.includes("bg-amber-50"),
        "green banner must NOT use amber styling",
      );

      const done = $("text-fa-finish-message-grain-done");
      assert(done !== null, "green branch must render the done line");
      const text = (done!.textContent || "").replace(/\s+/g, " ").trim();
      assert(
        text.includes("All 12 in-scope month(s) are message-grain and counted"),
        `green copy must confirm all in-scope months counted — got "${text}"`,
      );

      assert(
        $("button-fa-finish-message-grain") === null,
        "green branch must NOT render the finish-message-grain driver button",
      );
      console.log("  ✓ emerald styling and all-counted done line");
    } finally {
      await unmount(root);
    }
  }

  console.log("\nfront-coverage-in-scope-confirmation: all render cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
