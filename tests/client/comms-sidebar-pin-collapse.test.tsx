/* test-registration
{
  "name": "Comms sidebar pin/unpin + Clients collapse persistence (Task #3348)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3348: Comms sidebar pin/unpin + Clients-group collapse persistence. Mounts the real CommsSidebar from pages/Comms.tsx with a stub channel list, proves the pin toggle moves a row into the Pinned section, the Clients collapse writes comms_page_clients_group_open to localStorage and survives a fresh remount (refresh), and that DMs/non-client channels land in Recent, not Clients. Fast, DB-free, network-free jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-sidebar-pin-collapse-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3348 — Comms sidebar pin/unpin + Clients-group collapse persistence.
 *
 * Mounts the REAL CommsSidebar from client/src/pages/Comms.tsx in jsdom with a
 * stub channel list and a lightweight stateful CommsContext shim, and proves:
 *
 *   (1) groupChannels partitioning: a DM and a non-client channel land in
 *       Recent (not inside the Clients section); a stale client-linked channel
 *       lands under the collapsible Clients section; no Pinned section renders
 *       when nothing is pinned.
 *   (2) Clicking a row's pin toggle calls togglePin with the channel id, and
 *       once pinnedChannelIds includes it the row moves into a rendered
 *       "Pinned" section (pin button flips to "Unpin channel"); unpinning
 *       moves it back to Recent.
 *   (3) Collapsing the Clients group hides the client rows AND writes
 *       localStorage key comms_page_clients_group_open = "false"; a fresh
 *       remount (simulated page refresh) reads that key and keeps the group
 *       collapsed; expanding writes "true" and a further remount restores the
 *       open state.
 *
 * Heavy leaves of the Comms.tsx graph (LiveKit, MessagePane, Composer, panels)
 * are stubbed via the shared heavy-client loader; CommsContext is redirected
 * to a stub context the test drives. DB-free, network-free.
 *
 * Run with:
 *   TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx \
 *     --import ./tests/client/comms-sidebar-pin-collapse-setup.mjs \
 *     tests/client/comms-sidebar-pin-collapse.test.tsx
 *
 * Registered in tests/run-all.ts.
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
  throw new Error(`unexpected fetch in sidebar test: ${String(input)}`);
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const DM_ID = "ch-dm-3348";
const TEAM_ID = "ch-team-3348";
const CLIENT_ID = "ch-client-3348";

const CHANNELS = [
  {
    id: DM_ID,
    name: null,
    slug: null,
    type: "dm",
    clientId: null,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageAt: new Date(NOW - 1 * DAY).toISOString(),
    participants: [{ userId: "u-2", firstName: "Dana", lastName: "Dm" }],
  },
  {
    id: TEAM_ID,
    name: "team-general",
    slug: "team-general",
    type: "channel",
    clientId: null,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageAt: new Date(NOW - 2 * DAY).toISOString(),
  },
  {
    // Client-linked and stale (>30 days, no unreads) → Clients bucket.
    id: CLIENT_ID,
    name: "acme-law",
    slug: "acme-law",
    type: "channel",
    clientId: "client-acme",
    unreadCount: 0,
    mentionCount: 0,
    lastMessageAt: new Date(NOW - 45 * DAY).toISOString(),
  },
];

// ─── Stateful test provider driving the stub context ─────────────────────────

const togglePinCalls: string[] = [];
let setPinnedFromOutside: ((ids: string[]) => void) | null = null;

function TestProvider({ children }: { children: any }) {
  const [pinnedChannelIds, setPinned] = React.useState<string[]>([]);
  setPinnedFromOutside = setPinned;
  const togglePin = React.useCallback((channelId: string) => {
    togglePinCalls.push(channelId);
    setPinned((prev: string[]) =>
      prev.includes(channelId)
        ? prev.filter((id) => id !== channelId)
        : [...prev, channelId],
    );
  }, []);
  const value = React.useMemo(
    () => ({
      totalThreadUnread: 0,
      totalThreadMentions: 0,
      pinnedChannelIds,
      togglePin,
      myStatus: null,
    }),
    [pinnedChannelIds, togglePin],
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
        channels: CHANNELS,
        selectedId: null,
        onSelect: () => {},
        onNewChannel: () => {},
        onNewDm: () => {},
        open: false,
        onClose: () => {},
        selectedView: "channel",
        onSelectView: () => {},
      }),
    ),
  );
}

let root: Root | null = null;
async function mount(): Promise<void> {
  const container = document.getElementById("root")!;
  if (root) {
    await act(async () => { root!.unmount(); });
    container.innerHTML = "";
  }
  root = createRoot(container);
  await act(async () => { root!.render(sidebarElement()); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function sectionHeaders(): string[] {
  return [...document.querySelectorAll("[data-testid='comms-sidebar'] span")]
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => ["Pinned", "Recent", "Clients"].includes(t));
}
function inClientsSection(testId: string): boolean {
  const clients = $("sidebar-clients-section");
  return !!clients && !!clients.querySelector(`[data-testid="${testId}"]`);
}

async function main(): Promise<void> {
  section("1. Grouping — DM + non-client channel in Recent, client channel in Clients");
  await mount();

  assert(!!$("comms-sidebar"), "sidebar mounts");
  const headers = sectionHeaders();
  assert(!headers.includes("Pinned"), "no Pinned section renders when nothing is pinned");
  assert(headers.includes("Recent"), "Recent section renders");
  assert(headers.includes("Clients"), "Clients section renders");

  assert(!!$(`channel-item-${DM_ID}`), "DM row renders");
  assert(!inClientsSection(`channel-item-${DM_ID}`), "DM row is NOT inside the Clients section (lands in Recent)");
  assert(!!$(`channel-item-${TEAM_ID}`), "non-client channel row renders");
  assert(!inClientsSection(`channel-item-${TEAM_ID}`), "non-client channel is NOT inside the Clients section");
  assert(inClientsSection(`channel-item-${CLIENT_ID}`), "stale client-linked channel IS inside the Clients section");

  section("2. Pin toggle — row moves to Pinned, unpin returns it to Recent");
  const pinBtn = $(`pin-toggle-${DM_ID}`);
  assert(!!pinBtn, "pin toggle button renders on the DM row");
  assert(pinBtn?.getAttribute("aria-label") === "Pin channel", "unpinned row's toggle is labeled 'Pin channel'");
  await act(async () => { pinBtn!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  assert(
    togglePinCalls.length === 1 && togglePinCalls[0] === DM_ID,
    `togglePin called exactly once with the DM id (got ${JSON.stringify(togglePinCalls)})`,
  );
  assert(sectionHeaders().includes("Pinned"), "Pinned section appears after pinning");
  const pinnedBtn = $(`pin-toggle-${DM_ID}`);
  assert(
    pinnedBtn?.getAttribute("aria-label") === "Unpin channel",
    "pinned row's toggle flips to 'Unpin channel'",
  );
  assert(
    document.querySelectorAll(`[data-testid="channel-item-${DM_ID}"]`).length === 1,
    "the pinned row renders exactly once (moved, not duplicated)",
  );
  // The Pinned header precedes the row; the Recent header must come AFTER the
  // DM row is gone from Recent — verify by DOM order: DM row appears before
  // the "Recent" header span.
  {
    const sidebar = $("comms-sidebar")!;
    const all = [...sidebar.querySelectorAll("*")];
    const rowIdx = all.findIndex((el) => el.getAttribute("data-testid") === `channel-item-${DM_ID}`);
    const recentIdx = all.findIndex((el) => (el.textContent ?? "").trim() === "Recent" && el.tagName === "SPAN");
    assert(rowIdx >= 0 && recentIdx >= 0 && rowIdx < recentIdx, "pinned DM row renders above the Recent section");
  }

  await act(async () => { $(`pin-toggle-${DM_ID}`)!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert(!sectionHeaders().includes("Pinned"), "unpinning removes the Pinned section again");
  assert(
    $(`pin-toggle-${DM_ID}`)?.getAttribute("aria-label") === "Pin channel",
    "toggle reverts to 'Pin channel' after unpinning",
  );

  section("3. Clients collapse — localStorage write + survives remount (refresh)");
  assert(inClientsSection(`channel-item-${CLIENT_ID}`), "Clients group starts open (client row visible)");
  assert(
    dom.window.localStorage.getItem("comms_page_clients_group_open") === null,
    "no clientsOpen key written before any toggle",
  );

  await act(async () => { $("sidebar-clients-toggle")!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert(!$(`channel-item-${CLIENT_ID}`), "collapsing hides the client rows");
  assert(
    dom.window.localStorage.getItem("comms_page_clients_group_open") === "false",
    "collapse writes comms_page_clients_group_open = 'false'",
  );

  // Simulated page refresh: fresh mount, same localStorage.
  await mount();
  assert(!!$("sidebar-clients-toggle"), "Clients toggle still renders after remount");
  assert(!$(`channel-item-${CLIENT_ID}`), "Clients group stays collapsed after a fresh remount (refresh)");

  await act(async () => { $("sidebar-clients-toggle")!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert(!!$(`channel-item-${CLIENT_ID}`), "expanding shows the client rows again");
  assert(
    dom.window.localStorage.getItem("comms_page_clients_group_open") === "true",
    "expand writes comms_page_clients_group_open = 'true'",
  );

  await mount();
  assert(inClientsSection(`channel-item-${CLIENT_ID}`), "Clients group stays open after another remount");

  if (root) await act(async () => { root!.unmount(); });

  if (failed > 0) {
    console.error(`\ncomms-sidebar-pin-collapse: ${failed} assertion(s) FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\ncomms-sidebar-pin-collapse: all ${passed} assertions passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error("comms-sidebar-pin-collapse: fatal error", err);
  process.exit(1);
});
