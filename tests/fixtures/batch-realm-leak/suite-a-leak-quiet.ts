/**
 * Task #4652 fixture — synthetic batched suite that SETTLES GREEN but leaves
 * its JSDOM realm (window/document + a detonating focus listener) installed
 * on globalThis. Pre-fix, the next suite in the same batch child inherited
 * this dead realm. Driven only by tests/batch-worker-realm-isolation.test.ts.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body><input id=\"i\" /></body>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = (dom.window as any).HTMLElement;
g.Event = (dom.window as any).Event;
g.document.addEventListener("focusin", () => {
  (g.document.activeElement as any).detachEvent("onfocusout", () => {});
});

console.log("[suite-a-leak-quiet] settled green with realm left installed");
// No teardown, no process.exit — completes on import, realm leaks.
