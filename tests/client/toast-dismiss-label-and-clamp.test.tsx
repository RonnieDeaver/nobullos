/* test-registration
{
  "name": "Toast kit: dismiss-button aria-label + viewport clamp classes (Task #4694)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4694: the shared shadcn toast kit is used by every surface; a kit refresh can silently drop the close button's aria-label (screen-reader regression, Task #4688) or the wrap/clamp classes (375px mobile overflow). This jsdom mount test pins both: close control is a real <button> with a non-empty aria-label, content wrapper keeps min-w-0 + break-words, toast root keeps max-w-full. Fast, DB-free, network-free.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4694 — guard the toast kit's accessibility + mobile-clamp contract.
 *
 * Task #4688 added aria-label="Dismiss notification" to the shared ToastClose
 * button and clamped toasts at 375px (min-w-0 + break-words on the content
 * wrapper in toaster.tsx; max-w-full on the toast root in toast.tsx). A future
 * shadcn kit refresh could silently revert either. This test mounts the real
 * <Toaster /> in jsdom, fires a toast through the real use-toast store, and
 * asserts:
 *   - the close control is a real <button> element;
 *   - it carries a non-empty aria-label;
 *   - the content wrapper (parent of the title) has min-w-0 and break-words;
 *   - the toast root (role=status listitem) has max-w-full.
 *
 * Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json (client render tests need
 * the tests tsconfig for the automatic JSX runtime).
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" }
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// react/react-dom must be imported AFTER the jsdom globals exist (react-dom
// probes the environment at module-eval time) — hence dynamic imports.
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("../../client/src/components/ui/toaster");
const { toast } = await import("../../client/src/hooks/use-toast");

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

function classList(el: Element | null): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

const root = createRoot(document.getElementById("root")!);
try {
  await act(async () => {
    root.render(React.createElement(Toaster));
  });
  await act(async () => {
    toast({
      title: "Guard toast title",
      description: "averyverylongunbrokentokenthatwouldoverflowat375pxwithoutbreakwords",
    });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  console.log("\n— Dismiss button accessibility —");
  const closeEl = document.querySelector("[toast-close]");
  assert(closeEl !== null, "close control is rendered");
  assert(
    closeEl instanceof dom.window.HTMLButtonElement &&
      closeEl.tagName === "BUTTON",
    "close control is a real <button> element"
  );
  const ariaLabel = closeEl?.getAttribute("aria-label") ?? "";
  assert(
    ariaLabel.trim().length > 0,
    `close button has a non-empty aria-label (got: ${JSON.stringify(ariaLabel)})`
  );

  console.log("\n— Viewport clamp classes (Task #4688) —");
  // Content wrapper: the direct parent of the title carries min-w-0 + break-words.
  const titleEl = Array.from(document.querySelectorAll("div, span")).find(
    (el) => el.textContent === "Guard toast title" && el.children.length === 0
  );
  assert(titleEl != null, "toast title is rendered");
  const wrapper = titleEl?.parentElement ?? null;
  const wrapperClasses = classList(wrapper);
  assert(
    wrapperClasses.includes("min-w-0"),
    "content wrapper has min-w-0 (allows shrinking below intrinsic width)"
  );
  assert(
    wrapperClasses.includes("break-words"),
    "content wrapper has break-words (long tokens wrap at 375px)"
  );

  // Toast root: the Radix Root <li> carries max-w-full.
  const toastRoot = wrapper?.closest("li") ?? null;
  assert(toastRoot !== null, "toast root <li> is rendered");
  assert(
    classList(toastRoot).includes("max-w-full"),
    "toast root has max-w-full (clamped to the viewport)"
  );
} finally {
  await act(async () => {
    root.unmount();
  });
}

console.log(`\nTest results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
