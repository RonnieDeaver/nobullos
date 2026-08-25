/**
 * Task #4652 fixture — synthetic batched suite that settles green and then
 * crashes ASYNCHRONOUSLY (post-settle straggler): the Node-level timer
 * closes over its JSDOM realm and hits the legacy-IE detachEvent fallback.
 * Pre-fix the worker logged and carried on, leaving a poisoned process alive
 * for the next suite. Driven only by tests/batch-worker-realm-isolation.test.ts.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const doc = dom.window.document;

// Node timer (survives window.close()) — throws after the suite's result
// has been recorded.
setTimeout(() => {
  (doc.activeElement as any).detachEvent("onfocusout", () => {});
}, 60);

console.log("[suite-a-straggler] settled green; straggler crash armed");
