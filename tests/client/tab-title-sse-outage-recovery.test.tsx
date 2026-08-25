/* test-registration
{
  "name": "Tab title badge outage recovery — SSE onerror → 60 s safety-net poll converges cache on server truth; backoff reconnect re-suppresses polling; fresh push on reconnected stream drives title (Task #3359)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3359: the outage half of the tab-title badge contract — when the notification SSE stream drops, the 60 s safety-net poll must resume and converge the unread-count cache (and title) on server truth, and the backoff reconnect must re-suppress polling with a fully wired stream. Gate it so a regression in the sseConnected gating or the onerror/ reconnect path can't silently freeze the badge at a stale count.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3359 — tab title badge recovers when the notification stream
 * reconnects after an outage.
 *
 * Task #3355 covered the healthy SSE path (notification:count_updated →
 * cache → title). This test covers the OUTAGE path in NotificationBell
 * (client/src/components/NotificationBell.tsx):
 *
 *   (A) While SSE is connected, polling is fully suppressed: the 60 s
 *       refetchInterval timers created at mount (sseConnected starts
 *       false) are CLEARED once the stream's `open` event fires, and no
 *       new ones are scheduled.
 *   (B) EventSource onerror → sseConnected flips false → the 60 s
 *       safety-net poll intervals are re-armed AND a reconnect timer is
 *       scheduled with the exponential-backoff delay from
 *       nextSseReconnectState (first quick failure = 5 s base ± 20 %
 *       jitter). During the outage another tab reads notifications
 *       (server truth drops 3 → 0); firing the captured 60 s poll
 *       interval re-fetches and converges the
 *       ["/api/notifications/unread-count"] cache — and the composed
 *       tab title — on the server value.
 *   (C) Firing the captured reconnect timer opens a NEW EventSource;
 *       its `open` event clears the safety-net intervals again (no
 *       background polling while connected) and a fresh
 *       notification:count_updated push on the NEW stream converges the
 *       cache/title, proving the reconnected stream is fully wired.
 *
 * Determinism: real timers with delay >= 500 ms (React Query's 60 s
 * refetchInterval setInterval, the bell's backoff setTimeout) are
 * captured instead of scheduled, so the test fires them explicitly —
 * no waiting, no jitter flake.
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

// ---------------------------------------------------------------------------
// Captured-timer harness. Any setTimeout/setInterval with delay >= 500 ms is
// recorded instead of scheduled so the test can fire it deterministically.
// Must be installed BEFORE @tanstack/react-query and NotificationBell load.
// ---------------------------------------------------------------------------

type CapturedTimer = {
  id: number;
  fn: () => void;
  delay: number;
  kind: "timeout" | "interval";
  active: boolean;
};
const capturedTimers: CapturedTimer[] = [];
let nextFakeTimerId = 1_000_000_000;
const CAPTURE_THRESHOLD_MS = 500;

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);

function deactivate(id: unknown): boolean {
  const t = capturedTimers.find((c) => c.id === id);
  if (t) {
    t.active = false;
    return true;
  }
  return false;
}

(globalThis as any).setTimeout = (fn: any, delay?: number, ...args: any[]) => {
  if ((delay ?? 0) >= CAPTURE_THRESHOLD_MS) {
    const id = nextFakeTimerId++;
    capturedTimers.push({
      id,
      fn: () => fn(...args),
      delay: delay!,
      kind: "timeout",
      active: true,
    });
    return id as any;
  }
  return realSetTimeout(fn, delay, ...args);
};
(globalThis as any).clearTimeout = (id: any) => {
  if (deactivate(id)) return;
  return realClearTimeout(id);
};
(globalThis as any).setInterval = (fn: any, delay?: number, ...args: any[]) => {
  if ((delay ?? 0) >= CAPTURE_THRESHOLD_MS) {
    const id = nextFakeTimerId++;
    capturedTimers.push({
      id,
      fn: () => fn(...args),
      delay: delay!,
      kind: "interval",
      active: true,
    });
    return id as any;
  }
  return realSetInterval(fn, delay, ...args);
};
(globalThis as any).clearInterval = (id: any) => {
  if (deactivate(id)) return;
  return realClearInterval(id);
};
// Keep jsdom's window timers in lockstep so component code reached via
// window.setTimeout (none today, defensive) behaves identically.
(dom.window as any).setTimeout = (globalThis as any).setTimeout;
(dom.window as any).clearTimeout = (globalThis as any).clearTimeout;
(dom.window as any).setInterval = (globalThis as any).setInterval;
(dom.window as any).clearInterval = (globalThis as any).clearInterval;

function activePollIntervals(): CapturedTimer[] {
  return capturedTimers.filter(
    (t) => t.kind === "interval" && t.active && t.delay === 60_000,
  );
}
function activeReconnectTimeouts(): CapturedTimer[] {
  // The bell's backoff reconnect timer: first rapid failure produces
  // 5 s base ± 20 % jitter → [4000, 6000]. Nothing else in this mount
  // schedules a timeout in that band.
  return capturedTimers.filter(
    (t) => t.kind === "timeout" && t.active && t.delay >= 4_000 && t.delay <= 6_000,
  );
}

// ---------------------------------------------------------------------------
// Controllable EventSource stub (same shape as the Task #3355 harness) with
// onerror support so the outage path can be driven.
// ---------------------------------------------------------------------------

const esInstances: EventSourceStub[] = [];
class EventSourceStub {
  url: string;
  listeners = new Map<string, Array<(e: any) => void>>();
  onerror: ((e: any) => void) | null = null;
  closed = false;
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
  close() {
    this.closed = true;
  }
  emit(type: string, payload?: unknown) {
    const data =
      payload === undefined
        ? undefined
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload);
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  fail() {
    this.onerror?.({});
  }
}
(globalThis as any).EventSource = EventSourceStub;
(dom.window as any).EventSource = EventSourceStub;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
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

let unreadCountFetches = 0;
// Server-side truth for the bell count; the outage window flips this to
// prove the safety-net poll converges the cache on the server value.
let serverBellCount = 3;

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
    {
      method: "GET",
      path: "/api/notifications?limit=10",
      json: { notifications: [], total: 0, hasMore: false },
    },
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
const { composeTitleWithCounts } = await import("../../client/src/lib/titleComposer");

const UNREAD_COUNT_KEY = ["/api/notifications/unread-count"] as const;

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => realSetTimeout(r, 0));
    });
  }
}

async function main(): Promise<void> {
  // NOTE: no `refetchInterval: false` default — this test exercises the
  // component's OWN refetchInterval gating, so query defaults must not
  // mask it (the Task #3355 harness disables intervals globally; here
  // they are the subject under test).
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const bellCount = () =>
    (queryClient.getQueryData(UNREAD_COUNT_KEY) as { count: number } | undefined)
      ?.count ?? 0;

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

  console.log("— A. connected stream suppresses the safety-net poll —");
  assert(unreadCountFetches >= 1, "A: unread-count endpoint fetched on mount");
  assert(bellCount() === 3, `A: cache seeded with server count 3 (got ${bellCount()})`);
  // Before `open` fires, sseConnected=false, so the mount briefly arms the
  // 60 s poll intervals (unread-count + recent list).
  assert(
    capturedTimers.some((t) => t.kind === "interval" && t.delay === 60_000),
    "A: 60 s safety-net intervals were armed while SSE was not yet connected",
  );
  const stream1 = esInstances[esInstances.length - 1];
  assert(
    stream1 && stream1.url.includes("/api/notifications/events"),
    "A: an EventSource was opened for /api/notifications/events",
  );
  await act(async () => {
    stream1.emit("open");
  });
  await flush(2);
  assert(
    activePollIntervals().length === 0,
    `A: all 60 s poll intervals cleared once SSE connected (got ${activePollIntervals().length} active)`,
  );
  const fetchesWhileConnected = unreadCountFetches;
  await flush(4);
  assert(
    unreadCountFetches === fetchesWhileConnected,
    "A: no background unread-count polling while SSE is connected",
  );

  console.log("— B. outage: onerror re-arms polling + schedules backoff reconnect —");
  await act(async () => {
    stream1.fail();
  });
  await flush(2);
  assert(stream1.closed, "B: errored stream was closed");
  assert(
    activePollIntervals().length > 0,
    "B: 60 s safety-net poll re-armed after SSE error (refetchInterval flipped from false)",
  );
  const reconnects = activeReconnectTimeouts();
  assert(
    reconnects.length === 1,
    `B: exactly one backoff reconnect timer scheduled (got ${reconnects.length})`,
  );
  assert(
    reconnects[0].delay >= 4_000 && reconnects[0].delay <= 6_000,
    `B: first-failure backoff is 5 s base ± 20 % jitter (got ${reconnects[0].delay} ms)`,
  );

  // During the outage another tab reads everything: server truth is now 0,
  // but this tab's cache still says 3 — only the safety-net poll can fix it.
  serverBellCount = 0;
  assert(bellCount() === 3, "B: cache still stale (3) during the outage window");
  const fetchesBeforePoll = unreadCountFetches;
  const unreadPoll = activePollIntervals().find(() => true)!;
  await act(async () => {
    // Fire ALL armed 60 s intervals (unread-count + recent list) — exactly
    // what a real 60 s elapse would do.
    for (const t of activePollIntervals()) t.fn();
  });
  await flush(4);
  assert(
    unreadCountFetches > fetchesBeforePoll,
    "B: safety-net poll re-fetched the unread count during the outage",
  );
  assert(
    bellCount() === 0,
    `B: cache converged on server value 0 via polling (got ${bellCount()})`,
  );
  assert(
    composeTitleWithCounts("Dashboard", bellCount(), 0) === "Dashboard — NoBull OS",
    "B: tab title badge dropped once the poll converged on 0",
  );
  // React Query re-arms the interval after each refetch (clear + new
  // setInterval), so assert on the pool, not the original timer object.
  assert(
    activePollIntervals().length > 0,
    "B: safety-net polling stays armed while SSE is still down",
  );

  console.log("— C. reconnect: new stream re-suppresses polling and pushes converge —");
  const esCountBefore = esInstances.length;
  const reconnectTimer = activeReconnectTimeouts()[0];
  await act(async () => {
    reconnectTimer.active = false; // a fired timeout does not repeat
    reconnectTimer.fn();
  });
  await flush(2);
  assert(
    esInstances.length === esCountBefore + 1,
    "C: reconnect timer opened a new EventSource",
  );
  const stream2 = esInstances[esInstances.length - 1];
  assert(
    stream2.url.includes("/api/notifications/events"),
    "C: reconnected stream targets /api/notifications/events",
  );
  await act(async () => {
    stream2.emit("open");
  });
  await flush(2);
  assert(
    activePollIntervals().length === 0,
    `C: safety-net polling suppressed again after reconnect (got ${activePollIntervals().length} active)`,
  );

  // A fresh push on the NEW stream must drive the cache + title — proving
  // the reconnected stream's handlers are fully wired.
  serverBellCount = 5;
  const fetchesBeforePush = unreadCountFetches;
  await act(async () => {
    stream2.emit("notification:count_updated", { count: 5 });
  });
  await flush(2);
  assert(bellCount() === 5, `C: cache updated from reconnected stream push (got ${bellCount()})`);
  assert(
    unreadCountFetches === fetchesBeforePush,
    "C: push wrote the cache directly — no re-fetch, no polling",
  );
  assert(
    composeTitleWithCounts("Dashboard", bellCount(), 0) === "(5) Dashboard — NoBull OS",
    "C: tab title recomposed the badge from the reconnected stream's count",
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("tab-title-sse-outage-recovery: ALL TESTS PASSED");
}

await main();
process.exit(0);
