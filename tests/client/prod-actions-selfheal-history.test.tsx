/* test-registration
{
  "name": "Prod-actions panel auto-heal run history timeline (Task #2196)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2196 — Frontend test for the CEO prod-actions / maintenance panel
 * (`ProdActionsPanel`) "Auto-heal run history" timeline (added by Task #2125).
 *
 * The runs endpoint's `actor=system` filter is covered server-side, but the
 * React rendering of the collapsible timeline was untested. This locks the
 * frontend contract for the rows fed by
 * GET /api/admin/prod-actions/runs?actor=system:
 *
 *   - the history section is collapsed by default and expands on the header
 *     toggle (`header-prod-actions-selfheal-history-toggle`),
 *   - each system run renders a row (`row-prod-action-selfheal-run-<id>`)
 *     with its state badge, title, formatted timestamp, rows-affected, and
 *     error/detail line at the expected data-testids, and
 *   - when the endpoint returns no runs the empty-state
 *     (`text-prod-actions-selfheal-history-empty`) renders instead.
 *
 * so a future refactor can't silently drop the timeline, mis-map a field, or
 * lose the empty-state.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The panel
 * fetches only once opened, so the test clicks the panel header toggle first,
 * then the history toggle. Prior-task harness pattern: #2180
 * (tests/client/prod-actions-selfheal-failing-indicator.test.tsx).
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
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Status payload is intentionally minimal: this test exercises the auto-heal
// run *history* timeline, not the active/completed action lists. The history
// section only renders once the status query is no longer loading/errored.
const STATUSES = {
  actions: [],
  active: [],
  completed: [],
  selfHealEnabled: true,
  selfHealLastRun: null,
};

const APPLIED_AT_ISO = new Date("2026-06-02T09:30:00.000Z").toISOString();
const ERROR_AT_ISO = new Date("2026-06-02T08:15:00.000Z").toISOString();

// Two system-actor runs:
//   - applied run with a positive rowsAffected and a plain detail line, and
//   - error run with a null rowsAffected and an errorMessage line.
const RUNS = [
  {
    id: "run_applied_1",
    actionId: "rebuild_rollups",
    actionTitle: "Rebuild demand rollups",
    outcomeState: "applied",
    rowsAffected: 42,
    detail: "Rebuilt cleanly.",
    errorMessage: null,
    appliedAt: APPLIED_AT_ISO,
  },
  {
    id: "run_error_2",
    actionId: "drain_front_tail",
    actionTitle: "Drain stuck Front apply-tail",
    outcomeState: "error",
    rowsAffected: null,
    detail: null,
    errorMessage: "Timed out reaching Front API.",
    appliedAt: ERROR_AT_ISO,
  },
];

// Swappable runs payload so the same harness can render both the populated
// timeline and the empty-state across two mounts (queryClient.clear() between
// mounts forces a re-fetch that re-reads this).
let runsPayload: any[] = RUNS;

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "POST", json: { results: [] } },
    { path: "/api/admin/prod-actions/runs", json: () => ({ runs: runsPayload }) },
    { path: "/api/admin/prod-actions", json: STATUSES },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const { ProdActionsPanel } = await import(
  "../../client/src/components/admin/ProdActionsPanel"
);

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  return fetchHandler(url, init);
};

async function flush(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function mountAndOpenHistory(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(ProdActionsPanel as any),
      ),
    );
  });
  await flush();

  // The panel only fetches once opened — click the header toggle.
  const header = $("header-prod-actions-toggle");
  assert(header !== null, "panel header toggle must render");
  await act(async () => {
    header!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush();

  // The run-history section starts collapsed; expand it.
  const historyToggle = $("header-prod-actions-selfheal-history-toggle");
  assert(historyToggle !== null, "auto-heal history toggle must render");
  await act(async () => {
    historyToggle!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  await flush();
  return root!;
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("Prod-actions panel auto-heal run history timeline (Task #2196)");

  // ---- Case 1: populated timeline ----
  runsPayload = RUNS;
  let root = await mountAndOpenHistory();
  try {
    const list = $("list-prod-actions-selfheal-history");
    assert(list !== null, "expanded history list container must render");

    const countBadge = $("badge-prod-actions-selfheal-history-count");
    assert(
      (countBadge?.textContent || "").trim() === "2",
      `history count badge must show the run count — got "${countBadge?.textContent}"`,
    );

    // -- applied run: badge + title + timestamp + rows + detail --
    const appliedRow = $("row-prod-action-selfheal-run-run_applied_1");
    assert(appliedRow !== null, "the applied run row must render");

    const appliedTitle = $("text-prod-action-selfheal-run-title-run_applied_1");
    assert(
      (appliedTitle?.textContent || "").trim() === "Rebuild demand rollups",
      `applied run must show its action title — got "${appliedTitle?.textContent}"`,
    );

    const appliedAt = $("text-prod-action-selfheal-run-at-run_applied_1");
    assert(
      (appliedAt?.textContent || "").trim() ===
        new Date(APPLIED_AT_ISO).toLocaleString(),
      `applied run must show the locale-formatted timestamp — got "${appliedAt?.textContent}"`,
    );

    const appliedRows = $("text-prod-action-selfheal-run-rows-run_applied_1");
    assert(
      (appliedRows?.textContent || "").trim() === "42 row(s)",
      `applied run must show its rows-affected — got "${appliedRows?.textContent}"`,
    );

    const appliedDetail = $("text-prod-action-selfheal-run-detail-run_applied_1");
    assert(
      (appliedDetail?.textContent || "").trim() === "Rebuilt cleanly.",
      `applied run must show its detail line — got "${appliedDetail?.textContent}"`,
    );

    // The applied state badge must render inside the row.
    assert(
      appliedRow!.querySelector(
        '[data-testid="badge-prod-action-state-applied"]',
      ) !== null,
      "applied run row must carry an 'Applied' state badge",
    );
    console.log("  ✓ applied run → badge + title + timestamp + 42 row(s) + detail");

    // -- error run: errorMessage shown, no rows-affected line --
    const errorRow = $("row-prod-action-selfheal-run-run_error_2");
    assert(errorRow !== null, "the error run row must render");

    const errorTitle = $("text-prod-action-selfheal-run-title-run_error_2");
    assert(
      (errorTitle?.textContent || "").trim() === "Drain stuck Front apply-tail",
      `error run must show its action title — got "${errorTitle?.textContent}"`,
    );

    const errorDetail = $("text-prod-action-selfheal-run-detail-run_error_2");
    assert(
      (errorDetail?.textContent || "").trim() === "Timed out reaching Front API.",
      `error run must show its errorMessage — got "${errorDetail?.textContent}"`,
    );

    // rowsAffected is null → the rows line must be absent (not "null row(s)").
    assert(
      $("text-prod-action-selfheal-run-rows-run_error_2") === null,
      "error run with null rowsAffected must NOT render a rows-affected line",
    );

    assert(
      errorRow!.querySelector(
        '[data-testid="badge-prod-action-state-error"]',
      ) !== null,
      "error run row must carry an 'Error' state badge",
    );

    // The empty-state must be absent when runs are present.
    assert(
      $("text-prod-actions-selfheal-history-empty") === null,
      "empty-state must be absent when the timeline has rows",
    );
    console.log("  ✓ error run → errorMessage shown, no rows-affected line, error badge");
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  }

  // ---- Case 2: empty timeline ----
  runsPayload = [];
  root = await mountAndOpenHistory();
  try {
    assert(
      $("list-prod-actions-selfheal-history") !== null,
      "expanded history list container must render in the empty case",
    );
    assert(
      $("text-prod-actions-selfheal-history-empty") !== null,
      "the empty-state must render when the runs endpoint returns no runs",
    );
    assert(
      $("row-prod-action-selfheal-run-run_applied_1") === null &&
        $("row-prod-action-selfheal-run-run_error_2") === null,
      "no run rows must render in the empty case",
    );
    const countBadge = $("badge-prod-actions-selfheal-history-count");
    assert(
      (countBadge?.textContent || "").trim() === "0",
      `history count badge must show 0 in the empty case — got "${countBadge?.textContent}"`,
    );
    console.log("  ✓ empty timeline → empty-state renders, no run rows, count badge 0");
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-history: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
