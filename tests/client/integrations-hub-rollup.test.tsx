/* test-registration
{
  "name": "Integrations Hub health rollup: counts, jump chips, mobile ordering, checking-timeout flip (Task #4453)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the operators' 'what's broken' summary (Task #4356 rollup bar, jump chips, attention-first mobile order, bounded checking timeout) which previously had zero automated coverage; deterministic single jsdom mount, no DB, no network.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/integrations-hub-rollup-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "medium"
}
test-registration */
/**
 * Task #4453 — regression coverage for the Task #4356 Integrations Hub
 * health rollup, which was previously screenshot-verified only
 * (audits/integrations-hub-rollup-2026-08/).
 *
 * Mounts the real IntegrationsHub against a mixed all-status fixture
 * (7 healthy, zoom needs-attention via reconnectRequired.authGate,
 * stripe checking via connected:null) and asserts:
 *   1. Rollup counts match the fixture-derived classification.
 *   2. Every attention jump chip has a live `integration-card-{id}` target,
 *      and clicking it applies the transient highlight ring.
 *   3. `max-md:order-*` classes rank attention < checking < healthy.
 *   4. The checking→couldn't-reach flip: after CHECKING_TIMEOUT_MS of
 *      wall-clock (Date.now offset + manually fired captured 5s tick,
 *      per .agents/memory/captured-timer-refetchinterval-tests.md) the
 *      stripe card renders `degraded-stripe-status-unreachable` + retry
 *      button, the rollup reclassifies it to attention, and the retry
 *      button restarts the bounded wait (back to "Checking connection…").
 *
 * Harness pattern: tests/client/integrations-hub-all-status-unknown.test.tsx
 * (Task #2830) — team_lead user passes the admin gate without mounting the
 * CEO-only ProdActionsPanel; Clerk stubbed signed-in by the setup loader.
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
// The jump chip calls scrollIntoView, which jsdom does not implement.
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
// The rollup stamps checking-entry times with Date.now() and re-derives
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
  id: "admin-4453",
  email: "admin@example.com",
  firstName: "Ada",
  lastName: "Min",
  role: "team_lead",
};

// Mixed fixture (shapes per audits/integrations-hub-rollup-2026-08/README.md):
// zoom = needs attention (reconnectRequired.authGate), stripe = checking
// (connected:null forever), everything else healthy. Booking health answers
// {} so the booking entry is absent (bookingReady null) and the grid holds
// exactly the 9 integration cards.
const ALL_STATUS_MIXED = {
  front: { connected: true, webhookSecretConfigured: true },
  slack: { connected: true, team: "Example Team" },
  zoom: {
    connected: true,
    reconnectRequired: {
      authGate: { status: 401, reason: "invalid_token", since: 1 },
      scopeGates: [],
    },
  },
  twilio: { connected: true },
  pandadoc: { connected: true },
  stripe: { connected: null },
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
  semrush: { connected: true },
  unmatchedCount: 0,
};

const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { method: "POST", json: {} },
    { path: "/api/auth/user", json: ADMIN_USER },
    { path: "/api/integrations/all-status", json: ALL_STATUS_MIXED },
    { path: "/api/backfill-jobs", json: { rows: [] } },
    { path: "/api/integrations/front/auth-history", json: { last: null, recent: [] } },
    { path: "/api/admin/booking/health", json: {} },
    { path: "/api/admin/zoom/review-queue", json: { items: [] } },
    { path: "/api/integrations/front/rematch-all/running", json: { running: false } },
    {
      path: "/api/integrations/clickup/connected-users",
      json: { connectedUsers: [], totalTeamMembers: 0, oauthConfigured: true, redirectUri: null },
    },
    {
      path: "/api/integrations/clickup/company-token/status",
      json: {
        configured: true,
        source: "env",
        envPresent: true,
        dbOverride: false,
        lastEdited: null,
        directory: { configured: true, tokenSource: "env", live: true, lastSuccessAt: null, reason: null },
      },
    },
    { path: "/api/integrations/google-ads/customers", json: { customers: [] } },
    { path: "/api/integrations/google-ads/sync-runs", json: { runs: [] } },
    { path: "/api/semrush/status", json: { configured: true, connected: true, expired: false } },
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
(globalThis as any).fetch = fetchStub as any;

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

const CARD_TESTID_BY_ID: Record<string, string> = {
  front: "card-front-integration",
  slack: "card-slack-integration",
  zoom: "card-zoom-integration",
  clickup: "card-clickup-integration",
  "google-ads": "card-google-ads-integration",
  twilio: "card-twilio-integration",
  semrush: "card-semrush-integration",
  pandadoc: "card-pandadoc-integration",
  stripe: "card-stripe-integration",
};

function mobileOrderOf(id: string): number {
  const card = $(CARD_TESTID_BY_ID[id]);
  assert(card !== null, `${CARD_TESTID_BY_ID[id]} must render`);
  const m = (card!.className || "").match(/max-md:order-(\d+)/);
  assert(m !== null, `${id} card must carry a max-md:order-* class — got "${card!.className}"`);
  return Number(m![1]);
}

async function main(): Promise<void> {
  console.log("Integrations Hub health rollup (Task #4453)");

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
    assert(
      $("button-daily-judgments-run-all") === null,
      "the portfolio-wide ratings control must not render for a non-CEO user",
    );

    // ------------------------------------------------------------------
    // 1. Rollup counts derived from the mixed fixture.
    //    9 entries: zoom attention, stripe checking, 7 healthy.
    // ------------------------------------------------------------------
    assert($("bar-integrations-rollup") !== null, "rollup bar must render");
    const healthy = $("text-rollup-healthy-count");
    const attention = $("text-rollup-attention-count");
    const checking = $("text-rollup-checking-count");
    assert(healthy !== null && /\b7 healthy\b/.test(healthy!.textContent || ""),
      `healthy count must read "7 healthy" — got "${healthy?.textContent}"`);
    assert(attention !== null && /\b1 needs attention\b/.test(attention!.textContent || ""),
      `attention count must read "1 needs attention" — got "${attention?.textContent}"`);
    assert(checking !== null && /\b1 checking\b/.test(checking!.textContent || ""),
      `checking count must read "1 checking" — got "${checking?.textContent}"`);
    console.log("  ✓ rollup counts: 7 healthy / 1 needs attention / 1 checking");

    // ------------------------------------------------------------------
    // 2. Jump chips: every attention entry has a chip whose target card
    //    anchor exists; clicking applies the transient highlight ring.
    // ------------------------------------------------------------------
    const chips = Array.from(
      document.querySelectorAll('[data-testid^="chip-rollup-jump-"]'),
    ) as HTMLElement[];
    assert(chips.length === 1, `exactly one jump chip expected — got ${chips.length}`);
    const zoomChip = $("chip-rollup-jump-zoom");
    assert(zoomChip !== null, "zoom jump chip must render");
    for (const chip of chips) {
      const id = chip.getAttribute("data-testid")!.replace("chip-rollup-jump-", "");
      assert(
        document.getElementById(`integration-card-${id}`) !== null,
        `jump chip target integration-card-${id} must exist`,
      );
    }
    await click(zoomChip!);
    const zoomCard = $("card-zoom-integration");
    assert(
      (zoomCard!.className || "").includes("ring-2"),
      `clicking the zoom chip must apply the highlight ring — got "${zoomCard!.className}"`,
    );
    console.log("  ✓ jump chip targets exist; click highlights the card");

    // ------------------------------------------------------------------
    // 3. Mobile attention-first ordering: attention < checking < healthy.
    // ------------------------------------------------------------------
    const zoomOrder = mobileOrderOf("zoom"); // attention
    const stripeOrder = mobileOrderOf("stripe"); // checking
    const healthyOrders = ["front", "slack", "clickup", "google-ads", "twilio", "semrush", "pandadoc"]
      .map((id) => mobileOrderOf(id));
    assert(zoomOrder === 1, `attention (zoom) must rank first — got order-${zoomOrder}`);
    assert(
      stripeOrder > zoomOrder && healthyOrders.every((o) => o > stripeOrder),
      `ordering must rank attention < checking < healthy — zoom=${zoomOrder}, stripe=${stripeOrder}, healthy=[${healthyOrders}]`,
    );
    console.log("  ✓ max-md:order-* ranks attention < checking < healthy");

    // ------------------------------------------------------------------
    // 4. Checking→couldn't-reach flip after CHECKING_TIMEOUT_MS (20s):
    //    advance wall-clock past the bound and fire the 5s rollup tick.
    // ------------------------------------------------------------------
    assert($("text-stripe-checking") !== null, "stripe must start in the Checking connection… state");
    assert($("degraded-stripe-status-unreachable") === null, "no premature couldn't-reach state");

    nowOffsetMs = 21_000;
    await fireRollupTick();

    const degraded = $("degraded-stripe-status-unreachable");
    assert(degraded !== null, "after 20s the stripe card must render the couldn't-reach DegradedState");
    assert(
      /couldn't reach stripe status/i.test(degraded!.textContent || ""),
      `couldn't-reach copy must name Stripe — got "${degraded!.textContent?.slice(0, 120)}"`,
    );
    const retryBtn = $("button-stripe-retry-status-check");
    assert(retryBtn !== null, "the couldn't-reach state must offer a retry button");
    // Rollup reclassifies the timed-out card as attention (2 attention, 0 checking).
    const attention2 = $("text-rollup-attention-count");
    assert(
      /\b2 need attention\b/.test(attention2!.textContent || ""),
      `after timeout the rollup must read "2 need attention" — got "${attention2!.textContent}"`,
    );
    assert($("text-rollup-checking-count") === null, "checking count must drop out after the flip");
    console.log("  ✓ checking→couldn't-reach flip after the 20s bound + rollup reclassification");

    // ------------------------------------------------------------------
    // 5. Retry restarts the bounded wait: back to Checking connection…
    // ------------------------------------------------------------------
    await click(retryBtn!);
    await flush(6);
    assert(
      $("degraded-stripe-status-unreachable") === null,
      "retry must clear the couldn't-reach state (bounded wait restarts)",
    );
    assert($("text-stripe-checking") !== null, "retry must restore the Checking connection… row");
    const checking3 = $("text-rollup-checking-count");
    assert(
      checking3 !== null && /\b1 checking\b/.test(checking3!.textContent || ""),
      `after retry the rollup must count stripe as checking again — got "${checking3?.textContent}"`,
    );
    console.log("  ✓ retry button restarts the bounded wait");
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    queryClient.clear();
  }

  console.log("\nintegrations-hub-rollup: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
