/* test-registration
{
  "name": "Prod-actions panel auto-heal summary readout (Task #2215)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2215 — Frontend regression test for the per-action auto-heal
 * readout row (`SelfHealReadoutRow`) summary line on the CEO prod-actions /
 * maintenance panel (`ProdActionsPanel`).
 *
 * Task #2180 already covers the red "Auto-fix keeps failing" indicator, but
 * the rest of the readout row was untested at the client level. For each
 * self-heal-eligible action the row renders one of two branches:
 *
 *   - WHEN a `selfHeal` readout exists → `text-prod-action-selfheal-summary-<id>`
 *     showing the last outcome label, the formatted last-run time, the rows
 *     affected (when not null), and the next-eligible time.
 *   - WHEN `selfHeal` is null → an italic
 *     `text-prod-action-selfheal-never-<id>` "eligible — not yet
 *     auto-applied" note instead.
 *
 * This locks both branches so a refactor can't silently drop the summary,
 * mislabel the outcome, drop the row count, or break the "never run" note.
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

// The component formats both timestamps with Date#toLocaleString(), which is
// timezone-dependent. Compute the expected strings the same way so the test
// is stable regardless of the host timezone.
const NOW_LOCAL = new Date(NOW_ISO).toLocaleString();
const NEXT_LOCAL = new Date(NEXT_ISO).toLocaleString();

// Two self-heal-eligible active rows:
//   - has-readout: a `selfHeal` readout exists → summary line shows the last
//     outcome label, formatted last-run time, row count, and next-eligible
//     time.
//   - never-run: self-heal-eligible but `selfHeal: null` → "eligible — not
//     yet auto-applied" italic note instead of a summary.
const STATUSES = {
  actions: [],
  active: [
    {
      id: "has_readout",
      title: "Action with an auto-heal readout",
      description: "Self-heal has run at least once and recorded a readout.",
      change: "rebuild rollups",
      status: { state: "applied", detail: "Last run applied cleanly." },
      selfHealEligible: true,
      selfHeal: {
        lastRunAt: NOW_ISO,
        lastOutcome: "applied",
        lastRowsAffected: 7,
        nextEligibleAt: NEXT_ISO,
        consecutiveFailures: 0,
        lastErrorDetail: null,
        failureAlertSent: false,
        reconnectAlertSent: false,
      },
    },
    {
      id: "never_run",
      title: "Action eligible but never auto-applied",
      description: "Self-heal is eligible but hasn't run yet.",
      change: "re-drive sweep",
      status: { state: "pending", detail: "Awaiting first auto-heal run." },
      selfHealEligible: true,
      selfHeal: null,
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

  console.log("Prod-actions panel auto-heal summary readout (Task #2215)");

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

    // ---- has-readout: summary shows outcome, last-run, rows, next time ----
    const summary = $("text-prod-action-selfheal-summary-has_readout");
    assert(
      summary !== null,
      "the summary line must render when a selfHeal readout exists",
    );
    const summaryText = (summary!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      summaryText.includes("Applied"),
      `summary must show the last outcome label "Applied" — got "${summaryText}"`,
    );
    assert(
      summaryText.includes(NOW_LOCAL),
      `summary must show the formatted last-run time (${NOW_LOCAL}) — got "${summaryText}"`,
    );
    assert(
      summaryText.includes("7 row(s)"),
      `summary must show the rows affected ("7 row(s)") — got "${summaryText}"`,
    );
    assert(
      summaryText.includes(NEXT_LOCAL),
      `summary must show the next-eligible time (${NEXT_LOCAL}) — got "${summaryText}"`,
    );
    // The "never run" note must NOT appear for a row that has a readout.
    assert(
      $("text-prod-action-selfheal-never-has_readout") === null,
      "the 'never auto-applied' note must be absent when a readout exists",
    );
    console.log(
      "  ✓ has readout → summary shows 'Applied', last-run, '7 row(s)', next time",
    );

    // ---- never-run: italic "eligible — not yet auto-applied" note ----
    const never = $("text-prod-action-selfheal-never-never_run");
    assert(
      never !== null,
      "the 'never auto-applied' note must render when selfHeal is null",
    );
    const neverText = (never!.textContent || "").replace(/\s+/g, " ").trim();
    assert(
      neverText.includes("eligible — not yet auto-applied"),
      `never-run note must carry the expected copy — got "${neverText}"`,
    );
    // The summary line must NOT appear for a row that has never run.
    assert(
      $("text-prod-action-selfheal-summary-never_run") === null,
      "the summary line must be absent when selfHeal is null",
    );
    // Sanity: both rows still render their self-heal readout panel, so the
    // branch assertions above are real signals, not missing rows.
    assert(
      $("panel-prod-action-selfheal-has_readout") !== null &&
        $("panel-prod-action-selfheal-never_run") !== null,
      "both self-heal-eligible rows must render their readout panel",
    );
    console.log(
      "  ✓ never run (selfHeal null) → 'eligible — not yet auto-applied' note, no summary",
    );
  } finally {
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
  }

  console.log("\nprod-actions-selfheal-summary-readout: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
