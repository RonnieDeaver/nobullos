/* test-registration
{
  "name": "Comms clients view stays mounted across view switches + incoming call auto-switch (Task #4490)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4490: two load-bearing behaviors of the Task #4373 Conversation Hub convergence into /comms had only manual verification: (1) the clients pane stays MOUNTED (CSS-hidden) after first visit so an active Twilio browser call / hub SSE stream survives switching to team chat — an innocent refactor to conditional rendering would silently drop live calls; (2) an incoming client call fires the hub's onIncomingCall prop and auto-switches Comms back to the clients view. Fast, DB-free jsdom render with a stubbed Twilio device.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-clients-view-persistence-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4490 — client texts & calls survive switching Comms views.
 *
 * Mounts the REAL Comms page (client/src/pages/Comms.tsx) in jsdom with the
 * REAL ConversationHub loaded through the page's own lazy import, and pins:
 *
 *   (A) the clients view is NOT mounted before its first visit (lazy mount);
 *   (B) selecting "Client Texts & Calls" mounts the hub pane
 *       (clients-view-pane visible, conversation-hub-root in the DOM);
 *   (C) switching to another view keeps the hub pane IN THE DOM but hidden
 *       (class "hidden", not "flex") — the hub is NOT unmounted, so an
 *       active Twilio call / the hub's SSE stream would survive the switch;
 *   (D) a ringing Twilio browser call (stub device flips incomingCall
 *       truthy) fires the hub's onIncomingCall prop and Comms auto-switches
 *       selectedView back to "clients" (pane visible again).
 *
 * Harness seams (see the -setup/-loader .mjs files): heavy Comms leaves +
 * CSS stubbed via the shared heavy-client loader; @clerk/react stubbed as a
 * signed-in session so the REAL use-auth fetches /api/auth/user through the
 * fetch stub; CommsContext redirected to the shared stub shim; useTwilioDevice
 * redirected to a test-drivable stub (globalThis.__TEST_TWILIO_DEVICE).
 * EventSource is deliberately NOT defined so the hub's SSE effect skips.
 *
 * Run with:
 *   TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx \
 *     --import ./tests/client/comms-clients-view-persistence-setup.mjs \
 *     tests/client/comms-clients-view-persistence.test.tsx
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/comms" },
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
// wouter's useBrowserLocation reads the bare `location`/`history` globals.
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
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
// NOTE: we deliberately do NOT define EventSource — ConversationHub's SSE
// effect guards on `typeof EventSource === "undefined"` and skips itself.
// We also do NOT define Notification, so the Comms first-visit desktop
// notification prompt effect skips itself.

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    // Real use-auth (Clerk stubbed signed-in) fetches the DB user through
    // this stub. Flat shape — both Comms and the hub tolerate it; role
    // gating (emoji view) is not under test here.
    { path: "/api/auth/user", json: { id: "user-1", email: "op@nobull.com", firstName: "Op", lastName: "Erator", role: "ceo" } },
    // Comms page channel-side queries.
    { path: "/api/comms/presence", json: { onlineUserIds: [] } },
    { path: "/api/comms/channels", json: [] },
    // Browser call mode — the (stubbed) device hook is what rings.
    { path: "/api/users/me/twilio-settings", json: { callMode: "browser", callRoutingPhone: "", callerIdName: "", smsSignOff: "" } },
    // Conversation Hub list queries — all empty; the hub renders its shell.
    { path: "/api/twilio/conversations", json: [] },
    { path: "/api/twilio/calls", json: [] },
    { path: "/api/twilio/threads/notes", json: [] },
    { path: "/api/twilio/threads/assignments", json: [] },
    { path: "/api/twilio/threads/read-states", json: [] },
    { path: "/api/twilio/threads/assignees", json: [] },
    { method: "POST", path: "/api/twilio/threads/assignment-notifications/mark-read", json: { ok: true } },
    { path: "/api/twilio/threads/assignment-notifications", json: [] },
    { path: "/api/twilio/config", json: { isConfigured: true, phoneNumbers: ["+15559990000"] } },
    { path: "/api/twilio/client-suggestions", json: [] },
    { path: "/api/twilio/client-contacts/search", json: [] },
    { path: "/api/clients-basic-hub", json: [] },
    { method: "POST", path: "/api/twilio/voice-presence", json: { ok: true } },
  ],
  defaultJson: {},
}) as any;

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
function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
// Redirected by the loader to the stub shim — same context instance the
// Comms page graph sees.
const { StubCommsContext } = (await import(
  "../../client/src/contexts/CommsContext"
)) as any;
const Comms = (await import("../../client/src/pages/Comms")).default;

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

// The clients pane hosts the hub behind React.lazy — the chunk import is a
// real async module eval, so poll (bounded) instead of a fixed flush count.
async function flushUntil(pred: () => boolean, what: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await flush(2);
  }
}

async function main(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const commsCtxValue = {
    addSseListener: () => () => {},
    updateNotificationSettings: async () => {},
    totalThreadUnread: 0,
    totalThreadMentions: 0,
    pinnedChannelIds: [] as string[],
    togglePin: () => {},
    myStatus: null,
    userStatuses: {},
  };
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          StubCommsContext.Provider,
          { value: commsCtxValue },
          React.createElement(TooltipProvider, null, React.createElement(Comms)),
        ),
      ),
    );
  });
  await flush();

  section("A. clients view is not mounted before first visit");
  assert($("comms-sidebar"), "Comms page mounted (sidebar renders)");
  assert(!$("clients-view-pane"), "clients-view-pane absent before first visit (lazy mount)");
  assert(!$("conversation-hub-root"), "ConversationHub not mounted before first visit");

  section("B. opening Client Texts & Calls mounts the hub pane");
  const navClients = $("nav-clients");
  assert(navClients, "sidebar nav entry nav-clients renders");
  await act(async () => {
    navClients!.click();
  });
  await flushUntil(() => !!$("conversation-hub-root"), "lazy ConversationHub to mount");
  const paneAfterOpen = $("clients-view-pane");
  assert(paneAfterOpen, "clients-view-pane mounted after selecting the clients view");
  assert(
    paneAfterOpen!.classList.contains("flex") && !paneAfterOpen!.classList.contains("hidden"),
    "clients-view-pane is visible (flex, not hidden) while selected",
  );
  assert($("conversation-hub-root"), "conversation-hub-root rendered inside the pane");

  section("C. switching views keeps the hub pane mounted but CSS-hidden");
  const navThreads = $("nav-threads");
  assert(navThreads, "sidebar nav entry nav-threads renders");
  await act(async () => {
    navThreads!.click();
  });
  await flush();
  assert($("threads-view-pane"), "threads view pane renders after switching");
  const paneHidden = $("clients-view-pane");
  assert(paneHidden, "clients-view-pane is STILL in the DOM after switching away (not unmounted)");
  assert(
    paneHidden!.classList.contains("hidden") && !paneHidden!.classList.contains("flex"),
    "clients-view-pane is CSS-hidden (class 'hidden') while another view is selected",
  );
  assert(
    $("conversation-hub-root"),
    "ConversationHub stays mounted (an active Twilio call / SSE stream would survive)",
  );

  section("D. incoming Twilio browser call auto-switches back to the clients view");
  await act(async () => {
    (globalThis as any).__TEST_TWILIO_DEVICE.setIncomingCall({
      from: "+15551230001",
      callSid: "CA-test-4490",
      receivedAt: Date.now(),
    });
  });
  await flushUntil(
    () => {
      const p = $("clients-view-pane");
      return !!p && p.classList.contains("flex") && !p.classList.contains("hidden");
    },
    "clients-view-pane to become visible after incoming call",
    15000,
  );
  const paneRinging = $("clients-view-pane");
  assert(
    paneRinging!.classList.contains("flex") && !paneRinging!.classList.contains("hidden"),
    "incoming call flips selectedView to 'clients' (pane visible again)",
  );
  assert(!$("threads-view-pane"), "threads view pane is gone (clients view selected)");

  // Clear the ring so unmount doesn't race the banner.
  await act(async () => {
    (globalThis as any).__TEST_TWILIO_DEVICE.setIncomingCall(null);
  });
  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log(`\ncomms-clients-view-persistence: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("comms-clients-view-persistence: ALL TESTS PASSED");
}

await main();
process.exit(0);
