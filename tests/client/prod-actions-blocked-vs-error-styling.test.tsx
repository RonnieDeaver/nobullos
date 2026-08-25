/* test-registration
{
  "name": "Prod-actions panel blocked (amber) vs error (red) treatment (Task #2176)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2176 — Frontend regression test for the CEO prod-actions /
 * maintenance panel (`ProdActionsPanel`) "needs reconnect" vs "error"
 * treatment.
 *
 * Backend tasks (#2123 / #2155) proved a SEMrush/Zoom/Google Ads login
 * failure is reclassified into the calm `state:"blocked"` outcome (carrying
 * the integration name), while a genuine bug still returns `state:"error"`.
 * This locks the *frontend* contract those tasks depend on:
 *
 *   - a `blocked` row renders the warm amber/orange "Needs reconnect"
 *     treatment (NOT the red error treatment), names the integration, and
 *     offers a reconnect affordance (link to the Integrations Hub), and
 *   - a sibling `error` row renders the red error treatment,
 *
 * so a future styling/refactor can't silently turn a recoverable reconnect
 * back into a scary red error (or vice-versa). It also asserts blocked rows
 * are kept out of the error count in the "X pending, Y error" badge.
 *
 * Task #4840 — `blocked` now has TWO flavors, discriminated by whether the
 * status names an integration:
 *   - WITH `integration` (auth-dead): everything above holds unchanged.
 *   - WITHOUT `integration` (waiting on preconditions, e.g. the Zoom
 *     legacy-retirement soak): a neutral "Blocked — waiting" badge, a
 *     waiting note instead of reconnect copy, NO "Reconnect now →" link,
 *     and the count badge tallies it as "blocked/waiting", never
 *     "needs reconnect".
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The panel
 * fetches its statuses only once opened, so the test clicks the header
 * toggle first. Prior-task harness pattern: #2160
 * (tests/client/integrations-hub-reconnect-required-badge.test.tsx).
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

// Two active rows that arrive together: one reclassified login failure
// (blocked, carries the integration name) and one genuine bug (error).
const STATUSES = {
  actions: [],
  active: [
    {
      id: "semrush_demand_refresh",
      title: "SEMrush demand refresh",
      description: "Re-run the stale SEMrush demand sweep.",
      change: "refresh demand keywords",
      status: {
        state: "blocked",
        detail: "SEMrush login expired before the sweep could run.",
        integration: "SEMrush",
      },
    },
    {
      id: "rebuild_rollups",
      title: "Rebuild hourly rollups",
      description: "Recompute the external-call audit rollups.",
      change: "rebuild rollups",
      status: {
        state: "error",
        detail: "Unexpected null in rollup aggregation.",
      },
    },
    // Task #4840 — precondition wait-state: blocked WITHOUT an integration
    // (the Zoom retirement action parks like this while soaking). Must NOT
    // render any reconnect treatment.
    {
      id: "zoom_legacy_retirement",
      title: "Retire legacy Zoom OAuth token rows",
      description: "Delete the legacy Zoom OAuth rows once the S2S cutover has soaked.",
      change: "delete legacy zoom oauth token rows",
      status: {
        state: "blocked",
        detail: "Waiting for live S2S webhook evidence; soak window not yet elapsed.",
      },
    },
  ],
  completed: [],
  selfHealEnabled: false,
  selfHealLastRun: null,
};

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "POST", json: { results: [] } },
    { path: "/api/admin/prod-actions/runs", json: { runs: [] } },
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

  console.log("Prod-actions panel blocked (amber) vs error (red) treatment (Task #2176)");

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
    // The panel only fetches once opened — click the header toggle.
    const header = $("header-prod-actions-toggle");
    assert(header !== null, "panel header toggle must render");
    await act(async () => {
      header!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // ---- blocked row (auth-dead, integration named): amber/reconnect
    // treatment, NOT red. Scoped to its row — the waiting row below also
    // carries the blocked state testid (Task #4840). ----
    const blockedBadge = document.querySelector(
      '[data-testid="row-prod-action-semrush_demand_refresh"] [data-testid="badge-prod-action-state-blocked"]',
    ) as HTMLElement | null;
    assert(blockedBadge !== null, "blocked row must render a state badge");
    assert(
      (blockedBadge!.textContent || "").includes("Needs reconnect"),
      `blocked badge must read "Needs reconnect" — got "${blockedBadge!.textContent}"`,
    );
    const blockedCls = blockedBadge!.className || "";
    assert(
      blockedCls.includes("orange") || blockedCls.includes("amber"),
      `blocked badge must carry warm amber/orange styling — got "${blockedCls}"`,
    );
    assert(
      !blockedCls.includes("red"),
      `blocked badge must NOT carry red error styling — got "${blockedCls}"`,
    );

    const blockedNote = $("text-prod-action-blocked-note-semrush_demand_refresh");
    assert(blockedNote !== null, "blocked row must render the reconnect note");
    assert(
      (blockedNote!.textContent || "").includes("SEMrush"),
      `blocked note must name the integration — got "${blockedNote!.textContent}"`,
    );

    // reconnect affordance: a link pointing at the Integrations Hub.
    const reconnect = $("link-prod-action-reconnect-semrush_demand_refresh");
    assert(reconnect !== null, "blocked row must offer a reconnect link");
    assert(
      (reconnect as HTMLAnchorElement).getAttribute("href") === "/admin/integrations",
      `reconnect link must point at the Integrations Hub — got "${(reconnect as HTMLAnchorElement).getAttribute("href")}"`,
    );

    console.log("  ✓ blocked row → amber 'Needs reconnect', names SEMrush, reconnect link to Integrations Hub");

    // ---- error row: red error treatment, distinct from blocked ----
    const errorBadge = $("badge-prod-action-state-error");
    assert(errorBadge !== null, "error row must render a state badge");
    assert(
      (errorBadge!.textContent || "").includes("Error"),
      `error badge must read "Error" — got "${errorBadge!.textContent}"`,
    );
    const errorCls = errorBadge!.className || "";
    assert(
      errorCls.includes("red"),
      `error badge must carry red error styling — got "${errorCls}"`,
    );
    assert(
      !errorCls.includes("orange") && !errorCls.includes("amber"),
      `error badge must NOT borrow the amber reconnect styling — got "${errorCls}"`,
    );
    // The error row must NOT get a reconnect note/link.
    assert(
      $("text-prod-action-blocked-note-rebuild_rollups") === null,
      "error row must NOT render a blocked/reconnect note",
    );

    console.log("  ✓ error row → red 'Error' treatment, no reconnect affordance");

    // ---- waiting row (blocked WITHOUT integration): neutral waiting
    // treatment, no reconnect anywhere (Task #4840) ----
    const waitingBadge = document.querySelector(
      '[data-testid="row-prod-action-zoom_legacy_retirement"] [data-testid="badge-prod-action-state-blocked"]',
    ) as HTMLElement | null;
    assert(waitingBadge !== null, "waiting row must render a blocked state badge");
    const waitingBadgeText = waitingBadge!.textContent || "";
    assert(
      waitingBadgeText.includes("Blocked — waiting"),
      `waiting badge must read "Blocked — waiting" — got "${waitingBadgeText}"`,
    );
    assert(
      !waitingBadgeText.toLowerCase().includes("reconnect"),
      `waiting badge must NOT mention reconnect — got "${waitingBadgeText}"`,
    );
    const waitingCls = waitingBadge!.className || "";
    assert(
      waitingCls.includes("amber") && !waitingCls.includes("red"),
      `waiting badge must carry calm amber (not red) styling — got "${waitingCls}"`,
    );

    // The gate detail stays visible so the operator can see WHAT it waits on.
    const waitingDetail = $("text-prod-action-status-detail-zoom_legacy_retirement");
    assert(
      (waitingDetail?.textContent || "").includes("Waiting for live S2S webhook evidence"),
      `waiting row must keep showing its gate detail — got "${waitingDetail?.textContent}"`,
    );

    // Neutral waiting note instead of the reconnect note; NO reconnect link.
    const waitingNote = $("text-prod-action-blocked-waiting-note-zoom_legacy_retirement");
    assert(waitingNote !== null, "waiting row must render the neutral waiting note");
    const waitingNoteText = waitingNote!.textContent || "";
    assert(
      waitingNoteText.includes("Waiting on preconditions"),
      `waiting note must read as waiting on preconditions — got "${waitingNoteText}"`,
    );
    assert(
      $("text-prod-action-blocked-note-zoom_legacy_retirement") === null,
      "waiting row must NOT render the reconnect note",
    );
    assert(
      $("link-prod-action-reconnect-zoom_legacy_retirement") === null,
      "waiting row must NOT offer a 'Reconnect now →' link",
    );

    console.log(
      "  ✓ waiting row → 'Blocked — waiting' badge, neutral note, gate detail kept, no reconnect link",
    );

    // ---- count badge: blocked is not counted as an error ----
    const countBadge = $("badge-prod-actions-pending-count");
    assert(countBadge !== null, "the active-count badge must render");
    const countText = countBadge!.textContent || "";
    assert(
      countText.includes("1 error") && !countText.includes("2 error"),
      `the blocked row must NOT inflate the error count — got "${countText}"`,
    );
    assert(
      countText.includes("1 needs reconnect"),
      `only the integration-named blocked row may count as "needs reconnect" — got "${countText}"`,
    );
    // Task #4840 — the waiting row is tallied honestly as blocked/waiting,
    // never inflating the "needs reconnect" count.
    assert(
      countText.includes("1 blocked/waiting"),
      `the waiting row must surface in the count as "blocked/waiting" — got "${countText}"`,
    );

    console.log(
      "  ✓ count badge → reconnect vs waiting tallied separately, kept out of the error count",
    );
  } finally {
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-blocked-vs-error-styling: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
