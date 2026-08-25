/* test-registration
{
  "name": "Minimized bar attention pulse — unread bump pulses bar-collapsed chats on narrow viewports, auto-clears, desktop unaffected (Task #3368)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3368: new messages arriving in a bar-collapsed chat on narrow viewports must briefly pulse the bar (data-attention + animate-pulse) alongside the unread badge, auto-clear after the pulse window, and never fire on desktop. DB-free, no network (stubbed fetch/EventSource).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-popup-rehydrate-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3368 — unread attention pulse on minimized chat bars (narrow viewports).
 *
 * On phones (< 480px) older open chats render as minimized title bars stacked
 * above the newest expanded popup. When a new message arrives in one of those
 * bar-collapsed chats, the bar must visibly indicate the new activity: a brief
 * highlight/pulse (data-attention="true" + ring/animate classes) in addition
 * to the existing unread badge. Desktop popups are unaffected.
 *
 * This test mounts the REAL CommsProvider + CommsPopupManager in jsdom with
 * three open popups and proves:
 *
 *   (A) narrow (375px): bumping unreadCount on a bar-collapsed chat sets the
 *       attention state on that bar (and shows the unread badge), while the
 *       expanded newest popup gets no attention state;
 *   (B) the attention state clears on its own after the pulse window (~2s);
 *   (C) desktop (1024px): bumping unreadCount does NOT set attention on any
 *       popup (forcedBar is always false on desktop).
 *
 * MessagePane + Composer are stubbed via the shared heavy-client loader.
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
// Fixtures: three open popups, ch-c newest (expanded on narrow).
// ---------------------------------------------------------------------------

const CH_A = "ch-a-3368";
const CH_B = "ch-b-3368";
const CH_C = "ch-c-3368";
const POPUPS_SS_KEY = "comms_open_popups";

function makeChannel(id: string, name: string, unreadCount = 0) {
  return {
    id,
    name,
    slug: name,
    type: "channel",
    visibility: "public",
    topic: null,
    description: null,
    clientId: null,
    createdBy: "user-1",
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    unreadCount,
  };
}

const CHANNELS = [
  makeChannel(CH_A, "alpha"),
  makeChannel(CH_B, "bravo"),
  makeChannel(CH_C, "charlie"),
];

const USER = {
  id: "user-1",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

dom.window.sessionStorage.setItem(
  POPUPS_SS_KEY,
  JSON.stringify([
    { channelId: CH_A, minimized: false },
    { channelId: CH_B, minimized: false },
    { channelId: CH_C, minimized: false },
  ]),
);

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    // Fresh clones each call — returning the same array reference would make
    // the context's setChannels bail out and never re-render on refetch.
    { path: "/api/comms/channels", json: () => CHANNELS.map((c) => ({ ...c })) },
    { method: "POST", path: /\/api\/comms\/presence\/heartbeat$/, json: { ok: true } },
    { method: "POST", path: /\/api\/comms\/channels\/[^/]+\/read-state$/, json: { ok: true } },
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
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const { CommsProvider, useCommsContext } = await import(
  "../../client/src/contexts/CommsContext"
);
const { CommsPopupManager } = await import(
  "../../client/src/components/comms/CommsPopupManager"
);

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function setViewportWidth(width: number): Promise<void> {
  Object.defineProperty(dom.window, "innerWidth", {
    configurable: true,
    value: width,
  });
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event("resize"));
  });
  await flush(2);
}

function attentionOf(channelId: string): boolean {
  const el = $(`comms-popup-${channelId}`);
  assert(el, `popup for ${channelId} is rendered`);
  return el!.getAttribute("data-attention") === "true";
}

// Grabs refetchChannels from the real context so the test can simulate the
// SSE "message.created" → fetchChannels() refresh path.
function ContextProbe() {
  const ctx = useCommsContext();
  (globalThis as any).__refetchChannels = ctx.refetchChannels;
  return null;
}

async function main(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <CommsProvider>
            <ContextProbe />
            <CommsPopupManager currentUserId="user-1" />
          </CommsProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await flush();

  async function bumpUnread(channelId: string, unreadCount: number): Promise<void> {
    // Mutate the fetch stub's payload, then trigger the same channels refetch
    // the SSE message.created handler performs.
    const ch = CHANNELS.find((c) => c.id === channelId)!;
    (ch as any).unreadCount = unreadCount;
    await act(async () => {
      (globalThis as any).__refetchChannels();
    });
    await flush(3);
  }

  // ── A. narrow: new message in a bar-collapsed chat pulses the bar ─────────
  console.log("— A. narrow 375px: unread bump on a bar sets attention —");
  await setViewportWidth(375);
  assert(!attentionOf(CH_A), "bar has no attention state before any message");
  assert(!attentionOf(CH_C), "expanded newest popup has no attention state");

  await bumpUnread(CH_A, 1);
  assert(attentionOf(CH_A), "bar-collapsed chat (alpha) pulses after unread bump");
  assert(
    $(`comms-popup-${CH_A}`)!.className.includes("animate-pulse"),
    "attention applies the pulse animation class",
  );
  assert($(`popup-unread-badge-${CH_A}`), "unread badge shown alongside the pulse");
  assert(!attentionOf(CH_C), "expanded newest popup stays calm");
  assert(!attentionOf(CH_B), "untouched bar (bravo) stays calm");

  // ── B. attention clears on its own after the pulse window ─────────────────
  console.log("— B. attention clears after ~2s —");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 2200));
  });
  await flush(2);
  assert(!attentionOf(CH_A), "attention state clears after the pulse window");
  assert($(`popup-unread-badge-${CH_A}`), "unread badge remains after pulse ends");

  // ── C. desktop: unread bumps never set attention ───────────────────────────
  // 1200px fits all three 340px columns (56 + 3×340 + 2×8 = 1092), so no
  // popup is a forced overflow bar and the pulse must never fire.
  console.log("— C. desktop 1200px: unread bump sets no attention —");
  await setViewportWidth(1200);
  await bumpUnread(CH_B, 3);
  assert(!attentionOf(CH_A) && !attentionOf(CH_B) && !attentionOf(CH_C),
    "no popup gets attention state on desktop");

  await act(async () => {
    root.unmount();
  });

  console.log("comms-popup-bar-attention: ALL TESTS PASSED");
}

await main();
process.exit(0);
