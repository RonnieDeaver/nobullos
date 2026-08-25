/* test-registration
{
  "name": "Prod-actions panel auto-heal history per-action filter (Task #2232)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2232 — Frontend regression test for the CEO prod-actions /
 * maintenance panel (`ProdActionsPanel`) "Auto-heal run history" section's
 * new per-action filter.
 *
 * Task #2195 added "Load more" paging to the self-heal run timeline; Task
 * #2232 lets operators narrow that timeline to a single actionId so a
 * flapping action's pattern is easy to follow. This locks the frontend
 * contract:
 *
 *   - the dropdown is populated from the self-heal-eligible actions in the
 *     status payload,
 *   - selecting an action re-fetches with `&actionId=<id>` appended (and
 *     resets paging back to the default page size),
 *   - the per-row "Filter to this" affordance sets the same filter,
 *   - "Clear" removes the filter and the fetch drops the actionId param.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. Harness
 * pattern: tests/client/prod-actions-selfheal-history-load-more.test.tsx
 * (Task #2195).
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
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
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

// Two self-heal-eligible actions feed the dropdown; a third non-eligible
// action must NOT appear as a filter option.
const STATUSES = {
  actions: [
    { id: "flapping_action", title: "Flapping action", description: "", change: "", status: { state: "applied", detail: "" }, selfHealEligible: true },
    { id: "other_action", title: "Other action", description: "", change: "", status: { state: "applied", detail: "" }, selfHealEligible: true },
    { id: "manual_only", title: "Manual only", description: "", change: "", status: { state: "pending", detail: "" }, selfHealEligible: false },
  ],
  active: [],
  completed: [],
  selfHealEnabled: true,
  selfHealLastRun: null,
};

function makeRun(actionId: string, actionTitle: string, idx: number) {
  return {
    id: `${actionId}-${idx}`,
    actionId,
    actionTitle,
    outcomeState: idx % 2 === 0 ? "applied" : "error",
    rowsAffected: idx % 2 === 0 ? idx : null,
    detail: null,
    errorMessage: idx % 2 === 0 ? null : "boom",
    appliedAt: new Date(BASE_ISO - idx * 60_000).toISOString(),
  };
}

const runsUrlsRequested: string[] = [];

function runsForUrl(url: string): any[] {
  const m = url.match(/[?&]actionId=([^&]+)/);
  const actionId = m ? decodeURIComponent(m[1]).trim() : "";
  if (actionId === "flapping_action") {
    return [0, 1, 2].map((i) => makeRun("flapping_action", "Flapping action", i));
  }
  if (actionId === "other_action") {
    return [0].map((i) => makeRun("other_action", "Other action", i));
  }
  // Unfiltered (or blank): a mix of both actions.
  return [
    makeRun("flapping_action", "Flapping action", 0),
    makeRun("other_action", "Other action", 1),
    makeRun("flapping_action", "Flapping action", 2),
  ];
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

function setSelectValue(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("Prod-actions panel auto-heal history per-action filter (Task #2232)");

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
    // Open the panel, then the "Auto-heal run history" sub-section.
    const header = $("header-prod-actions-toggle");
    assert(header !== null, "panel header toggle must render");
    await act(async () => {
      header!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const historyToggle = $("header-prod-actions-selfheal-history-toggle");
    assert(historyToggle !== null, "auto-heal history toggle must render");
    await act(async () => {
      historyToggle!.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();

    // ---- default fetch has no actionId param ----
    assert(
      runsUrlsRequested.some((u) => !/[?&]actionId=/.test(u)),
      `default fetch must omit actionId — saw ${JSON.stringify(runsUrlsRequested)}`,
    );

    // ---- dropdown is populated from self-heal-eligible actions only ----
    const select = $("select-prod-actions-selfheal-history-filter") as HTMLSelectElement | null;
    assert(select !== null, "the per-action filter dropdown must render");
    const optionValues = Array.from(select!.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    assert(
      optionValues.includes("") &&
        optionValues.includes("flapping_action") &&
        optionValues.includes("other_action"),
      `dropdown must offer 'All actions' + both eligible actions — got ${JSON.stringify(optionValues)}`,
    );
    assert(
      !optionValues.includes("manual_only"),
      "non-self-heal-eligible actions must NOT appear as filter options",
    );
    console.log("  ✓ dropdown lists 'All actions' + self-heal-eligible actions only");

    // ---- selecting an action re-fetches with that actionId ----
    runsUrlsRequested.length = 0;
    await act(async () => {
      setSelectValue(select!, "flapping_action");
    });
    await flush();
    assert(
      runsUrlsRequested.some((u) => /[?&]actionId=flapping_action\b/.test(u)),
      `selecting an action must fetch with actionId — saw ${JSON.stringify(runsUrlsRequested)}`,
    );
    // Filtered fetch keeps the default page size (paging reset).
    assert(
      runsUrlsRequested.some((u) => /[?&]limit=10\b/.test(u)),
      `filtered fetch must reset paging to limit=10 — saw ${JSON.stringify(runsUrlsRequested)}`,
    );
    const shownFiltered = $("text-prod-actions-selfheal-history-shown");
    assert(
      (shownFiltered?.textContent || "").includes("3 run(s)"),
      `filtered view must show the 3 flapping rows — got "${shownFiltered?.textContent}"`,
    );
    console.log("  ✓ selecting an action fetches &actionId=… and resets paging");

    // ---- "Clear" removes the filter (back to the unfiltered view) ----
    // Returning to the default (no-actionId) URL hits React Query's cache
    // from the initial load, so we assert via the rendered rows + dropdown
    // state rather than expecting a fresh network call.
    const clearBtn = $("button-prod-actions-selfheal-history-clear-filter");
    assert(clearBtn !== null, "the 'Clear' filter button must render while filtered");
    await act(async () => {
      clearBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const selectCleared = $("select-prod-actions-selfheal-history-filter") as HTMLSelectElement | null;
    assert(
      selectCleared?.value === "",
      `'Clear' must reset the dropdown to 'All actions' — got "${selectCleared?.value}"`,
    );
    assert(
      $("button-prod-actions-selfheal-history-clear-filter") === null,
      "'Clear' button must disappear once the filter is removed",
    );
    assert(
      $("row-prod-action-selfheal-run-other_action-1") !== null,
      "unfiltered view must show the other action's run again after 'Clear'",
    );
    console.log("  ✓ 'Clear' removes the actionId filter");

    // ---- per-row "Filter to this" sets the filter from a run row ----
    const rowFilter = $("button-prod-action-selfheal-run-filter-other_action-1");
    assert(rowFilter !== null, "per-row 'Filter to this' affordance must render");
    runsUrlsRequested.length = 0;
    await act(async () => {
      rowFilter!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
    assert(
      runsUrlsRequested.some((u) => /[?&]actionId=other_action\b/.test(u)),
      `'Filter to this' must fetch that row's action — saw ${JSON.stringify(runsUrlsRequested)}`,
    );
    const selectAfter = $("select-prod-actions-selfheal-history-filter") as HTMLSelectElement | null;
    assert(
      selectAfter?.value === "other_action",
      `dropdown must reflect the row-set filter — got "${selectAfter?.value}"`,
    );
    console.log("  ✓ per-row 'Filter to this' narrows to that action");
  } finally {
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-history-filter: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
