/* test-registration
{
  "name": "Comms popups on narrow viewports — vertical stack, newest expands, tap-to-promote, desktop unchanged (Task #3352)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3352: on viewports < 480px multiple open popups used to stack horizontally and slide off-screen. Guard: narrow viewports stack popups vertically at the right edge — only the newest expands, older popups render as minimized bars above it, tapping a bar promotes that chat to the expanded slot, and desktop (>= 480px) keeps up to 3 side-by-side. DB-free, no network (stubbed fetch/EventSource).",
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
 * Task #3352 — multiple open chat popups stay usable on phones.
 *
 * On viewports < 480px only one popup fits side-to-side, so instead of
 * stacking horizontally (older popups sliding off-screen to the left),
 * CommsPopupManager stacks popups VERTICALLY at the right edge: only the
 * newest (last-opened) popup can expand; every older popup renders as a
 * minimized title bar above it. Tapping an older bar promotes that chat to
 * the newest (expanded) slot. Desktop behavior is unchanged.
 *
 * This test mounts the REAL CommsProvider + CommsPopupManager in jsdom with
 * three open popups and proves:
 *
 *   (A) desktop (1024px): all three popups expand side-by-side — distinct
 *       `right` offsets, same `bottom: 0`, all with bodies;
 *   (B) narrow (375px): only the newest popup has a body; the two older
 *       popups are title bars (no body) with the SAME right offset but
 *       increasing `bottom` offsets — all fully on-screen widths;
 *   (C) tapping an older bar's title promotes it: it becomes the expanded
 *       bottom popup and the previously-newest popup becomes a bar;
 *   (D) resizing back to desktop restores three expanded side-by-side popups.
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
// Fixtures: three open popups, ch-c newest.
// ---------------------------------------------------------------------------

const CH_A = "ch-a-3352";
const CH_B = "ch-b-3352";
const CH_C = "ch-c-3352";
const POPUPS_SS_KEY = "comms_open_popups";

function makeChannel(id: string, name: string) {
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
    unreadCount: 0,
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
    { path: "/api/comms/channels", json: CHANNELS },
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

function popupInfo(channelId: string) {
  const el = $(`comms-popup-${channelId}`);
  assert(el, `popup for ${channelId} is rendered`);
  const style = el!.style;
  const right = parseFloat(style.right || "0");
  const bottom = parseFloat(style.bottom || "0");
  const width = parseFloat(style.width || "0");
  const height = parseFloat(style.height || "0");
  // MessagePane/Composer are stubbed to null, so expansion is asserted via
  // the popup's height: 40 (title bar only) vs 420 (title + body).
  const expanded = height > 40;
  return { el: el!, right, bottom, width, height, expanded };
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
            <CommsPopupManager currentUserId="user-1" />
          </CommsProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await flush();

  // ── A. desktop: three expanded popups side-by-side ────────────────────────
  // 1200px fits all three 340px columns (56 + 3×340 + 2×8 = 1092); tighter
  // desktop widths overflow into stacked bars (covered by the
  // comms-popup-desktop-overflow test).
  console.log("— A. desktop 1200px: three expanded popups side-by-side —");
  await setViewportWidth(1200);
  {
    const a = popupInfo(CH_A);
    const b = popupInfo(CH_B);
    const c = popupInfo(CH_C);
    assert(a.expanded && b.expanded && c.expanded, "all three popups expanded on desktop");
    assert(a.bottom === 0 && b.bottom === 0 && c.bottom === 0, "all bottom-anchored on desktop");
    assert(
      a.right > b.right && b.right > c.right,
      `distinct horizontal offsets, newest right-most (got ${a.right}, ${b.right}, ${c.right})`,
    );
    assert(a.width === 340 && c.width === 340, "desktop width unchanged (340)");
  }

  // ── B. narrow: newest expands, older become stacked bars ──────────────────
  console.log("— B. narrow 375px: newest expanded, older popups are stacked bars —");
  await setViewportWidth(375);
  {
    const a = popupInfo(CH_A);
    const b = popupInfo(CH_B);
    const c = popupInfo(CH_C);
    assert(c.expanded, "newest popup (charlie) is expanded");
    assert(!a.expanded && !b.expanded, "older popups collapse to bars");
    assert(a.height === 40 && b.height === 40, "older popups are title-bar height");
    assert(
      a.right === b.right && b.right === c.right,
      "narrow: all popups share the same right offset (no horizontal stacking)",
    );
    assert(c.bottom === 0, "newest popup anchored to the bottom");
    assert(
      b.bottom > c.bottom && a.bottom > b.bottom,
      `older bars stack upward (got bottoms ${c.bottom}, ${b.bottom}, ${a.bottom})`,
    );
    assert(
      a.width + a.right <= 375 && a.width > 0,
      `bars fit on-screen (width ${a.width} + right ${a.right} <= 375)`,
    );
  }

  // ── C. tapping an older bar promotes it to the expanded slot ──────────────
  console.log("— C. tapping an older bar promotes it to the expanded slot —");
  await act(async () => {
    $(`popup-title-${CH_A}`)!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  await flush();
  {
    const a = popupInfo(CH_A);
    const c = popupInfo(CH_C);
    assert(a.expanded, "promoted popup (alpha) is now expanded");
    assert(a.bottom === 0, "promoted popup anchored to the bottom");
    assert(!c.expanded, "previously-newest popup (charlie) is now a bar");
    assert(c.bottom > 0, "demoted popup stacked above the expanded one");
  }

  // ── D. resize back to desktop restores side-by-side ───────────────────────
  console.log("— D. resize back to desktop restores three expanded popups —");
  await setViewportWidth(1200);
  {
    const a = popupInfo(CH_A);
    const b = popupInfo(CH_B);
    const c = popupInfo(CH_C);
    assert(a.expanded && b.expanded && c.expanded, "all three expanded again on desktop");
    assert(a.bottom === 0 && b.bottom === 0 && c.bottom === 0, "all bottom-anchored again");
    const rights = [a.right, b.right, c.right];
    assert(new Set(rights).size === 3, "three distinct horizontal offsets restored");
  }

  await act(async () => {
    root.unmount();
  });

  console.log("comms-popup-narrow-stack: ALL TESTS PASSED");
}

await main();
process.exit(0);
