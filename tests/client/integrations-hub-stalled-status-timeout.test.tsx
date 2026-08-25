/* test-registration
{
  "name": "Integrations Hub ClickUp/SEMrush stalled-status timeout resolves to couldn't-reach (Task #4586)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the Task #4452 bounded-wait resolution for the ClickUp and SEMrush card bodies (per-card queries stalled -> shared couldn't-reach DegradedState + retry). Previously screenshot-verified only; a rollup-classifier or card-branch refactor could silently drop it. Deterministic single jsdom mount, no DB, no network.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/integrations-hub-stalled-status-timeout-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4586 — regression coverage for the Task #4452 bounded-wait
 * resolution on the ClickUp and SEMrush card BODIES (the rollup bar's flip
 * is covered by tests/client/integrations-hub-rollup.test.tsx, Task #4453).
 *
 * Fixture: the ClickUp per-card queries
 * (`/api/integrations/clickup/connected-users`,
 * `/api/integrations/clickup/company-token/status`) and `/api/semrush/status`
 * HANG (never-settling fetch promises), and all-status answers semrush
 * `connected: null` — so both cards classify as raw-rollup "checking".
 *
 * Asserts:
 *   1. Pre-timeout: ClickUp shows the roster spinner, no couldn't-reach
 *      DegradedState renders for either card.
 *   2. After CHECKING_TIMEOUT_MS of wall-clock (Date.now offset + manually
 *      fired captured 5s rollup tick — the checking-entry stamp is
 *      Date.now()-based precisely so a manually-fired timer alone can't fake
 *      elapsed time; see checkingSinceRef in IntegrationsHub.tsx):
 *      `degraded-clickup-status-unreachable` / `degraded-semrush-status-unreachable`
 *      render with their retry buttons, and the ClickUp roster spinner is gone.
 *   3. The per-card retry buttons restart the bounded wait (degraded state
 *      clears; the still-hanging queries put the cards back into checking).
 *
 * Harness pattern: tests/client/integrations-hub-rollup.test.tsx — team_lead
 * user passes the admin gate without mounting the CEO-only ProdActionsPanel;
 * Clerk stubbed signed-in by the setup loader.
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
(dom.window as any).HTMLElement.prototype.scrollIntoView = function () {};
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

// ---------------------------------------------------------------------------
// Wall-clock + interval seams (installed BEFORE the component module loads).
// The bounded wait stamps checking-entry times with Date.now() and re-derives
// timeouts on a 5s setInterval tick, so the test advances a Date.now offset
// and fires the captured tick manually — no real 20s wait.
// ---------------------------------------------------------------------------
const realNow = Date.now.bind(Date);
let nowOffsetMs = 0;
Date.now = () => realNow() + nowOffsetMs;

type CapturedInterval = { fn: (...a: any[]) => void; ms: number };
const capturedIntervals: CapturedInterval[] = [];
const realSetInterval = globalThis.setInterval.bind(globalThis);
(globalThis as any).setInterval = ((fn: any, ms?: number, ...args: any[]) => {
  capturedIntervals.push({ fn, ms: ms ?? 0 });
  // Return a real (inert, far-future) handle so clearInterval stays valid.
  return realSetInterval(() => {}, 2 ** 30);
}) as any;

const ADMIN_USER = {
  id: "admin-4586",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "team_lead",
};

// All-status: everything healthy EXCEPT semrush, which answers connected:null
// (server has no cached probe result) — the rollup's badge-fallback classifies
// it as "checking". ClickUp has no all-status entry; its rollup state derives
// entirely from the two per-card queries, which this suite leaves hanging.
const ALL_STATUS = {
  front: { connected: true, webhookSecretConfigured: true },
  slack: { connected: true, team: "Example Team" },
  zoom: { connected: true },
  twilio: { connected: true },
  pandadoc: { connected: true },
  stripe: { connected: true },
  googleAds: {
    configured: true,
    connected: true,
    adsOs: {
      configured: true,
      refreshTokenSource: "env",
      health: "healthy",
      healthDetail: null,
      lastDataUpdateAt: null,
    },
  },
  semrush: { connected: null },
  unmatchedCount: 0,
};

// The stalled endpoints: fetches for these NEVER settle, keeping their
// queries in the loading state (raw rollup "checking") indefinitely.
const HANGING_PATHS = [
  "/api/integrations/clickup/connected-users",
  "/api/integrations/clickup/company-token/status",
  "/api/semrush/status",
];
let hangCount = 0;

const routedStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "POST", json: {} },
    { path: "/api/auth/user", json: ADMIN_USER },
    { path: "/api/integrations/all-status", json: ALL_STATUS },
    { path: "/api/backfill-jobs", json: { rows: [] } },
    { path: "/api/integrations/front/auth-history", json: { last: null, recent: [] } },
    { path: "/api/admin/booking/health", json: {} },
    { path: "/api/admin/zoom/review-queue", json: { items: [] } },
    { path: "/api/integrations/front/rematch-all/running", json: { running: false } },
    { path: "/api/integrations/google-ads/customers", json: { customers: [] } },
    { path: "/api/integrations/google-ads/sync-runs", json: { runs: [] } },
    {
      path: "/api/semrush/console/sync-state",
      json: {
        outcomeTotals: {
          freshlySynced: 0,
          alreadyCurrent: 0,
          partiallyRefreshed: 0,
          failed: 0,
          neverRun: 0,
          totalIntegrations: 0,
        },
      },
    },
  ],
  defaultJson: {},
});
(globalThis as any).fetch = ((input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (HANGING_PATHS.some((p) => url === p || url.startsWith(`${p}?`))) {
    hangCount++;
    return new Promise(() => {}); // never settles — the stalled status load
  }
  return (routedStub as any)(input, init);
}) as any;

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals, timer seams, and fetch stub.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
(globalThis as any).React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const IntegrationsHub = (await import("../../client/src/pages/admin/IntegrationsHub")).default;

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

function click(el: HTMLElement): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Fire every captured 5s rollup tick once (inside act). */
async function fireRollupTick(): Promise<void> {
  await act(async () => {
    for (const t of capturedIntervals) {
      if (t.ms === 5_000) t.fn();
    }
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(4);
}

async function main(): Promise<void> {
  console.log("Integrations Hub ClickUp/SEMrush stalled-status timeout (Task #4586)");

  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(IntegrationsHub as any),
      ),
    );
  });
  await flush();

  try {
    // ------------------------------------------------------------------
    // 0. Sanity: the stalled queries actually fired (and are hanging).
    // ------------------------------------------------------------------
    assert(hangCount >= 3, `all three stalled endpoints must have been fetched — got ${hangCount}`);
    assert($("card-clickup-integration") !== null, "ClickUp card must render");
    assert($("card-semrush-integration") !== null, "SEMrush card must render");

    // ------------------------------------------------------------------
    // 1. Pre-timeout: roster spinner spins, no couldn't-reach state yet.
    // ------------------------------------------------------------------
    assert(
      $("text-clickup-roster-loading") !== null,
      "ClickUp roster spinner must render while the roster query is in-flight",
    );
    assert(
      $("degraded-clickup-status-unreachable") === null,
      "no premature ClickUp couldn't-reach state before the bound",
    );
    assert(
      $("degraded-semrush-status-unreachable") === null,
      "no premature SEMrush couldn't-reach state before the bound",
    );
    // A tick alone (no elapsed wall-clock) must not flip anything — the
    // checking-entry stamp is Date.now()-based by design.
    await fireRollupTick();
    assert(
      $("degraded-clickup-status-unreachable") === null &&
        $("degraded-semrush-status-unreachable") === null,
      "a fired tick without elapsed wall-clock must not fake the timeout",
    );
    console.log("  ✓ pre-timeout: roster spinner, no couldn't-reach state (tick alone can't fake it)");

    // ------------------------------------------------------------------
    // 2. Advance past CHECKING_TIMEOUT_MS (20s) and fire the 5s tick:
    //    both card bodies resolve to the shared couldn't-reach state.
    // ------------------------------------------------------------------
    nowOffsetMs = 21_000;
    await fireRollupTick();

    const clickupDegraded = $("degraded-clickup-status-unreachable");
    assert(clickupDegraded !== null, "ClickUp card must render degraded-clickup-status-unreachable after the bound");
    assert(
      /couldn't reach clickup status/i.test(clickupDegraded!.textContent || ""),
      `ClickUp couldn't-reach copy must name ClickUp — got "${clickupDegraded!.textContent?.slice(0, 120)}"`,
    );
    assert(
      $("button-clickup-retry-status-check") !== null,
      "ClickUp couldn't-reach state must offer its retry button",
    );
    assert(
      $("text-clickup-roster-loading") === null,
      "the ClickUp roster spinner must be gone once the couldn't-reach state renders",
    );

    const semrushDegraded = $("degraded-semrush-status-unreachable");
    assert(semrushDegraded !== null, "SEMrush card must render degraded-semrush-status-unreachable after the bound");
    assert(
      /couldn't reach semrush status/i.test(semrushDegraded!.textContent || ""),
      `SEMrush couldn't-reach copy must name Semrush — got "${semrushDegraded!.textContent?.slice(0, 120)}"`,
    );
    assert(
      $("button-semrush-retry-status-check") !== null,
      "SEMrush couldn't-reach state must offer its retry button",
    );
    console.log("  ✓ after the 20s bound: both couldn't-reach states + retry buttons, roster spinner gone");

    // ------------------------------------------------------------------
    // 3. Per-card retries restart the bounded wait: the degraded states
    //    clear and the (still hanging) queries put the cards back into
    //    the checking presentation.
    // ------------------------------------------------------------------
    // (retryStatusCheck resets EVERY card's checking stamp, so one card's
    // retry clears both degraded states — that's the shared bounded-wait
    // restart, not a per-card scope bug.)
    await click($("button-clickup-retry-status-check")!);
    await flush(6);
    assert(
      $("degraded-clickup-status-unreachable") === null,
      "ClickUp retry must clear the couldn't-reach state (bounded wait restarts)",
    );
    assert(
      $("text-clickup-roster-loading") !== null,
      "ClickUp retry must restore the roster spinner while the refetch hangs",
    );
    assert(
      $("degraded-semrush-status-unreachable") === null,
      "the shared bounded-wait restart clears the SEMrush state too",
    );
    // Re-flip (queries are still hanging) and exercise the SEMrush retry.
    nowOffsetMs += 21_000;
    await fireRollupTick();
    assert(
      $("degraded-semrush-status-unreachable") !== null,
      "still-hanging queries must re-resolve to couldn't-reach after another bound",
    );
    await click($("button-semrush-retry-status-check")!);
    await flush(6);
    assert(
      $("degraded-semrush-status-unreachable") === null,
      "SEMrush retry must clear the couldn't-reach state (bounded wait restarts)",
    );
    console.log("  ✓ per-card retry buttons restart the bounded wait");
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    queryClient.clear();
  }

  console.log("\nintegrations-hub-stalled-status-timeout: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
