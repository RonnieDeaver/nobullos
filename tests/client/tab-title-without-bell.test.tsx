/* test-registration
{
  "name": "Tab title badge without NotificationBell — GlobalTitleManager self-contained boot fetch, no premature (0), single deduped unread-count request with bell mounted (Task #3354); seeded-cache reuse with zero re-fetches + shared-key/fetcher static drift guard (Task #3380)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3354: the tab badge must be correct even on pages where NotificationBell never mounts — GlobalTitleManager performs its own boot fetch via the shared lib/notificationsQuery config, both subscribers dedupe into ONE request, and the legacy CommsContext title writer that used to clobber the composed title stays deleted. Gate it so a reintroduced second document.title writer or a broken boot fetch fails fast.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/tab-title-without-bell-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/GlobalTitleManager.tsx",
    "client/src/components/NotificationBell.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3354 — the tab count badge must be correct even when NotificationBell
 * never renders on the page.
 *
 * Mounts the REAL GlobalTitleManager (client/src/components/GlobalTitleManager.tsx)
 * inside QueryClientProvider + TitleProvider + CommsProvider and asserts:
 *
 *   (A) WITHOUT NotificationBell mounted anywhere, GlobalTitleManager performs
 *       its own boot fetch of /api/notifications/unread-count and writes the
 *       badge into document.title — it does not depend on the bell seeding
 *       the cache first.
 *   (B) Before the boot fetch resolves, the title never shows a "(0)" badge —
 *       unknown is rendered as no badge, not an authoritative zero.
 *   (C) With BOTH GlobalTitleManager and NotificationBell mounted together on
 *       a fresh cache, the unread-count endpoint is fetched exactly ONCE
 *       (React Query dedupes the concurrent subscribers into one request).
 *
 * Task #3380 additions — guard the bell/title lockstep mechanism itself:
 *
 *   (D) On an ALREADY-SEEDED cache (bell fetched earlier, then unmounted), a
 *       later GlobalTitleManager mount reuses the shared cache entry with
 *       ZERO additional network requests (staleTime: Infinity reuse) and the
 *       title still shows the correct badge.
 *   (E) Static drift guard: GlobalTitleManager.tsx and NotificationBell.tsx
 *       both import UNREAD_COUNT_KEY + fetchUnreadCount from the shared
 *       lib/notificationsQuery module, and NEITHER redefines the query-key
 *       literal locally — a locally re-declared key is exactly the drift
 *       that made the bell and the tab badge disagree in the first place.
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

class EventSourceStub {
  url: string;
  onerror: ((e: any) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
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
// Fetch stub — the unread-count response is gated behind a manually released
// promise so part B can observe the title BEFORE the boot fetch resolves.
// ---------------------------------------------------------------------------

const USER = {
  id: "user-me",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

let unreadCountFetches = 0;
let releaseUnreadCount: () => void = () => {};
let unreadCountGate: Promise<void> = Promise.resolve();
function armUnreadCountGate(): void {
  unreadCountGate = new Promise((r) => {
    releaseUnreadCount = r;
  });
}

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    {
      method: "GET",
      path: "/api/notifications/unread-count",
      json: async () => {
        unreadCountFetches++;
        await unreadCountGate;
        return { count: 6 };
      },
    },
    { method: "GET", path: "/api/notifications?limit=10", json: { notifications: [], total: 0, hasMore: false } },
    { method: "GET", path: "/api/comms/channels", json: [] },
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
const { GlobalTitleManager } = await import("../../client/src/components/GlobalTitleManager");
const { NotificationBell } = await import("../../client/src/components/NotificationBell");
const { TitleProvider, useTitleContext } = await import("../../client/src/contexts/TitleContext");
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// Seeds the page title the way a page's usePageTitle would.
function PageTitleSeed({ title }: { title: string }) {
  const { setPageTitle } = useTitleContext();
  React.useEffect(() => {
    setPageTitle(title);
  }, [title, setPageTitle]);
  return null;
}

function shell(queryClient: any, children: any) {
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(
      TitleProvider,
      null,
      React.createElement(CommsProvider, null, children),
    ),
  );
}

async function main(): Promise<void> {
  console.log("— A/B. GlobalTitleManager alone: boot fetch + no premature (0) —");
  armUnreadCountGate();
  const qc1 = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      shell(
        qc1,
        React.createElement(
          React.Fragment,
          null,
          React.createElement(PageTitleSeed, { title: "Dashboard" }),
          React.createElement(GlobalTitleManager),
        ),
      ),
    );
  });
  await flush(3);

  assert(
    unreadCountFetches === 1,
    `A: GlobalTitleManager boot-fetched unread-count on its own (got ${unreadCountFetches} fetches)`,
  );
  assert(
    !document.title.includes("(0)"),
    `B: no authoritative (0) badge before the fetch resolves (title: "${document.title}")`,
  );

  await act(async () => {
    releaseUnreadCount();
  });
  await flush(4);
  assert(
    document.title === "(6) Dashboard — NoBull OS",
    `A: title shows the fetched badge without the bell mounted (got "${document.title}")`,
  );

  await act(async () => {
    root.unmount();
  });

  console.log("— C. bell + title manager together: exactly one request —");
  unreadCountFetches = 0;
  armUnreadCountGate();
  releaseUnreadCount();
  const qc2 = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const container2 = document.createElement("div");
  document.body.appendChild(container2);
  const root2 = createRoot(container2);
  await act(async () => {
    root2.render(
      shell(
        qc2,
        React.createElement(
          React.Fragment,
          null,
          React.createElement(PageTitleSeed, { title: "Dashboard" }),
          React.createElement(GlobalTitleManager),
          React.createElement(NotificationBell),
        ),
      ),
    );
  });
  await flush(6);

  assert(
    unreadCountFetches === 1,
    `C: both subscribers share one deduped request (got ${unreadCountFetches})`,
  );
  assert(
    document.title === "(6) Dashboard — NoBull OS",
    `C: title composed from the shared cache entry (got "${document.title}")`,
  );

  await act(async () => {
    root2.unmount();
  });

  console.log("— D. seeded cache: later GlobalTitleManager mount adds ZERO fetches —");
  // The bell (and title manager) fetched into qc2 in part C and are now
  // unmounted. Reset document.title so part D proves the badge comes from the
  // shared cache entry, not a leftover title write.
  document.title = "stale-title-before-remount";
  unreadCountFetches = 0;
  const container3 = document.createElement("div");
  document.body.appendChild(container3);
  const root3 = createRoot(container3);
  await act(async () => {
    root3.render(
      shell(
        qc2,
        React.createElement(
          React.Fragment,
          null,
          React.createElement(PageTitleSeed, { title: "Clients" }),
          React.createElement(GlobalTitleManager),
        ),
      ),
    );
  });
  await flush(4);

  assert(
    unreadCountFetches === 0,
    `D: staleTime Infinity reuses the seeded cache — no new request (got ${unreadCountFetches})`,
  );
  assert(
    document.title === "(6) Clients — NoBull OS",
    `D: title composed from the shared cache entry without a re-fetch (got "${document.title}")`,
  );

  await act(async () => {
    root3.unmount();
  });
  qc1.clear();
  qc2.clear();

  console.log("— E. static drift guard: one shared key/fetcher module, no local redefinition —");
  const fs = await import("node:fs");
  const titleManagerSrc = fs.readFileSync(
    "client/src/components/GlobalTitleManager.tsx",
    "utf8",
  );
  const bellSrc = fs.readFileSync(
    "client/src/components/NotificationBell.tsx",
    "utf8",
  );
  const sharedImportRe =
    /import\s*\{[^}]*\bUNREAD_COUNT_KEY\b[^}]*\bfetchUnreadCount\b[^}]*\}\s*from\s*["']@\/lib\/notificationsQuery["']/;
  assert(
    sharedImportRe.test(titleManagerSrc),
    "E: GlobalTitleManager imports UNREAD_COUNT_KEY + fetchUnreadCount from @/lib/notificationsQuery",
  );
  assert(
    sharedImportRe.test(bellSrc),
    "E: NotificationBell imports UNREAD_COUNT_KEY + fetchUnreadCount from @/lib/notificationsQuery",
  );
  // A locally re-declared key literal is the exact drift that split the bell
  // from the tab badge: each component would own a private cache entry.
  const localKeyLiteralRe = /\[\s*["'`]\/api\/notifications\/unread-count["'`]/;
  assert(
    !localKeyLiteralRe.test(titleManagerSrc),
    "E: GlobalTitleManager does not redefine the unread-count query key locally",
  );
  assert(
    !localKeyLiteralRe.test(bellSrc),
    "E: NotificationBell does not redefine the unread-count query key locally",
  );
  assert(
    !/const\s+UNREAD_COUNT_KEY\s*=/.test(titleManagerSrc) &&
      !/const\s+UNREAD_COUNT_KEY\s*=/.test(bellSrc),
    "E: neither component declares its own UNREAD_COUNT_KEY constant",
  );

  console.log("tab-title-without-bell: ALL TESTS PASSED");
}

await main();
process.exit(0);
