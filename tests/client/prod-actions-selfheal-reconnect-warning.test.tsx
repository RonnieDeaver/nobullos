/* test-registration
{
  "name": "Prod-actions panel auto-heal blocked strip: reconnect vs waiting flavors (Tasks #2249/#4840)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2249 — Frontend regression test for the per-action auto-heal readout
 * row (`SelfHealReadoutRow` in `client/src/components/admin/ProdActionsPanel`)
 * blocked warning strip.
 *
 * When a self-heal-eligible action's last automatic run came back `blocked`
 * AND the status names an integration (auth-dead / reconnect-required), the
 * row renders a separate orange warning block that:
 *
 *   - reads "Reconnect required: <integration>", and
 *   - appends "· admins alerted" only when `selfHeal.reconnectAlertSent` is
 *     true.
 *
 * Task #4840 — a `blocked` row WITHOUT `status.integration` is a
 * precondition wait-state on a healthy integration (e.g. the Zoom
 * legacy-retirement soak), NOT an auth failure. Its strip must render the
 * neutral waiting block (testid `text-prod-action-selfheal-waiting-<id>`)
 * instead: no "Reconnect required" claim, no "admins alerted" claim, and
 * the reconnect-strip testid must be absent. (This suite originally pinned
 * the pre-#4840 blanket behavior — "Reconnect required" with the suffix
 * omitted — which is exactly the false paging UX #4840 removes.)
 *
 * Task #2256 (tests/client/prod-actions-selfheal-reconnect-notice.test.tsx)
 * locks the integration-named cases (alerted vs not-alerted) and the
 * absent-when-not-blocked case; together these stop a refactor from
 * dropping the warning or blurring the two blocked flavors back together.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The panel
 * fetches its statuses only once opened, so the test clicks the header toggle
 * first. Prior-task harness pattern: #2215
 * (tests/client/prod-actions-selfheal-summary-readout.test.tsx).
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

// The integration name the named reconnect warning must surface verbatim.
const NAMED_INTEGRATION = "Zoom";

// Three self-heal-eligible active rows:
//   - blocked_named_alerted: lastOutcome "blocked", integration set,
//     reconnectAlertSent true → reconnect warning renders, names the
//     integration, AND shows "· admins alerted".
//   - blocked_no_integration: lastOutcome "blocked", NO integration →
//     Task #4840: the neutral WAITING strip renders instead of the
//     reconnect warning (no reconnect claim, no admins-alerted claim).
//   - not_blocked: lastOutcome "applied" → both strips absent.
const STATUSES = {
  actions: [],
  active: [
    {
      id: "blocked_named_alerted",
      title: "Blocked action — integration named, admins alerted",
      description: "Self-heal is blocked on a dead integration token.",
      change: "re-drive zoom sync",
      status: { state: "blocked", detail: "Reconnect required.", integration: NAMED_INTEGRATION },
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
    {
      id: "blocked_no_integration",
      title: "Blocked action — no integration name, not yet alerted",
      description: "Self-heal is blocked but no integration label is attached.",
      change: "re-drive generic sync",
      // No `integration` key — Task #4840: this is a precondition
      // wait-state, so the WAITING strip must render, not the reconnect one.
      status: { state: "blocked", detail: "Waiting for soak evidence." },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "blocked",
        lastRowsAffected: null,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 0,
        lastErrorDetail: null,
        failureAlertSent: false,
        reconnectAlertSent: false,
      },
    },
    {
      id: "not_blocked",
      title: "Healthy action — last run applied",
      description: "Self-heal last ran cleanly; no reconnect needed.",
      change: "rebuild rollups",
      status: { state: "applied", detail: "Applied cleanly.", integration: "SEMrush" },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "applied",
        lastRowsAffected: 3,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 0,
        lastErrorDetail: null,
        failureAlertSent: false,
        reconnectAlertSent: false,
      },
    },
  ],
  completed: [],
  selfHealEnabled: true,
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

  console.log("Prod-actions panel 'Reconnect required' warning branch (Task #2249)");

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

    // ---- blocked + integration named + alerted ----
    const named = $("text-prod-action-selfheal-reconnect-blocked_named_alerted");
    assert(
      named !== null,
      "the reconnect warning must render when lastOutcome is 'blocked'",
    );
    const namedText = (named!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      namedText.includes("Reconnect required"),
      `reconnect warning must read "Reconnect required" — got "${namedText}"`,
    );
    assert(
      namedText.includes(`: ${NAMED_INTEGRATION}`),
      `reconnect warning must name the integration ": ${NAMED_INTEGRATION}" when status.integration is set — got "${namedText}"`,
    );
    assert(
      namedText.includes("· admins alerted"),
      `reconnect warning must show "· admins alerted" when reconnectAlertSent is true — got "${namedText}"`,
    );
    console.log(
      "  ✓ blocked + integration + alerted → 'Reconnect required: Zoom · admins alerted'",
    );

    // ---- blocked + NO integration → neutral waiting strip (Task #4840) ----
    assert(
      $("text-prod-action-selfheal-reconnect-blocked_no_integration") === null,
      "a blocked row with no integration must NOT render the reconnect warning",
    );
    const waiting = $(
      "text-prod-action-selfheal-waiting-blocked_no_integration",
    );
    assert(
      waiting !== null,
      "a blocked row with no integration must render the neutral waiting strip",
    );
    const waitingText = (waiting!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      waitingText.includes("Waiting on preconditions"),
      `waiting strip must read as waiting on preconditions — got "${waitingText}"`,
    );
    assert(
      !waitingText.toLowerCase().includes("reconnect required"),
      `waiting strip must NOT claim a reconnect is required — got "${waitingText}"`,
    );
    assert(
      !waitingText.includes("admins alerted"),
      `waiting strip must NEVER claim "admins alerted" (waiting blocks never page) — got "${waitingText}"`,
    );
    console.log(
      "  ✓ blocked + no integration → neutral waiting strip, no reconnect/alerted claims",
    );

    // ---- not blocked: both strips absent ----
    assert(
      $("text-prod-action-selfheal-reconnect-not_blocked") === null,
      "the reconnect warning must be absent when lastOutcome is not 'blocked'",
    );
    assert(
      $("text-prod-action-selfheal-waiting-not_blocked") === null,
      "the waiting strip must be absent when lastOutcome is not 'blocked'",
    );
    // Sanity: the non-blocked row still rendered (its summary shows), so the
    // absence above is a real omission, not a missing row.
    assert(
      $("text-prod-action-selfheal-summary-not_blocked") !== null,
      "the healthy row must still render its self-heal summary",
    );
    console.log("  ✓ not blocked → reconnect warning absent (row still rendered)");
  } finally {
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-reconnect-warning: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
