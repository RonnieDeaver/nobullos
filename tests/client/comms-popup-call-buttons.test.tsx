/* test-registration
{
  "name": "Comms popup call buttons — enabled/in-flight/callsConfigured=false disabled states (Task #3236)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3236: popup voice/video call buttons rendered-state gate. Mounts the REAL CommsProvider + CommsPopupManager in jsdom and proves: buttons are enabled when calls are configured; clicking voice fires exactly one POST to /api/comms/channels/:id/calls and BOTH buttons disable (+aria-disabled, spinner) while it is in-flight; a 503 (LiveKit not configured) flips callsConfigured=false so buttons stay disabled after settling and no further POSTs fire. DB-free, no network (stubbed fetch/EventSource).",
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
 * Task #3236 — popup voice/video call buttons reflect callsConfigured +
 * in-flight state correctly.
 *
 * CommsPopup disables its voice/video call buttons when `startingCall` is
 * in-flight or when `callsConfigured === false` (flipped by a 503 from
 * POST /api/comms/channels/:id/calls, i.e. LiveKit not configured). This was
 * only covered by a static scan; this test mounts the REAL CommsProvider +
 * CommsPopupManager in jsdom and proves:
 *
 *   (A) with calls configured (the initial state), both buttons render
 *       enabled (disabled=false, aria-disabled="false");
 *   (B) clicking the voice button fires exactly one POST to the calls
 *       endpoint, and WHILE that POST is in-flight BOTH buttons are
 *       disabled/aria-disabled (startingCall gating) and the voice button
 *       shows its spinner; clicking video during the in-flight window fires
 *       no additional POST;
 *   (C) when the POST resolves 503 (LiveKit not configured), callsConfigured
 *       flips false: both buttons stay disabled/aria-disabled="true" even
 *       though the request has settled, and no navigation happened;
 *   (D) clicking either disabled button fires no further POSTs.
 *
 * MessagePane + Composer are stubbed via the shared heavy-client loader; the
 * provider, popup chrome, and call-button logic are the real code.
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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures: one persisted popup whose channel exists.
// ---------------------------------------------------------------------------

const CHANNEL_ID = "ch-calls-3236";
const POPUPS_SS_KEY = "comms_open_popups";

const CHANNEL = {
  id: CHANNEL_ID,
  name: "war-room",
  slug: "war-room",
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

dom.window.sessionStorage.setItem(
  POPUPS_SS_KEY,
  JSON.stringify([{ channelId: CHANNEL_ID, minimized: false }]),
);

// Gate: the calls POST does not resolve until released, so the in-flight
// (startingCall) window is deterministic.
let releaseCallPost!: () => void;
const callPostGate = new Promise<void>((resolve) => { releaseCallPost = resolve; });
let callPostCount = 0;

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: "/api/comms/channels", json: [CHANNEL] },
    {
      method: "POST",
      path: /\/api\/comms\/channels\/[^/]+\/calls$/,
      respond: async ({ jsonResponse }: any) => {
        callPostCount++;
        await callPostGate;
        // 503 = LiveKit not configured → popup flips callsConfigured=false.
        return jsonResponse(503, { message: "Calls are not configured" });
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

function voiceBtn(): HTMLButtonElement {
  const el = $(`popup-voice-call-${CHANNEL_ID}`);
  assert(el, "voice call button renders");
  return el as HTMLButtonElement;
}

function videoBtn(): HTMLButtonElement {
  const el = $(`popup-video-call-${CHANNEL_ID}`);
  assert(el, "video call button renders");
  return el as HTMLButtonElement;
}

function assertBothDisabled(phase: string): void {
  for (const [label, btn] of [["voice", voiceBtn()], ["video", videoBtn()]] as const) {
    assert(btn.disabled, `${phase}: ${label} button is disabled`);
    assert(
      btn.getAttribute("aria-disabled") === "true",
      `${phase}: ${label} button has aria-disabled="true"`,
    );
  }
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

  console.log("— A. calls configured: both buttons enabled —");
  assert($(`comms-popup-${CHANNEL_ID}`), "popup renders for the seeded channel");
  for (const [label, btn] of [["voice", voiceBtn()], ["video", videoBtn()]] as const) {
    assert(!btn.disabled, `A: ${label} button is enabled when callsConfigured`);
    assert(
      btn.getAttribute("aria-disabled") === "false",
      `A: ${label} button has aria-disabled="false" when callsConfigured`,
    );
  }

  console.log("— B. click voice: POST fires, both buttons disabled in-flight —");
  await act(async () => {
    voiceBtn().click();
  });
  await flush(2);
  assert(callPostCount === 1, `voice click fired exactly one calls POST (got ${callPostCount})`);
  assertBothDisabled("B (in-flight)");
  assert(
    voiceBtn().querySelector(".animate-spin"),
    "B: voice button shows the in-flight spinner",
  );
  // Clicking video mid-flight must not start a second call.
  await act(async () => {
    videoBtn().click();
  });
  await flush(2);
  assert(
    callPostCount === 1,
    `clicking video while a call POST is in-flight fires no extra POST (got ${callPostCount})`,
  );

  console.log("— C. POST resolves 503: callsConfigured=false keeps buttons disabled —");
  releaseCallPost();
  await flush();
  assert(
    !voiceBtn().querySelector(".animate-spin"),
    "C: spinner cleared after the POST settled",
  );
  assertBothDisabled("C (callsConfigured=false)");
  assert(
    dom.window.location.pathname === "/dashboard",
    `C: 503 does not navigate away (still on ${dom.window.location.pathname})`,
  );

  console.log("— D. disabled buttons fire no further POSTs —");
  await act(async () => {
    voiceBtn().click();
    videoBtn().click();
  });
  await flush(2);
  assert(
    callPostCount === 1,
    `no additional calls POSTs after callsConfigured=false (got ${callPostCount})`,
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("comms-popup-call-buttons: ALL TESTS PASSED");
}

await main();
process.exit(0);
