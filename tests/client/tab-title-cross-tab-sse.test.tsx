/* test-registration
{
  "name": "Tab title badge cross-tab accuracy — notification:count_updated SSE → cache → title; malformed-payload re-fetch fallback; comms:read_state → totalUnread → title (Task #3355)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3355: cross-tab badge accuracy — the SSE → React Query cache → title path (notification:count_updated direct cache write + malformed-payload invalidation fallback, and comms:read_state → fetchChannels → totalUnread). Gate it so a regression in either stream handler silently desyncing the other tab's title badge fails fast.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/tab-title-cross-tab-sse-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/contexts/CommsContext.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3355 — tab title badge stays accurate when the user reads
 * notifications from a different tab.
 *
 * Covers the end-to-end SSE → React Query cache → title composition path
 * that GlobalTitleManager (client/src/App.tsx) relies on:
 *
 *   (A) Mounts the REAL NotificationBell with a controllable EventSource
 *       stub; the initial unread count is fetched into the
 *       ["/api/notifications/unread-count"] cache.
 *   (B) A `notification:count_updated` SSE push (the event the server
 *       broadcasts to ALL of a user's tabs when notifications are read
 *       anywhere) writes the new count directly into the cache WITHOUT a
 *       re-fetch — and the title composed from the cached count drops the
 *       badge when the count reaches zero.
 *   (C) A count bump via SSE composes the badge back into the title.
 *   (D) A malformed `notification:count_updated` payload falls back to
 *       invalidation → re-fetch, so the cache converges on the server value.
 *   (E) Comms path: mounts the REAL CommsProvider; a `comms:read_state`
 *       SSE push triggers fetchChannels, totalUnread drops to zero, and the
 *       chat badge disappears from the composed title.
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
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
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

// Controllable EventSource stub — capture instances by URL so the test can
// emit named SSE events into the exact stream (bell vs comms) under test.
const esInstances: EventSourceStub[] = [];
class EventSourceStub {
  url: string;
  listeners = new Map<string, Array<(e: any) => void>>();
  onerror: ((e: any) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    esInstances.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener() {}
  close() {}
  emit(type: string, payload: unknown) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}
(globalThis as any).EventSource = EventSourceStub;
(dom.window as any).EventSource = EventSourceStub;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function streamFor(urlPart: string): EventSourceStub {
  const es = [...esInstances].reverse().find((e) => e.url.includes(urlPart));
  assert(es, `an EventSource was opened for ${urlPart}`);
  return es!;
}

// ---------------------------------------------------------------------------
// Fixtures + fetch stub
// ---------------------------------------------------------------------------

const USER = {
  id: "user-me",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

const baseChannel = {
  type: "channel",
  visibility: "public" as const,
  topic: null,
  description: null,
  clientId: null,
  createdBy: USER.id,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// Channels snapshot BEFORE the other tab reads: 4 unread in #general
// (counts toward totalUnread) + 9 unread in a MUTED channel (must not).
const CHANNELS_UNREAD = [
  { ...baseChannel, id: "ch-general-3355", name: "general", slug: "general", unreadCount: 4, mentionCount: 0, notifPref: "all" },
  { ...baseChannel, id: "ch-muted-3355", name: "muted", slug: "muted", unreadCount: 9, mentionCount: 0, notifPref: "muted" },
];
// Snapshot AFTER the other tab reads everything.
const CHANNELS_READ = CHANNELS_UNREAD.map((c) => ({ ...c, unreadCount: 0, mentionCount: 0 }));

let unreadCountFetches = 0;
// Server-side truth for the bell count; part D flips this to prove that the
// malformed-payload fallback re-fetches and converges on the server value.
let serverBellCount = 3;
let channelsFetches = 0;
let channelsReadNow = false;

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    {
      method: "GET",
      path: "/api/notifications/unread-count",
      json: () => {
        unreadCountFetches++;
        return { count: serverBellCount };
      },
    },
    { method: "GET", path: "/api/notifications?limit=10", json: { notifications: [], total: 0, hasMore: false } },
    {
      method: "GET",
      path: "/api/comms/channels",
      json: () => {
        channelsFetches++;
        return channelsReadNow ? CHANNELS_READ : CHANNELS_UNREAD;
      },
    },
    { method: "GET", path: "/api/comms/threads/unread-summary", json: { totalUnreadReplies: 0, totalMentions: 0 } },
    { method: "GET", path: "/api/comms/users", json: [] },
    { method: "GET", path: "/api/comms/status/bulk", json: [] },
    { method: "GET", path: "/api/comms/sidebar/categories", json: [] },
    { method: "GET", path: "/api/comms/drafts", json: [] },
    { method: "POST", path: /\/api\/comms\/presence\/heartbeat$/, json: { ok: true } },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { NotificationBell } = await import("../../client/src/components/NotificationBell");
const { CommsProvider, useCommsContext } = await import("../../client/src/contexts/CommsContext");
const { composeTitleWithCounts } = await import("../../client/src/lib/titleComposer");

const UNREAD_COUNT_KEY = ["/api/notifications/unread-count"] as const;

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// Probe replicating GlobalTitleManager's chat-count sourcing: it reads
// totalUnread + totalThreadUnread from CommsContext and exposes them.
let observedChat: { totalUnread: number; totalThreadUnread: number } | null = null;
function ChatCountProbe() {
  const { totalUnread, totalThreadUnread } = useCommsContext();
  observedChat = { totalUnread, totalThreadUnread };
  return null;
}

async function main(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });

  // Mirrors GlobalTitleManager: bell count comes straight from the unread
  // count cache that NotificationBell's SSE handler keeps fresh.
  const bellCount = () =>
    (queryClient.getQueryData(UNREAD_COUNT_KEY) as { count: number } | undefined)?.count ?? 0;

  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(NotificationBell),
      ),
    );
  });
  await flush();

  console.log("— A. initial fetch seeds the unread-count cache —");
  assert(unreadCountFetches >= 1, "A: unread-count endpoint fetched on mount");
  assert(bellCount() === 3, `A: cache seeded with server count 3 (got ${bellCount()})`);
  assert(
    composeTitleWithCounts("Dashboard", bellCount(), 0) === "(3) Dashboard — NoBull OS",
    "A: title composes badge from initial cached count",
  );
  const fetchesBeforeSse = unreadCountFetches;
  const bellStream = streamFor("/api/notifications/events");

  console.log("— B. cross-tab read → count_updated(0) drops the badge, no re-fetch —");
  await act(async () => {
    bellStream.emit("notification:count_updated", { count: 0 });
  });
  await flush(2);
  assert(bellCount() === 0, `B: cache written directly to 0 (got ${bellCount()})`);
  assert(
    unreadCountFetches === fetchesBeforeSse,
    `B: no re-fetch — SSE count is authoritative (got ${unreadCountFetches}, expected ${fetchesBeforeSse})`,
  );
  assert(
    composeTitleWithCounts("Dashboard", bellCount(), 0) === "Dashboard — NoBull OS",
    "B: badge removed from composed title when count reaches 0",
  );

  console.log("— C. count bump via SSE restores the badge —");
  await act(async () => {
    bellStream.emit("notification:count_updated", { count: 7 });
  });
  await flush(2);
  assert(bellCount() === 7, `C: cache updated to 7 (got ${bellCount()})`);
  assert(
    composeTitleWithCounts("Dashboard", bellCount(), 0) === "(7) Dashboard — NoBull OS",
    "C: title composes the bumped badge",
  );

  console.log("— D. malformed payload falls back to invalidate → server truth —");
  serverBellCount = 5;
  await act(async () => {
    bellStream.emit("notification:count_updated", "not-json{{{");
  });
  await flush(4);
  assert(
    unreadCountFetches > fetchesBeforeSse,
    "D: malformed payload triggered an invalidation re-fetch",
  );
  assert(bellCount() === 5, `D: cache converged on server value 5 (got ${bellCount()})`);
  assert(
    composeTitleWithCounts("Dashboard", bellCount(), 0) === "(5) Dashboard — NoBull OS",
    "D: title composes from the re-fetched count",
  );

  await act(async () => {
    root.unmount();
  });

  console.log("— E. comms: read_state in another tab drops the chat badge —");
  // Task #3360: CommsContext must never write document.title itself — that is
  // GlobalTitleManager's job. Plant a sentinel and assert the provider leaves
  // it alone through mount, refetches, and SSE events.
  const TITLE_SENTINEL = "sentinel-title-owned-by-GlobalTitleManager";
  document.title = TITLE_SENTINEL;
  const root2 = createRoot(document.getElementById("root")!);
  await act(async () => {
    root2.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(CommsProvider, null, React.createElement(ChatCountProbe)),
      ),
    );
  });
  await flush(8);
  assert(observedChat, "E: comms probe mounted");
  assert(
    document.title === TITLE_SENTINEL,
    `E: CommsProvider mount did not write document.title (got "${document.title}")`,
  );
  assert(
    observedChat!.totalUnread === 4,
    `E: initial totalUnread is 4 (muted channel excluded) (got ${observedChat!.totalUnread})`,
  );
  const chatCount = () => observedChat!.totalUnread + observedChat!.totalThreadUnread;
  assert(
    composeTitleWithCounts("Comms", 0, chatCount()) === "(4) Comms — NoBull OS",
    "E: title composes the chat badge from unread channels",
  );

  // The other tab reads everything: server now reports 0 unread and pushes
  // comms:read_state to every connected tab.
  channelsReadNow = true;
  const fetchesBeforeReadState = channelsFetches;
  const commsStream = streamFor("/api/comms/events");
  await act(async () => {
    commsStream.emit("comms:read_state", { type: "comms:read_state", channelId: "ch-general-3355" });
  });
  await flush(2);
  // Task #3548: comms:read_state applies a zero-unread update to the named
  // channel CLIENT-SIDE, instantly — before the debounced (800ms) refetch
  // has any chance to fire. Assert the drop happened with NO server call.
  assert(
    channelsFetches === fetchesBeforeReadState,
    `E: instant update made no fetch yet (got ${channelsFetches}, expected ${fetchesBeforeReadState})`,
  );
  assert(
    observedChat!.totalUnread === 0,
    `E: totalUnread dropped to 0 instantly via local update (got ${observedChat!.totalUnread})`,
  );
  assert(
    composeTitleWithCounts("Comms", 0, chatCount()) === "Comms — NoBull OS",
    "E: chat badge removed from composed title before any re-fetch",
  );
  // The debounced fetchChannels (800ms) still fires afterward to converge on
  // the true server count. Advance past the window and verify convergence.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 900));
  });
  await flush(4);
  assert(
    channelsFetches > fetchesBeforeReadState,
    "E: debounced fetchChannels converged on the server count",
  );
  assert(
    observedChat!.totalUnread === 0,
    `E: totalUnread stayed 0 after cross-tab read (got ${observedChat!.totalUnread})`,
  );
  assert(
    composeTitleWithCounts("Comms", 0, chatCount()) === "Comms — NoBull OS",
    "E: chat badge removed from composed title",
  );
  assert(
    document.title === TITLE_SENTINEL,
    `E: CommsContext left document.title alone across refetch + SSE (got "${document.title}")`,
  );

  console.log("— F. static guard: CommsContext.tsx has no document.title writer —");
  const fs = await import("node:fs");
  const commsSource = fs.readFileSync("client/src/contexts/CommsContext.tsx", "utf8");
  assert(
    !/document\.title\s*=/.test(commsSource),
    "F: CommsContext.tsx contains no direct document.title assignment (GlobalTitleManager is the single writer)",
  );

  await act(async () => {
    root2.unmount();
  });
  queryClient.clear();

  console.log("tab-title-cross-tab-sse: ALL TESTS PASSED");
}

await main();
process.exit(0);
