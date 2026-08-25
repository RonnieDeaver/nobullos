/* test-registration
{
  "name": "Prod-actions panel auto-heal history 'Load more' paging (Task #2195)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2195 — Frontend regression test for the CEO prod-actions /
 * maintenance panel (`ProdActionsPanel`) "Auto-heal run history" section's
 * new "Load more" paging control.
 *
 * Task #2125 added a short timeline of the last 10 automatic self-heal
 * runs. Task #2195 lets operators pull older runs on demand by raising the
 * `limit` query param (default stays at 10 so the panel stays lightweight).
 * This locks the frontend contract:
 *
 *   - the default fetch requests `?actor=system&limit=10`,
 *   - when a full page (>= limit) comes back, a "Load more" button renders,
 *   - clicking it re-fetches with the limit raised by one page (limit=20),
 *   - once the server returns fewer than the limit (no more rows), the
 *     "Load more" button is gone and a "Show less" reset appears.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The panel
 * fetches its statuses only once opened, so the test clicks the header
 * toggle first, then opens the "Auto-heal run history" sub-section. Harness
 * pattern: tests/client/prod-actions-selfheal-failing-indicator.test.tsx
 * (Task #2180).
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

const BASE_ISO = new Date("2026-06-02T12:00:00.000Z").getTime();

// No active rows — this test only exercises the run-history sub-section.
const STATUSES = {
  actions: [],
  active: [],
  completed: [],
  selfHealEnabled: true,
  selfHealLastRun: null,
};

// Build N synthetic system-actor run rows, newest-first.
function makeRuns(n: number, idPrefix: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}-${i}`,
    actionId: "flapping_action",
    actionTitle: "Flapping action",
    outcomeState: i % 2 === 0 ? "applied" : "error",
    rowsAffected: i % 2 === 0 ? i : null,
    detail: null,
    errorMessage: i % 2 === 0 ? null : "boom",
    appliedAt: new Date(BASE_ISO - i * 60_000).toISOString(),
  }));
}

// Track every run-history URL the panel requested so we can assert the
// limit progression.
const runsUrlsRequested: string[] = [];

function runsForUrl(url: string): any[] {
  const m = url.match(/[?&]limit=(\d+)/);
  const limit = m ? Number(m[1]) : 10;
  // The "server" has exactly 15 system runs total. limit=10 → a full page
  // (more available); limit=20 → only 15 (fewer than the limit → no more).
  const TOTAL = 15;
  return makeRuns(Math.min(limit, TOTAL), `run`);
}

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "POST", json: { results: [] } },
    {
      path: "/api/admin/prod-actions/runs",
      respond: ({ url }) => {
        runsUrlsRequested.push(url);
        return { status: 200, json: { runs: runsForUrl(url) } };
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

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("Prod-actions panel auto-heal history 'Load more' (Task #2195)");

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

  try {
    // Open the panel.
    const header = $("header-prod-actions-toggle");
    assert(header !== null, "panel header toggle must render");
    await act(async () => {
      header!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Open the "Auto-heal run history" sub-section.
    const historyToggle = $("header-prod-actions-selfheal-history-toggle");
    assert(historyToggle !== null, "auto-heal history toggle must render");
    await act(async () => {
      historyToggle!.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();

    // ---- default fetch uses limit=10 and shows a full page ----
    assert(
      runsUrlsRequested.some((u) => /[?&]limit=10\b/.test(u)),
      `default run-history fetch must request limit=10 — saw ${JSON.stringify(runsUrlsRequested)}`,
    );
    const shown = $("text-prod-actions-selfheal-history-shown");
    assert(shown !== null, "the run-history footer count must render");
    assert(
      (shown!.textContent || "").includes("10 run(s)"),
      `footer must report 10 runs on first page — got "${shown!.textContent}"`,
    );

    // ---- a full page (10 >= limit 10) → "Load more" button present ----
    const loadMore = $("button-prod-actions-selfheal-history-load-more");
    assert(
      loadMore !== null,
      "the 'Load more' button must render when a full page comes back",
    );
    assert(
      $("button-prod-actions-selfheal-history-show-less") === null,
      "'Show less' must NOT render while still on the first page",
    );
    console.log("  ✓ default limit=10, full page → 'Load more' shown, no 'Show less'");

    // ---- click "Load more" → re-fetch with limit=20 ----
    await act(async () => {
      loadMore!.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();

    assert(
      runsUrlsRequested.some((u) => /[?&]limit=20\b/.test(u)),
      `clicking 'Load more' must request limit=20 — saw ${JSON.stringify(runsUrlsRequested)}`,
    );
    const shown2 = $("text-prod-actions-selfheal-history-shown");
    assert(
      (shown2!.textContent || "").includes("15 run(s)"),
      `footer must report all 15 runs after loading more — got "${shown2!.textContent}"`,
    );
    console.log("  ✓ 'Load more' → fetches limit=20, renders all 15 runs");

    // ---- server returned fewer than the limit → no more pages ----
    assert(
      $("button-prod-actions-selfheal-history-load-more") === null,
      "'Load more' must disappear once the server returns fewer than the limit",
    );
    const showLess = $("button-prod-actions-selfheal-history-show-less");
    assert(
      showLess !== null,
      "'Show less' must appear once the limit was raised past the default page",
    );
    console.log("  ✓ no more rows → 'Load more' gone, 'Show less' offered");

    // ---- "Show less" resets back to the lightweight default ----
    await act(async () => {
      showLess!.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    const shown3 = $("text-prod-actions-selfheal-history-shown");
    assert(
      (shown3!.textContent || "").includes("10 run(s)"),
      `'Show less' must collapse back to the 10-row default — got "${shown3!.textContent}"`,
    );
    console.log("  ✓ 'Show less' → collapses back to the 10-row default view");
  } finally {
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-history-load-more: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
