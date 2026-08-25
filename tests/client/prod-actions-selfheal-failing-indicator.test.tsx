/* test-registration
{
  "name": "Prod-actions panel 'Auto-fix keeps failing' indicator (Task #2180)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2180 — Frontend regression test for the CEO prod-actions /
 * maintenance panel (`ProdActionsPanel`) "Auto-fix keeps failing"
 * indicator (added by Task #2153).
 *
 * Task #2153 added a red "Auto-fix keeps failing — N× in a row · admins
 * alerted" badge to the per-action self-heal readout row. The backend
 * readout fields (consecutiveFailures / failureAlertSent) are covered by
 * tests/prod-action-self-heal.test.ts, but the *client rendering* of the
 * indicator was untested. This locks the frontend contract:
 *
 *   - the `text-prod-action-selfheal-failing-<id>` indicator appears ONLY
 *     when selfHeal.consecutiveFailures > 0,
 *   - it shows the exact failure count ("N× in a row"), and
 *   - the "· admins alerted" suffix toggles on selfHeal.failureAlertSent.
 *
 * so a future refactor can't silently drop the indicator, miscount, or
 * leave the alerted suffix stuck on/off.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The panel
 * fetches its statuses only once opened, so the test clicks the header
 * toggle first. Prior-task harness pattern: #2176
 * (tests/client/prod-actions-blocked-vs-error-styling.test.tsx).
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

// Three self-heal-eligible active rows:
//   - failing-alerted: consecutiveFailures > 0 AND failureAlertSent → indicator
//     present, names the count, carries the "· admins alerted" suffix.
//   - failing-not-alerted: consecutiveFailures > 0 but NOT alerted → indicator
//     present, names the count, NO "· admins alerted" suffix.
//   - healthy: consecutiveFailures === 0 → indicator absent.
const STATUSES = {
  actions: [],
  active: [
    {
      id: "failing_alerted",
      title: "Failing + alerted action",
      description: "Self-heal has failed several times and admins were paged.",
      change: "re-drive failing sweep",
      status: { state: "error", detail: "Self-heal keeps erroring." },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "error",
        lastRowsAffected: null,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 3,
        failureAlertSent: true,
      },
    },
    {
      id: "failing_not_alerted",
      title: "Failing, not yet alerted action",
      description: "Self-heal has failed but the alert threshold isn't reached.",
      change: "re-drive failing sweep",
      status: { state: "error", detail: "Self-heal erroring." },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "error",
        lastRowsAffected: null,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 1,
        failureAlertSent: false,
      },
    },
    {
      id: "healthy_action",
      title: "Healthy self-heal action",
      description: "Self-heal is running cleanly.",
      change: "rebuild rollups",
      status: { state: "applied", detail: "Last run applied cleanly." },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "applied",
        lastRowsAffected: 5,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 0,
        failureAlertSent: false,
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

  console.log("Prod-actions panel 'Auto-fix keeps failing' indicator (Task #2180)");

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

    // ---- failing + alerted: indicator present, count + "admins alerted" ----
    const alerted = $("text-prod-action-selfheal-failing-failing_alerted");
    assert(
      alerted !== null,
      "the failing indicator must render when consecutiveFailures > 0",
    );
    const alertedText = (alerted!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      alertedText.includes("Auto-fix keeps failing"),
      `failing indicator must carry the headline — got "${alertedText}"`,
    );
    assert(
      alertedText.includes("3× in a row"),
      `failing indicator must show the exact count — got "${alertedText}"`,
    );
    assert(
      alertedText.includes("admins alerted"),
      `failing indicator must show the "admins alerted" suffix when failureAlertSent — got "${alertedText}"`,
    );
    console.log("  ✓ failing + alerted → indicator shows '3× in a row · admins alerted'");

    // ---- failing, not alerted: indicator present, count, NO suffix ----
    const notAlerted = $("text-prod-action-selfheal-failing-failing_not_alerted");
    assert(
      notAlerted !== null,
      "the failing indicator must render even before the alert is sent",
    );
    const notAlertedText = (notAlerted!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      notAlertedText.includes("1× in a row"),
      `not-alerted indicator must show the exact count — got "${notAlertedText}"`,
    );
    assert(
      !notAlertedText.includes("admins alerted"),
      `not-alerted indicator must NOT show the "admins alerted" suffix — got "${notAlertedText}"`,
    );
    console.log("  ✓ failing, not alerted → indicator shows '1× in a row', no alerted suffix");

    // ---- healthy: indicator absent ----
    assert(
      $("text-prod-action-selfheal-failing-healthy_action") === null,
      "the failing indicator must be absent when consecutiveFailures === 0",
    );
    // Sanity: the healthy row still renders its self-heal readout panel, so the
    // absence above is a real "not failing" signal, not a missing row.
    assert(
      $("panel-prod-action-selfheal-healthy_action") !== null,
      "the healthy row must still render its self-heal readout panel",
    );
    console.log("  ✓ healthy (0 failures) → no failing indicator, readout panel still present");
  } finally {
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-failing-indicator: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
