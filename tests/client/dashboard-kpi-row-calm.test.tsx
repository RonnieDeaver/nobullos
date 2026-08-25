/* test-registration
{
  "name": "Dashboard KPI row calm — one-line label/caption zones, tooltip fallbacks, DOM order (Task #4993)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4993 calmed the dashboard KPI band: every tile keeps a single-line label zone and a structurally one-line, bottom-pinned caption zone so the seven numbers and captions align at every breakpoint. Nothing else pins those contracts — a future copy edit or KpiCard refactor could quietly reintroduce wrapping (the exact regression the task fixed) and all existing suites would stay green. Fast (<5s), DB-free, deterministic (fetch fully stubbed).",
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
 * Task #4993 — regression harness for the calmed dashboard KPI row.
 *
 * The seven KPI tiles (Clients, Healthy, Watch, At Risk, Reports,
 * Notifications, Panel Reviews) read as one aligned band because:
 *
 *   1. ONE-LINE CAPTIONS — every dashboard caption renders through
 *      oneLineKpiCaption: a `block truncate` span whose `title` carries the
 *      full text. `truncate` = nowrap + hidden overflow + ellipsis, so the
 *      caption zone is exactly one text line tall at EVERY viewport width —
 *      jsdom has no layout engine, but the class itself is the
 *      width-independent guarantee (covers 2-up phone, 4-up md, 7-across xl
 *      simultaneously). This is asserted for all seven tiles, including the
 *      dynamic hidden-demo and review-due captions with realistic values.
 *
 *   2. ONE-LINE LABELS — KpiCard's label zone truncates instead of wrapping
 *      (wrapped labels were pushing the big numbers to different heights),
 *      and the shortened "At Risk" label keeps the full "At Risk / Critical"
 *      phrase reachable via a title tooltip.
 *
 *   3. BOTTOM-PINNED CAPTION ZONE — KpiCard pins the caption zone with
 *      mt-auto inside a stretched flex column, so captions sit in the same
 *      slot in every sibling card.
 *
 *   4. ROW CONTRACTS INTACT — all seven testids in their original DOM
 *      order, the Notifications tile still wrapped in the inbox link, and
 *      value/unit copy for the conditional tiles (visible count with demo
 *      accounts hidden, "56/57 done" with "1 due this month").
 *
 * The Dashboard component is mounted in jsdom with fetch fully stubbed
 * (same harness pattern as dashboard-win-feed-layout.test.tsx).
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const jsonResponse = createJsonResponse(dom.window.Headers as any);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_USER = {
  id: "user-kpi-1",
  email: "lead@example.com",
  firstName: "Lead",
  lastName: "User",
  role: "team_lead",
  profileImageUrl: null,
};

function makeSummary(id: string, judgmentStatus: string | null, isDemo: boolean) {
  return {
    id,
    clientCode: id.toUpperCase(),
    firmName: `Firm ${id}`,
    contactName: "Jane Doe",
    isDemo,
    products: [] as string[],
    practiceAreas: [] as string[],
    clientStartDate: "2025-01-01",
    ownerId: "user-kpi-1",
    ownerName: "Lead User",
    ownerAvatar: null,
    lastCommDate: "2026-06-01T00:00:00.000Z",
    commCount30d: 5,
    commCountTotal: 50,
    touchpointCount30d: 2,
    touchpointCountTotal: 20,
    lastTouchpointDate: "2026-06-01T00:00:00.000Z",
    judgmentStatus,
    relationshipHealth: "good",
    judgmentHeadline: "hl",
    judgmentDate: "2026-06-01T00:00:00.000Z",
    judgmentBasis: null,
    judgmentConfidence: null,
    lastReviewedAt: "2026-06-01T00:00:00.000Z",
    budgetPosture: null,
  };
}

// 4 visible accounts (one per health bucket) + 2 demo accounts. With the
// hide-demo preference ON the Clients tile shows 4 and its caption reads
// "Active accounts · 2 demo hidden" — the realistic conditional state the
// one-line caption contract must hold for.
const SUMMARIES = [
  makeSummary("cl-a", "Healthy", false),
  makeSummary("cl-b", "Watch", false),
  makeSummary("cl-c", "At Risk", false),
  makeSummary("cl-d", "Critical", false),
  makeSummary("cl-demo-1", "Healthy", true),
  makeSummary("cl-demo-2", "Watch", true),
];

// The Reports tile counts reports whose reportMonth equals the previous
// calendar month (clock-derived here exactly like the page computes it, so
// the fixture never rots as real time advances).
function previousMonthPeriod(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}
const REPORTING_PERIOD = previousMonthPeriod();

const REPORTS = [
  { id: "rep-1", clientId: "cl-a", reportMonth: REPORTING_PERIOD, status: "final" },
  { id: "rep-2", clientId: "cl-b", reportMonth: REPORTING_PERIOD, status: "draft" },
  { id: "rep-3", clientId: "cl-c", reportMonth: REPORTING_PERIOD, status: "final" },
];

const CARD_IDS = [
  "card-stat-clients",
  "card-stat-healthy",
  "card-stat-watch",
  "card-stat-atrisk",
  "card-stat-reports",
  "card-stat-notifications",
  "card-stat-monthly-reviews",
];

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

function mustGet(id: string): Element {
  const el = byTestId(id);
  assert.ok(el, `[data-testid="${id}"] must be in the DOM`);
  return el!;
}

/** Returns true when elA precedes elB in document order. */
function precedes(elA: Element, elB: Element): boolean {
  return !!(
    elA.compareDocumentPosition(elB) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING
  );
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

  function mount() {
    // Tear down the previous scenario's tree BEFORE clearing the query
    // cache: clearing while the old tree is still subscribed kicks off
    // refetches that abort mid-unmount and strand queries in error state.
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "HEAD") throw new TypeError("Failed to fetch");

      if (url.includes("/api/dashboard/wins")) return jsonResponse(200, []);
      if (url.includes("/api/auth/user")) return jsonResponse(200, TEST_USER);
      if (url.includes("/api/dashboard/client-summaries"))
        return jsonResponse(200, SUMMARIES);
      if (url.includes("/api/reports")) return jsonResponse(200, REPORTS);
      if (url.includes("/api/clients")) return jsonResponse(200, []);
      if (url.includes("/api/notifications/unread-count"))
        return jsonResponse(200, { count: 53 });
      if (url.includes("/api/monthly-review-stats"))
        return jsonResponse(200, { reviewed: 56, needsReview: 1, total: 57 });
      if (url.includes("/api/tags"))
        return jsonResponse(200, { tags: [], assignments: [] });
      if (url.includes("/api/monthly-review-notifications") && method === "POST")
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

  // ════════════════════════════════════════════════════════════════════════
  // Scenario A — hide-demo ON (the conditional caption the completion review
  // flagged): "Active accounts · 2 demo hidden" must render as a one-line
  // truncating span with the full text in its title.
  // ════════════════════════════════════════════════════════════════════════

  dom.window.localStorage.setItem(
    "hide-demo-accounts:user-kpi-1",
    JSON.stringify(true),
  );

  mount();

  await waitFor(
    "KPI tiles render with hydrated data",
    () =>
      byTestId("card-stat-clients") !== null &&
      (byTestId("text-monthly-review-count")?.textContent || "") === "56/57",
  );
  // One extra beat for the usePersistentState localStorage hydration effect.
  await sleep(150);
  await waitFor(
    "hidden-demo caption hydrates",
    () =>
      (byTestId("card-stat-clients-caption")?.textContent || "").includes(
        "demo hidden",
      ),
  );

  // 1. ONE-LINE CAPTION STRUCTURE on all seven tiles: the caption slot's
  //    only element child is a `block truncate` span whose title equals its
  //    full text. `truncate` (white-space: nowrap) cannot render a second
  //    line at any viewport width, which is exactly the cross-breakpoint
  //    guarantee — phone 2-up, md 4-up, and xl 7-across all inherit it.
  for (const id of CARD_IDS) {
    const caption = mustGet(`${id}-caption`);
    const children = Array.from(caption.children);
    assert.equal(
      children.length,
      1,
      `${id}-caption must contain exactly one element child (the one-line span); got ${children.length}`,
    );
    const span = children[0] as HTMLElement;
    assert.ok(
      span.classList.contains("truncate") && span.classList.contains("block"),
      `${id}-caption child must carry "block truncate"; got class="${span.className}"`,
    );
    const text = (span.textContent || "").trim();
    assert.ok(text.length > 0, `${id}-caption must render non-empty text`);
    assert.equal(
      span.getAttribute("title"),
      text,
      `${id}-caption span's title must carry the full caption text (tooltip fallback for ellipsized copy)`,
    );
    // The kit pins the caption zone to the card bottom so captions sit in
    // the same slot across stretched siblings.
    assert.ok(
      caption.classList.contains("mt-auto"),
      `${id}-caption zone must be bottom-pinned (mt-auto); got class="${caption.className}"`,
    );
  }
  console.log("  ✓ One-line captions: all 7 tiles render block-truncate spans with title fallbacks");

  // 2. REALISTIC CONDITIONAL VALUES — hidden-demo state and review-due
  //    state render the expected copy through the one-line span.
  assert.equal(
    byTestId("card-stat-clients-caption")!.textContent!.trim(),
    "Active accounts · 2 demo hidden",
    "Clients caption must name the hidden demo count when hide-demo is on",
  );
  assert.equal(
    (byTestId("text-client-count")?.textContent || "").trim(),
    "4",
    "Clients value must count only visible (non-demo) accounts with hide-demo on",
  );
  assert.equal(
    byTestId("card-stat-monthly-reviews-caption")!.textContent!.trim(),
    "1 due this month",
    "Panel Reviews caption must carry the due count",
  );
  assert.ok(
    (byTestId("card-stat-monthly-reviews")!.textContent || "").includes("done"),
    'Panel Reviews unit "done" must render next to the 56/57 value',
  );
  assert.equal(
    byTestId("card-stat-reports-caption")!.textContent!.trim(),
    `Period ${REPORTING_PERIOD}`,
    "Reports caption must carry the reporting period",
  );
  console.log("  ✓ Conditional copy: demo-hidden caption, review-due caption, period caption all exact");

  // 3. ONE-LINE LABEL ZONE — KpiCard's label container truncates instead of
  //    wrapping, and the At Risk tile keeps the full phrase in a tooltip.
  for (const id of CARD_IDS) {
    const card = mustGet(id);
    const label = card.querySelector(".uppercase") as HTMLElement | null;
    assert.ok(label, `${id} must render its label zone`);
    assert.ok(
      label!.classList.contains("truncate"),
      `${id} label zone must be single-line (truncate); got class="${label!.className}"`,
    );
  }
  const atriskLabel = mustGet("card-stat-atrisk").querySelector(
    ".uppercase span[title]",
  ) as HTMLElement | null;
  assert.ok(atriskLabel, "At Risk label must carry a title-bearing span");
  assert.equal(
    atriskLabel!.getAttribute("title"),
    "At Risk / Critical",
    "At Risk label tooltip must preserve the full phrase",
  );
  assert.equal(
    (atriskLabel!.textContent || "").trim(),
    "At Risk",
    "At Risk label must display the short form",
  );
  // At Risk value combines At Risk + Critical accounts (1 + 1 fixture rows).
  assert.equal(
    (mustGet("card-stat-atrisk-value").textContent || "").replace(/accounts/, "").trim(),
    "2",
    "At Risk value must combine At Risk and Critical counts",
  );
  console.log("  ✓ One-line labels: truncating label zones; At Risk keeps full phrase via tooltip");

  // 4. ROW CONTRACTS — original DOM order of all seven tiles and the
  //    Notifications tile still wrapped in the inbox link.
  for (let i = 0; i < CARD_IDS.length - 1; i++) {
    assert.ok(
      precedes(mustGet(CARD_IDS[i]), mustGet(CARD_IDS[i + 1])),
      `${CARD_IDS[i]} must precede ${CARD_IDS[i + 1]} in DOM order`,
    );
  }
  const notifLink = mustGet("card-stat-notifications").closest(
    '[data-testid="link-stat-notifications"]',
  );
  assert.ok(notifLink, "Notifications tile must stay wrapped in the inbox link");
  assert.equal(
    notifLink!.getAttribute("href"),
    "/notifications",
    "Notifications link must point at the inbox",
  );
  console.log("  ✓ Row contracts: 7-tile DOM order and Notifications inbox link intact");

  // ════════════════════════════════════════════════════════════════════════
  // Scenario B — hide-demo OFF: the Clients caption falls back to the plain
  // form, still through the one-line span.
  // ════════════════════════════════════════════════════════════════════════

  dom.window.localStorage.setItem(
    "hide-demo-accounts:user-kpi-1",
    JSON.stringify(false),
  );

  mount();

  await waitFor(
    "Clients tile settles with hide-demo off (plain caption + full count)",
    () =>
      (byTestId("card-stat-clients-caption")?.textContent || "").trim() ===
        "Active accounts" &&
      (byTestId("text-client-count")?.textContent || "").trim() === "6",
  );
  const plainSpan = mustGet("card-stat-clients-caption").children[0] as HTMLElement;
  assert.ok(
    plainSpan.classList.contains("truncate"),
    "plain Clients caption must render through the same one-line span",
  );
  assert.equal(
    (byTestId("text-client-count")?.textContent || "").trim(),
    "6",
    "Clients value must count all accounts (demo included) with hide-demo off",
  );
  console.log("  ✓ Hide-demo off: plain caption via the same one-line span; count includes demo rows");

  act(() => {
    root.unmount();
  });

  console.log("dashboard-kpi-row-calm: all assertions passed");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
