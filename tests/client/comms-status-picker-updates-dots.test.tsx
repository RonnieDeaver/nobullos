/* test-registration
{
  "name": "Comms status picker updates every presence dot — footer trigger → Away/DND/custom PUTs + SSE-broadcast re-render of footer StatusDot, custom line, avatar dots (Task #3444)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3444: #3343/#3362 pinned presence-dot colors only as static reads; nothing exercised the interactive path. This mounts the REAL Comms page with the real UserStatusPicker (Radix dropdown-menu shim) and proves the full loop: footer trigger → Away/DND/custom selections issue the right PUTs to /api/comms/status/me(/custom), and the server's comms:user_status SSE broadcast re-renders the footer StatusDot (online→away→dnd), the footer custom-status line, and another user's message avatar dot. DB-free, stubbed fetch + replayable EventSource stub.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-status-picker-updates-dots-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3444 — changing your status actually updates every presence dot.
 *
 * Tasks #3343/#3362 pinned the rendered colors of presence dots on all comms
 * surfaces, but only as static reads of /api/comms/status/bulk + /status/me.
 * Nothing exercised the interactive path. This test mounts the REAL Comms
 * page (real UserStatusPicker via the Radix dropdown-menu shim, real
 * MessagePane) and proves the full status-change loop:
 *
 *   (A) baseline: sidebar footer StatusDot is online (bg-green-500);
 *   (B) Away: clicking the footer trigger + the Away menu item issues exactly
 *       one PUT /api/comms/status/me {status:"away", dndExpiresAt:null}, and
 *       the server's comms:user_status SSE broadcast re-renders the footer
 *       dot as status-dot-away (bg-yellow-400) with the old dot gone;
 *   (C) DND: picking a DND expiry ("Until I change it") PUTs
 *       {status:"dnd", dndExpiresAt:null} and the SSE broadcast flips the
 *       footer dot to status-dot-dnd (bg-red-500);
 *   (D) custom status: opening the custom-status dialog, reusing a recent
 *       custom status and saving PUTs /api/comms/status/me/custom with that
 *       emoji+text, and the SSE broadcast renders the custom line in the
 *       footer;
 *   (E) other users' dots re-render too: a comms:user_status broadcast for
 *       the DM author flips their message avatar dot from online
 *       (bg-green-500) to away (bg-yellow-400).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const DM_ID = "dm-status-3444";

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

// ---------------------------------------------------------------------------
// EventSource stub that lets the test replay server SSE broadcasts.
// CommsProviderInner registers a listener per comms:* event type; emit()
// dispatches a MessageEvent-shaped object to those listeners so the test can
// simulate the server's comms:user_status broadcast after each PUT.
// ---------------------------------------------------------------------------

let activeEventSource: EventSourceStub | null = null;

class EventSourceStub {
  url: string;
  listeners = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    activeEventSource = this;
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  removeEventListener() {}
  close() {}
  emit(type: string, payload: unknown) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data: JSON.stringify(payload) });
    }
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
const OTHER = "user-2";

const USER = {
  id: ME,
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

const now = new Date().toISOString();
const DM_CHANNEL = {
  id: DM_ID,
  type: "dm",
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
  members: [
    { channelId: DM_ID, userId: ME, role: "member" },
    { channelId: DM_ID, userId: OTHER, role: "member" },
  ],
};

const RECENT_CUSTOM = { emoji: "🎯", text: "Heads down" };

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
    recentCustomStatuses: userId === ME ? [RECENT_CUSTOM] : [],
  };
}

const DM_MESSAGES = [
  {
    id: "m1",
    channelId: DM_ID,
    userId: OTHER,
    parentId: null,
    content: "hello from the other user",
    contentType: "text",
    editedAt: null,
    deletedAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    user: { id: OTHER, firstName: "Other", lastName: "User", profileImageUrl: null },
    reactionCounts: {},
    replyCount: 0,
    attachments: [],
  },
];

// Recorded write calls: { url, body } for every PUT the picker issues.
const putCalls: Array<{ url: string; body: any }> = [];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: /\/api\/comms\/channels$/, json: [DM_CHANNEL] },
    { method: "GET", path: /\/api\/comms\/channels\/public$/, json: [] },
    { method: "GET", path: /\/api\/comms\/status\/bulk/, json: [statusEntry(OTHER, "online")] },
    { method: "GET", path: /\/api\/comms\/status\/me$/, json: statusEntry(ME, "online") },
    { method: "GET", path: /\/api\/comms\/presence$/, json: { onlineUserIds: [OTHER] } },
    { method: "GET", path: /\/api\/comms\/sidebar\/categories$/, json: [] },
    { method: "GET", path: /\/api\/comms\/users$/, json: [] },
    { method: "GET", path: /\/api\/comms\/emoji$/, json: [] },
    { method: "GET", path: /\/api\/comms\/channels\/[^/]+\/bookmarks/, json: [] },
    { method: "GET", path: /\/api\/comms\/channels\/[^/]+\/pins/, json: [] },
    {
      method: "GET",
      path: new RegExp(`/api/comms/channels/${DM_ID}/messages`),
      json: DM_MESSAGES,
    },
    {
      method: "PUT",
      path: /\/api\/comms\/status\/me(\/custom)?$/,
      respond: ({ url, init }: any) => {
        putCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return { status: 200, json: { ok: true } };
      },
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

async function click(el: HTMLElement | null, label: string): Promise<void> {
  assert(el, `${label}: element to click renders`);
  await act(async () => {
    el!.click();
  });
  await flush();
}

async function broadcastStatus(entry: ReturnType<typeof statusEntry>): Promise<void> {
  assert(activeEventSource, "SSE stub: CommsProvider opened an EventSource");
  await act(async () => {
    activeEventSource!.emit("comms:user_status", { type: "comms:user_status", ...entry });
  });
  await flush();
}

function footerDot(status: string): HTMLElement | null {
  const trigger = $("comms-page-status-picker-trigger");
  assert(trigger, "sidebar status footer trigger renders");
  return trigger!.querySelector(
    `[data-testid="status-dot-${status}"]`,
  ) as HTMLElement | null;
}

function assertDotColor(el: HTMLElement | null, cls: string, label: string): void {
  assert(el, `${label}: dot element renders`);
  const className = el!.getAttribute("class") ?? "";
  assert(
    className.includes(cls),
    `${label}: dot has color class ${cls} (got "${className}")`,
  );
}

async function main(): Promise<void> {
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

  console.log("— A. Baseline: footer dot online —");
  assertDotColor(footerDot("online"), "bg-green-500", "A: footer StatusDot (online)");

  console.log("— B. Pick Away: PUT + SSE broadcast flips the footer dot —");
  await click($("comms-page-status-picker-trigger"), "B: footer trigger");
  const awayOption = $("status-option-away");
  assert(awayOption, "B: Away menu item renders in the picker");
  await click(awayOption, "B: Away menu item");
  assert(putCalls.length === 1, `B: exactly one PUT issued (got ${putCalls.length})`);
  assert(
    putCalls[0].url.endsWith("/api/comms/status/me"),
    `B: PUT hits /api/comms/status/me (got ${putCalls[0].url})`,
  );
  assert(
    putCalls[0].body?.status === "away" && putCalls[0].body?.dndExpiresAt === null,
    `B: PUT body is {status:"away", dndExpiresAt:null} (got ${JSON.stringify(putCalls[0].body)})`,
  );
  // Footer dot only flips once the server broadcasts the new status.
  await broadcastStatus(statusEntry(ME, "away"));
  assertDotColor(footerDot("away"), "bg-yellow-400", "B: footer StatusDot (away)");
  assert(!footerDot("online"), "B: old online footer dot is gone");

  console.log("— C. Pick DND (Until I change it): PUT + footer dot dnd —");
  await click($("dnd-expiry-never"), "C: DND 'Until I change it' item");
  assert(putCalls.length === 2, `C: second PUT issued (got ${putCalls.length})`);
  assert(
    putCalls[1].url.endsWith("/api/comms/status/me") &&
      putCalls[1].body?.status === "dnd" &&
      putCalls[1].body?.dndExpiresAt === null,
    `C: PUT body is {status:"dnd", dndExpiresAt:null} (got ${JSON.stringify(putCalls[1].body)})`,
  );
  await broadcastStatus(statusEntry(ME, "dnd"));
  assertDotColor(footerDot("dnd"), "bg-red-500", "C: footer StatusDot (dnd)");
  assert(!footerDot("away"), "C: old away footer dot is gone");

  console.log("— D. Custom status: reuse a recent one, save, footer line —");
  await click($("status-custom-status-btn"), "D: 'Set a custom status…' item");
  const recent = $("custom-status-recent-0");
  assert(recent, "D: recent custom status chip renders in the dialog");
  await click(recent, "D: recent custom status chip");
  await click($("custom-status-save-btn"), "D: custom status Save button");
  assert(putCalls.length === 3, `D: third PUT issued (got ${putCalls.length})`);
  assert(
    putCalls[2].url.endsWith("/api/comms/status/me/custom") &&
      putCalls[2].body?.emoji === RECENT_CUSTOM.emoji &&
      putCalls[2].body?.text === RECENT_CUSTOM.text,
    `D: PUT hits /status/me/custom with the recent emoji+text (got ${putCalls[2].url} ${JSON.stringify(putCalls[2].body)})`,
  );
  await broadcastStatus(
    statusEntry(ME, "dnd", RECENT_CUSTOM.emoji, RECENT_CUSTOM.text),
  );
  const footerTrigger = $("comms-page-status-picker-trigger");
  assert(
    footerTrigger!.textContent?.includes(RECENT_CUSTOM.text),
    `D: footer shows the custom status text (got "${footerTrigger!.textContent}")`,
  );

  console.log("— E. Other user's SSE broadcast flips their avatar dot —");
  const msg = $("comms-message-m1");
  assert(msg, "E: DM message renders");
  assertDotColor(
    msg!.querySelector('[data-testid="avatar-status-online"]') as HTMLElement | null,
    "bg-green-500",
    "E: avatar dot starts online",
  );
  await broadcastStatus(statusEntry(OTHER, "away"));
  const msgAfter = $("comms-message-m1");
  assert(msgAfter, "E: DM message still renders after broadcast");
  assertDotColor(
    msgAfter!.querySelector('[data-testid="avatar-status-away"]') as HTMLElement | null,
    "bg-yellow-400",
    "E: avatar dot re-renders as away",
  );
  assert(
    !msgAfter!.querySelector('[data-testid="avatar-status-online"]'),
    "E: old online avatar dot is gone",
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("comms-status-picker-updates-dots: ALL TESTS PASSED");
}

await main();
process.exit(0);
