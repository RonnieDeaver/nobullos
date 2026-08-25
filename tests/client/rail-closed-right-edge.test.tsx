/* test-registration
{
  "name": "Rail closed state — zero-width w-0 panel, no full-height right-edge blocker >10px, edge tab clickable (Task #3334)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3334: closed chat rail must not block the Sheets editor's right edge. Mounts the REAL CommsRail in the REAL CommsProvider (closed state) and asserts the rail panel is w-0 + pointer-events-none, no full-height fixed right-0 element is wider than ~10px (the old 48px strip regression), the closed affordance is the small h-16 edge tab, and open/collapse toggling restores the safe closed classes. DB-free, stubbed fetch/SSE.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/rail-closed-right-edge-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3334 — rightmost Sheets editor controls are clickable when the chat
 * rail is closed.
 *
 * Regression under guard: the old collapsed chat rail was a 48px full-height
 * fixed strip pinned to the right edge, which sat on top of the Sheets
 * editor's rightmost cells and vertical scrollbar and blocked clicks. It was
 * replaced by a zero-width closed panel plus a small (h-16, non-full-height)
 * edge tab. This test mounts the REAL CommsRail inside the REAL CommsProvider
 * (closed state — no localStorage flag) and proves:
 *
 *   (1) The rail container (`comms-rail`) renders with data-rail-open=false,
 *       zero width (w-0), pointer-events-none, and overflow-hidden — so it
 *       cannot intercept clicks on content beneath it.
 *   (2) No full-height fixed element pinned to right:0 is wider than ~10px:
 *       every element styled `fixed` + `right-0` that spans the full viewport
 *       height (top-*+bottom-0 or inset-y-0) must be zero-width while closed.
 *   (3) The closed-state affordance is the small edge tab (h-16, w-5), NOT a
 *       full-height strip.
 *   (4) Clicking the edge tab opens the rail (data-rail-open=true, w-64) and
 *       clicking collapse returns it to the safe zero-width closed state —
 *       proving the closed-state classes are the real toggle wiring, not
 *       dead markup.
 *
 * jsdom has no layout engine, so "width" and "full height" are asserted from
 * the Tailwind utility classes that produce them (w-0 / w-64 / h-16, top-14 +
 * bottom-0). DB-free, network stubbed.
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

// The real CommsProvider opens an SSE stream — stub EventSource entirely.
class EventSourceStub {
  onopen: any = null;
  onerror: any = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as any).EventSource = EventSourceStub;
(dom.window as any).EventSource = EventSourceStub;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const USER = {
  id: "user-3334",
  email: "am@nobull.test",
  firstName: "Rail",
  lastName: "Tester",
  role: "account_manager",
};

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { path: "/api/comms/channels/archived", json: [] },
    { path: "/api/comms/channels", json: [] },
    { path: "/api/comms/drafts", json: [] },
    { path: "/api/comms/users", json: [] },
    { path: "/api/comms/threads/unread-summary", json: { totalUnreadReplies: 0, totalMentions: 0 } },
    { path: "/api/comms/threads", json: [] },
    { path: "/api/comms/sidebar-categories", json: [] },
    { path: "/api/comms/status/me", json: null },
    { path: "/api/comms/notification-settings", json: {} },
  ],
  defaultJson: {},
}) as any;

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");
const { CommsRail } = await import("../../client/src/components/comms/CommsRail");

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

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** Tailwind fixed elements pinned to the right edge that span full height. */
function fullHeightRightEdgeElements(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    const cls = classes(el);
    if (!cls.includes("fixed")) continue;
    if (!cls.includes("right-0")) continue;
    const fullHeight =
      cls.includes("inset-y-0") ||
      cls.includes("h-screen") ||
      (cls.includes("bottom-0") && cls.some((c) => /^top-/.test(c)));
    if (fullHeight) out.push(el);
  }
  return out;
}

/** Width in px implied by a Tailwind w-N class (4px scale); null if none. */
function tailwindWidthPx(el: Element): number | null {
  for (const c of classes(el)) {
    const m = /^w-(\d+(?:\.\d+)?)$/.exec(c);
    if (m) return parseFloat(m[1]) * 4;
  }
  return null;
}

async function main(): Promise<void> {
  // Closed state: no comms_rail_open flag in localStorage.
  localStorage.removeItem("comms_rail_open");

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  queryClient.setQueryData(["/api/auth/user"], USER);

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
            React.createElement(CommsRail, null),
          ),
        ),
      ),
    );
  });
  await flush();

  console.log("— 1. closed rail is zero-width and click-transparent —");
  const rail = $("comms-rail");
  assert(rail, "comms-rail container renders");
  assert(
    rail!.getAttribute("data-rail-open") === "false",
    `rail is closed by default (data-rail-open=${rail!.getAttribute("data-rail-open")})`,
  );
  const railCls = classes(rail!);
  assert(railCls.includes("w-0"), "closed rail has zero width (w-0)");
  assert(
    railCls.includes("pointer-events-none"),
    "closed rail is click-transparent (pointer-events-none)",
  );
  assert(
    railCls.includes("overflow-hidden"),
    "closed rail clips its content (overflow-hidden)",
  );
  assert(
    rail!.getAttribute("aria-hidden") === "true",
    "closed rail is aria-hidden",
  );

  console.log("— 2. no full-height fixed right-edge element wider than ~10px —");
  const edgeEls = fullHeightRightEdgeElements();
  assert(
    edgeEls.length >= 1,
    "the rail panel itself is detected by the right-edge scan (scan is live)",
  );
  for (const el of edgeEls) {
    const w = tailwindWidthPx(el);
    assert(
      w !== null,
      `full-height fixed right-0 element has an explicit width class (testid=${el.getAttribute("data-testid") ?? el.tagName})`,
    );
    assert(
      w! <= 10,
      `full-height fixed right-0 element is <=10px wide while rail is closed — got ${w}px on ${el.getAttribute("data-testid") ?? el.tagName} (a wider strip would cover the Sheets editor's rightmost cells/scrollbar)`,
    );
  }

  console.log("— 3. the closed-state affordance is a small edge tab, not a strip —");
  const tab = $("rail-expand-button");
  assert(tab, "edge tab (rail-expand-button) renders while closed");
  const tabCls = classes(tab!);
  assert(tabCls.includes("h-16"), "edge tab is h-16 (64px), not full-height");
  assert(
    !tabCls.includes("bottom-0") && !tabCls.includes("inset-y-0") && !tabCls.includes("h-screen"),
    "edge tab does not span the full viewport height",
  );
  assert(
    !tabCls.includes("pointer-events-none"),
    "edge tab remains clickable while the rail is closed",
  );

  console.log("— 4. toggle open → w-64; collapse → back to safe closed state —");
  await act(async () => {
    tab!.click();
  });
  await flush(2);
  assert(
    rail!.getAttribute("data-rail-open") === "true",
    "clicking the edge tab opens the rail",
  );
  const openCls = classes($("comms-rail")!);
  assert(openCls.includes("w-64"), "open rail is w-64");
  assert(!openCls.includes("w-0"), "open rail no longer has w-0");

  const collapseBtn = $("rail-collapse-button");
  assert(collapseBtn, "collapse button renders in the open rail");
  await act(async () => {
    collapseBtn!.click();
  });
  await flush(2);
  const railAfter = $("comms-rail");
  assert(
    railAfter!.getAttribute("data-rail-open") === "false",
    "collapse returns the rail to closed",
  );
  const closedAgain = classes(railAfter!);
  assert(
    closedAgain.includes("w-0") && closedAgain.includes("pointer-events-none"),
    "re-closed rail is again zero-width and click-transparent",
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("rail-closed-right-edge: ALL TESTS PASSED");
}

await main();
process.exit(0);
