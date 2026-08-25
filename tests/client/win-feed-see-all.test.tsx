/* test-registration
{
  "name": "Win Feed 'See all wins' gating — button whenever wins exist, mobile button removed (Task #5012)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5012 replaced the 3/6-tile-cap dual thresholds with one rule: the header 'See all wins' button renders whenever any win survives the hide-demo filter — feed rows clamp their body preview, so the dialog is the full-text reading surface and must stay reachable — and the mobile-only bottom button is gone for good. Pure render logic, no DB; a jsdom mount with stubbed fetch covers the 0/1/many boundaries plus partial and to-zero demo filtering in ~0.3s.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/win-feed-see-all-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * WinFeedCard "See all wins" gating regression. Originally pinned Task
 * #4917's 3/6-tile-cap dual thresholds; re-pinned for Task #5012's compact
 * scrolling rework.
 *
 * Task #5012 removed the tile caps (every fetched win renders inside the
 * bounded-height scroller) and with them the mobile-only bottom button, so
 * one affordance and one rule remain:
 *
 *   [data-testid="button-see-all-wins"] — header button, present whenever at
 *   least one win survives the hide-demo filter. Feed rows clamp their body
 *   preview, so the AllWinsDialog it opens is the full-text reading surface
 *   and must stay reachable whenever there is anything to read.
 *
 *   [data-testid="button-see-all-wins-mobile"] — REMOVED; every scenario
 *   asserts it never renders again, at any win count.
 *
 * Boundary cases verified (all wins non-demo unless noted):
 *
 *   • 0 wins  → no button (empty state shows instead)
 *   • 1 win   → button present
 *   • 7 wins  → button present
 *   • 4 wins, 1 demo + hideDemo cookie → net 3 → button present
 *   • 2 wins, both demo + hideDemo cookie → net 0 → no button, empty state
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createJsonResponse } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLImageElement = dom.window.HTMLImageElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
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
    dispatchEvent() { return false; },
  }));
(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const jsonResponse = createJsonResponse(dom.window.Headers as any);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_USER = {
  id: "user-wf1",
  email: "am@example.com",
  firstName: "Alice",
  lastName: "Manager",
  role: "account_manager",
  profileImageUrl: null,
};

function makeWin(id: string, isDemo = false) {
  return {
    id,
    clientId: `client-${id}`,
    clientFirmName: `Firm ${id}`,
    clientIsDemo: isDemo,
    title: `Win ${id}`,
    body: null,
    createdAt: new Date().toISOString(),
    createdBy: "user-wf1",
    authorFirstName: "Alice",
    authorLastName: "Manager",
    authorEmail: "am@example.com",
  };
}

// ── Fetch stub ─────────────────────────────────────────────────────────────────

// Controlled via currentWins — each scenario replaces this before mounting.
let currentWins: ReturnType<typeof makeWin>[] = [];

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = (init?.method || "GET").toUpperCase();

  if (method === "HEAD") throw new TypeError("Failed to fetch");
  if (url.includes("/api/dashboard/wins")) return jsonResponse(200, currentWins);
  if (url.includes("/api/auth/user")) return jsonResponse(200, TEST_USER);
  if (url.includes("/api/dashboard/client-summaries")) return jsonResponse(200, []);
  if (url.includes("/api/reports")) return jsonResponse(200, []);
  if (url.includes("/api/notifications/unread-count")) return jsonResponse(200, { count: 0 });
  if (url.includes("/api/monthly-review-stats")) return jsonResponse(200, { reviewed: 0, needsReview: 0, total: 0 });
  if (url.includes("/api/monthly-review-notifications") && method === "POST") return jsonResponse(200, {});
  return jsonResponse(200, {});
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function byTestId(id: string): Element | null {
  return dom.window.document.querySelector(`[data-testid="${id}"]`);
}

// ── Test runner ────────────────────────────────────────────────────────────────

async function run() {
  (globalThis as any).__capturedToasts = [];

  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClientProvider, QueryClient } = (await import("@tanstack/react-query")) as any;
  const Dashboard = (await import("@/pages/Dashboard")).default as any;

  const container = dom.window.document.getElementById("root")!;

  // Each scenario gets its own QueryClient so cached wins data from one run
  // can't bleed into the next.
  async function runScenario(
    label: string,
    wins: ReturnType<typeof makeWin>[],
    hideDemoCookie: boolean,
    expect: { seeAll: boolean; emptyState?: boolean },
  ) {
    currentWins = wins;

    // useHideDemoAccounts uses key `hide-demo-accounts:${userId ?? "anon"}`.
    // The Dashboard fetches the user asynchronously, so we set BOTH the
    // anon key (used before auth resolves) and the user-specific key
    // (used once /api/auth/user returns "user-wf1"). Values are JSON-serialized.
    const DEMO_KEY_ANON = "hide-demo-accounts:anon";
    const DEMO_KEY_USER = "hide-demo-accounts:user-wf1";
    if (hideDemoCookie) {
      dom.window.localStorage.setItem(DEMO_KEY_ANON, "true");
      dom.window.localStorage.setItem(DEMO_KEY_USER, "true");
    } else {
      dom.window.localStorage.removeItem(DEMO_KEY_ANON);
      dom.window.localStorage.removeItem(DEMO_KEY_USER);
    }

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: qc },
          React.createElement(Dashboard),
        ),
      );
    });

    // Wait for the win feed to load (either a tile or the "no wins" text).
    await waitFor(
      `${label}: win feed resolves`,
      () =>
        byTestId("card-win-feed") !== null &&
        byTestId("win-feed-loading") === null,
    );

    const seeAllBtn = byTestId("button-see-all-wins");

    assert.equal(
      seeAllBtn !== null,
      expect.seeAll,
      `${label}: header "See all wins" button — expected ${expect.seeAll ? "present" : "absent"}, got ${seeAllBtn !== null ? "present" : "absent"}`,
    );
    // Task #5012 removed the mobile-only bottom button outright — it must
    // never render again, at ANY win count or filter state.
    assert.equal(
      byTestId("button-see-all-wins-mobile"),
      null,
      `${label}: removed mobile "See all wins" button must not render`,
    );
    if (expect.emptyState !== undefined) {
      assert.equal(
        byTestId("text-no-wins") !== null,
        expect.emptyState,
        `${label}: empty state — expected ${expect.emptyState ? "present" : "absent"}`,
      );
    }

    console.log(`  ✓ ${label}: seeAll=${expect.seeAll}, mobile button absent`);

    act(() => root.unmount());
    // Let React drain any pending state updates before next scenario.
    await sleep(10);
  }

  // ── Boundary cases ──────────────────────────────────────────────────────────

  // 0 wins → no button: nothing for the dialog to show, empty state renders.
  await runScenario("0 wins", [], false, { seeAll: false, emptyState: true });

  // 1 win → button present: any win means the dialog has full text to offer
  // (feed rows clamp their body preview).
  await runScenario("1 win (no demo)", [makeWin("w1")], false, {
    seeAll: true,
    emptyState: false,
  });

  // 7 wins → button present: the old >6 desktop threshold is gone, but high
  // counts still qualify under the wins-exist rule.
  await runScenario(
    "7 wins (no demo)",
    [1, 2, 3, 4, 5, 6, 7].map((n) => makeWin(`w${n}`)),
    false,
    { seeAll: true },
  );

  // 4 wins, 1 is demo + hideDemo=true → net 3 → button present: partial demo
  // filtering leaves surviving wins, so the affordance stays. (Under the old
  // cap rule this exact case hid both buttons — the inversion proves the
  // re-pin took.)
  await runScenario(
    "4 wins (1 demo, hideDemo=true) → net 3",
    [makeWin("w1"), makeWin("w2"), makeWin("w3"), makeWin("w-demo", true)],
    true,
    { seeAll: true },
  );

  // 2 wins, both demo + hideDemo=true → net 0 → no button: the hide-demo
  // filter interacts with the gate by emptying the feed entirely.
  await runScenario(
    "2 wins (both demo, hideDemo=true) → net 0",
    [makeWin("w-demo-1", true), makeWin("w-demo-2", true)],
    true,
    { seeAll: false, emptyState: true },
  );
}

run()
  .then(() => {
    console.log("\nPASS tests/client/win-feed-see-all.test.tsx");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/win-feed-see-all.test.tsx");
    console.error(err);
    process.exit(1);
  });
