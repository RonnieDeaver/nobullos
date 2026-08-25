/* test-registration
{
  "name": "Prod-actions panel auto-heal run history loading/error states (Task #2233)",
  "regression": true,
  "sweepOnlyReason": "Task #4096 triage of the migrated no-reason boilerplate: too slow for the routine gate (~5.3s in the 2026-08-07 nightly sweep); still runs in the full suite and the nightly --regression sweep.",
  "scanPaths": [
    "client/src/components/admin/ProdActionsPanel.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2233 — Frontend test for the CEO prod-actions / maintenance panel
 * (`ProdActionsPanel`) "Auto-heal run history" timeline LOADING and ERROR
 * rendering branches (added by Task #2125).
 *
 * Task #2196 (tests/client/prod-actions-selfheal-history.test.tsx) already
 * locks the populated-rows and empty-state branches. This sibling covers the
 * two remaining rendering branches around `selfHealRunsQuery`:
 *
 *   - the spinner / "Loading recent automatic runs…" line
 *     (`text-prod-actions-selfheal-history-loading`) renders while the runs
 *     request is still in flight (a runs fetch that never resolves), and
 *   - the red "Failed to load run history: …" line
 *     (`text-prod-actions-selfheal-history-error`) renders with the error
 *     message when GET /api/admin/prod-actions/runs returns a non-2xx
 *     response.
 *
 * so a future refactor can't silently drop the loading spinner or the error
 * feedback.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The status
 * query must resolve first so the history section (and its toggle) renders;
 * only the runs query is held pending / made to fail. Prior-task harness
 * pattern: #2196 (tests/client/prod-actions-selfheal-history.test.tsx).
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
// section (and its toggle) only renders once the status query is no longer
// loading/errored.
const STATUSES = {
  actions: [],
  active: [],
  completed: [],
  selfHealEnabled: true,
  selfHealLastRun: null,
};

// "loading"  → the runs fetch never resolves (query stays isLoading).
// "error"    → the runs fetch returns a non-2xx response (query goes isError).
let runsMode: "loading" | "error" = "loading";
const RUNS_ERROR_BODY = { error: "boom while reading run history" };

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "POST", json: { results: [] } },
    {
      path: "/api/admin/prod-actions/runs",
      respond: () => {
        if (runsMode === "loading") {
          // Never resolves — keeps selfHealRunsQuery.isLoading true.
          return new Promise<Response>(() => {});
        }
        return { status: 500, json: RUNS_ERROR_BODY };
      },
    },
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

async function flush(times = 14, stepMs = 0): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, stepMs));
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

  console.log(
    "Prod-actions panel auto-heal run history loading/error states (Task #2233)",
  );

  // ---- Case 1: loading (runs fetch in flight) ----
  runsMode = "loading";
  let root = await mountAndOpenHistory();
  try {
    assert(
      $("list-prod-actions-selfheal-history") !== null,
      "expanded history list container must render while runs are loading",
    );
    assert(
      $("text-prod-actions-selfheal-history-loading") !== null,
      "the loading spinner line must render while the runs fetch is pending",
    );
    // While loading, neither the error nor the empty-state may render.
    assert(
      $("text-prod-actions-selfheal-history-error") === null,
      "the error line must be absent while the runs fetch is pending",
    );
    assert(
      $("text-prod-actions-selfheal-history-empty") === null,
      "the empty-state must be absent while the runs fetch is pending",
    );
    console.log("  ✓ runs fetch pending → loading spinner renders, no error/empty");
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  }

  // ---- Case 2: error (runs endpoint returns non-2xx) ----
  runsMode = "error";
  root = await mountAndOpenHistory();
  // A 5xx runs response is treated as a transient failure by the shared
  // queryClient (Task #2808), so `selfHealRunsQuery` retries with backoff
  // (~1s + 2s) before reaching its terminal isError state. Advance real time
  // past that retry window so the error branch actually renders.
  await flush(20, 250);
  try {
    assert(
      $("list-prod-actions-selfheal-history") !== null,
      "expanded history list container must render in the error case",
    );
    // The app queryClient now retries transient 5xx twice with 1s/2s backoff
    // (global transient-retry policy) before the query goes isError, so poll
    // in real time instead of asserting immediately after the first flush.
    const deadline = Date.now() + 10_000;
    while ($("text-prod-actions-selfheal-history-error") === null && Date.now() < deadline) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 150));
      });
    }
    const errorEl = $("text-prod-actions-selfheal-history-error");
    assert(
      errorEl !== null,
      "the error line must render when the runs endpoint returns a non-2xx response",
    );
    const errorText = (errorEl?.textContent || "").trim();
    assert(
      errorText.startsWith("Failed to load run history:"),
      `the error line must carry the "Failed to load run history:" prefix — got "${errorText}"`,
    );
    // The thrown query error is `${status}: ${text}`; the readout surfaces it.
    assert(
      errorText.includes("500"),
      `the error line must include the upstream status — got "${errorText}"`,
    );
    // While errored, neither the loading spinner nor the empty-state may render.
    assert(
      $("text-prod-actions-selfheal-history-loading") === null,
      "the loading spinner must be absent once the runs fetch has failed",
    );
    assert(
      $("text-prod-actions-selfheal-history-empty") === null,
      "the empty-state must be absent when the runs fetch has failed",
    );
    console.log("  ✓ runs fetch non-2xx → error readout renders, no loading/empty");
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-history-states: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
