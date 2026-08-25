/* test-registration
{
  "name": "Comms Composer live formatting preview — toggle, shared-renderer output, live updates (Task #3320)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3320: Composer live formatting preview — Eye toggle shows a panel rendered through the SAME shared renderContent used for sent messages (bold/code/list assertions), live-updates as the user types, and hides on toggle-off. Rendered jsdom test mounting the real CommsProvider + Composer; DB-free, network-free (fetch stubbed).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/composer-preview-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3320 — Composer live formatting preview.
 *
 * Mounts the REAL Composer (with the real CommsProvider) in jsdom and proves:
 *
 *   (A) the preview toggle button renders and the preview panel is hidden
 *       by default;
 *   (B) clicking the toggle shows the preview panel; with empty content it
 *       shows the "start typing" hint;
 *   (C) typing markdown into the textarea renders it through the shared
 *       renderContent — **bold** becomes a <strong>, `code` becomes a <code>,
 *       and a "- item" line becomes a <li>;
 *   (D) editing the text live-updates the preview;
 *   (E) toggling again hides the preview panel.
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
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
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

// CommsProvider opens an SSE connection on mount — stub it.
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
// Fixtures + fetch stub
// ---------------------------------------------------------------------------

const CHANNEL_ID = "ch-preview-3320";
const USER = {
  id: "user-me",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: "/api/comms/channels", json: [] },
    { method: "GET", path: "/api/comms/users", json: [] },
    { method: "GET", path: /\/api\/comms\/emoji/, json: [] },
    { method: "GET", path: new RegExp(`/api/comms/channels/${CHANNEL_ID}/draft`), json: null },
    { method: "GET", path: new RegExp(`/api/comms/channels/${CHANNEL_ID}/stats`), json: { memberCount: 2 } },
    { method: "PUT", path: new RegExp(`/api/comms/channels/${CHANNEL_ID}/draft`), json: { ok: true } },
    { method: "POST", path: new RegExp(`/api/comms/channels/${CHANNEL_ID}/typing`), json: { ok: true } },
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
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");
const { Composer } = await import("../../client/src/components/comms/Composer");

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

/** Drive the textarea like a user typing (native setter + input event). */
async function typeInto(ta: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(ta, value);
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await flush(2);
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush(2);
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
            React.createElement(Composer, {
              channelId: CHANNEL_ID,
              placeholder: "Message #general",
            }),
          ),
        ),
      ),
    );
  });
  await flush(8);

  // (A) toggle exists, preview hidden by default
  const toggle = $("toggle-preview");
  assert(toggle, "preview toggle button renders");
  assert(!$("composer-preview"), "preview panel hidden by default");

  // (B) toggle on with empty content → hint shown
  await click(toggle!);
  assert($("composer-preview"), "preview panel visible after toggle");
  assert($("composer-preview-empty"), "empty-content hint shown");

  // (C) type markdown → rendered via shared renderContent
  const ta = $("comms-composer-input") as HTMLTextAreaElement;
  assert(ta, "composer textarea renders");
  await typeInto(ta, "**bold** and `code`\n- item one");
  const preview = $("composer-preview-content");
  assert(preview, "preview content renders once text exists");
  const strong = preview!.querySelector("strong");
  assert(strong && strong.textContent === "bold", "**bold** renders as <strong>bold</strong>");
  const code = preview!.querySelector("code");
  assert(code && code.textContent === "code", "`code` renders as <code>code</code>");
  const li = preview!.querySelector("li");
  assert(li && li.textContent?.includes("item one"), "- item renders as <li>");
  assert(
    !preview!.textContent?.includes("**"),
    "raw ** markers do not appear in the rendered preview",
  );

  // (D) editing live-updates the preview
  await typeInto(ta, "*italic now*");
  const preview2 = $("composer-preview-content");
  const em = preview2?.querySelector("em");
  assert(em && em.textContent === "italic now", "preview live-updates to <em>italic now</em>");
  assert(!preview2!.querySelector("strong"), "old bold rendering removed after edit");

  // (E) toggle off hides the panel
  await click($("toggle-preview")!);
  assert(!$("composer-preview"), "preview panel hidden after toggling off");

  console.log("composer-preview.test.tsx: full composer assertions passed");
  await act(async () => root.unmount());
}

/**
 * Task #3371 — compact composers (thread replies, popups) get a trimmed
 * toolbar: bold/italic/code + preview stay, @channel/attach/schedule drop,
 * and the preview panel is height-capped so it can't crowd small popups.
 */
async function compactMain(): Promise<void> {
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
            React.createElement(Composer, {
              channelId: CHANNEL_ID,
              placeholder: "Reply…",
              compact: true,
            }),
          ),
        ),
      ),
    );
  });
  await flush(8);

  // (F) trimmed toolbar: formatting insertion buttons present in compact mode
  assert($("format-bold"), "compact: bold button renders");
  assert($("format-italic"), "compact: italic button renders");
  assert($("format-code"), "compact: code button renders");
  assert($("toggle-preview"), "compact: preview toggle renders");
  // …while the space-hungry actions stay full-view-only
  assert(!$("mention-channel"), "compact: @channel button hidden");
  assert(!$("attach-file"), "compact: attach button hidden");
  assert(!$("schedule-send-trigger"), "compact: schedule button hidden");

  // (G) bold button actually inserts markers into the compact textarea
  const ta = $("comms-composer-input") as HTMLTextAreaElement;
  assert(ta, "compact: composer textarea renders");
  await typeInto(ta, "hi");
  await act(async () => {
    ta.setSelectionRange(0, 2);
  });
  await click($("format-bold")!);
  assert(
    ta.value.includes("**"),
    `compact: bold button inserts ** markers (value: ${JSON.stringify(ta.value)})`,
  );

  // (H) preview panel is height-capped + scrollable in compact mode
  await click($("toggle-preview")!);
  const panel = $("composer-preview");
  assert(panel, "compact: preview panel visible after toggle");
  assert(
    panel!.className.includes("max-h-24") && panel!.className.includes("overflow-y-auto"),
    "compact: preview panel is height-capped and scrollable",
  );
  assert($("composer-preview-content"), "compact: preview renders typed content");

  console.log("composer-preview.test.tsx: compact composer assertions passed");
  await act(async () => root.unmount());
}

await main();
await compactMain();
console.log("composer-preview.test.tsx: all assertions passed");
process.exit(0);
