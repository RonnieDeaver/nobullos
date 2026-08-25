/* test-registration
{
  "name": "Coverage table completeness Status badge (Task #2091)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/front-coverage-completeness-badge-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2091 — Frontend regression test for the Front Analytics coverage
 * table's per-month completeness Status cell (added by Task #2087).
 *
 * Task #2087's classifier is already pinned as a pure function by
 * tests/front-analytics-coverage-completeness.test.ts. This test locks
 * the *UI contract* of the panel render so a future refactor can't
 * silently re-mask a gap month as "final":
 *
 *   1. For each completeness status the server can emit, the Status cell
 *      renders the badge `badge-fa-completeness-${month}` with the
 *      correct human label AND color token:
 *        - covered      → "covered"      (bg-green-50)
 *        - ingest-gap   → "ingest gap"   (bg-amber-50)
 *        - apply-gap    → "apply gap"    (bg-rose-50)
 *        - in-progress  → "in progress"  (bg-sky-50)
 *        - not-measured → "not measured" (bg-muted, dashed)
 *
 *   2. The legacy finalized/current state is demoted to the muted
 *      `text-fa-finalized-${month}` sub-label ("denominator: finalized"
 *      vs "denominator: current") — it is no longer the primary signal.
 *
 * Mounts the real `FrontHistoricalRecoveryPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch` that
 * serves a coverage payload whose `months` cover every status. The
 * close-state filter defaults to "all", so all rows render.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2087 (completenessStatus / completenessReason classifier + Status
 *   cell), #2088 (close-state column + filter that shares the row),
 *   #2058 / #2021 (this jsdom panel-mount harness pattern), #1837 / #1974
 *   (per-direction coverage + denominator semantics behind the row).
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
  id: "admin-2091",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "ceo",
};

// One coverage row per completeness status. `frontAnalyticsStatus: "ok"`
// with no error keeps the error/pending pills out of the Status cell so
// the assertions target only the completeness badge + sub-label.
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

const MONTHS = [
  coverageMonth({
    month: "2026-01",
    completenessStatus: "covered",
    completenessReason: "Finalized month, no material gap.",
    isFinalizedMonth: true,
  }),
  coverageMonth({
    month: "2026-02",
    completenessStatus: "ingest-gap",
    completenessReason: "Front has more messages than were fetched.",
    isFinalizedMonth: true,
  }),
  coverageMonth({
    month: "2026-03",
    completenessStatus: "apply-gap",
    completenessReason: "Fetched but not yet applied.",
    isFinalizedMonth: true,
  }),
  coverageMonth({
    month: "2026-04",
    completenessStatus: "in-progress",
    completenessReason: "Current / non-finalized month.",
    isFinalizedMonth: false,
  }),
  coverageMonth({
    month: "2026-05",
    completenessStatus: "not-measured",
    completenessReason: "No measured denominator for this month.",
    isFinalizedMonth: false,
    unitsComparable: false,
    pulledAt: null,
  }),
];

// Expected badge label + a distinctive color token per status.
const EXPECTED: Record<
  string,
  { month: string; label: string; colorToken: string; finalized: boolean }
> = {
  covered: { month: "2026-01", label: "covered", colorToken: "bg-green-50", finalized: true },
  "ingest-gap": { month: "2026-02", label: "ingest gap", colorToken: "bg-amber-50", finalized: true },
  "apply-gap": { month: "2026-03", label: "apply gap", colorToken: "bg-rose-50", finalized: true },
  "in-progress": { month: "2026-04", label: "in progress", colorToken: "bg-sky-50", finalized: false },
  // Token updated by the gray/slate→semantic migration (bg-muted + border-dashed).
  "not-measured": { month: "2026-05", label: "not measured", colorToken: "bg-muted", finalized: false },
};

function makeFetchHandler(opts: { user: any }): (url: string, init?: any) => Promise<Response> {
  return createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { method: "POST", json: {} },
      {
        path: "/api/auth/user",
        respond: () => (opts.user ? { status: 200, json: opts.user } : { status: 401, json: {} }),
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

    for (const [status, exp] of Object.entries(EXPECTED)) {
      console.log(`\n— status "${status}" (${exp.month}) —`);

      const row = $(`row-fa-month-${exp.month}`);
      assert(row !== null, `coverage row for ${exp.month} must render`);

      const badge = $(`badge-fa-completeness-${exp.month}`);
      assert(badge !== null, `completeness badge for ${exp.month} must render`);
      assert(
        (badge!.textContent || "").trim() === exp.label,
        `badge label for ${status} must be "${exp.label}" — got "${badge!.textContent}"`,
      );
      assert(
        (badge!.className || "").includes(exp.colorToken),
        `badge for ${status} must carry color token "${exp.colorToken}" — got "${badge!.className}"`,
      );
      if (status === "not-measured") {
        assert(
          (badge!.className || "").includes("border-dashed"),
          `not-measured badge must be visually distinct (border-dashed) — got "${badge!.className}"`,
        );
      }

      // The finalized/current state is demoted to the muted sub-label.
      const subLabel = $(`text-fa-finalized-${exp.month}`);
      assert(subLabel !== null, `finalized sub-label for ${exp.month} must render`);
      const expectedSub = exp.finalized ? "denominator: finalized" : "denominator: current";
      assert(
        (subLabel!.textContent || "").trim() === expectedSub,
        `sub-label for ${exp.month} must be "${expectedSub}" — got "${subLabel!.textContent}"`,
      );

      console.log(
        `  ✓ badge "${exp.label}" (${exp.colorToken}); sub-label "${expectedSub}"`,
      );
    }

    console.log("\nfront-coverage-completeness-badge: all DOM cases passed");
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
