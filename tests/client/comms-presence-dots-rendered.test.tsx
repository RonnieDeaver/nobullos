/* test-registration
{
  "name": "Comms presence dots — DM/group-DM header + popup status dots, colors, offline fallback, DM-only custom line, >5-participant +N overflow chip, live SSE repaint of DM + group-DM header/popup dots (Tasks #3343, #3384, #3443)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3343: the DM/group-DM presence dots in the /comms channel header and the popup title bars had no rendered coverage — a ChannelHeader or CommsPopup refactor could drop them silently. Mounts the REAL Comms page + CommsPopupManager (heavy leaves stubbed) and asserts: DM shows one dot with the right HEADER_STATUS_COLORS/STATUS_DOT_COLORS class per status, group DMs show one dot per OTHER participant, users missing from userStatuses fall back to offline (never hidden), and the custom status line is DM-only.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-presence-dots-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3343 — the presence dot in chat headers can't silently break.
 *
 * The DM/group-DM presence dots in the /comms channel header and in the
 * CommsPopup title bars had zero rendered coverage — a refactor of
 * ChannelHeader (pages/Comms.tsx) or CommsPopup (CommsPopupManager.tsx) could
 * drop them without any test failing. This test mounts the REAL Comms page +
 * CommsPopupManager inside the real CommsProvider (userStatuses hydrated via
 * a stubbed /api/comms/status/bulk fetch) and proves:
 *
 *   (A) DM header: a single dot renders with the status color from
 *       HEADER_STATUS_COLORS (online → bg-green-400), no group-dot strip,
 *       and the custom status line renders for DMs;
 *   (B) DM popup title bar: the single dot uses STATUS_DOT_COLORS
 *       (online → bg-green-400);
 *   (C) group-DM popup title bar: one dot per OTHER participant
 *       (popup-group-status-<channelId>-<userId>) with per-user colors —
 *       away → bg-yellow-400, dnd → bg-red-400, and a user missing from the
 *       statuses map falls back to offline (bg-white/30);
 *   (D) group-DM header (remounted at ?channel=<groupId>): no single-DM dot,
 *       no custom status line (DM-only), and one dot per other participant
 *       (channel-header-group-status-<userId>) — away → bg-yellow-400,
 *       dnd → bg-red-400, unknown → offline bg-slate-300;
 *   (E/H/I) live SSE 'comms:user_status' events repaint the DM dots AND the
 *       group-DM popup + header strips without a remount (Tasks #3363, #3443),
 *       including upgrading a previously-unknown participant's offline
 *       fallback dot and leaving untouched siblings' colors alone.
 *
 * Heavy leaves (MessagePane, Composer, LiveKit suite, side panels,
 * UserStatusPicker) are stubbed via comms-presence-dots-setup.mjs; the
 * provider, page shell, ChannelHeader, and popup chrome are the real code.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const DM_ID = "dm-presence-3343";
const GROUP_ID = "gdm-presence-3343";
const BIG_GROUP_ID = "gdm-presence-3384-big";

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

// CommsProviderInner opens the shared SSE connection on mount — stub it, but
// record listeners so the test can push events through the REAL provider
// handler (the path a live 'comms:user_status' broadcast takes).
class EventSourceStub {
  static instances: EventSourceStub[] = [];
  url: string;
  listeners = new Map<string, Set<(e: any) => void>>();
  constructor(url: string) {
    this.url = url;
    EventSourceStub.instances.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {}
  emit(type: string, data: unknown) {
    const e = new dom.window.MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
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
const DM_OTHER = "user-2";      // online + custom status
const GROUP_AWAY = "user-3";    // away
const GROUP_DND = "user-4";     // dnd
const GROUP_UNKNOWN = "user-5"; // absent from the statuses map → offline fallback

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
    { channelId: DM_ID, userId: DM_OTHER, role: "member" },
  ],
};

const GROUP_CHANNEL = {
  ...baseChannel,
  id: GROUP_ID,
  type: "group_dm",
  members: [
    { channelId: GROUP_ID, userId: ME, role: "member" },
    { channelId: GROUP_ID, userId: GROUP_AWAY, role: "member" },
    { channelId: GROUP_ID, userId: GROUP_DND, role: "member" },
    { channelId: GROUP_ID, userId: GROUP_UNKNOWN, role: "member" },
  ],
};

// Task #3384 — a group DM with 7 OTHER participants: exactly 5 dots render
// plus a "+2" overflow chip whose hover title lists the remaining two
// participants with name + status.
const BIG_MEMBERS = ["user-10", "user-11", "user-12", "user-13", "user-14", "user-15", "user-16"];
const BIG_OVERFLOW_A = BIG_MEMBERS[5]; // user-15 — named, dnd
const BIG_OVERFLOW_B = BIG_MEMBERS[6]; // user-16 — unnamed, no status → offline
const BIG_GROUP_CHANNEL = {
  ...baseChannel,
  id: BIG_GROUP_ID,
  type: "group_dm",
  members: [
    { channelId: BIG_GROUP_ID, userId: ME, role: "member" },
    ...BIG_MEMBERS.map((id) => ({ channelId: BIG_GROUP_ID, userId: id, role: "member" })),
  ],
  dmParticipants: [
    { userId: BIG_OVERFLOW_A, name: "Olivia Overflow" },
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

// GROUP_UNKNOWN is deliberately missing — both surfaces must fall back to
// their offline color rather than hiding the dot.
const BULK_STATUSES = [
  statusEntry(DM_OTHER, "online", "🎯", "Heads down"),
  statusEntry(GROUP_AWAY, "away"),
  statusEntry(GROUP_DND, "dnd"),
  statusEntry(BIG_OVERFLOW_A, "dnd"),
  // BIG_OVERFLOW_B deliberately absent — overflow list must fall back to offline.
];

// Both channels open as docked popups so the title-bar dots render too.
dom.window.sessionStorage.setItem(
  "comms_open_popups",
  JSON.stringify([
    { channelId: DM_ID, minimized: false },
    { channelId: GROUP_ID, minimized: false },
    { channelId: BIG_GROUP_ID, minimized: false },
  ]),
);

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: /\/api\/comms\/channels$/, json: [DM_CHANNEL, GROUP_CHANNEL, BIG_GROUP_CHANNEL] },
    { method: "GET", path: /\/api\/comms\/channels\/public$/, json: [] },
    { method: "GET", path: /\/api\/comms\/status\/bulk/, json: BULK_STATUSES },
    { method: "GET", path: /\/api\/comms\/status\/me$/, json: statusEntry(ME, "online") },
    { method: "GET", path: /\/api\/comms\/presence$/, json: { onlineUserIds: [DM_OTHER] } },
    { method: "GET", path: /\/api\/comms\/sidebar\/categories$/, json: [] },
    { method: "GET", path: /\/api\/comms\/users$/, json: [] },
    { method: "GET", path: /\/api\/comms\/channels\/[^/]+\/messages/, json: [] },
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
const { CommsPopupManager } = await import(
  "../../client/src/components/comms/CommsPopupManager"
);
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
  assert(
    el!.className.includes(cls),
    `${label}: dot has color class ${cls} (got "${el!.className}")`,
  );
}

type Mounted = { root: ReturnType<typeof createRoot>; queryClient: InstanceType<typeof QueryClient> };

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
          React.createElement(
            CommsProvider,
            null,
            React.createElement(
              React.Fragment,
              null,
              React.createElement(CommsPage),
              React.createElement(CommsPopupManager, { currentUserId: ME }),
            ),
          ),
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

  console.log("— A. DM header: single online dot + custom status line —");
  const dmHeaderDot = $("channel-header-other-status");
  assertDotColor(dmHeaderDot, "bg-green-400", "A: DM header (online)");
  assert(
    !$("channel-header-group-statuses"),
    "A: DM header renders no group-dot strip",
  );
  const customLine = $("channel-header-other-custom-status");
  assert(customLine, "A: DM header renders the custom status line");
  assert(
    customLine!.textContent === "🎯 Heads down",
    `A: custom status line shows emoji + text (got "${customLine!.textContent}")`,
  );

  console.log("— B. DM popup title bar: single online dot —");
  assert($(`comms-popup-${DM_ID}`), "B: DM popup renders");
  assertDotColor($(`popup-other-status-${DM_ID}`), "bg-green-400", "B: DM popup (online)");

  console.log("— C. group-DM popup: one dot per other participant —");
  assert($(`comms-popup-${GROUP_ID}`), "C: group-DM popup renders");
  assert(
    !$(`popup-other-status-${GROUP_ID}`),
    "C: group-DM popup renders no single-DM dot",
  );
  const popupStrip = $(`popup-group-statuses-${GROUP_ID}`);
  assert(popupStrip, "C: group-DM popup renders the group-dot strip");
  assert(
    popupStrip!.children.length === 3,
    `C: one popup dot per OTHER participant (got ${popupStrip!.children.length}, expected 3)`,
  );
  assertDotColor(
    $(`popup-group-status-${GROUP_ID}-${GROUP_AWAY}`), "bg-yellow-400", "C: popup away dot",
  );
  assertDotColor(
    $(`popup-group-status-${GROUP_ID}-${GROUP_DND}`), "bg-red-400", "C: popup dnd dot",
  );
  assertDotColor(
    $(`popup-group-status-${GROUP_ID}-${GROUP_UNKNOWN}`), "bg-white/30",
    "C: popup unknown-user dot falls back to offline",
  );
  assert(
    !$(`popup-group-status-${GROUP_ID}-${ME}`),
    "C: no popup dot for the current user",
  );
  assert(
    !$(`popup-group-status-overflow-${GROUP_ID}`),
    "C: no overflow chip when the group has ≤5 other participants",
  );

  console.log("— F. big group-DM popup: 5 dots + '+2' overflow chip —");
  assert($(`comms-popup-${BIG_GROUP_ID}`), "F: big group-DM popup renders");
  const bigPopupStrip = $(`popup-group-statuses-${BIG_GROUP_ID}`);
  assert(bigPopupStrip, "F: big group-DM popup renders the group-dot strip");
  assert(
    bigPopupStrip!.children.length === 6,
    `F: strip has 5 dots + 1 chip (got ${bigPopupStrip!.children.length}, expected 6)`,
  );
  for (const id of BIG_MEMBERS.slice(0, 5)) {
    assert($(`popup-group-status-${BIG_GROUP_ID}-${id}`), `F: popup dot renders for ${id}`);
  }
  assert(
    !$(`popup-group-status-${BIG_GROUP_ID}-${BIG_OVERFLOW_A}`) &&
      !$(`popup-group-status-${BIG_GROUP_ID}-${BIG_OVERFLOW_B}`),
    "F: participants 6-7 have no individual dot",
  );
  const popupChip = $(`popup-group-status-overflow-${BIG_GROUP_ID}`);
  assert(popupChip, "F: overflow chip renders in the popup title bar");
  assert(
    popupChip!.textContent === "+2",
    `F: chip shows +2 (got "${popupChip!.textContent}")`,
  );
  const popupChipTitle = popupChip!.getAttribute("title") ?? "";
  assert(
    popupChipTitle.includes("Olivia Overflow — Do not disturb"),
    `F: chip hover lists the named overflow participant with status (got "${popupChipTitle}")`,
  );
  assert(
    popupChipTitle.split("\n").length === 2 && popupChipTitle.includes("Offline"),
    `F: chip hover lists BOTH overflow participants, unnamed one as Offline (got "${popupChipTitle}")`,
  );

  // ── E. Live SSE status change (Task #3363) ────────────────────────────────
  // A teammate flipping their status must repaint the header + popup dots
  // WITHOUT a remount — the event flows EventSource → provider handleEvent →
  // setUserStatuses, the same path a real 'comms:user_status' broadcast takes.
  console.log("— E. SSE comms:user_status flips the dots live (no remount) —");
  const es = EventSourceStub.instances[EventSourceStub.instances.length - 1];
  assert(es, "E: provider opened an SSE connection");
  assert(
    (es.listeners.get("comms:user_status")?.size ?? 0) > 0,
    "E: provider subscribed to comms:user_status",
  );

  await act(async () => {
    es.emit("comms:user_status", {
      type: "comms:user_status",
      userId: DM_OTHER,
      effectiveStatus: "dnd",
      manualStatus: "dnd",
      dndExpiresAt: null,
      customEmoji: "⛔",
      customText: "In a meeting",
      customExpiresAt: null,
    });
  });
  await flush();

  assertDotColor(
    $("channel-header-other-status"), "bg-red-400",
    "E: DM header dot flipped online → dnd via SSE",
  );
  assertDotColor(
    $(`popup-other-status-${DM_ID}`), "bg-red-400",
    "E: DM popup dot flipped online → dnd via SSE",
  );
  const liveCustomLine = $("channel-header-other-custom-status");
  assert(liveCustomLine, "E: custom status line still renders after SSE update");
  assert(
    liveCustomLine!.textContent === "⛔ In a meeting",
    `E: custom status line updated via SSE (got "${liveCustomLine!.textContent}")`,
  );

  // Flip back online — proves updates keep applying on the same mount.
  await act(async () => {
    es.emit("comms:user_status", {
      type: "comms:user_status",
      userId: DM_OTHER,
      effectiveStatus: "online",
      manualStatus: "online",
      dndExpiresAt: null,
      customEmoji: null,
      customText: null,
      customExpiresAt: null,
    });
  });
  await flush();
  assertDotColor(
    $("channel-header-other-status"), "bg-green-400",
    "E: DM header dot flipped back dnd → online via SSE",
  );
  assertDotColor(
    $(`popup-other-status-${DM_ID}`), "bg-green-400",
    "E: DM popup dot flipped back dnd → online via SSE",
  );

  // ── H. Live SSE status change for a group-DM participant (Task #3443) ───
  // The group popup title-bar strip must repaint per-participant dots when a
  // teammate's status arrives over the live stream — same handler path, but a
  // different consumer (the strip maps userStatuses per member).
  console.log("— H. SSE comms:user_status flips group-DM popup dots live —");
  await act(async () => {
    es.emit("comms:user_status", {
      type: "comms:user_status",
      userId: GROUP_AWAY,
      effectiveStatus: "dnd",
      manualStatus: "dnd",
      dndExpiresAt: null,
      customEmoji: null,
      customText: null,
      customExpiresAt: null,
    });
  });
  await flush();
  assertDotColor(
    $(`popup-group-status-${GROUP_ID}-${GROUP_AWAY}`), "bg-red-400",
    "H: popup strip dot flipped away → dnd via SSE",
  );
  // A previously-unknown participant coming online must upgrade the offline
  // fallback dot live too.
  await act(async () => {
    es.emit("comms:user_status", {
      type: "comms:user_status",
      userId: GROUP_UNKNOWN,
      effectiveStatus: "online",
      manualStatus: "online",
      dndExpiresAt: null,
      customEmoji: null,
      customText: null,
      customExpiresAt: null,
    });
  });
  await flush();
  assertDotColor(
    $(`popup-group-status-${GROUP_ID}-${GROUP_UNKNOWN}`), "bg-green-400",
    "H: popup strip unknown-user dot flipped offline → online via SSE",
  );
  // Untouched sibling dot keeps its color — the update is per-user.
  assertDotColor(
    $(`popup-group-status-${GROUP_ID}-${GROUP_DND}`), "bg-red-400",
    "H: untouched popup dnd dot unchanged after sibling updates",
  );
  // Flip both back so later sections keep their bulk-hydration expectations.
  await act(async () => {
    es.emit("comms:user_status", {
      type: "comms:user_status",
      userId: GROUP_AWAY,
      effectiveStatus: "away",
      manualStatus: "away",
      dndExpiresAt: null,
      customEmoji: null,
      customText: null,
      customExpiresAt: null,
    });
    es.emit("comms:user_status", {
      type: "comms:user_status",
      userId: GROUP_UNKNOWN,
      effectiveStatus: "offline",
      manualStatus: "offline",
      dndExpiresAt: null,
      customEmoji: null,
      customText: null,
      customExpiresAt: null,
    });
  });
  await flush();
  assertDotColor(
    $(`popup-group-status-${GROUP_ID}-${GROUP_AWAY}`), "bg-yellow-400",
    "H: popup strip dot flipped back dnd → away via SSE",
  );

  // ── Mount 2: group-DM channel selected (?channel=<group>) ────────────────
  await unmountApp(mounted);
  dom.window.history.replaceState(null, "", `/comms?channel=${GROUP_ID}`);
  mounted = await mountApp();

  console.log("— D. group-DM header: per-participant dots, no custom line —");
  assert(
    !$("channel-header-other-status"),
    "D: group-DM header renders no single-DM dot",
  );
  assert(
    !$("channel-header-other-custom-status"),
    "D: custom status line is DM-only (absent for group DM)",
  );
  const headerStrip = $("channel-header-group-statuses");
  assert(headerStrip, "D: group-DM header renders the group-dot strip");
  assert(
    headerStrip!.children.length === 3,
    `D: one header dot per OTHER participant (got ${headerStrip!.children.length}, expected 3)`,
  );
  assertDotColor(
    $(`channel-header-group-status-${GROUP_AWAY}`), "bg-yellow-400", "D: header away dot",
  );
  assertDotColor(
    $(`channel-header-group-status-${GROUP_DND}`), "bg-red-400", "D: header dnd dot",
  );
  assertDotColor(
    $(`channel-header-group-status-${GROUP_UNKNOWN}`), "bg-slate-300",
    "D: header unknown-user dot falls back to offline",
  );
  assert(
    !$(`channel-header-group-status-${ME}`),
    "D: no header dot for the current user",
  );

  assert(
    !$("channel-header-group-status-overflow"),
    "D: no header overflow chip when the group has ≤5 other participants",
  );

  // ── I. Live SSE status change repaints the group-DM HEADER strip ─────────
  // (Task #3443) — mount 2 opened a fresh SSE connection; push a status
  // change through it and prove the header strip dot flips without a remount.
  console.log("— I. SSE comms:user_status flips group-DM header dots live —");
  const es2 = EventSourceStub.instances[EventSourceStub.instances.length - 1];
  assert(es2 && es2 !== es, "I: remounted provider opened a fresh SSE connection");
  assert(
    (es2.listeners.get("comms:user_status")?.size ?? 0) > 0,
    "I: remounted provider subscribed to comms:user_status",
  );
  await act(async () => {
    es2.emit("comms:user_status", {
      type: "comms:user_status",
      userId: GROUP_AWAY,
      effectiveStatus: "online",
      manualStatus: "online",
      dndExpiresAt: null,
      customEmoji: null,
      customText: null,
      customExpiresAt: null,
    });
    es2.emit("comms:user_status", {
      type: "comms:user_status",
      userId: GROUP_UNKNOWN,
      effectiveStatus: "dnd",
      manualStatus: "dnd",
      dndExpiresAt: null,
      customEmoji: null,
      customText: null,
      customExpiresAt: null,
    });
  });
  await flush();
  assertDotColor(
    $(`channel-header-group-status-${GROUP_AWAY}`), "bg-green-400",
    "I: header strip dot flipped away → online via SSE",
  );
  assertDotColor(
    $(`channel-header-group-status-${GROUP_UNKNOWN}`), "bg-red-400",
    "I: header strip unknown-user dot flipped offline → dnd via SSE",
  );
  // Untouched sibling dot keeps its bulk-hydrated color.
  assertDotColor(
    $(`channel-header-group-status-${GROUP_DND}`), "bg-red-400",
    "I: untouched header dnd dot unchanged after sibling updates",
  );
  // Group popup is also mounted here — the same event repaints BOTH surfaces.
  assertDotColor(
    $(`popup-group-status-${GROUP_ID}-${GROUP_AWAY}`), "bg-green-400",
    "I: popup strip dot repainted by the same SSE event",
  );

  // ── Mount 3: big group-DM channel selected (?channel=<bigGroup>) ─────────
  await unmountApp(mounted);
  dom.window.history.replaceState(null, "", `/comms?channel=${BIG_GROUP_ID}`);
  mounted = await mountApp();

  console.log("— G. big group-DM header: 5 dots + '+2' overflow chip —");
  const bigHeaderStrip = $("channel-header-group-statuses");
  assert(bigHeaderStrip, "G: big group-DM header renders the group-dot strip");
  assert(
    bigHeaderStrip!.children.length === 6,
    `G: strip has 5 dots + 1 chip (got ${bigHeaderStrip!.children.length}, expected 6)`,
  );
  for (const id of BIG_MEMBERS.slice(0, 5)) {
    assert($(`channel-header-group-status-${id}`), `G: header dot renders for ${id}`);
  }
  assert(
    !$(`channel-header-group-status-${BIG_OVERFLOW_A}`) &&
      !$(`channel-header-group-status-${BIG_OVERFLOW_B}`),
    "G: participants 6-7 have no individual header dot",
  );
  const headerChip = $("channel-header-group-status-overflow");
  assert(headerChip, "G: overflow chip renders in the header");
  assert(
    headerChip!.textContent === "+2",
    `G: chip shows +2 (got "${headerChip!.textContent}")`,
  );
  const headerChipTitle = headerChip!.getAttribute("title") ?? "";
  assert(
    headerChipTitle.includes("Olivia Overflow — Do not disturb"),
    `G: chip hover lists the named overflow participant with status (got "${headerChipTitle}")`,
  );
  assert(
    headerChipTitle.split("\n").length === 2 && headerChipTitle.includes("Offline"),
    `G: chip hover lists BOTH overflow participants, unnamed one as Offline (got "${headerChipTitle}")`,
  );

  await unmountApp(mounted);

  console.log("comms-presence-dots-rendered: ALL TESTS PASSED");
}

await main();
process.exit(0);
