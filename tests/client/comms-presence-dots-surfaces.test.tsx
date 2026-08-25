/* test-registration
{
  "name": "Comms presence dots — sidebar footer StatusDot, message-list avatar dots, New-DM dialog row dots, offline/unknown fallbacks (Task #3362)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3362: the remaining presence surfaces — the sidebar footer StatusDot (CommsSidebarStatusFooter), the message-list avatar dots (real MessagePane → MessageItem → Avatar status prop), and the New-DM dialog member-row Circle dots — had no rendered coverage. Mounts the REAL Comms page with MessagePane + UserStatusPicker real (deep leaves stubbed) and asserts per-status colors, custom-status lines, the unknown-user offline fallback in the dialog rows, and that an author missing from userStatuses renders no avatar dot (never a wrong color). DB-free, stubbed fetch/EventSource.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-presence-dots-surfaces-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3362 — presence dots on the remaining surfaces can't silently break.
 *
 * Task #3343 covered the /comms channel-header + popup title-bar dots (with
 * MessagePane and UserStatusPicker stubbed). The sidebar footer StatusDot,
 * the message-list avatar dots, and the New-DM dialog member rows still had
 * zero rendered coverage — a refactor of CommsSidebarStatusFooter, StatusDot,
 * MessageItem/Avatar, or NewDmDialog could drop them without any test
 * failing. This test mounts the REAL Comms page (real MessagePane,
 * MessageItem, UserStatusPicker/StatusDot; only deep leaves stubbed via
 * comms-presence-dots-surfaces-setup.mjs) and proves:
 *
 *   (A) sidebar footer: the my-status StatusDot renders inside the
 *       comms-page-status-picker-trigger with the STATUS_DOT_CLASSES color
 *       for my effective status (online → bg-green-500);
 *   (B) DM message list: each rendered message's Avatar carries the author's
 *       status dot (avatar-status-online → bg-green-500) and the author
 *       custom-status line renders next to the name;
 *   (C) New-DM dialog rows: one Circle dot per teammate with per-status text
 *       colors — online → text-green-500, away → text-yellow-500,
 *       dnd → text-red-500, unknown user → text-muted-foreground/30 — plus
 *       the row's custom-status line;
 *   (D) group-DM message list (remounted at ?channel=<groupId>): away →
 *       avatar-status-away bg-yellow-400, dnd → avatar-status-dnd bg-red-500,
 *       offline → avatar-status-offline bg-muted-foreground/40, and an author
 *       missing from the statuses map renders no avatar dot (current
 *       documented Avatar behavior: no status → dot hidden, never a wrong
 *       color).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const DM_ID = "dm-presence-3362";
const GROUP_ID = "gdm-presence-3362";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: `http://localhost/comms?channel=${DM_ID}` },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
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
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).history = dom.window.history;
(globalThis as any).location = dom.window.location;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).CustomEvent = dom.window.CustomEvent;
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

// CommsProviderInner opens the shared SSE connection on mount — stub it.
class EventSourceStub {
  url: string;
  constructor(url: string) { this.url = url; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as any).EventSource = EventSourceStub;
(dom.window as any).EventSource = EventSourceStub;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME = "user-1";
const OTHER_ONLINE = "user-2";  // online + custom status
const OTHER_AWAY = "user-3";    // away
const OTHER_DND = "user-4";     // dnd
const OTHER_OFFLINE = "user-5"; // explicit offline entry
const OTHER_UNKNOWN = "user-6"; // absent from the statuses map

const USER = {
  id: ME,
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

const now = new Date().toISOString();
const baseChannel = {
  name: null,
  slug: null,
  visibility: "private",
  topic: null,
  description: null,
  clientId: null,
  createdBy: ME,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
  unreadCount: 0,
  activeCall: null,
};

const DM_CHANNEL = {
  ...baseChannel,
  id: DM_ID,
  type: "dm",
  members: [
    { channelId: DM_ID, userId: ME, role: "member" },
    { channelId: DM_ID, userId: OTHER_ONLINE, role: "member" },
  ],
};

const GROUP_CHANNEL = {
  ...baseChannel,
  id: GROUP_ID,
  type: "group_dm",
  members: [
    { channelId: GROUP_ID, userId: ME, role: "member" },
    { channelId: GROUP_ID, userId: OTHER_AWAY, role: "member" },
    { channelId: GROUP_ID, userId: OTHER_DND, role: "member" },
    { channelId: GROUP_ID, userId: OTHER_OFFLINE, role: "member" },
    { channelId: GROUP_ID, userId: OTHER_UNKNOWN, role: "member" },
  ],
};

function statusEntry(
  userId: string,
  effectiveStatus: string,
  customEmoji: string | null = null,
  customText: string | null = null,
) {
  return {
    userId,
    effectiveStatus,
    manualStatus: effectiveStatus,
    dndExpiresAt: null,
    priorStatus: null,
    customEmoji,
    customText,
    customExpiresAt: null,
    recentCustomStatuses: [],
  };
}

// OTHER_UNKNOWN is deliberately missing.
const BULK_STATUSES = [
  statusEntry(OTHER_ONLINE, "online", "🎯", "Heads down"),
  statusEntry(OTHER_AWAY, "away"),
  statusEntry(OTHER_DND, "dnd"),
  statusEntry(OTHER_OFFLINE, "offline"),
];

function teamMember(id: string, first: string) {
  return {
    id,
    firstName: first,
    lastName: "Member",
    email: `${first.toLowerCase()}@nobull.test`,
    profileImageUrl: null,
  };
}

const TEAM_MEMBERS = [
  teamMember(ME, "Me"),
  teamMember(OTHER_ONLINE, "Online"),
  teamMember(OTHER_AWAY, "Away"),
  teamMember(OTHER_DND, "Dnd"),
  teamMember(OTHER_UNKNOWN, "Unknown"),
];

function message(id: string, channelId: string, userId: string, content: string) {
  return {
    id,
    channelId,
    userId,
    parentId: null,
    content,
    contentType: "text",
    editedAt: null,
    deletedAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    user: {
      id: userId,
      firstName: `First-${userId}`,
      lastName: `Last-${userId}`,
      profileImageUrl: null,
    },
    reactionCounts: {},
    replyCount: 0,
    attachments: [],
  };
}

const DM_MESSAGES = [message("m1", DM_ID, OTHER_ONLINE, "hello from online")];
const GROUP_MESSAGES = [
  message("g1", GROUP_ID, OTHER_AWAY, "away message"),
  message("g2", GROUP_ID, OTHER_DND, "dnd message"),
  message("g3", GROUP_ID, OTHER_OFFLINE, "offline message"),
  message("g4", GROUP_ID, OTHER_UNKNOWN, "unknown-status message"),
];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: /\/api\/comms\/channels$/, json: [DM_CHANNEL, GROUP_CHANNEL] },
    { method: "GET", path: /\/api\/comms\/channels\/public$/, json: [] },
    { method: "GET", path: /\/api\/comms\/status\/bulk/, json: BULK_STATUSES },
    { method: "GET", path: /\/api\/comms\/status\/me$/, json: statusEntry(ME, "online") },
    { method: "GET", path: /\/api\/comms\/presence$/, json: { onlineUserIds: [OTHER_ONLINE] } },
    { method: "GET", path: /\/api\/comms\/sidebar\/categories$/, json: [] },
    { method: "GET", path: /\/api\/comms\/users$/, json: TEAM_MEMBERS },
    { method: "GET", path: /\/api\/comms\/emoji$/, json: [] },
    { method: "GET", path: /\/api\/comms\/channels\/[^/]+\/bookmarks/, json: [] },
    { method: "GET", path: /\/api\/comms\/channels\/[^/]+\/pins/, json: [] },
    {
      method: "GET",
      path: new RegExp(`/api/comms/channels/${DM_ID}/messages`),
      json: DM_MESSAGES,
    },
    {
      method: "GET",
      path: new RegExp(`/api/comms/channels/${GROUP_ID}/messages`),
      json: GROUP_MESSAGES,
    },
    { method: "POST", path: /\/api\/comms\/presence\/heartbeat$/, json: { ok: true } },
    { method: "POST", path: /\/api\/comms\/channels\/[^/]+\/read-state$/, json: { ok: true } },
  ],
  defaultJson: {},
  onCall: ({ url, method }: any) => {
    if (process.env.DEBUG_FETCH) console.log(`[fetch] ${method} ${url}`);
  },
}) as any;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");
const CommsPage = (await import("../../client/src/pages/Comms")).default;

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function assertDotColor(el: HTMLElement | null, cls: string, label: string): void {
  assert(el, `${label}: dot element renders`);
  // SVG dots (lucide Circle) expose className as SVGAnimatedString — read the
  // class attribute so both span and svg dots assert uniformly.
  const className = el!.getAttribute("class") ?? "";
  assert(
    className.includes(cls),
    `${label}: dot has color class ${cls} (got "${className}")`,
  );
}

type Mounted = {
  root: ReturnType<typeof createRoot>;
  queryClient: InstanceType<typeof QueryClient>;
};

async function mountApp(): Promise<Mounted> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(CommsProvider, null, React.createElement(CommsPage)),
        ),
      ),
    );
  });
  await flush();
  return { root, queryClient };
}

async function unmountApp(m: Mounted): Promise<void> {
  await act(async () => {
    m.root.unmount();
  });
  m.queryClient.clear();
}

async function main(): Promise<void> {
  // ── Mount 1: DM channel selected (?channel=<dm>) ──────────────────────────
  let mounted = await mountApp();

  console.log("— A. Sidebar footer: my-status StatusDot —");
  const footerTrigger = $("comms-page-status-picker-trigger");
  assert(footerTrigger, "A: sidebar status footer trigger renders");
  const footerDot = footerTrigger!.querySelector(
    '[data-testid="status-dot-online"]',
  ) as HTMLElement | null;
  assertDotColor(footerDot, "bg-green-500", "A: sidebar footer StatusDot (online)");

  console.log("— B. DM message list: author avatar dot + custom status —");
  const dmMsg = $("comms-message-m1");
  assert(dmMsg, "B: DM message renders");
  const dmAvatarDot = dmMsg!.querySelector(
    '[data-testid="avatar-status-online"]',
  ) as HTMLElement | null;
  assertDotColor(dmAvatarDot, "bg-green-500", "B: message avatar dot (online)");
  const authorCustom = $("msg-author-custom-status-m1");
  assert(authorCustom, "B: author custom-status line renders");
  assert(
    authorCustom!.textContent === "🎯 Heads down",
    `B: custom status shows emoji + text (got "${authorCustom!.textContent}")`,
  );

  console.log("— C. New-DM dialog rows: per-user status dots —");
  const newDmButton = $("new-dm-button");
  assert(newDmButton, "C: new-dm button renders in the sidebar");
  await act(async () => {
    newDmButton!.click();
  });
  await flush();
  assert($("new-dm-search-input"), "C: New-DM dialog content mounts");
  assertDotColor(
    $(`dm-member-status-${OTHER_ONLINE}`), "text-green-500", "C: online row dot",
  );
  assertDotColor(
    $(`dm-member-status-${OTHER_AWAY}`), "text-yellow-500", "C: away row dot",
  );
  assertDotColor(
    $(`dm-member-status-${OTHER_DND}`), "text-red-500", "C: dnd row dot",
  );
  assertDotColor(
    $(`dm-member-status-${OTHER_UNKNOWN}`), "text-muted-foreground/30",
    "C: unknown-user row dot falls back to offline color",
  );
  const rowCustom = $(`dm-member-custom-status-${OTHER_ONLINE}`);
  assert(rowCustom, "C: row custom-status line renders");
  assert(
    rowCustom!.textContent === "🎯 Heads down",
    `C: row custom status shows emoji + text (got "${rowCustom!.textContent}")`,
  );
  assert(
    !$(`dm-member-status-${ME}`),
    "C: no row (or dot) for the current user",
  );

  // ── Mount 2: group-DM channel selected (?channel=<group>) ────────────────
  await unmountApp(mounted);
  dom.window.history.replaceState(null, "", `/comms?channel=${GROUP_ID}`);
  mounted = await mountApp();

  console.log("— D. group-DM message list: per-author avatar dots —");
  const g1 = $("comms-message-g1");
  assert(g1, "D: away-author message renders");
  assertDotColor(
    g1!.querySelector('[data-testid="avatar-status-away"]') as HTMLElement | null,
    "bg-yellow-400",
    "D: away avatar dot",
  );
  const g2 = $("comms-message-g2");
  assert(g2, "D: dnd-author message renders");
  assertDotColor(
    g2!.querySelector('[data-testid="avatar-status-dnd"]') as HTMLElement | null,
    "bg-red-500",
    "D: dnd avatar dot",
  );
  const g3 = $("comms-message-g3");
  assert(g3, "D: offline-author message renders");
  assertDotColor(
    g3!.querySelector('[data-testid="avatar-status-offline"]') as HTMLElement | null,
    "bg-muted-foreground/40",
    "D: offline avatar dot",
  );
  const g4 = $("comms-message-g4");
  assert(g4, "D: unknown-status-author message renders");
  assert(
    !g4!.querySelector('[data-testid^="avatar-status-"]'),
    "D: author missing from the statuses map renders no avatar dot (never a wrong color)",
  );

  await unmountApp(mounted);

  console.log("comms-presence-dots-surfaces: ALL TESTS PASSED");
}

await main();
process.exit(0);
