/* test-registration
{
  "name": "Rail channel grouping mirrors the Comms page — Favorites/Recent/Clients buckets, pin wiring, clients-collapse persistence (Task #3366)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3366: the mini comms rail must group channels the same way as the main Comms page. Mounts the real CommsRail with the same stub channel fixtures as the #3348 sidebar test and proves the shared groupChannels() three-bucket partitioning (Favorites/Recent/Clients), the pin-toggle wiring (pinnedChannelIds passed through; row moves above Recent), and the comms_rail_clients_group_open collapse persistence. Fast, DB-free, network-stubbed jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/rail-channel-grouping-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3366 — mini comms rail groups channels the same way as the main
 * Comms page.
 *
 * Both the /comms page sidebar and the global CommsRail call the shared
 * groupChannels() from channelGrouping.ts. Task #3348 covered the page
 * sidebar only; this test mounts the REAL CommsRail (client/src/components/
 * comms/CommsRail.tsx) in jsdom with the SAME stub channel fixtures used in
 * tests/client/comms-sidebar-pin-collapse.test.tsx and proves:
 *
 *   (1) Three-bucket partitioning: a DM and a non-client channel land in
 *       Recent (rendered above the Clients group toggle); a stale
 *       client-linked channel lands under the collapsible Clients group
 *       (hidden while collapsed — the rail's default — and rendered BELOW
 *       the Clients toggle once expanded); no Favorites section renders
 *       when nothing is pinned.
 *   (2) Pin-toggle wiring: clicking a row's pin button calls togglePin with
 *       the channel id, and once pinnedChannelIds includes it the row moves
 *       into a rendered "Favorites" section above Recent (title flips to
 *       "Remove from Favorites"), exactly once — proving the rail passes
 *       pinnedChannelIds through to groupChannels. Unpinning moves it back.
 *   (3) The Clients expand/collapse toggle persists to localStorage key
 *       comms_rail_clients_group_open.
 *
 * Heavy leaves (UserStatusPicker, NotificationSettingsPanel) are stubbed and
 * Radix Popover/Dialog/DropdownMenu are shimmed via the shared heavy-client
 * loader; CommsContext is redirected to a stub context the test drives.
 * DB-free; network is a declarative fetch stub (archived channels → []).
 *
 * Run with:
 *   TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx \
 *     --import ./tests/client/rail-channel-grouping-setup.mjs \
 *     tests/client/rail-channel-grouping.test.tsx
 *
 * Registered in tests/run-all.ts.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/dashboard" },
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

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/comms/channels/archived", json: [] },
    { path: "/api/comms/users", json: [] },
  ],
  defaultJson: {},
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
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
// Redirected by the loader to the stub shim — same instance CommsRail.tsx sees.
const { StubCommsContext } = (await import(
  "../../client/src/contexts/CommsContext"
)) as any;
const { CommsRail } = (await import(
  "../../client/src/components/comms/CommsRail"
)) as any;

// ─── Fixtures — SAME shapes as comms-sidebar-pin-collapse.test.tsx ────────────

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const DM_ID = "ch-dm-3366";
const TEAM_ID = "ch-team-3366";
const CLIENT_ID = "ch-client-3366";

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

function TestProvider({ children }: { children: any }) {
  const [pinnedChannelIds, setPinned] = React.useState<string[]>([]);
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
      channels: CHANNELS,
      onlineUserIds: [] as string[],
      totalUnread: 0,
      totalMentions: 0,
      totalThreadUnread: 0,
      totalThreadMentions: 0,
      railOpen: true,
      toggleRail: () => {},
      pinnedChannelIds,
      togglePin,
      // Empty → the rail renders the shared groupChannels() fallback view
      // (Favorites / Recent / Clients), which is the surface under test.
      sidebarCategories: [] as any[],
      openPopup: () => {},
      registerArchivedChannel: () => {},
      refetchChannels: () => {},
      addSseListener: () => () => {},
      myStatus: null,
      draftsByChannelId: new Map<string, unknown>(),
      notificationSettings: null,
      updateNotificationSettings: async () => {},
      userStatuses: new Map<string, unknown>(),
    }),
    [pinnedChannelIds, togglePin],
  );
  return React.createElement(StubCommsContext.Provider, { value }, children);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchInterval: false } },
});

function railElement() {
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(TestProvider, null, React.createElement(CommsRail)),
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
  await act(async () => { root!.render(railElement()); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function sectionHeaders(): string[] {
  return [...document.querySelectorAll("[data-testid='comms-rail'] span")]
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => ["Favorites", "Recent", "Clients"].includes(t));
}
/** DOM index of the first element matching testid within the rail (or -1). */
function railIndexOf(predicate: (el: Element) => boolean): number {
  const rail = $("comms-rail");
  if (!rail) return -1;
  return [...rail.querySelectorAll("*")].findIndex(predicate);
}
function rowIndex(id: string): number {
  return railIndexOf((el) => el.getAttribute("data-testid") === `rail-expanded-channel-${id}`);
}
function clientsToggleIndex(): number {
  return railIndexOf((el) => el.getAttribute("data-testid") === "rail-clients-group-toggle");
}

async function main(): Promise<void> {
  section("1. Grouping — DM + non-client channel in Recent, client channel under Clients");
  await mount();

  assert(!!$("comms-rail"), "rail mounts");
  const headers = sectionHeaders();
  assert(!headers.includes("Favorites"), "no Favorites section renders when nothing is pinned");
  assert(headers.includes("Recent"), "Recent section renders");
  assert(headers.includes("Clients"), "Clients group toggle renders");

  assert(!!$(`rail-expanded-channel-${DM_ID}`), "DM row renders");
  assert(!!$(`rail-expanded-channel-${TEAM_ID}`), "non-client channel row renders");
  assert(
    rowIndex(DM_ID) >= 0 && rowIndex(DM_ID) < clientsToggleIndex(),
    "DM row renders in Recent (above the Clients group)",
  );
  assert(
    rowIndex(TEAM_ID) >= 0 && rowIndex(TEAM_ID) < clientsToggleIndex(),
    "non-client channel renders in Recent (above the Clients group)",
  );
  assert(
    !$(`rail-expanded-channel-${CLIENT_ID}`),
    "stale client-linked channel is hidden while the Clients group is collapsed (rail default)",
  );

  section("2. Clients expand — client row renders under the Clients toggle + persists");
  await act(async () => { $("rail-clients-group-toggle")!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert(!!$(`rail-expanded-channel-${CLIENT_ID}`), "expanding shows the client row");
  assert(
    rowIndex(CLIENT_ID) > clientsToggleIndex(),
    "client row renders BELOW the Clients toggle (inside the Clients group)",
  );
  assert(
    rowIndex(CLIENT_ID) > rowIndex(DM_ID) && rowIndex(CLIENT_ID) > rowIndex(TEAM_ID),
    "client row renders below both Recent rows",
  );
  assert(
    dom.window.localStorage.getItem("comms_rail_clients_group_open") === "true",
    "expand writes comms_rail_clients_group_open = 'true'",
  );

  section("3. Pin toggle — row moves to Favorites, unpin returns it to Recent");
  const pinBtn = $(`rail-pin-${DM_ID}`);
  assert(!!pinBtn, "pin toggle button renders on the DM row");
  assert(
    pinBtn?.getAttribute("title") === "Add to Favorites",
    "unpinned row's toggle is titled 'Add to Favorites'",
  );
  await act(async () => { pinBtn!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  assert(
    togglePinCalls.length === 1 && togglePinCalls[0] === DM_ID,
    `togglePin called exactly once with the DM id (got ${JSON.stringify(togglePinCalls)})`,
  );
  assert(sectionHeaders().includes("Favorites"), "Favorites section appears after pinning");
  assert(
    $(`rail-pin-${DM_ID}`)?.getAttribute("title") === "Remove from Favorites",
    "pinned row's toggle flips to 'Remove from Favorites'",
  );
  assert(
    document.querySelectorAll(`[data-testid="rail-expanded-channel-${DM_ID}"]`).length === 1,
    "the pinned row renders exactly once (moved, not duplicated)",
  );
  {
    const recentIdx = railIndexOf(
      (el) => (el.textContent ?? "").trim() === "Recent" && el.tagName === "SPAN",
    );
    assert(
      rowIndex(DM_ID) >= 0 && recentIdx >= 0 && rowIndex(DM_ID) < recentIdx,
      "pinned DM row renders above the Recent section — rail passes pinnedChannelIds into groupChannels",
    );
  }
  assert(
    rowIndex(TEAM_ID) > 0 && rowIndex(TEAM_ID) < clientsToggleIndex(),
    "non-client channel stays in Recent after the pin",
  );

  await act(async () => { $(`rail-pin-${DM_ID}`)!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert(!sectionHeaders().includes("Favorites"), "unpinning removes the Favorites section again");
  assert(
    $(`rail-pin-${DM_ID}`)?.getAttribute("title") === "Add to Favorites",
    "toggle reverts to 'Add to Favorites' after unpinning",
  );
  assert(
    rowIndex(DM_ID) >= 0 && rowIndex(DM_ID) < clientsToggleIndex(),
    "unpinned DM row lands back in Recent",
  );

  section("4. Collapse persists — fresh remount reads comms_rail_clients_group_open");
  await act(async () => { $("rail-clients-group-toggle")!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert(!$(`rail-expanded-channel-${CLIENT_ID}`), "collapsing hides the client row");
  assert(
    dom.window.localStorage.getItem("comms_rail_clients_group_open") === "false",
    "collapse writes comms_rail_clients_group_open = 'false'",
  );
  dom.window.localStorage.setItem("comms_rail_clients_group_open", "true");
  await mount();
  assert(
    !!$(`rail-expanded-channel-${CLIENT_ID}`),
    "a fresh remount reads the stored key and keeps the Clients group open",
  );

  if (root) await act(async () => { root!.unmount(); });
  queryClient.clear();

  if (failed > 0) {
    console.error(`\nrail-channel-grouping: ${failed} assertion(s) FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nrail-channel-grouping: all ${passed} assertions passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error("rail-channel-grouping: fatal error", err);
  process.exit(1);
});
