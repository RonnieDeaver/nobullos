/* test-registration
{
  "name": "Comms pinned channels survive a page reload — server favorites round-trip (Task #3365)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3365: pinned channels come back after a real page reload. Mounts the REAL CommsProvider against a stateful fetch stub acting as the server: togglePin fires POST /api/comms/sidebar/favorites/:id, and a completely fresh provider mount (simulated reload) re-derives pinnedChannelIds from the refetched favorites category — both pin and unpin directions.",
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
 * Task #3365 — pinned channels come back after a real page reload
 * (server favorites round-trip through the REAL CommsProvider).
 *
 * Task #3348 proved the CommsSidebar component moves a row into the Pinned
 * section when a stub context flips pinnedChannelIds. The real persistence
 * path is server-side: CommsContext derives pinnedChannelIds from the sidebar
 * "favorites" category and togglePin POSTs to
 * /api/comms/sidebar/favorites/:channelId. This test closes the loop by
 * mounting the REAL CommsProvider in jsdom against a stateful fetch stub that
 * acts as the server (its favorites list persists across provider mounts),
 * and proves:
 *
 *   (A) on first mount pinnedChannelIds is empty (favorites category empty);
 *   (B) togglePin(channel) fires exactly one POST to
 *       /api/comms/sidebar/favorites/<id> AND optimistically flips
 *       pinnedChannelIds to include the channel;
 *   (C) a completely fresh CommsProvider mount (new provider, new QueryClient
 *       — the simulated full page reload) refetches
 *       GET /api/comms/sidebar/categories and derives pinnedChannelIds
 *       containing the channel purely from the server response;
 *   (D) unpinning on the fresh mount POSTs again, and a THIRD fresh mount
 *       comes back unpinned — the round-trip works in both directions;
 *   (E) the localStorage-pins migration endpoint is never called (no local
 *       pins exist).
 *
 * MessagePane/Composer are stubbed via the shared heavy-client loader (not
 * under test); the provider, derivation, and togglePin path are the real code.
 *
 * Run with:
 *   TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx \
 *     --import ./tests/client/comms-popup-rehydrate-setup.mjs \
 *     tests/client/comms-pin-server-roundtrip.test.tsx
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

// ---------------------------------------------------------------------------
// Fixtures + stateful "server"
// ---------------------------------------------------------------------------

const CHANNEL_ID = "ch-pin-3365";
const FAV_CAT_ID = "cat-fav-3365";

const CHANNEL = {
  id: CHANNEL_ID,
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
  mentionCount: 0,
};

const USER = {
  id: "user-1",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

// The server-side favorites list. Persists across provider mounts — this is
// exactly the state a real page reload would come back to.
let serverFavorites: string[] = [];
const favoriteToggleCalls: string[] = [];
let migrateCalls = 0;
let categoriesGetCount = 0;

function categoriesResponse() {
  return [
    {
      id: FAV_CAT_ID,
      type: "favorites",
      name: "Favorites",
      collapsed: false,
      sorting: "manual",
      unreadsOnTop: false,
      sortOrder: 0,
      channelIds: [...serverFavorites],
    },
  ];
}

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { path: "/api/comms/channels", json: [CHANNEL] },
    {
      method: "GET",
      path: "/api/comms/sidebar/categories",
      json: () => {
        categoriesGetCount++;
        return categoriesResponse();
      },
    },
    {
      method: "POST",
      path: /\/api\/comms\/sidebar\/favorites\/migrate$/,
      respond: ({ jsonResponse }: any) => {
        migrateCalls++;
        return jsonResponse(200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /\/api\/comms\/sidebar\/favorites\/[^/]+$/,
      respond: ({ url, jsonResponse }: any) => {
        const channelId = url.split("/").pop()!;
        favoriteToggleCalls.push(channelId);
        serverFavorites = serverFavorites.includes(channelId)
          ? serverFavorites.filter((id) => id !== channelId)
          : [...serverFavorites, channelId];
        return jsonResponse(200, { ok: true, favorited: serverFavorites.includes(channelId) });
      },
    },
    { path: "/api/comms/threads", json: [] },
    { path: "/api/comms/drafts", json: [] },
    { path: /\/api\/comms\/status\/bulk/, json: [] },
    { method: "POST", path: /\/api\/comms\/presence\/heartbeat$/, json: { ok: true } },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Mount plumbing
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CommsProvider, useCommsContext } = await import(
  "../../client/src/contexts/CommsContext"
);

// Tiny consumer: renders the derived pinnedChannelIds and exposes togglePin.
let latestPinned: string[] = [];
let latestTogglePin: ((id: string) => void) | null = null;
function PinProbe() {
  const { pinnedChannelIds, togglePin } = useCommsContext();
  latestPinned = pinnedChannelIds;
  latestTogglePin = togglePin;
  return React.createElement(
    "div",
    { "data-testid": "pinned-ids" },
    pinnedChannelIds.join(","),
  );
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

type Root = ReturnType<typeof createRoot>;
let root: Root | null = null;

// A fresh mount = new QueryClient + new provider tree, exactly what a full
// page reload produces (no React state survives).
async function freshMount(): Promise<void> {
  const container = document.getElementById("root")!;
  if (root) {
    await act(async () => { root!.unmount(); });
    container.innerHTML = "";
  }
  latestPinned = [];
  latestTogglePin = null;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(CommsProvider, null, React.createElement(PinProbe)),
      ),
    );
  });
  await flush();
}

function renderedPinned(): string {
  return (
    document.querySelector("[data-testid='pinned-ids']")?.textContent ?? ""
  );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  section("A. First mount — empty favorites → no pinned channels");
  await freshMount();
  assert(categoriesGetCount >= 1, "provider fetched GET /api/comms/sidebar/categories on mount");
  assert(latestPinned.length === 0, "pinnedChannelIds starts empty (server favorites empty)");
  assert(renderedPinned() === "", "consumer renders no pinned ids");
  assert(typeof latestTogglePin === "function", "togglePin is exposed by the real context");

  section("B. togglePin — POST fires + optimistic pinned state");
  await act(async () => { latestTogglePin!(CHANNEL_ID); });
  await flush();
  assert(
    favoriteToggleCalls.length === 1 && favoriteToggleCalls[0] === CHANNEL_ID,
    `exactly one POST /api/comms/sidebar/favorites/${CHANNEL_ID} fired (got ${JSON.stringify(favoriteToggleCalls)})`,
  );
  assert(
    latestPinned.includes(CHANNEL_ID),
    "pinnedChannelIds optimistically includes the channel after togglePin",
  );
  assert(
    serverFavorites.includes(CHANNEL_ID),
    "server-side favorites now contain the channel",
  );

  section("C. Simulated page reload — fresh provider derives pin from server");
  const getsBeforeReload = categoriesGetCount;
  await freshMount();
  assert(
    categoriesGetCount > getsBeforeReload,
    "fresh mount refetched the sidebar categories from the server",
  );
  assert(
    latestPinned.length === 1 && latestPinned[0] === CHANNEL_ID,
    `fresh mount derives pinnedChannelIds from the server favorites (got ${JSON.stringify(latestPinned)})`,
  );
  assert(
    renderedPinned() === CHANNEL_ID,
    "consumer renders the pinned channel id after the reload",
  );

  section("D. Unpin on the fresh mount — round-trips back to empty");
  await act(async () => { latestTogglePin!(CHANNEL_ID); });
  await flush();
  assert(
    favoriteToggleCalls.length === 2 && favoriteToggleCalls[1] === CHANNEL_ID,
    "unpin fires a second POST to the same favorites endpoint",
  );
  assert(!latestPinned.includes(CHANNEL_ID), "pinnedChannelIds optimistically drops the channel");
  assert(serverFavorites.length === 0, "server-side favorites are empty again");

  await freshMount();
  assert(
    latestPinned.length === 0 && renderedPinned() === "",
    "a third fresh mount (reload after unpin) comes back with no pinned channels",
  );

  section("E. No spurious migration");
  assert(migrateCalls === 0, "localStorage-pins migration endpoint was never called");

  if (root) await act(async () => { root!.unmount(); });

  if (failed > 0) {
    console.error(`\ncomms-pin-server-roundtrip: ${failed} assertion(s) FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\ncomms-pin-server-roundtrip: all ${passed} assertions passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error("comms-pin-server-roundtrip: fatal error", err);
  process.exit(1);
});
