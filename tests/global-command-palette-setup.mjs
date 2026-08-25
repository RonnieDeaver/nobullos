// Entry passed via `tsx --import` for tests/global-command-palette.test.tsx.
//
// 1. Creates the JSDOM window and installs browser globals HERE — before the
//    test module's static `react-dom/client` import evaluates. react-dom's
//    synthetic event system feature-detects the DOM at module-eval time; if
//    the globals land after that (e.g. assigned in the test file body), window
//    listeners still work but React onKeyDown/onChange handlers NEVER fire —
//    exactly what this palette test exercises through real cmdk
//    (see .agents/memory/jsdom-globals-before-react-dom-eval.md).
// 2. Registers the shared heavy-client loader to stub the heavy siblings
//    QuicklinksBar statically imports (FeedbackButton's dialog/upload stack
//    and NotificationBell's query wiring are irrelevant to palette gating),
//    maps CSS imports to empty modules, and shims the Radix dialog +
//    dropdown-menu primitives (Radix portals never mount in the raw jsdom
//    harness — see tests/dialog-shim.mjs).
// 3. Registers the existing use-auth loader (QuicklinksBar's module graph
//    evaluates @/hooks/use-auth; the stub keeps Clerk's import.meta.env reads
//    out of the bare tsx run).
//
// cmdk itself stays REAL — the palette's filtering/selection behavior is the
// thing under test.

import { register } from "node:module";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.location = dom.window.location;
globalThis.history = dom.window.history;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// cmdk scrolls the selected item into view; jsdom has no layout.
dom.window.Element.prototype.scrollIntoView = () => {};
// cmdk observes the list element's size; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;
dom.window.ResizeObserver = ResizeObserverStub;

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      FeedbackButton: [],
      NotificationBell: ["NotificationBell"],
    },
    radix: ["dialog", "dropdown-menu", "alert-dialog"],
    stubCss: true,
  },
});

register("./comms-sidebar-cmdk-use-auth-loader.mjs", import.meta.url);
