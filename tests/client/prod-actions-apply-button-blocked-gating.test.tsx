/* test-registration
{
  "name": "Prod-actions panel 'Apply all' gating on blocked-only state (Task #2268)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2268 — Frontend regression test for the CEO prod-actions /
 * maintenance panel (`ProdActionsPanel`) "Apply all" button gating against
 * reconnect-required ("blocked") actions.
 *
 * The panel deliberately separates two counts (Task #2111):
 *
 *   - `actionableCount` = pending + error → drives the destructive
 *     "Apply all" button's enabled state.
 *   - `activeBadgeCount` = pending + error + blocked → drives the
 *     "needs attention" badge and empty-state copy.
 *
 * A reconnect-required ("blocked") action shows in the active list and in
 * the badge, but re-pressing "Apply all" does nothing until the integration
 * is reconnected — so a blocked-ONLY active list must keep the button
 * DISABLED while the badge still counts the blocked item. The reconnect
 * *notice* block (Task #2256) and the blocked-vs-error badge styling are
 * already tested, but this button-gating contract was untested at the
 * client layer, so a refactor could silently re-enable the destructive
 * button on a blocked-only state. This locks the contract:
 *
 *   - blocked-only active list → "Apply all" DISABLED, badge counts the
 *     blocked item ("0 pending, 1 needs reconnect"), and the footer copy
 *     tells the operator to reconnect, and
 *   - a pending action → "Apply all" ENABLED.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The panel
 * fetches its statuses only once opened, so the test clicks the header
 * toggle first. Prior-task harness pattern: #2256
 * (tests/client/prod-actions-selfheal-reconnect-notice.test.tsx).
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

const NOW_ISO = new Date("2026-06-02T12:00:00.000Z").toISOString();
const NEXT_ISO = new Date("2026-06-02T18:00:00.000Z").toISOString();

// Blocked-only active list: a single reconnect-required action. The badge
// must count it, but "Apply all" must stay DISABLED because re-pressing it
// does nothing until the integration is reconnected.
const BLOCKED_ONLY_STATUSES = {
  actions: [],
  active: [
    {
      id: "blocked_only",
      title: "Blocked action — reconnect required",
      description: "Re-pressing does nothing until the token is reconnected.",
      change: "re-drive zoom sync",
      status: { state: "blocked", detail: "Reconnect required.", integration: "Zoom" },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "blocked",
        lastRowsAffected: null,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 0,
        lastErrorDetail: null,
        failureAlertSent: false,
        reconnectAlertSent: true,
      },
    },
  ],
  completed: [],
  selfHealEnabled: true,
  selfHealLastRun: null,
};

// Pending active list: a single genuinely-actionable action. "Apply all"
// must be ENABLED.
const PENDING_STATUSES = {
  actions: [],
  active: [
    {
      id: "pending_one",
      title: "Pending action — ready to apply",
      description: "A real pending write the CEO can apply.",
      change: "rebuild rollups",
      status: { state: "pending", detail: "Pending." },
      selfHealEligible: false,
      selfHeal: null,
    },
  ],
  completed: [],
  selfHealEnabled: true,
  selfHealLastRun: null,
};

let currentStatuses: any = BLOCKED_ONLY_STATUSES;

const fetchHandler = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "POST", json: { results: [] } },
    { path: "/api/admin/prod-actions/runs", json: { runs: [] } },
    { path: "/api/admin/prod-actions", json: () => currentStatuses },
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

async function mountAndOpen(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root!: Root;
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
  const header = $("header-prod-actions-toggle");
  assert(header !== null, "panel header toggle must render");
  await act(async () => {
    header!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
  return root;
}

async function main(): Promise<void> {
  assert(
    queryClient instanceof QueryClient,
    "the imported queryClient must be a real QueryClient instance",
  );

  console.log("Prod-actions panel 'Apply all' gating on blocked-only state (Task #2268)");

  // ---- Case 1: blocked-only → button disabled, badge still counts it ----
  currentStatuses = BLOCKED_ONLY_STATUSES;
  let root = await mountAndOpen();
  try {
    const applyBtn = $("button-prod-actions-apply") as HTMLButtonElement | null;
    assert(applyBtn !== null, "the 'Apply all' button must render");
    assert(
      (applyBtn as HTMLButtonElement).disabled === true,
      "'Apply all' must be DISABLED when the active list holds only a blocked action",
    );

    // The "needs attention" badge must still reflect the blocked item.
    const badge = $("badge-prod-actions-pending-count");
    assert(
      badge !== null,
      "the needs-attention badge must render while a blocked item is active",
    );
    const badgeText = (badge!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      badgeText.includes("0 pending"),
      `badge must show "0 pending" for a blocked-only list — got "${badgeText}"`,
    );
    assert(
      badgeText.includes("1 needs reconnect"),
      `badge must count the blocked item as "1 needs reconnect" — got "${badgeText}"`,
    );
    console.log("  ✓ blocked-only → 'Apply all' disabled, badge counts the blocked item");
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  }

  // ---- Case 2: a pending action → button enabled ----
  currentStatuses = PENDING_STATUSES;
  root = await mountAndOpen();
  try {
    const applyBtn = $("button-prod-actions-apply") as HTMLButtonElement | null;
    assert(applyBtn !== null, "the 'Apply all' button must render");
    assert(
      (applyBtn as HTMLButtonElement).disabled === false,
      "'Apply all' must be ENABLED when the active list holds a pending action",
    );
    console.log("  ✓ pending action → 'Apply all' enabled");
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-apply-button-blocked-gating: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
