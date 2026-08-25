/* test-registration
{
  "name": "GlobalAppNav — Sheets & Ads OS render under More → Internal Tools, not inline/System Tools; active highlighting at /sheets and /ads-os (Tasks #3089/#3603)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3089: GlobalAppNav placement guard — Sheets must NOT be in the inline primary nav, and both Sheets and Ads OS must sit under More → Internal Tools (not System Tools), with active-page highlighting intact at /sheets and /ads-os. A manifest regression (cluster flip or PRIMARY_INLINE_IDS re-add) would silently move them back; this rendered jsdom test is the only assertion of their placement. Fast, DB-free, network-free (fetch stubbed).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/global-nav-sheets-adsos-placement-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3089 — GlobalAppNav placement guard for Sheets and Ads OS,
 * retargeted to the Task #4763 function-based regrouping.
 *
 * Task #3089 moved Sheets out of the inline bar into the More dropdown;
 * Task #4763 then regrouped every tool menu into five function-based
 * sections (CRM / Client Management / Workspace / Team / System Admin)
 * driven by the ordered QUICKLINK_TOOL_GROUPS list. Nothing else asserts
 * where these items render, so a manifest regression (e.g. someone flips a
 * `cluster` value, or adds "sheets" back to PRIMARY_INLINE_IDS) would
 * silently put them back in the wrong place.
 *
 * Mounts the REAL `GlobalAppNav` (client/src/components/QuicklinksBar.tsx)
 * in jsdom as a CEO user (Ads OS is CEO-gated) and asserts:
 *   1. "Sheets" does NOT appear in the inline primary nav
 *      (`nav[aria-label="Primary"]`).
 *   2. The desktop "More" dropdown renders the five group labels in
 *      QUICKLINK_TOOL_GROUPS order, the retired catch-all labels (Work /
 *      Internal Tools / System Tools) are gone, and `menu-sheets` sits
 *      AFTER the "Workspace" label and BEFORE the "Team" label.
 *   3. `menu-ads-os-v2` sits under Client Management (not System Admin);
 *      Scoring sits under CRM and Unmatched under System Admin — the
 *      deliberate Task #4763 placement calls.
 *   4. Active-page highlighting works in the new locations: at /sheets the
 *      `menu-sheets` item carries data-active + aria-current="page"; at
 *      /ads-os the same holds for `menu-ads-os-v2` — the rebuilt Ads OS entry (Task #3603) — (and Sheets is NOT
 *      active).
 *
 * Radix DropdownMenu portals never mount in this raw jsdom harness, so the
 * setup file shims `@radix-ui/react-dropdown-menu` to inline pass-throughs
 * (see tests/dropdown-menu-shim.mjs) — menu content renders inline with all
 * props/order preserved, which is exactly what these ordering assertions
 * need. NotificationBell / FeedbackButton are stubbed.
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
// wouter's browser-location hook reads the global `location`/`history` and
// subscribes via the global `addEventListener`/`removeEventListener`.
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
// wouter's history patch dispatches a bare global `dispatchEvent(...)` on
// pushState/replaceState.
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).PopStateEvent = dom.window.PopStateEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
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

// CEO user so the CEO-gated Ads OS entry is visible.
const CEO_USER = {
  id: "ceo-3089",
  email: "ceo@example.com",
  firstName: "Cee",
  lastName: "Oh",
  role: "ceo",
  authorityLevel: "ceo",
  functions: [],
};

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [{ path: "/api/auth/user", json: CEO_USER }],
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
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("../../client/src/lib/queryClient");
// QuicklinksBar's ThemeMenuSub calls useTheme(), which throws outside a live
// <ThemeProvider> (added upstream 2026-08; this raw-jsdom harness predates
// it). ThemeProvider itself needs the QueryClientProvider below plus the
// setup file's Clerk stub + this suite's /api/auth/user fetch fixture.
const { ThemeProvider } = await import("../../client/src/lib/theme");
const { GlobalAppNav } = await import("../../client/src/components/QuicklinksBar");

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountNavAt(pathname: string): Promise<Root> {
  dom.window.history.replaceState(null, "", pathname);
  const container = document.getElementById("root")!;
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient } as any,
        React.createElement(
          ThemeProvider as any,
          null,
          React.createElement(GlobalAppNav as any),
        ),
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
}

/**
 * Locates the desktop "More" dropdown content: the shimmed
 * DropdownMenuContent renders inline inside the same wrapper div as the
 * `button-more-menu` trigger.
 */
function moreMenuContent(): HTMLElement {
  const trigger = document.querySelector('[data-testid="button-more-menu"]');
  assert(trigger, "desktop More trigger (button-more-menu) must render");
  const wrapper = (trigger as HTMLElement).closest("div")!;
  return wrapper;
}

function findLabel(scope: HTMLElement, text: string): HTMLElement {
  const labels = Array.from(scope.querySelectorAll("div, span")).filter(
    (el) => (el.textContent || "").trim() === text && el.children.length === 0,
  ) as HTMLElement[];
  assert(labels.length > 0, `section label "${text}" must render in the More dropdown`);
  return labels[0];
}

function labelExists(scope: HTMLElement, text: string): boolean {
  return Array.from(scope.querySelectorAll("div, span")).some(
    (el) => (el.textContent || "").trim() === text && el.children.length === 0,
  );
}

function inOrder(a: Element, b: Element): boolean {
  // a precedes b in document order
  return !!(a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
}

async function main(): Promise<void> {
  console.log("GlobalAppNav — Sheets & Ads OS placement in the regrouped More menu (Tasks #3089/#4763)");

  // ── Case 1: neutral page — placement assertions ────────────────────────
  let root = await mountNavAt("/");
  try {
    // 1. Sheets must NOT be in the inline primary nav.
    const primaryNav = document.querySelector('nav[aria-label="Primary"]') as HTMLElement;
    assert(primaryNav, "inline primary nav must render");
    assert(
      !primaryNav.querySelector('[data-testid="button-sheets"]'),
      "Sheets must NOT render as an inline primary nav link",
    );
    assert(
      !/\bSheets\b/.test(primaryNav.textContent || ""),
      `inline primary nav must not contain the text "Sheets" — got "${primaryNav.textContent}"`,
    );
    console.log("  ✓ Sheets absent from the inline primary nav");

    // Task #4675 — inline set trimmed to Dashboard + All Reports + Comms so
    // the CEO nav fits 1280–1408px viewports. Client Admin and Insights must
    // NOT render inline; they fold into More → Client Management (Task #4763).
    assert(
      primaryNav.querySelector('[data-testid="button-all-reports"]'),
      "All Reports must remain an inline primary nav link",
    );
    assert(
      primaryNav.querySelector('[data-testid="button-comms"]'),
      "Comms must remain an inline primary nav link",
    );
    assert(
      !primaryNav.querySelector('[data-testid="button-manage-clients"]'),
      "Client Admin must NOT render inline (folded into More, Task #4675)",
    );
    assert(
      !primaryNav.querySelector('[data-testid="button-ceo-insights"]'),
      "Insights must NOT render inline (folded into More, Task #4675)",
    );
    console.log("  ✓ Inline primary nav trimmed to All Reports + Comms (Task #4675)");

    // 2/3. The More dropdown renders the five function-based groups (Task
    // #4763) in QUICKLINK_TOOL_GROUPS order, the retired catch-all labels
    // are gone, and Sheets/Ads OS sit under Workspace/Client Management.
    const more = moreMenuContent();
    const crmLabel = findLabel(more, "CRM");
    const clientMgmtLabel = findLabel(more, "Client Management");
    const workspaceLabel = findLabel(more, "Workspace");
    const teamLabel = findLabel(more, "Team");
    const systemAdminLabel = findLabel(more, "System Admin");
    assert(
      inOrder(crmLabel, clientMgmtLabel) &&
        inOrder(clientMgmtLabel, workspaceLabel) &&
        inOrder(workspaceLabel, teamLabel) &&
        inOrder(teamLabel, systemAdminLabel),
      "More dropdown labels must run CRM → Client Management → Workspace → Team → System Admin",
    );
    for (const retired of ["Work", "Internal Tools", "System Tools"]) {
      assert(
        !labelExists(more, retired),
        `retired catch-all label "${retired}" must NOT render in the More dropdown (Task #4763)`,
      );
    }
    console.log("  ✓ More dropdown shows the five function-based groups in order (Task #4763)");

    // Task #4675 — the two demoted primary links live under More → Client
    // Management (their Task #4763 group, before the Workspace label).
    for (const [id, label] of [
      ["menu-manage-clients", "Client Admin"],
      ["menu-ceo-insights", "Insights"],
    ] as const) {
      const el = more.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      assert(el, `${label} (${id}) must render inside the More dropdown (Task #4675)`);
      assert(
        inOrder(clientMgmtLabel, el) && inOrder(el, workspaceLabel),
        `${label} must appear under More → Client Management (after its label, before Workspace)`,
      );
      assert(
        more.querySelectorAll(`[data-testid="${id}"]`).length === 1,
        `${id} must appear exactly once in the More dropdown`,
      );
    }
    console.log("  ✓ Client Admin + Insights render under More → Client Management (Tasks #4675/#4763)");

    // Deliberate Task #4763 placement calls: deal-pipeline config lives
    // under CRM (not System Admin), and Unmatched stays under System Admin.
    const menuScoring = more.querySelector('[data-testid="menu-scoring"]') as HTMLElement;
    assert(menuScoring, "menu-scoring must render inside the More dropdown");
    assert(
      inOrder(crmLabel, menuScoring) && inOrder(menuScoring, clientMgmtLabel),
      "Scoring (pipeline config) must appear under CRM — not System Admin (Task #4763 placement call)",
    );
    const menuUnmatched = more.querySelector('[data-testid="menu-unmatched"]') as HTMLElement;
    assert(menuUnmatched, "menu-unmatched must render inside the More dropdown");
    assert(
      inOrder(systemAdminLabel, menuUnmatched),
      "Unmatched (admin triage queue) must appear under System Admin (Task #4763 placement call)",
    );
    console.log("  ✓ Scoring under CRM, Unmatched under System Admin (Task #4763 placement calls)");

    const menuSheets = more.querySelector('[data-testid="menu-sheets"]') as HTMLElement;
    assert(menuSheets, "menu-sheets must render inside the More dropdown");
    assert(
      inOrder(workspaceLabel, menuSheets) && inOrder(menuSheets, teamLabel),
      "Sheets must appear under Workspace (after its label, before Team)",
    );
    assert(
      (menuSheets.getAttribute("href") || "") === "/sheets",
      `menu-sheets must link to /sheets — got "${menuSheets.getAttribute("href")}"`,
    );
    console.log("  ✓ Sheets renders under More → Workspace");

    const menuAdsOs = more.querySelector('[data-testid="menu-ads-os-v2"]') as HTMLElement;
    assert(menuAdsOs, "menu-ads-os-v2 must render inside the More dropdown (CEO user)");
    assert(
      inOrder(clientMgmtLabel, menuAdsOs) && inOrder(menuAdsOs, workspaceLabel),
      "Ads OS must appear under Client Management (after its label, before Workspace) — NOT under System Admin",
    );
    assert(
      (menuAdsOs.getAttribute("href") || "") === "/ads-os",
      `menu-ads-os-v2 must link to /ads-os — got "${menuAdsOs.getAttribute("href")}"`,
    );
    console.log("  ✓ Ads OS renders under More → Client Management");

    // Guard against accidental duplicate placement across sections within the
    // desktop More dropdown. (The mobile menu legitimately renders its own
    // copy elsewhere in the document, so scope to `more`.)
    assert(
      more.querySelectorAll('[data-testid="menu-ads-os-v2"]').length === 1,
      "menu-ads-os-v2 must appear exactly once in the More dropdown",
    );
    assert(
      more.querySelectorAll('[data-testid="menu-sheets"]').length === 1,
      "menu-sheets must appear exactly once in the More dropdown",
    );
    console.log("  ✓ Sheets and Ads OS each appear exactly once in the More dropdown");

    // Neither is active on "/".
    assert(
      menuSheets.getAttribute("data-active") !== "true",
      "menu-sheets must not be active on /",
    );
    assert(
      menuAdsOs.getAttribute("data-active") !== "true",
      "menu-ads-os-v2 must not be active on /",
    );
  } finally {
    await unmount(root);
  }

  // ── Case 2: /sheets → Sheets item highlighted in its new home ──────────
  root = await mountNavAt("/sheets");
  try {
    const more = moreMenuContent();
    const menuSheets = more.querySelector('[data-testid="menu-sheets"]') as HTMLElement;
    assert(menuSheets, "menu-sheets must render at /sheets");
    assert(
      menuSheets.getAttribute("data-active") === "true",
      "menu-sheets must carry data-active=true at /sheets",
    );
    assert(
      menuSheets.getAttribute("aria-current") === "page",
      "menu-sheets must carry aria-current=page at /sheets",
    );
    const menuAdsOs = more.querySelector('[data-testid="menu-ads-os-v2"]') as HTMLElement;
    assert(
      menuAdsOs.getAttribute("data-active") !== "true",
      "menu-ads-os-v2 must NOT be active at /sheets",
    );
    console.log("  ✓ /sheets highlights the Sheets item in the More dropdown");
  } finally {
    await unmount(root);
  }

  // ── Case 3: /ads-os → Ads OS item highlighted ────────────────────
  root = await mountNavAt("/ads-os");
  try {
    const more = moreMenuContent();
    const menuAdsOs = more.querySelector('[data-testid="menu-ads-os-v2"]') as HTMLElement;
    assert(menuAdsOs, "menu-ads-os-v2 must render at /ads-os");
    assert(
      menuAdsOs.getAttribute("data-active") === "true",
      "menu-ads-os-v2 must carry data-active=true at /ads-os",
    );
    assert(
      menuAdsOs.getAttribute("aria-current") === "page",
      "menu-ads-os-v2 must carry aria-current=page at /ads-os",
    );
    const menuSheets = more.querySelector('[data-testid="menu-sheets"]') as HTMLElement;
    assert(
      menuSheets.getAttribute("data-active") !== "true",
      "menu-sheets must NOT be active at /ads-os",
    );
    console.log("  ✓ /ads-os highlights the Ads OS item in the More dropdown");
  } finally {
    await unmount(root);
    queryClient.clear();
  }

  console.log("\nAll GlobalAppNav Sheets/Ads OS placement assertions passed.");
}

await main();
process.exit(0);
