/* test-registration
{
  "name": "HeatmapPicker preview header shows client attribution (Task #2894)",
  "regression": true,
  "sweepOnlyReason": "Task #2894 — pure client-side preview-badge render regression (no DB/network); HeavyClientLoader+dialog-shim jsdom render like the #2886 sibling, not a smoke-gate candidate.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/heatmap-picker-back-button-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/components/HeatmapPicker.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2894 — the Browse tab's preview panel must show client attribution
 * next to the "Preview" header so an operator can confirm whose heatmap it is
 * before pressing "Use This Heatmap".
 *
 * Assertions:
 *   a. Previewing a snapshot WITH a linked client shows the client-name badge
 *      in the preview header.
 *   b. Previewing a snapshot WITHOUT a linked client shows the
 *      "No client linked" fallback (consistent with the browse list rows).
 *   c. Closing the preview removes the badge.
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
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).FocusEvent = (dom.window as any).FocusEvent || dom.window.Event;
(globalThis as any).PointerEvent = (dom.window as any).PointerEvent || (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  }));
if (!(dom.window.HTMLElement.prototype as any).hasPointerCapture) {
  (dom.window.HTMLElement.prototype as any).hasPointerCapture = () => false;
}
if (!(dom.window.HTMLElement.prototype as any).releasePointerCapture) {
  (dom.window.HTMLElement.prototype as any).releasePointerCapture = () => {};
}
if (!(dom.window.HTMLElement.prototype as any).setPointerCapture) {
  (dom.window.HTMLElement.prototype as any).setPointerCapture = () => {};
}
if (!(dom.window.HTMLElement.prototype as any).scrollIntoView) {
  (dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

const snapshotRows = [
  {
    id: "snap-linked",
    locationName: "Austin Office",
    keywordName: "personal injury lawyer",
    reportDate: "2026-06-01",
    gridTemplate: "7x7",
    pointsNumber: 49,
    clientName: "Acme Law Group",
    metrics: null,
  },
  {
    id: "snap-orphan",
    locationName: "Dallas Office",
    keywordName: "car accident lawyer",
    reportDate: "2026-06-01",
    gridTemplate: "7x7",
    pointsNumber: 49,
    clientName: null,
    metrics: null,
  },
];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: /\/api\/semrush\/status/, json: { configured: false, connected: false, expired: false } },
    { path: /\/api\/heatmaps\/search/, json: snapshotRows },
    { path: /\/api\/auth\/user/, json: { id: "u1", role: "ceo" } },
  ],
  defaultJson: [],
});

// ---------------------------------------------------------------------------
// Imports — must come AFTER jsdom globals + fetch stub are installed.
// ---------------------------------------------------------------------------
const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { getQueryFn } = await import("../../client/src/lib/queryClient");
const HeatmapPicker = (await import("../../client/src/components/HeatmapPicker")).default;

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function click(el: HTMLElement): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

async function main(): Promise<void> {
  const container = document.getElementById("root")!;
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: getQueryFn({ on401: "throw" }),
        retry: false,
        gcTime: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });

  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(HeatmapPicker as any, {
          open: true,
          onClose: () => {},
          onSelect: () => {},
        }),
      ),
    );
  });
  await flush(15);

  // ---- 1. Switch to the Browse Existing tab ----
  const browseTab = $("heatmap-tab-browse");
  assert(browseTab !== null, "Browse tab trigger must render");
  await act(async () => {
    browseTab!.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    browseTab!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await flush(15);

  const linkedRow = $("heatmap-snapshot-snap-linked");
  assert(linkedRow !== null, "browse list must show the linked snapshot row");
  assert(
    $("heatmap-preview-client-name") === null,
    "no preview badge should exist before any preview is opened",
  );

  // ---- 2. Preview the client-linked snapshot → badge shows client name ----
  await click($("heatmap-preview-snap-linked")!);
  await flush(10);
  const badge = $("heatmap-preview-client-name");
  assert(badge !== null, "REGRESSION: preview header has no client-name element for a client-linked snapshot");
  assert(
    badge!.textContent?.includes("Acme Law Group"),
    `preview badge must show the client name, got "${badge!.textContent}"`,
  );
  console.log("  ✓ preview of a client-linked snapshot shows the client-name badge");

  // ---- 3. Preview the orphan snapshot → 'No client linked' fallback ----
  await click($("heatmap-preview-snap-orphan")!);
  await flush(10);
  const fallback = $("heatmap-preview-client-name");
  assert(fallback !== null, "REGRESSION: preview header has no client element for an unlinked snapshot");
  assert(
    fallback!.textContent?.includes("No client linked"),
    `unlinked snapshot preview must show "No client linked", got "${fallback!.textContent}"`,
  );
  console.log("  ✓ preview of an unlinked snapshot shows the 'No client linked' fallback");

  // ---- 4. Close preview → badge goes away ----
  await click($("heatmap-close-preview")!);
  await flush(6);
  assert(
    $("heatmap-preview-client-name") === null,
    "closing the preview must remove the client-name element",
  );
  console.log("  ✓ closing the preview removes the client attribution");

  await act(async () => {
    root!.unmount();
  });

  console.log("heatmap-picker-preview-client-name: all cases passed");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
