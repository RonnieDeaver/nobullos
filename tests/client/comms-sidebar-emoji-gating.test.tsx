/* test-registration
{
  "name": "Custom Emoji sidebar nav item role gating (Task #3314)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3314: the Custom Emoji admin entry point is role-gated in the Comms sidebar (team_lead/ceo only). Mounts the real CommsSidebar with a role-switchable useAuth stub and pins: nav-emoji renders for team_lead (and selects the emoji view on click) and ceo, does NOT render for a regular role or when no user is loaded (fails closed), while ungated nav items stay visible. Fast, DB-free, network-free jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-sidebar-emoji-gating-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3314 — Custom Emoji admin entry point role gating.
 *
 * Mounts the REAL CommsSidebar from client/src/pages/Comms.tsx in jsdom with
 * a role-switchable useAuth stub and proves the "Custom Emoji" nav item
 * (nav-emoji) is role-gated:
 *
 *   (1) team_lead → item renders and clicking it calls onSelectView("emoji")
 *   (2) ceo → item renders
 *   (3) reporting (regular internal role) → item does NOT render, while the
 *       ungated nav items (Search/Threads/Drafts/Scheduled) still do
 *   (4) no user loaded yet (user=null) → item does NOT render (fails closed)
 *
 * Heavy leaves of the Comms.tsx graph are stubbed via the shared heavy-client
 * loader; CommsContext is redirected to the shared stub shim; useAuth reads
 * globalThis.__TEST_AUTH_ROLE per render. DB-free, network-free.
 *
 * Run with:
 *   TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx \
 *     --import ./tests/client/comms-sidebar-emoji-gating-setup.mjs \
 *     tests/client/comms-sidebar-emoji-gating.test.tsx
 *
 * Registered in tests/run-all.ts (SMOKE_FILES).
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/comms" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).history = dom.window.history;
(globalThis as any).location = dom.window.location;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }));
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
class ResizeObserverStub {
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// No network expected; fail loudly if anything fetches.
globalThis.fetch = (async (input: any) => {
  throw new Error(`unexpected fetch in emoji gating test: ${String(input)}`);
}) as any;

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function section(title: string): void {
  console.log(`\n— ${title} —`);
}
function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = ReturnType<typeof createRoot>;
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
// Redirected by the loader to the stub shim — same instance Comms.tsx sees.
const { StubCommsContext } = (await import(
  "../../client/src/contexts/CommsContext"
)) as any;
const { CommsSidebar } = (await import("../../client/src/pages/Comms")) as any;

const selectViewCalls: string[] = [];

function TestProvider({ children }: { children: any }) {
  const value = React.useMemo(
    () => ({
      totalThreadUnread: 0,
      totalThreadMentions: 0,
      pinnedChannelIds: [] as string[],
      togglePin: () => {},
      myStatus: null,
    }),
    [],
  );
  return React.createElement(StubCommsContext.Provider, { value }, children);
}

function sidebarElement() {
  return React.createElement(
    TooltipProvider,
    null,
    React.createElement(
      TestProvider,
      null,
      React.createElement(CommsSidebar, {
        channels: [],
        selectedId: null,
        onSelect: () => {},
        onNewChannel: () => {},
        onNewDm: () => {},
        open: false,
        onClose: () => {},
        selectedView: "channel",
        onSelectView: (view: string) => { selectViewCalls.push(view); },
      }),
    ),
  );
}

let root: Root | null = null;
async function mountAs(role: string | undefined): Promise<void> {
  (globalThis as any).__TEST_AUTH_ROLE = role;
  const container = document.getElementById("root")!;
  if (root) {
    await act(async () => { root!.unmount(); });
    container.innerHTML = "";
  }
  root = createRoot(container);
  await act(async () => { root!.render(sidebarElement()); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function main(): Promise<void> {
  section("1. team_lead sees the Custom Emoji nav item and it selects the emoji view");
  await mountAs("team_lead");
  assert(!!$("comms-sidebar"), "sidebar mounts for team_lead");
  const emojiNav = $("nav-emoji");
  assert(!!emojiNav, "nav-emoji renders for team_lead");
  assert(
    (emojiNav?.textContent ?? "").includes("Custom Emoji"),
    "nav item is labeled 'Custom Emoji'",
  );
  await act(async () => { emojiNav!.click(); });
  assert(
    selectViewCalls.length === 1 && selectViewCalls[0] === "emoji",
    `clicking it calls onSelectView("emoji") exactly once (got ${JSON.stringify(selectViewCalls)})`,
  );

  section("2. ceo sees the Custom Emoji nav item");
  await mountAs("ceo");
  assert(!!$("nav-emoji"), "nav-emoji renders for ceo");

  section("3. regular role does NOT see the Custom Emoji nav item");
  await mountAs("reporting");
  assert(!!$("comms-sidebar"), "sidebar mounts for reporting role");
  assert(!$("nav-emoji"), "nav-emoji does NOT render for reporting role");
  assert(!!$("nav-search"), "ungated nav-search still renders");
  assert(!!$("nav-threads"), "ungated nav-threads still renders");
  assert(!!$("nav-drafts"), "ungated nav-drafts still renders");
  assert(!!$("nav-scheduled"), "ungated nav-scheduled still renders");

  section("4. no user loaded (user=null) fails closed");
  await mountAs(undefined);
  assert(!!$("comms-sidebar"), "sidebar mounts with no user");
  assert(!$("nav-emoji"), "nav-emoji does NOT render when user is null");

  if (root) await act(async () => { root!.unmount(); });

  if (failed > 0) {
    console.error(`\ncomms-sidebar-emoji-gating: ${failed} assertion(s) FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\ncomms-sidebar-emoji-gating: all ${passed} assertions passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error("comms-sidebar-emoji-gating: fatal error", err);
  process.exit(1);
});
