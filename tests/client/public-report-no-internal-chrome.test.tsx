/* test-registration
{
  "name": "Public report surfaces stay free of internal chat chrome and authenticated 401 probes — real App shell mounted at /demo-report fires ZERO authenticated requests and renders no comms rail/FAB; same mount navigated to an internal path proves the harness detects both (Task #4257)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4225 removed the staff chat rail/FAB and the background authenticated probes (/api/auth/user, /api/notifications/unread-count, /api/comms/*, /api/phase-settings, /api/trends/practice-areas) from client-facing report links, but nothing structural prevents a future component mounted in App's Router (or a new ungated useQuery in PublicReport) from silently reintroducing 401 console errors and error toasts over client reports. This mounts the REAL App shell at /demo-report with a recording fetch stub and fails fast on any forbidden request or any rail-* or comms-floating-button test-id. The in-test positive control (navigate to an internal path, probes fire + FAB renders) keeps the guard honest. Fast, DB-free, network-free jsdom render test.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/public-report-no-internal-chrome-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4257 — internal chat chrome and authenticated background probes must
 * never leak onto client-facing report surfaces.
 *
 * Mounts the REAL App (client/src/App.tsx — QueryClientProvider, CommsProvider,
 * Router, CommsShell, GlobalTitleManager, AuthGate, the works) at /demo-report
 * and asserts:
 *
 *   (A) The demo report actually renders (firm name visible) — so a crashed
 *       mount can't fake a pass on the negative assertions below.
 *   (B) NO request is made to any authenticated endpoint:
 *       /api/auth/user, /api/notifications/unread-count, /api/comms/*,
 *       /api/phase-settings, /api/trends/practice-areas.
 *   (C) NO internal chat chrome renders: no comms-floating-button, no
 *       rail-* test-ids anywhere in the document.
 *
 * Positive control (keeps B/C honest — a harness where the queries are simply
 * broken would pass them vacuously):
 *
 *   (D) Navigating the SAME mounted App to an internal path re-enables the
 *       gated queries — /api/auth/user and /api/notifications/unread-count
 *       are fetched — and the comms FAB/rail chrome appears.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/demo-report" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
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
class IntersectionObserverStub {
  constructor(_cb: any) {}
  observe() {} unobserve() {} disconnect() {}
  takeRecords() { return []; }
}
(globalThis as any).IntersectionObserver = IntersectionObserverStub;
(dom.window as any).IntersectionObserver = IntersectionObserverStub;
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
// Fetch stub — records EVERY request URL so the forbidden-endpoint assertions
// run over the complete traffic log, not a per-route allow-list.
// ---------------------------------------------------------------------------

const USER = {
  id: "user-me",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

const DEMO_REPORT = {
  report: { id: "demo-report-1", reportMonth: "2026-07", status: "shared" },
  client: {
    firmName: "Demo Firm & Associates",
    contactName: "Demo Contact",
    products: ["seo"],
    practiceAreas: ["Personal Injury"],
  },
  sections: [],
  ceoPulse: null,
  dataAccess: null,
  trendData: null,
};

const requestedUrls: string[] = [];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  onCall: ({ url }: { url: string }) => {
    requestedUrls.push(url);
  },
  routes: [
    { method: "GET", path: "/api/demo-report", json: DEMO_REPORT },
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: "/api/notifications/unread-count", json: { count: 2 } },
    { method: "GET", path: "/api/notifications?limit=10", json: { notifications: [], total: 0, hasMore: false } },
    { method: "GET", path: /\/api\/comms\/channels(\?|$)/, json: [] },
    { method: "GET", path: "/api/comms/threads/unread-summary", json: { totalUnreadReplies: 0, totalMentions: 0 } },
    { method: "GET", path: "/api/comms/users", json: [] },
    { method: "GET", path: "/api/comms/status/bulk", json: [] },
    { method: "GET", path: "/api/comms/sidebar/categories", json: [] },
    { method: "GET", path: "/api/comms/drafts", json: [] },
    { method: "POST", path: /\/api\/comms\/presence\/heartbeat$/, json: { ok: true } },
    { method: "GET", path: "/api/phase-settings", json: [] },
    { method: "GET", path: "/api/trends/practice-areas", json: {} },
  ],
  defaultJson: {},
}) as any;

// The exact endpoints Task #4225 removed from public report surfaces. Any
// request to these while the app sits on /demo-report is a regression.
const FORBIDDEN_ON_PUBLIC: Array<{ label: string; test: (url: string) => boolean }> = [
  { label: "/api/auth/user", test: (u) => u.includes("/api/auth/user") },
  { label: "/api/notifications/unread-count", test: (u) => u.includes("/api/notifications/unread-count") },
  { label: "/api/comms/*", test: (u) => u.includes("/api/comms/") },
  { label: "/api/phase-settings", test: (u) => u.includes("/api/phase-settings") },
  { label: "/api/trends/practice-areas", test: (u) => u.includes("/api/trends/practice-areas") },
];

function forbiddenHits(urls: string[]): string[] {
  return urls.filter((u) => FORBIDDEN_ON_PUBLIC.some((f) => f.test(u)));
}

function internalChromeTestIds(): string[] {
  const found: string[] = [];
  for (const el of Array.from(document.querySelectorAll("[data-testid]"))) {
    const id = el.getAttribute("data-testid") || "";
    if (id === "comms-floating-button" || id.startsWith("rail-")) found.push(id);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const AppModule = await import("../../client/src/App");
const App = AppModule.default;

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// Lazy route chunks (DemoReport → PublicReport) resolve through dynamic
// imports that tsx transpiles on first load — that takes real wall time, so
// poll with real delays instead of a fixed microtask flush.
async function waitFor(cond: () => boolean, label: string, timeoutMs = 90000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
  }
  await flush(6);
}

async function main(): Promise<void> {
  let failed = false;
  try {
    console.log("— A/B/C. real App shell at /demo-report —");
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(React.createElement(App));
    });
    await waitFor(
      () => !!document.body.textContent?.includes("Demo Firm & Associates"),
      "demo report content rendered (lazy PublicReport chunk resolved)",
    );

    assert(
      document.body.textContent?.includes("Demo Firm & Associates"),
      `A: the demo report content actually rendered (body has ${document.body.textContent?.length ?? 0} chars) — a crashed mount must not fake a pass`,
    );

    const hits = forbiddenHits(requestedUrls);
    assert(
      hits.length === 0,
      `B: no authenticated endpoint is fetched on /demo-report — forbidden requests seen: ${JSON.stringify(hits)} (all traffic: ${JSON.stringify(requestedUrls)})`,
    );

    const chrome = internalChromeTestIds();
    assert(
      chrome.length === 0,
      `C: no internal chat chrome (comms FAB / rail) renders on /demo-report — found test-ids: ${JSON.stringify(chrome)}`,
    );

    console.log("— D. positive control: internal path re-enables probes + chrome —");
    // Navigate the SAME mounted app to an internal (non-public) path. wouter
    // patches history.pushState to notify subscribers, so this is exactly the
    // in-app navigation code path.
    requestedUrls.length = 0;
    await act(async () => {
      dom.window.history.pushState({}, "", "/task-4257-internal-control");
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    });
    await waitFor(
      () => requestedUrls.some((u) => u.includes("/api/auth/user")) &&
        requestedUrls.some((u) => u.includes("/api/notifications/unread-count")) &&
        internalChromeTestIds().length > 0,
      `internal-path control: auth probe + unread-count fetched and comms chrome rendered (traffic so far: ${JSON.stringify(requestedUrls)})`,
    );

    assert(
      requestedUrls.some((u) => u.includes("/api/auth/user")),
      `D: /api/auth/user IS fetched once we're on an internal path (traffic: ${JSON.stringify(requestedUrls)}) — otherwise assertions B/C are vacuous`,
    );
    assert(
      requestedUrls.some((u) => u.includes("/api/notifications/unread-count")),
      `D: /api/notifications/unread-count IS fetched on an internal path (traffic: ${JSON.stringify(requestedUrls)})`,
    );
    const controlChrome = internalChromeTestIds();
    assert(
      controlChrome.length > 0,
      "D: comms chrome (FAB/rail) renders for the authenticated user on an internal path — proving assertion C can actually detect it",
    );

    await act(async () => {
      root.unmount();
    });

    console.log("— E. gate functions also cover the share-link/print prefixes —");
    // /demo-report exercises the exact-path branch of both gates; the client
    // share links go through the prefix branch. Assert the shared gate
    // functions directly so a prefix removal can't slip past this suite.
    const { isPublicPath } = await import("../../client/src/lib/publicPaths");
    const { shouldRenderGlobalQuicklinksBar } = await import(
      "../../client/src/components/QuicklinksBar"
    );
    for (const path of ["/share/some-token", "/share/some-token/print", "/demo-report"]) {
      assert(isPublicPath(path), `E: isPublicPath("${path}") — auth/unread probes stay disabled there`);
      assert(
        !shouldRenderGlobalQuicklinksBar(path),
        `E: shouldRenderGlobalQuicklinksBar("${path}") is false — CommsShell/nav chrome stays hidden there`,
      );
    }

    console.log("public-report-no-internal-chrome: ALL TESTS PASSED");
  } catch (err) {
    failed = true;
    console.error(err);
  }
  process.exit(failed ? 1 : 0);
}

await main();
