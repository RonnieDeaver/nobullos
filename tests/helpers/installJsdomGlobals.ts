/**
 * Task #4310 — Shared JSDOM global bootstrap for tests/client jsdom suites.
 *
 * Every client jsdom suite used to copy-paste this block; when a shared app
 * hook grew a new bare-global dependency (e.g. Task #4225 made useAuth call
 * wouter's useLocation(), which reads bare `location`/`addEventListener`),
 * dozens of suites broke identically and had to be patched one-by-one
 * (Task #4307). Centralizing here makes the next ripple a one-line fix.
 *
 * Usage (before any dynamic import of react/react-dom/app code):
 *   const dom = new JSDOM("<!doctype html>...", { pretendToBeVisual: true, url: "http://localhost/" });
 *   installJsdomGlobals(dom);
 *
 * NOTE (memory: jsdom-globals-before-react-dom-eval): suites that statically
 * import react-dom must install globals in their `--import` setup .mjs
 * instead; this helper is for suites that dynamic-import react after setup.
 */
import type { JSDOM } from "jsdom";

export function installJsdomGlobals(dom: JSDOM): void {
  const g = globalThis as any;
  const w = dom.window as any;

  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  // wouter's use-browser-location reads BARE `location` and subscribes via
  // bare addEventListener/removeEventListener/dispatchEvent (Task #4307).
  g.location = dom.window.location;
  g.history = dom.window.history;
  g.addEventListener = dom.window.addEventListener.bind(dom.window);
  g.removeEventListener = dom.window.removeEventListener.bind(dom.window);
  g.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
  g.HTMLElement = w.HTMLElement;
  g.HTMLDivElement = w.HTMLDivElement;
  g.HTMLInputElement = w.HTMLInputElement;
  g.HTMLButtonElement = w.HTMLButtonElement;
  g.HTMLAnchorElement = w.HTMLAnchorElement;
  g.Element = w.Element;
  g.Node = w.Node;
  g.DocumentFragment = w.DocumentFragment;
  g.ShadowRoot = w.ShadowRoot;
  g.Event = w.Event;
  g.MouseEvent = w.MouseEvent;
  g.KeyboardEvent = w.KeyboardEvent;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: any) => clearTimeout(id);
  w.matchMedia =
    w.matchMedia ||
    ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }));
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // Auto-accept native confirm() dialogs (e.g. Revert handlers).
  g.confirm = () => true;
  w.confirm = () => true;
}
