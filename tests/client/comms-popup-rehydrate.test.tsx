/* test-registration
{
  "name": "Comms popup rehydration — skeleton → real popup → stale prune after navigation (Task #3141)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3141: rendered proof that reopened chat popups survive a full-page navigation. Mounts the REAL CommsProvider + CommsPopupManager in jsdom, seeds sessionStorage with two popup entries, gates /api/comms/channels: both render as skeletons while hydrating, the existing channel becomes a full popup, the stale one is pruned from DOM + sessionStorage, and close persists. Guards the #3137 persistence/skeleton behavior the static scan can't. DB-free, no network (stubbed fetch/EventSource).",
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
 * Task #3141 — reopened chat popups survive page navigation end-to-end.
 *
 * Task #3137 added sessionStorage persistence + rehydration of popup chat
 * windows (CommsContext) and a loading skeleton while channels hydrate. The
 * prior coverage was a static source scan; this test mounts the REAL
 * CommsProvider + CommsPopupManager in jsdom (simulating the fresh mount that
 * happens after a full-page navigation), seeds sessionStorage with two popup
 * entries, gates the /api/comms/channels fetch behind a manual release, and
 * proves:
 *
 *   (A) before channels load, BOTH seeded popups render as loading skeletons
 *       (comms-popup-skeleton-<id>), not full popups and not nothing;
 *   (B) after channels arrive, the popup whose channel exists becomes a full
 *       popup (comms-popup-<id> with the real channel name) and its skeleton
 *       is gone;
 *   (C) the popup whose channel does NOT exist is pruned — no skeleton, no
 *       popup — and sessionStorage is rewritten to only the surviving entry
 *       (so the stale id doesn't resurrect on the next navigation);
 *   (D) closing the surviving popup persists an empty popup list to
 *       sessionStorage (close survives navigation too).
 *
 * MessagePane + Composer are stubbed via the shared heavy-client loader (the
 * popup body's message fetching is not under test); everything else — the
 * provider, persistence, pruning, skeleton, popup chrome — is the real code.
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

// CommsProviderInner opens the shared SSE connection on mount — stub it so no
// real network / reconnect timers run.
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
// Fixtures: two persisted popups — one whose channel exists, one stale.
// ---------------------------------------------------------------------------

const REAL_CHANNEL_ID = "ch-real-3141";
const STALE_CHANNEL_ID = "ch-stale-3141";
const POPUPS_SS_KEY = "comms_open_popups";

const REAL_CHANNEL = {
  id: REAL_CHANNEL_ID,
  name: "general",
  slug: "general",
  type: "channel",
  visibility: "public",
  topic: null,
  description: null,
  clientId: null,
  createdBy: "user-1",
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  unreadCount: 0,
};

const USER = {
  id: "user-1",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

// Seed sessionStorage BEFORE the provider mounts — this is exactly the state
// left behind by a previous page before a full-page navigation.
dom.window.sessionStorage.setItem(
  POPUPS_SS_KEY,
  JSON.stringify([
    { channelId: REAL_CHANNEL_ID, minimized: false },
    { channelId: STALE_CHANNEL_ID, minimized: false },
  ]),
);

// Gate: /api/comms/channels does not resolve until we release it, so we can
// assert the skeleton phase deterministically.
let releaseChannels!: () => void;
const channelsGate = new Promise<void>((resolve) => { releaseChannels = resolve; });

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    {
      path: "/api/comms/channels",
      respond: async ({ jsonResponse }: any) => {
        await channelsGate;
        return jsonResponse(200, [REAL_CHANNEL]);
      },
    },
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
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");
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

function persistedPopupIds(): string[] {
  const raw = dom.window.sessionStorage.getItem(POPUPS_SS_KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as Array<{ channelId: string }>).map((p) => p.channelId);
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
          React.createElement(
            CommsProvider,
            null,
            React.createElement(CommsPopupManager, { currentUserId: USER.id }),
          ),
        ),
      ),
    );
  });
  await flush();

  console.log("— A. skeletons render for BOTH seeded popups while channels hydrate —");
  assert(
    $(`comms-popup-skeleton-${REAL_CHANNEL_ID}`),
    "real-channel popup shows a loading skeleton before channels load",
  );
  assert(
    $(`comms-popup-skeleton-${STALE_CHANNEL_ID}`),
    "stale-channel popup also shows a skeleton before channels load (no premature drop)",
  );
  assert(
    !$(`comms-popup-${REAL_CHANNEL_ID}`),
    "full popup does NOT render before the channel list arrives",
  );
  assert(
    JSON.stringify(persistedPopupIds()) ===
      JSON.stringify([REAL_CHANNEL_ID, STALE_CHANNEL_ID]),
    "sessionStorage still holds both entries during hydration (nothing pruned early)",
  );

  console.log("— B. real popup appears once channels arrive —");
  releaseChannels();
  await flush();

  const realPopup = $(`comms-popup-${REAL_CHANNEL_ID}`);
  assert(realPopup, "full popup renders for the existing channel after channels load");
  assert(
    !$(`comms-popup-skeleton-${REAL_CHANNEL_ID}`),
    "skeleton for the existing channel is replaced by the full popup",
  );
  const title = $(`popup-title-${REAL_CHANNEL_ID}`);
  assert(
    title && title.textContent!.includes("general"),
    `popup title shows the real channel name (got "${title?.textContent}")`,
  );

  console.log("— C. stale popup is pruned after load + storage rewritten —");
  assert(
    !$(`comms-popup-${STALE_CHANNEL_ID}`) && !$(`comms-popup-skeleton-${STALE_CHANNEL_ID}`),
    "popup for the nonexistent channel is fully pruned after channels load",
  );
  assert(
    JSON.stringify(persistedPopupIds()) === JSON.stringify([REAL_CHANNEL_ID]),
    `sessionStorage pruned to only the surviving channel (got ${JSON.stringify(persistedPopupIds())})`,
  );

  console.log("— D. closing the surviving popup persists to sessionStorage —");
  const closeBtn = $(`popup-close-${REAL_CHANNEL_ID}`);
  assert(closeBtn, "close button renders on the surviving popup");
  await act(async () => {
    closeBtn!.click();
  });
  await flush(2);
  assert(!$(`comms-popup-${REAL_CHANNEL_ID}`), "popup unmounts on close");
  assert(
    persistedPopupIds().length === 0,
    "sessionStorage holds an empty popup list after close (close survives navigation)",
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("comms-popup-rehydrate: ALL TESTS PASSED");
}

await main();
process.exit(0);
