/* test-registration
{
  "name": "Comms popups desktop overflow — 768/800px + expanded rail fit one column, older popups become stacked bars clear of the rail, tap-to-promote, wide desktop unchanged (Task #3404)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3404: on desktop widths where not every 340px column fits (e.g. 768–800px with the comms rail expanded, only one fits), overflow popups must collapse into minimized bars stacked above the newest column at the rail-clearing right offset — never sliding off-screen left or overlapping the rail. Tap-to-promote works on desktop bars too. DB-free, no network.",
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
 * Task #3404 — chat popups stay on-screen when the browser window is only
 * wide enough for one column.
 *
 * On desktop widths (>= 480px) popups normally line up as 340px columns
 * left of the comms rail. When not all columns fit (e.g. 768px viewport
 * with the rail expanded: 768 − 268 offset − 8 left margin = 492px → one
 * column), the older popups must NOT slide off-screen to the left; they
 * collapse into minimized bars stacked above the newest column, aligned at
 * the same right offset so they never overlap the expanded rail.
 *
 * This test mounts the REAL CommsProvider + CommsPopupManager in jsdom with
 * the rail persisted open and three open popups and proves:
 *
 *   (A) 768px + rail expanded: only the newest popup is an expanded column
 *       at right 268; the two older popups are 40px title bars at the SAME
 *       right offset with increasing bottoms — every popup satisfies
 *       right >= 268 (clear of the rail) and right + width <= 768 (on-screen);
 *   (B) 800px + rail expanded (tightest band's upper edge): same single-column
 *       overflow geometry, still fully visible;
 *   (C) tapping an overflow bar promotes it to the expanded column slot;
 *   (D) 1400px: all three fit again (rail expanded needs 268 + 3×340 + 2×8 =
       1304px + margin) — three expanded side-by-side columns.
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
// Layout constants mirrored from CommsPopupManager.tsx.
// ---------------------------------------------------------------------------

const POPUP_WIDTH = 340;
const POPUP_TITLE_HEIGHT = 40;
const POPUP_GAP = 8;
const EXPANDED_RAIL_OFFSET = 256 + 12; // rail width + rail gap = 268

// ---------------------------------------------------------------------------
// Fixtures: rail persisted open + three open popups, ch-c newest.
// ---------------------------------------------------------------------------

const CH_A = "ch-a-3404";
const CH_B = "ch-b-3404";
const CH_C = "ch-c-3404";
const POPUPS_SS_KEY = "comms_open_popups";
const RAIL_LS_KEY = "comms_rail_open";

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

dom.window.localStorage.setItem(RAIL_LS_KEY, "true");
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
  const expanded = height > POPUP_TITLE_HEIGHT;
  return { el: el!, right, bottom, width, height, expanded };
}

function assertOverflowGeometry(viewportWidth: number): void {
  const a = popupInfo(CH_A);
  const b = popupInfo(CH_B);
  const c = popupInfo(CH_C);
  assert(c.expanded, "newest popup (charlie) is the expanded column");
  assert(!a.expanded && !b.expanded, "older popups collapse to overflow bars");
  assert(
    a.height === POPUP_TITLE_HEIGHT && b.height === POPUP_TITLE_HEIGHT,
    "overflow bars are title-bar height",
  );
  assert(
    a.right === EXPANDED_RAIL_OFFSET &&
      b.right === EXPANDED_RAIL_OFFSET &&
      c.right === EXPANDED_RAIL_OFFSET,
    `all popups sit at the expanded-rail offset ${EXPANDED_RAIL_OFFSET} ` +
      `(got ${a.right}, ${b.right}, ${c.right}) — no popup overlaps the rail`,
  );
  assert(c.bottom === 0, "newest column anchored to the bottom");
  assert(
    b.bottom > c.bottom && a.bottom > b.bottom,
    `overflow bars stack upward above the column (got bottoms ${c.bottom}, ${b.bottom}, ${a.bottom})`,
  );
  // Newest bar sits directly above the expanded column (title + body + gap).
  assert(
    b.bottom === c.height + POPUP_GAP,
    `first bar clears the expanded column (expected ${c.height + POPUP_GAP}, got ${b.bottom})`,
  );
  for (const [label, p] of [["alpha", a], ["bravo", b], ["charlie", c]] as const) {
    assert(
      p.right + p.width <= viewportWidth,
      `${label} fully on-screen at ${viewportWidth}px (right ${p.right} + width ${p.width})`,
    );
    assert(p.width === POPUP_WIDTH, `${label} keeps the 340px width (got ${p.width})`);
  }
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

  // ── A. 768px + rail expanded: one column, older popups become bars ────────
  console.log("— A. 768px + rail expanded: overflow bars stack above the single column —");
  await setViewportWidth(768);
  assertOverflowGeometry(768);

  // ── B. 800px + rail expanded: still single-column overflow, fully visible ─
  console.log("— B. 800px + rail expanded: same overflow geometry, fully visible —");
  await setViewportWidth(800);
  assertOverflowGeometry(800);

  // ── C. tapping an overflow bar promotes it to the expanded column ─────────
  console.log("— C. tapping an overflow bar promotes it to the column slot —");
  await act(async () => {
    $(`popup-title-${CH_A}`)!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  await flush();
  {
    const a = popupInfo(CH_A);
    const c = popupInfo(CH_C);
    assert(a.expanded, "promoted popup (alpha) is now the expanded column");
    assert(a.bottom === 0, "promoted popup anchored to the bottom");
    assert(!c.expanded, "previously-newest popup (charlie) is now an overflow bar");
    assert(c.bottom > 0, "demoted popup stacked above the expanded column");
    assert(
      c.right === EXPANDED_RAIL_OFFSET && c.right + c.width <= 800,
      "demoted bar stays clear of the rail and on-screen",
    );
  }

  // ── D. 1400px: all three fit — expanded side-by-side columns return ───────
  // With the rail expanded, three columns need 268 + 3×340 + 2×8 = 1304px
  // plus the 8px left margin, so 1400px comfortably fits all three.
  console.log("— D. 1400px: three expanded side-by-side columns —");
  await setViewportWidth(1400);
  {
    const a = popupInfo(CH_A);
    const b = popupInfo(CH_B);
    const c = popupInfo(CH_C);
    assert(a.expanded && b.expanded && c.expanded, "all three expanded at 1400px");
    assert(a.bottom === 0 && b.bottom === 0 && c.bottom === 0, "all bottom-anchored");
    assert(
      new Set([a.right, b.right, c.right]).size === 3,
      "three distinct horizontal offsets",
    );
  }

  await act(async () => {
    root.unmount();
  });

  console.log("comms-popup-desktop-overflow: ALL TESTS PASSED");
}

await main();
process.exit(0);
