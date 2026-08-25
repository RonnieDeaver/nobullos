/* test-registration
{
  "name": "Prod-actions panel 'Reconnect required' notice (Task #2256)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2256 — Frontend regression test for the CEO prod-actions /
 * maintenance panel (`ProdActionsPanel` → `SelfHealReadoutRow`) "Reconnect
 * required" notice (added by Task #2111 / #2124).
 *
 * When a self-heal-eligible action's last automatic run came back
 * `blocked` (auth-dead / reconnect-required), the panel renders a separate
 * amber block (testid `text-prod-action-selfheal-reconnect-<id>`) that:
 *
 *   - names the integration from `status.integration`, and
 *   - appends "· admins alerted" when `selfHeal.reconnectAlertSent` is true.
 *
 * The blocked-vs-error badge styling and the failing-streak / error-detail
 * readouts each have their own DOM tests, but this reconnect notice block
 * was still untested at the client layer, so a refactor could silently drop
 * it or mislabel the integration. This locks the frontend contract:
 *
 *   - the reconnect block renders, names the integration, and shows
 *     "· admins alerted" when reconnectAlertSent is true,
 *   - the same block renders + names the integration but OMITS the
 *     "· admins alerted" suffix when reconnectAlertSent is false, and
 *   - the block is ABSENT when lastOutcome is not "blocked".
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The panel
 * fetches its statuses only once opened, so the test clicks the header
 * toggle first. Prior-task harness pattern: #2219
 * (tests/client/prod-actions-selfheal-error-detail.test.tsx).
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

// The integration names the reconnect notice must surface verbatim.
const ALERTED_INTEGRATION = "Zoom";
const NOT_ALERTED_INTEGRATION = "Front";

// Three self-heal-eligible active rows:
//   - blocked_alerted: lastOutcome "blocked", integration set, reconnect
//     alert already sent → reconnect block renders, names the integration,
//     AND shows "· admins alerted".
//   - blocked_not_alerted: lastOutcome "blocked", integration set, no alert
//     yet → reconnect block renders, names the integration, but OMITS the
//     "· admins alerted" suffix.
//   - not_blocked: lastOutcome "applied" → reconnect block absent.
const STATUSES = {
  actions: [],
  active: [
    {
      id: "blocked_alerted",
      title: "Blocked action — admins already alerted",
      description: "Self-heal is blocked on a dead integration token.",
      change: "re-drive zoom sync",
      status: { state: "blocked", detail: "Reconnect required.", integration: ALERTED_INTEGRATION },
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
      id: "blocked_not_alerted",
      title: "Blocked action — admins not yet alerted",
      description: "Self-heal is blocked but the alert has not paged yet.",
      change: "re-drive front sync",
      status: { state: "blocked", detail: "Reconnect required.", integration: NOT_ALERTED_INTEGRATION },
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

  console.log("Prod-actions panel 'Reconnect required' notice (Task #2256)");

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

    // ---- blocked + alerted: renders, names integration, "admins alerted" ----
    const alerted = $("text-prod-action-selfheal-reconnect-blocked_alerted");
    assert(
      alerted !== null,
      "the reconnect block must render when lastOutcome is 'blocked'",
    );
    const alertedText = (alerted!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      alertedText.includes("Reconnect required"),
      `reconnect block must read "Reconnect required" — got "${alertedText}"`,
    );
    assert(
      alertedText.includes(ALERTED_INTEGRATION),
      `reconnect block must name the integration "${ALERTED_INTEGRATION}" — got "${alertedText}"`,
    );
    assert(
      alertedText.includes("admins alerted"),
      `reconnect block must show "· admins alerted" when reconnectAlertSent is true — got "${alertedText}"`,
    );
    // The integration must come from THIS row's status.integration, not be
    // hardcoded or cross-wired from the other blocked row.
    assert(
      !alertedText.includes(NOT_ALERTED_INTEGRATION),
      `the blocked+alerted reconnect block must name ONLY its own integration "${ALERTED_INTEGRATION}", not the other row's "${NOT_ALERTED_INTEGRATION}" — got "${alertedText}"`,
    );
    console.log("  ✓ blocked + alerted → reconnect block names integration and shows 'admins alerted'");

    // ---- blocked + NOT alerted: renders, names integration, no suffix ----
    const notAlerted = $("text-prod-action-selfheal-reconnect-blocked_not_alerted");
    assert(
      notAlerted !== null,
      "the reconnect block must render for a second blocked row too",
    );
    const notAlertedText = (notAlerted!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      notAlertedText.includes("Reconnect required"),
      `reconnect block must read "Reconnect required" — got "${notAlertedText}"`,
    );
    assert(
      notAlertedText.includes(NOT_ALERTED_INTEGRATION),
      `reconnect block must name the integration "${NOT_ALERTED_INTEGRATION}" — got "${notAlertedText}"`,
    );
    assert(
      !notAlertedText.includes("admins alerted"),
      `reconnect block must OMIT "· admins alerted" when reconnectAlertSent is false — got "${notAlertedText}"`,
    );
    // Same per-row isolation guard in the other direction: this block must
    // name its own integration, not leak the first blocked row's.
    assert(
      !notAlertedText.includes(ALERTED_INTEGRATION),
      `the blocked+not-alerted reconnect block must name ONLY its own integration "${NOT_ALERTED_INTEGRATION}", not the other row's "${ALERTED_INTEGRATION}" — got "${notAlertedText}"`,
    );
    console.log("  ✓ blocked + not alerted → reconnect block names integration, no 'admins alerted' suffix");

    // ---- not blocked: reconnect block absent ----
    assert(
      $("text-prod-action-selfheal-reconnect-not_blocked") === null,
      "the reconnect block must be absent when lastOutcome is not 'blocked'",
    );
    // Sanity: the row itself still rendered (its self-heal summary is shown),
    // so the absence above is a real omission, not a missing row.
    assert(
      $("text-prod-action-selfheal-summary-not_blocked") !== null,
      "the healthy row must still render its self-heal summary",
    );
    console.log("  ✓ not blocked → reconnect block absent (row still rendered)");
  } finally {
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-reconnect-notice: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
