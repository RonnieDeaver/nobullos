/**
 * Task #4652 fixture — the "innocent" suite that runs after a leaky/crashing
 * sibling in the same batch child. It must start from clean globals, install
 * its own JSDOM realm, and survive focus activity. Driven only by
 * tests/batch-worker-realm-isolation.test.ts.
 */
import { JSDOM } from "jsdom";

const g = globalThis as any;
if (g.window !== undefined || g.document !== undefined) {
  throw new Error(
    "leaked jsdom realm visible: a previous suite's window/document survived into this suite",
  );
}

const dom = new JSDOM("<!doctype html><body><input id=\"target\" /></body>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;

// Focus activity — pre-fix this is what walked into a dead realm's leftover
// listener (`activeElement$1.detachEvent is not a function`).
const input = dom.window.document.getElementById("target") as any;
input.focus();
input.dispatchEvent(new (dom.window as any).FocusEvent("focusin", { bubbles: true }));

console.log("[suite-b-innocent] focus activity survived; suite green");
