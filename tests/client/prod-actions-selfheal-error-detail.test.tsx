/* test-registration
{
  "name": "Prod-actions panel auto-fix failure reason readout (Task #2219)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2219 — Frontend regression test for the CEO prod-actions /
 * maintenance panel (`ProdActionsPanel`) auto-fix failure *reason* readout
 * (added by Task #2179).
 *
 * Task #2179 made the panel render the most recent error message under the
 * "Auto-fix keeps failing — N× in a row" indicator. The service-side readout
 * (`lastErrorDetail`) is unit-tested, and the blocked-vs-error styling and the
 * failing-streak indicator each have their own DOM tests, but nothing asserts
 * the panel actually renders the error message *text*. A regression could
 * silently drop the reason while keeping the streak count, leaving operators
 * blind again. This locks the frontend contract:
 *
 *   - the `text-prod-action-selfheal-error-detail-<id>` block appears, and
 *     shows the exact `selfHeal.lastErrorDetail` text, when
 *     consecutiveFailures > 0 AND lastErrorDetail is non-null, and
 *   - the block is ABSENT when lastErrorDetail is null, even though the
 *     failing-streak indicator is still shown.
 *
 * Mounts the real `ProdActionsPanel` against the real
 * `client/src/lib/queryClient` with a stubbed `globalThis.fetch`. The panel
 * fetches its statuses only once opened, so the test clicks the header
 * toggle first. Prior-task harness pattern: #2180
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

const NOW_ISO = new Date("2026-06-02T12:00:00.000Z").toISOString();
const NEXT_ISO = new Date("2026-06-02T18:00:00.000Z").toISOString();

// The exact reason text the panel must surface verbatim.
const ERROR_DETAIL =
  "TypeError: Cannot read properties of null (reading 'rollupId') at rebuildRollups()";

// Two self-heal-eligible active rows:
//   - failing_with_reason: consecutiveFailures > 0 AND lastErrorDetail set →
//     the error-detail block renders, showing the exact reason text.
//   - failing_no_reason: consecutiveFailures > 0 but lastErrorDetail null →
//     the failing-streak indicator still renders, but the error-detail block
//     is absent.
const STATUSES = {
  actions: [],
  active: [
    {
      id: "failing_with_reason",
      title: "Failing action with a reason",
      description: "Self-heal keeps erroring and captured the message.",
      change: "rebuild rollups",
      status: { state: "error", detail: "Self-heal keeps erroring." },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "error",
        lastRowsAffected: null,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 4,
        lastErrorDetail: ERROR_DETAIL,
        failureAlertSent: true,
        reconnectAlertSent: false,
      },
    },
    {
      id: "failing_no_reason",
      title: "Failing action with no captured reason",
      description: "Self-heal is failing but no message was recorded.",
      change: "re-drive failing sweep",
      status: { state: "error", detail: "Self-heal erroring." },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "error",
        lastRowsAffected: null,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 2,
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

  console.log("Prod-actions panel auto-fix failure reason readout (Task #2219)");

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

    // ---- failing + reason: the error-detail block renders the exact text ----
    // Sanity: the failing-streak indicator is present (so the detail block is a
    // child of a shown streak, not an unrelated absence).
    assert(
      $("text-prod-action-selfheal-failing-failing_with_reason") !== null,
      "the failing-streak indicator must render when consecutiveFailures > 0",
    );
    const detail = $("text-prod-action-selfheal-error-detail-failing_with_reason");
    assert(
      detail !== null,
      "the error-detail block must render when lastErrorDetail is non-null",
    );
    const detailText = (detail!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      detailText.includes("TypeError: Cannot read properties of null"),
      `error-detail block must surface the reason text — got "${detailText}"`,
    );
    assert(
      detailText.includes("rebuildRollups()"),
      `error-detail block must surface the full reason text — got "${detailText}"`,
    );
    console.log("  ✓ failing + reason → error-detail block shows the exact message");

    // ---- failing, no reason: streak indicator shown, detail block absent ----
    assert(
      $("text-prod-action-selfheal-failing-failing_no_reason") !== null,
      "the failing-streak indicator must still render when consecutiveFailures > 0",
    );
    assert(
      $("text-prod-action-selfheal-error-detail-failing_no_reason") === null,
      "the error-detail block must be absent when lastErrorDetail is null",
    );
    console.log("  ✓ failing, no reason → streak indicator shown, error-detail block absent");
  } finally {
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-error-detail: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
