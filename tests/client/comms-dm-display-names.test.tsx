/* test-registration
{
  "name": "Comms channel switcher shows real DM names (Task #3357)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3357: the channel switcher must show REAL names for DMs on screen. Mounts the real CommsSidebar (pages/Comms.tsx → SidebarChannelRow → channelDisplayName) with dm/group_dm rows carrying dmParticipantNames and asserts the RENDERED text: the DM row shows the other participant's full name, the group-DM row shows comma-joined first names, and the honest fallbacks (\"Direct Message\" when no names; explicit name wins) hold. Fast, DB-free, network-free jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-dm-display-names-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3357 — the channel switcher must show REAL names for DMs on screen.
 *
 * Task #3344 locked in the API contract (every channels endpoint returns
 * dmParticipantNames for dm/group_dm rows), but the visible label is produced
 * by the frontend: channelDisplayName in components/comms/helpers.tsx,
 * rendered by the sidebar rows. Until now only a static source scan guarded
 * that path — a rendering refactor could show "Direct Message" on screen
 * while the API stayed correct.
 *
 * This test mounts the REAL CommsSidebar (the /comms channel switcher from
 * client/src/pages/Comms.tsx — SidebarChannelRow → channelDisplayName) with
 * a stub channel list and proves the RENDERED text:
 *
 *   (1) a dm carrying dmParticipantNames shows the other participant's real
 *       full name — not "Direct Message";
 *   (2) a group_dm carrying dmParticipantNames shows the comma-joined FIRST
 *       names of the other participants — not "Group DM";
 *   (3) fallbacks stay honest: a dm with NO dmParticipantNames still renders
 *       "Direct Message" (no invented name), and an explicitly named
 *       group_dm prefers its name over the participant list.
 *
 * Harness follows tests/client/comms-sidebar-pin-collapse.test.tsx: heavy
 * leaves of the Comms.tsx graph stubbed via the shared heavy-client loader,
 * CommsContext redirected to the stub shim. DB-free, network-free.
 *
 * Run with:
 *   TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx \
 *     --import ./tests/client/comms-dm-display-names-setup.mjs \
 *     tests/client/comms-dm-display-names.test.tsx
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
  throw new Error(`unexpected fetch in dm-display-names test: ${String(input)}`);
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
function rowText(channelId: string): string {
  const row = $(`channel-item-${channelId}`);
  return (row?.textContent ?? "").trim();
}

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
// Redirected by the loader to the stub shim — same instance Comms.tsx sees.
const { StubCommsContext } = (await import(
  "../../client/src/contexts/CommsContext"
)) as any;
const { CommsSidebar } = (await import("../../client/src/pages/Comms")) as any;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const DM_ID = "ch-dm-3357";
const GROUP_ID = "ch-gdm-3357";
const DM_NO_NAMES_ID = "ch-dm-no-names-3357";
const NAMED_GROUP_ID = "ch-gdm-named-3357";

const base = {
  clientId: null,
  unreadCount: 0,
  mentionCount: 0,
};

const CHANNELS = [
  {
    ...base,
    id: DM_ID,
    name: null,
    slug: null,
    type: "dm",
    lastMessageAt: new Date(NOW - 1 * DAY).toISOString(),
    dmParticipantNames: ["Dana Delacroix"],
  },
  {
    ...base,
    id: GROUP_ID,
    name: null,
    slug: null,
    type: "group_dm",
    lastMessageAt: new Date(NOW - 2 * DAY).toISOString(),
    dmParticipantNames: ["Alice Anderson", "Bob Brubaker", "Carol Chen"],
  },
  {
    // API-contract regression path: no names supplied → generic fallback,
    // never an invented name.
    ...base,
    id: DM_NO_NAMES_ID,
    name: null,
    slug: null,
    type: "dm",
    lastMessageAt: new Date(NOW - 3 * DAY).toISOString(),
    dmParticipantNames: null,
  },
  {
    // Explicitly named group DM prefers its name over the participant list.
    ...base,
    id: NAMED_GROUP_ID,
    name: "launch-war-room",
    slug: null,
    type: "group_dm",
    lastMessageAt: new Date(NOW - 4 * DAY).toISOString(),
    dmParticipantNames: ["Alice Anderson", "Bob Brubaker"],
  },
];

// ─── Minimal stub context provider ────────────────────────────────────────────

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

const root = createRoot(document.getElementById("root")!);
await act(async () => {
  root.render(
    React.createElement(
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
    ),
  );
});
await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// ─── Assertions ───────────────────────────────────────────────────────────────

section("1. DM row shows the other participant's real name");
assert(!!$("comms-sidebar"), "sidebar mounts");
assert(!!$(`channel-item-${DM_ID}`), "DM row renders");
const dmText = rowText(DM_ID);
assert(
  dmText.includes("Dana Delacroix"),
  `DM row shows the real full name "Dana Delacroix" (got "${dmText}")`,
);
assert(
  !dmText.includes("Direct Message"),
  "DM row does NOT show the generic 'Direct Message' label",
);

section("2. Group DM row shows comma-joined first names");
assert(!!$(`channel-item-${GROUP_ID}`), "group-DM row renders");
const groupText = rowText(GROUP_ID);
assert(
  groupText.includes("Alice, Bob, Carol"),
  `group-DM row shows comma-joined FIRST names "Alice, Bob, Carol" (got "${groupText}")`,
);
assert(
  !groupText.includes("Anderson") && !groupText.includes("Brubaker") && !groupText.includes("Chen"),
  "group-DM label uses first names only (no last names)",
);
assert(
  !groupText.includes("Group DM"),
  "group-DM row does NOT show the generic 'Group DM' label",
);

section("3. Honest fallbacks");
const noNamesText = rowText(DM_NO_NAMES_ID);
assert(
  noNamesText.includes("Direct Message"),
  `DM with no dmParticipantNames still renders the explicit "Direct Message" fallback (got "${noNamesText}")`,
);
const namedGroupText = rowText(NAMED_GROUP_ID);
assert(
  namedGroupText.includes("launch-war-room"),
  `explicitly named group DM prefers its name (got "${namedGroupText}")`,
);
assert(
  !namedGroupText.includes("Alice"),
  "explicitly named group DM does not fall through to participant names",
);

await act(async () => { root.unmount(); });

if (failed > 0) {
  console.error(`\ncomms-dm-display-names: ${failed} assertion(s) FAILED (${passed} passed)`);
  process.exit(1);
}
console.log(`\ncomms-dm-display-names: all ${passed} assertions passed`);
process.exit(0);
