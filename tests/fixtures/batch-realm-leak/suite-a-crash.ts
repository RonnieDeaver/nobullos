/**
 * Task #4652 fixture — synthetic batched suite that installs a global focus
 * listener bound to its own JSDOM realm and then CRASHES at top level.
 * Driven only by tests/batch-worker-realm-isolation.test.ts through
 * tests/run-all-worker.mjs; NOT a registered test suite.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body><button id=\"b\">x</button></body>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = (dom.window as any).HTMLElement;
g.Event = (dom.window as any).Event;

// Legacy-IE fallback shape: fires on focus activity and calls detachEvent,
// which does not exist on jsdom elements — the audit-recorded ghost signature.
g.document.addEventListener("focusin", () => {
  (g.document.activeElement as any).detachEvent("onfocusout", () => {});
});

throw new Error("synthetic suite crash (batch-realm-leak fixture, Task #4652)");
