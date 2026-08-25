/* test-registration
{
  "name": "Dashboard Win Feed layout — full-width placement, bounded scroller, all wins reachable, feed clamp vs dialog full text, demo filtering (Task #5012)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5012 reworked the Win Feed band into a compact single-column timeline inside a bounded-height scroller: ALL fetched wins render (the 6-desktop/3-mobile tile caps and the mobile bottom button are gone), feed rows clamp their body preview while the All Wins dialog keeps full unclamped text, and the feed still leads the page. Nothing else pins these contracts — a refactor could silently unbound the band, re-cap the list, clamp the dialog, or demote the feed and every test would stay green. Fast (<5s), DB-free, deterministic (fetch fully stubbed). Gates five properties: DOM order, bounded-scroller classes, all-rows-render + client links, feed-clamp vs dialog-full-text, demo chip + hide-demo filtering.",
  "extraNodeArgs": [
    "--import",
    "./tests/dashboard-win-feed-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Regression harness for the Win Feed band. Originally pinned Task #4912's
 * full-text grid (Task #4916); re-pinned for Task #5012's compact scrolling
 * rework.
 *
 * Task #5012 reworked the band into a compact, tweet-feed-style single-column
 * list inside a bounded-height scroll area: every fetched win is reachable by
 * scrolling the band, row bodies clamp to a short preview, and the full text
 * lives in the All Wins dialog. This suite pins the new contracts so a future
 * refactor can't silently undo them:
 *
 *   1. DOM ORDER — [data-testid="card-win-feed"] appears in the document
 *      before any KPI tile (card-stat-clients) and before the All Accounts
 *      table (card-clients-list). (Unchanged from Task #4912.)
 *
 *   2. BOUNDED SCROLLER — the rows render inside [data-testid=
 *      "win-feed-scroll"], a single-column (no grid) container carrying
 *      max-h-* + overflow-y-auto + divide-y class tokens (Tailwind styles
 *      don't compute in jsdom, so the class tokens are the pinnable
 *      contract).
 *
 *   3. ALL WINS REACHABLE — all 8 fetched wins render as rows (the old
 *      6-desktop/3-mobile caps are gone), no row carries the mobile-hide
 *      class, the mobile-only bottom button is gone, and rows still link to
 *      their client page.
 *
 *   4. DEMO FILTERING — a demo-client win renders a "demo" chip; enabling
 *      the hide-demo preference (via localStorage, the same mechanism used
 *      by the real toggle) removes it from the feed.
 *
 *   5. FEED CLAMPS, DIALOG DOESN'T — feed body previews carry a
 *      line-clamp-* class (titles/meta never hard-`truncate`), while the All
 *      Wins dialog (opened via the header button) contains zero
 *      truncate/line-clamp classes and renders the full multi-paragraph body.
 *
 * The Dashboard component is mounted in jsdom with fetch fully stubbed
 * (same harness pattern as dashboard-transient-resilience.test.tsx).
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
    dispatchEvent() {
      return false;
    },
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
  id: "user-wf-1",
  email: "lead@example.com",
  firstName: "Lead",
  lastName: "User",
  role: "team_lead",
  profileImageUrl: null,
};

const CLIENT_SUMMARY = {
  id: "client-wf-1",
  clientCode: "ACME",
  firmName: "Acme Law Firm",
  contactName: "Jane Doe",
  isDemo: false,
  products: [] as string[],
  practiceAreas: [] as string[],
  clientStartDate: "2025-01-01",
  ownerId: "user-wf-1",
  ownerName: "Lead User",
  ownerAvatar: null,
  lastCommDate: "2026-06-01T00:00:00.000Z",
  commCount30d: 5,
  commCountTotal: 50,
  touchpointCount30d: 2,
  touchpointCountTotal: 20,
  lastTouchpointDate: "2026-06-01T00:00:00.000Z",
  judgmentStatus: "Healthy",
  relationshipHealth: "good",
  judgmentHeadline: "All good",
  judgmentDate: "2026-06-01T00:00:00.000Z",
  judgmentBasis: null,
  judgmentConfidence: null,
  lastReviewedAt: "2026-06-01T00:00:00.000Z",
  budgetPosture: null,
};

// 8 wins: positions 1–2 are demo-client, positions 3–8 are non-demo — more
// than the retired 6-tile cap ever showed, so Scenario A can prove EVERY
// fetched win now renders in the scroller. The first non-demo win carries a
// long title and a multi-paragraph body to exercise the feed-clamp vs
// dialog-full-text contract.
const DEMO_WIN_IDS = ["win-demo-1", "win-demo-2"];

function makeWins() {
  const wins = [
    {
      id: "win-demo-1",
      clientId: "client-demo-1",
      clientFirmName: "Demo Corp",
      clientIsDemo: true,
      title: "Demo: secured favorable ruling on motion to dismiss",
      body: "This is a demo account win for QA purposes.",
      createdAt: "2026-08-02T10:00:00.000Z",
      createdBy: "user-wf-1",
      authorFirstName: "Lead",
      authorLastName: "User",
      authorEmail: "lead@example.com",
    },
    {
      id: "win-demo-2",
      clientId: "client-demo-2",
      clientFirmName: "Demo Partners",
      clientIsDemo: true,
      title: "Demo: arbitration award in client's favor",
      body: null,
      createdAt: "2026-08-01T12:00:00.000Z",
      createdBy: "user-wf-1",
      authorFirstName: "Lead",
      authorLastName: "User",
      authorEmail: "lead@example.com",
    },
    {
      id: "win-001",
      clientId: "client-wf-1",
      clientFirmName: "Acme Law",
      clientIsDemo: false,
      title:
        "Secured landmark summary-judgment win in a highly contested IP infringement case after six months of intensive discovery and briefing",
      body: "The court granted our motion on all counts.\n\nKey arguments: prior art, prosecution history estoppel, and file wrapper estoppel all cut in our favor.\n\nThis sets a strong precedent for future IP work in the district.",
      createdAt: "2026-08-01T10:00:00.000Z",
      createdBy: "user-wf-1",
      authorFirstName: "Lead",
      authorLastName: "User",
      authorEmail: "lead@example.com",
    },
    {
      id: "win-002",
      clientId: "client-wf-1",
      clientFirmName: "Acme Law",
      clientIsDemo: false,
      title:
        "Successfully defended class certification in a multi-plaintiff consumer fraud action — court denied plaintiffs' motion in a detailed 45-page opinion",
      body: "Judge Smith's ruling highlighted inadequate commonality and predominance.\n\nWe're filing a Rule 11 motion next week.\n\nClient expressed exceptional satisfaction with the outcome.",
      createdAt: "2026-07-28T09:00:00.000Z",
      createdBy: "user-wf-1",
      authorFirstName: "Lead",
      authorLastName: "User",
      authorEmail: "lead@example.com",
    },
    {
      id: "win-003",
      clientId: "client-wf-1",
      clientFirmName: "Acme Law",
      clientIsDemo: false,
      title: "Favorable settlement in employment dispute",
      body: "Settled for 40% below initial demand.",
      createdAt: "2026-07-20T08:00:00.000Z",
      createdBy: "user-wf-1",
      authorFirstName: "Lead",
      authorLastName: "User",
      authorEmail: "lead@example.com",
    },
    {
      id: "win-004",
      clientId: "client-wf-1",
      clientFirmName: "Acme Law",
      clientIsDemo: false,
      title: "Contract renegotiation saves client $2M annually",
      body: null,
      createdAt: "2026-07-15T08:00:00.000Z",
      createdBy: "user-wf-1",
      authorFirstName: "Lead",
      authorLastName: "User",
      authorEmail: "lead@example.com",
    },
    {
      id: "win-005",
      clientId: "client-wf-1",
      clientFirmName: "Acme Law",
      clientIsDemo: false,
      title: "Regulatory approval secured after two-year review",
      body: "FDA approved the NDA without further conditions.",
      createdAt: "2026-07-10T08:00:00.000Z",
      createdBy: "user-wf-1",
      authorFirstName: "Lead",
      authorLastName: "User",
      authorEmail: "lead@example.com",
    },
    {
      id: "win-006",
      clientId: "client-wf-1",
      clientFirmName: "Acme Law",
      clientIsDemo: false,
      title: "Appellate reversal: lower-court damages award vacated",
      body: "Circuit panel agreed on all three grounds we argued.",
      createdAt: "2026-07-05T08:00:00.000Z",
      createdBy: "user-wf-1",
      authorFirstName: "Lead",
      authorLastName: "User",
      authorEmail: "lead@example.com",
    },
  ];
  return wins;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
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

function allByTestIdPrefix(prefix: string): Element[] {
  return Array.from(
    dom.window.document.querySelectorAll(`[data-testid^="${prefix}"]`),
  );
}

/** Returns true when elA precedes elB in document order. */
function precedes(elA: Element, elB: Element): boolean {
  // compareDocumentPosition returns a bitmask; bit 2 (value 4) = "B follows A"
  return !!(elA.compareDocumentPosition(elB) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
}

/** Collect every class token on el and all its descendants. */
function allDescendantClasses(root: Element): string[] {
  const classes: string[] = [];
  const all = root.querySelectorAll("*");
  // include the root's own classes
  root.classList.forEach((c) => classes.push(c));
  all.forEach((el) => el.classList.forEach((c) => classes.push(c)));
  return classes;
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run() {
  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClientProvider } = (await import("@tanstack/react-query")) as any;
  const { queryClient } = (await import("@/lib/queryClient")) as any;
  const Dashboard = (await import("@/pages/Dashboard")).default as any;

  const container = dom.window.document.getElementById("root")!;
  let root: any = null;

  function mountWith(wins: ReturnType<typeof makeWins>) {
    // Fresh root per scenario so component state (e.g. the All Wins dialog
    // opened during Scenario A) can't leak into the next scenario.
    if (root) act(() => root.unmount());
    // Wipe all stored fetch overrides so each scenario is clean.
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url =
        typeof input === "string" ? input : input?.url ?? String(input);
      const method = (init?.method || "GET").toUpperCase();

      // Keep the connection-lost HEAD probe failing so it doesn't
      // interfere with query state.
      if (method === "HEAD") throw new TypeError("Failed to fetch");

      if (url.includes("/api/dashboard/wins"))
        return jsonResponse(200, wins);
      if (url.includes("/api/auth/user"))
        return jsonResponse(200, TEST_USER);
      if (url.includes("/api/dashboard/client-summaries"))
        return jsonResponse(200, [CLIENT_SUMMARY]);
      if (url.includes("/api/reports")) return jsonResponse(200, []);
      if (url.includes("/api/notifications/unread-count"))
        return jsonResponse(200, { count: 0 });
      if (url.includes("/api/monthly-review-stats"))
        return jsonResponse(200, { reviewed: 0, needsReview: 0, total: 0 });
      if (url.includes("/api/tags"))
        return jsonResponse(200, { tags: [], assignments: [] });
      if (
        url.includes("/api/monthly-review-notifications") &&
        method === "POST"
      )
        return jsonResponse(200, {});
      return jsonResponse(200, {});
    };

    queryClient.clear();

    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Dashboard),
        ),
      );
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario A — default (hide-demo OFF): verify DOM order, the bounded
  // scroller, all-rows-render + client links, demo chip visibility, and the
  // feed-clamp vs dialog-full-text split.
  // ══════════════════════════════════════════════════════════════════════════

  // Ensure hide-demo is NOT set for this user.
  dom.window.localStorage.removeItem("hide-demo-accounts:user-wf-1");

  mountWith(makeWins());

  // Wait for the feed to populate (first real-win tile).
  await waitFor(
    "win feed tiles render",
    () => allByTestIdPrefix("row-win-").length > 0,
  );

  // 1. DOM ORDER: card-win-feed precedes KPI tiles and the accounts table.
  const winFeed = byTestId("card-win-feed");
  const kpiTile = byTestId("card-stat-clients");
  const accountsTable = byTestId("card-clients-list");

  assert.ok(winFeed, "card-win-feed must be in the DOM");
  assert.ok(kpiTile, "card-stat-clients (KPI) must be in the DOM");
  assert.ok(accountsTable, "card-clients-list (All Accounts) must be in the DOM");

  assert.ok(
    precedes(winFeed!, kpiTile!),
    "card-win-feed must precede card-stat-clients (KPI tiles) in DOM order",
  );
  assert.ok(
    precedes(winFeed!, accountsTable!),
    "card-win-feed must precede card-clients-list (All Accounts) in DOM order",
  );

  console.log("  ✓ DOM order: Win Feed precedes KPI tiles and All Accounts table");

  // 2. BOUNDED SCROLLER: the rows render inside a single-column,
  //    bounded-height, vertically scrollable container. Tailwind styles do
  //    not compute in jsdom, so the class tokens ARE the pinnable contract.
  const feedScroll = byTestId("win-feed-scroll");
  assert.ok(feedScroll, "win-feed-scroll container must be in the DOM");
  assert.ok(
    winFeed!.contains(feedScroll!),
    "win-feed-scroll must live inside card-win-feed",
  );
  const scrollClasses = Array.from(feedScroll!.classList);
  assert.ok(
    scrollClasses.includes("overflow-y-auto"),
    `win-feed-scroll must be a vertical scroller (overflow-y-auto); classes: ${scrollClasses.join(" ")}`,
  );
  assert.ok(
    scrollClasses.some((c) => /^max-h-/.test(c)),
    `win-feed-scroll must be height-bounded (max-h-*); classes: ${scrollClasses.join(" ")}`,
  );
  assert.ok(
    scrollClasses.some((c) => c === "divide-y" || c.startsWith("divide-y-")),
    `win-feed-scroll must separate rows like a timeline (divide-y); classes: ${scrollClasses.join(" ")}`,
  );
  assert.ok(
    !scrollClasses.some((c) => c === "grid" || c.includes("grid-cols")),
    `win-feed-scroll must be a single column, not a grid; classes: ${scrollClasses.join(" ")}`,
  );

  console.log("  ✓ Bounded scroller: single-column max-h + overflow-y-auto + divide-y container");

  // 3. ALL WINS REACHABLE: every fetched win renders as a row — the retired
  //    6-desktop/3-mobile caps must not resurface, no row hides behind the
  //    old `hidden md:block` mobile mechanics, the mobile-only bottom button
  //    is gone, and rows still deep-link to their client page.
  const winRows = allByTestIdPrefix("row-win-");
  assert.equal(
    winRows.length,
    8,
    `all 8 fetched wins must render as rows (no cap); got ${winRows.length}`,
  );
  for (const row of winRows) {
    assert.ok(
      !row.classList.contains("hidden"),
      `${row.getAttribute("data-testid")} must not carry the mobile-hide class`,
    );
  }
  assert.equal(
    byTestId("button-see-all-wins-mobile"),
    null,
    "the removed mobile-only bottom 'See all wins' button must not render",
  );
  const linkRow = feedScroll!.querySelector('[data-testid="row-win-win-001"]');
  assert.ok(linkRow, "row-win-win-001 must render inside the scroller");
  assert.equal(
    linkRow!.getAttribute("href"),
    "/clients/client-wf-1",
    "feed rows must keep linking to their client page",
  );

  console.log("  ✓ All wins reachable: 8/8 rows in the scroller, client links intact, mobile button gone");

  // 4a. DEMO CHIP: demo wins render (positions 1–2) and each carries a
  //     "demo" chip. Asserted BEFORE the dialog opens so byTestId can't hit
  //     a dialog copy of the same row.
  for (const demoId of DEMO_WIN_IDS) {
    const tile = byTestId(`row-win-${demoId}`);
    assert.ok(tile, `demo row row-win-${demoId} must render when hideDemo is off`);
    assert.ok(
      (tile!.textContent || "").includes("demo"),
      `demo row row-win-${demoId} must contain the "demo" chip text`,
    );
  }

  console.log("  ✓ Demo chip: \"demo\" chip appears on both demo-client rows");

  // 5a. FEED CLAMP: the feed body preview is clamped via a line-clamp-*
  //     class, while titles/meta never hard-truncate to a single line.
  const feedBody = Array.from(linkRow!.querySelectorAll("*")).find((el) =>
    Array.from(el.classList).some((c) => /^line-clamp-\d/.test(c)),
  );
  assert.ok(
    feedBody,
    "row-win-win-001's body preview must carry a line-clamp-* class in the feed",
  );
  assert.ok(
    (feedBody!.textContent || "").includes("The court granted our motion"),
    "the clamped element must be the body preview, not the title or meta line",
  );
  const feedClasses = allDescendantClasses(winFeed!);
  assert.equal(
    feedClasses.filter((c) => c === "truncate").length,
    0,
    "no hard `truncate` classes anywhere inside card-win-feed",
  );

  console.log("  ✓ Feed clamp: body preview line-clamped, no hard truncate classes");

  // 5b. DIALOG FULL TEXT: the header "See all wins" button (present because
  //     wins exist) opens the All Wins dialog, whose bodies render complete
  //     and unclamped.
  const seeAllBtn = byTestId("button-see-all-wins");
  assert.ok(seeAllBtn, "header 'See all wins' button must render when wins exist");
  await act(async () => {
    (seeAllBtn as any).dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
    await sleep(0);
  });
  await waitFor(
    "all-wins dialog renders its rows",
    () => {
      const dlg = byTestId("dialog-all-wins");
      return !!dlg && dlg.querySelectorAll('[data-testid^="row-win-"]').length > 0;
    },
  );
  const dialogEl = byTestId("dialog-all-wins")!;
  const dialogClampClasses = allDescendantClasses(dialogEl).filter(
    (c) => c === "truncate" || c.startsWith("line-clamp"),
  );
  assert.equal(
    dialogClampClasses.length,
    0,
    `dialog-all-wins must contain no truncate/line-clamp classes; found: ${dialogClampClasses.join(", ")}`,
  );
  const dialogRow = dialogEl.querySelector('[data-testid="row-win-win-001"]');
  assert.ok(dialogRow, "the dialog must render win-001");
  assert.ok(
    (dialogRow!.textContent || "").includes(
      "This sets a strong precedent for future IP work in the district.",
    ),
    "the dialog body must include the win's full multi-paragraph text",
  );

  console.log("  ✓ Dialog full text: zero truncate/line-clamp classes, complete body rendered");

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario B — hide-demo ON (set via localStorage before mount): demo wins
  // must not appear in the feed.
  // ══════════════════════════════════════════════════════════════════════════

  // Pre-seed localStorage so usePersistentState hydrates to true on mount.
  dom.window.localStorage.setItem(
    "hide-demo-accounts:user-wf-1",
    JSON.stringify(true),
  );

  // Use mixed wins (non-demo + demo) so the demo filter can be exercised.
  mountWith(makeWins());

  // Wait for any non-demo tile to render (proves the feed loaded).
  await waitFor(
    "non-demo win tiles render with hide-demo on",
    () => {
      const tiles = allByTestIdPrefix("row-win-");
      return tiles.length > 0;
    },
  );

  // Allow one render cycle for the localStorage hydration useEffect to fire
  // (usePersistentState reads localStorage in a useEffect on mount).
  await sleep(150);

  // After hydration, demo tiles must be absent and at least one non-demo
  // tile must remain (proves filtered output loaded, not a whole-feed crash).
  const tilesAfterHide = allByTestIdPrefix("row-win-");
  for (const tile of tilesAfterHide) {
    const testId = (tile as Element).getAttribute("data-testid") || "";
    const isDemo = DEMO_WIN_IDS.some((id) => testId.includes(id));
    assert.ok(
      !isDemo,
      `demo win tile "${testId}" must not render when hide-demo is enabled`,
    );
  }
  // All six non-demo wins must remain — the filter removed demos, and the
  // uncapped scroller still renders every surviving win (wins 3–8 in
  // makeWins() are non-demo).
  assert.equal(
    tilesAfterHide.length,
    6,
    `all 6 non-demo rows must remain visible when hide-demo is ON; got ${tilesAfterHide.length}`,
  );

  console.log("  ✓ Hide-demo filtering: demo win tiles absent, non-demo tiles present when preference is ON");

  // Cleanup.
  dom.window.localStorage.removeItem("hide-demo-accounts:user-wf-1");
  act(() => root.unmount());
}

run()
  .then(() => {
    console.log("\nPASS tests/client/dashboard-win-feed-layout.test.tsx");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/dashboard-win-feed-layout.test.tsx");
    console.error(err);
    process.exit(1);
  });
