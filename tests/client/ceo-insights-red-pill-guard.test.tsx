/* test-registration
{
  "name": "CEO Insights red-pill wall guard \u2014 gap pills rest neutral, red ONLY for explicit refusals, refused client sorts first, mobile list bounded at 10 with Show-all toggle (Task #4465)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4465: locks the calm-scan pill semantics on CEO Insights (Task #4354) \u2014 the token lints guard colors, not semantics, so only this mount test catches a reintroduced count-based red (the 77/77 red-pill wall, P1-6 \u00a77.2). DB-free, network-free jsdom mount, ~3s.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ceo-insights-red-pill-guard-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4465 — automatically catch any return of the red-pill wall on CEO
 * Insights.
 *
 * Task #4354 made the CEO Insights scan calm: the per-client "Gaps" status
 * pills rest neutral, and `critical` (red) appears ONLY for clients with an
 * explicitly refused data-access category — the actionable-now signal. The
 * original audit finding (P1-6 §7.2) was 77/77 red pills from count-based
 * tone. Nothing but this test enforces the semantics: the token lints guard
 * colors, not which tone a pill claims.
 *
 * Mounts the REAL CeoInsights page (client/src/pages/CeoInsights.tsx) in
 * jsdom as a CEO with a stubbed fetch and asserts:
 *
 *   1. Gap-heavy but refusal-free fixtures (12 clients, every category
 *      pending/unknown): ZERO critical pills in `table-data-gaps` — every
 *      `pill-gaps-<clientId>` is neutral and none reads "refused".
 *   2. One client with a refused category: EXACTLY that client's pill is
 *      critical, its text includes "refused", and that client sorts first
 *      in the desktop table (refusals lead the chase list).
 *   3. Mobile list (`list-data-gaps-mobile`) renders at most 10 rows with
 *      `button-toggle-all-gaps-mobile` present; toggling shows all 12.
 *
 * Harness per the repo mount-kit conventions (see memory:
 * mount-large-client-component-jsdom + clerk-auth-migration-harness-seams):
 * heavyClientLoader stubs @clerk/react signed-IN (setup:
 * tests/client/ceo-insights-red-pill-guard-setup.mjs) so the real use-auth
 * hook fetches the CEO role through the fetch stub. Every list query the
 * page mounts is stubbed: /api/auth/user, /api/clients, /api/reports,
 * /api/users, /api/all-data-access, /api/all-report-sections.
 */

import { JSDOM } from "jsdom";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/ceo-insights" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).HTMLFormElement = dom.window.HTMLFormElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).FocusEvent = dom.window.FocusEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).DOMRect = dom.window.DOMRect;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CEO_USER = {
  id: "ceo-4465",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
};

const DATA_ACCESS_CATEGORIES = [
  "consult_bookings",
  "sales_conversions",
  "sales_transcripts",
  "no_show_rate",
  "follow_up_touches",
];

// 12 active clients — more than the MOBILE_TOP_N=10 bound so the mobile
// "Show all" toggle renders.
const CLIENT_COUNT = 12;
const CLIENTS = Array.from({ length: CLIENT_COUNT }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    id: `client-4465-${n}`,
    firmName: `Firm ${n} Law`,
    ownerId: null,
    isArchived: false,
    isDemo: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
});

const REFUSED_CLIENT_ID = "client-4465-07";

/**
 * Gap-heavy but refusal-free: every client has every category pending or
 * unknown (no `available`, no `refused`) — the exact shape that used to
 * paint the 77/77 red wall. Under the calm-scan rule ALL pills stay neutral.
 */
function refusalFreeAccess() {
  const rows: Array<{ id: string; clientId: string; category: string; status: string; notes: null }> = [];
  CLIENTS.forEach((client, ci) => {
    DATA_ACCESS_CATEGORIES.forEach((category, di) => {
      rows.push({
        id: `da-${ci}-${di}`,
        clientId: client.id,
        category,
        status: di % 2 === 0 ? "pending" : "unknown",
        notes: null,
      });
    });
  });
  return rows;
}

/** Same fixtures, but ONE client explicitly refused one category. */
function oneRefusalAccess() {
  return refusalFreeAccess().map((row) =>
    row.clientId === REFUSED_CLIENT_ID && row.category === "sales_transcripts"
      ? { ...row, status: "refused" }
      : row,
  );
}

// Mutable per-scenario store the fetch stub reads.
let dataAccessRows = refusalFreeAccess();

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: CEO_USER },
    { path: "/api/clients", json: () => CLIENTS },
    { path: "/api/reports", json: () => [] },
    { path: "/api/users", json: () => [CEO_USER] },
    { path: "/api/all-data-access", json: () => dataAccessRows },
    { path: "/api/all-report-sections", json: () => [] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch shim are installed.
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
const CeoInsights = (await import("../../client/src/pages/CeoInsights")).default;

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function mountPage(): Promise<Root> {
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(CeoInsights as any),
      ),
    );
  });
  await flush();
  return root!;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();
}

/** All gap pills inside the desktop data-gaps table, in DOM (=sorted) order. */
function gapPillsInTable(): HTMLElement[] {
  const table = $("table-data-gaps");
  assert(table !== null, "the desktop data-gaps table (table-data-gaps) must render");
  return Array.from(
    table!.querySelectorAll('[data-testid^="pill-gaps-"]'),
  ) as HTMLElement[];
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_refusalFreeStaysNeutral(): Promise<void> {
  console.log("\n— Scenario 1: gap-heavy, refusal-free → ZERO critical pills —");
  dataAccessRows = refusalFreeAccess();
  const root = await mountPage();
  try {
    const pills = gapPillsInTable();
    assert(
      pills.length === CLIENT_COUNT,
      `expected one gap pill per client (${CLIENT_COUNT}), got ${pills.length}`,
    );
    const criticals = pills.filter((p) => p.getAttribute("data-tone") === "critical");
    assert(
      criticals.length === 0,
      `refusal-free fixtures must render ZERO critical pills (the red-pill wall returned) — got ${criticals.length} of ${pills.length}: ${criticals
        .map((p) => p.getAttribute("data-testid"))
        .join(", ")}`,
    );
    for (const pill of pills) {
      // Stronger than "not critical": a regression repainting the wall in a
      // warning/advisory tone must also fail — gap pills REST NEUTRAL.
      assert(
        pill.getAttribute("data-tone") === "neutral",
        `refusal-free pill must be data-tone="neutral" — got "${pill.getAttribute("data-tone")}" on ${pill.getAttribute("data-testid")}`,
      );
      assert(
        !(pill.textContent || "").toLowerCase().includes("refused"),
        `refusal-free pill must not read "refused" — got "${pill.textContent}" on ${pill.getAttribute("data-testid")}`,
      );
    }
    console.log(`  ✓ all ${pills.length} gap pills neutral despite every category being a gap`);
  } finally {
    await unmount(root);
  }
}

async function scenario2_refusedClientIsTheOnlyRedAndSortsFirst(): Promise<void> {
  console.log("\n— Scenario 2: one refused category → exactly that pill critical, client first —");
  dataAccessRows = oneRefusalAccess();
  const root = await mountPage();
  try {
    const pills = gapPillsInTable();
    assert(pills.length === CLIENT_COUNT, `expected ${CLIENT_COUNT} pills, got ${pills.length}`);
    const criticals = pills.filter((p) => p.getAttribute("data-tone") === "critical");
    assert(
      criticals.length === 1,
      `exactly ONE pill must be critical (the refused client) — got ${criticals.length}`,
    );
    assert(
      criticals[0].getAttribute("data-testid") === `pill-gaps-${REFUSED_CLIENT_ID}`,
      `the critical pill must belong to the refused client — got ${criticals[0].getAttribute("data-testid")}`,
    );
    assert(
      (criticals[0].textContent || "").toLowerCase().includes("refused"),
      `the critical pill's text must include "refused" — got "${criticals[0].textContent}"`,
    );
    // Every OTHER client's pill must still rest neutral (not merely
    // non-critical): one refusal must not repaint the rest of the column.
    for (const pill of pills) {
      if (pill.getAttribute("data-testid") === `pill-gaps-${REFUSED_CLIENT_ID}`) continue;
      assert(
        pill.getAttribute("data-tone") === "neutral",
        `non-refused pill must stay data-tone="neutral" — got "${pill.getAttribute("data-tone")}" on ${pill.getAttribute("data-testid")}`,
      );
    }
    // Refusals lead the chase list: the default sort (gaps desc) must put the
    // refused client's pill first in DOM order.
    assert(
      pills[0].getAttribute("data-testid") === `pill-gaps-${REFUSED_CLIENT_ID}`,
      `the refused client must sort FIRST in the table — first pill was ${pills[0].getAttribute("data-testid")}`,
    );
    console.log("  ✓ exactly one critical pill, labelled refused, sorted first");
  } finally {
    await unmount(root);
  }
}

async function scenario3_mobileListBoundedWithToggle(): Promise<void> {
  console.log("\n— Scenario 3: mobile list caps at 10 rows; Show-all toggle reveals all —");
  dataAccessRows = refusalFreeAccess();
  const root = await mountPage();
  try {
    const list = $("list-data-gaps-mobile");
    assert(list !== null, "the mobile data-gaps list (list-data-gaps-mobile) must render");
    const rowsBefore = list!.querySelectorAll('[data-testid^="row-gap-mobile-"]');
    assert(
      rowsBefore.length <= 10,
      `mobile list must render at most 10 rows before toggling — got ${rowsBefore.length}`,
    );
    const toggle = $("button-toggle-all-gaps-mobile");
    assert(
      toggle !== null,
      "button-toggle-all-gaps-mobile must be present when clients exceed the top-10 bound",
    );
    await act(async () => {
      toggle!.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    const rowsAfter = $("list-data-gaps-mobile")!.querySelectorAll(
      '[data-testid^="row-gap-mobile-"]',
    );
    assert(
      rowsAfter.length === CLIENT_COUNT,
      `after toggling, the mobile list must show all ${CLIENT_COUNT} clients — got ${rowsAfter.length}`,
    );
    console.log(`  ✓ ${rowsBefore.length} rows before toggle, ${rowsAfter.length} after`);
  } finally {
    await unmount(root);
  }
}

async function main(): Promise<void> {
  await scenario1_refusalFreeStaysNeutral();
  await scenario2_refusedClientIsTheOnlyRedAndSortsFirst();
  await scenario3_mobileListBoundedWithToggle();
  console.log("\nceo-insights-red-pill-guard: all DOM cases passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
