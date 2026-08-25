// Entry passed via `tsx --import` so it runs before the test module's
// (hoisted, ESM) imports evaluate. Two jobs:
//
// 1. Register the shared heavy-client customization hook: Radix Dialog's
//    portal never mounts in the raw jsdom harness, so the Add/Edit bookmark
//    dialog content would never be queryable without the shared dialog shim
//    (see tests/dialog-shim.mjs).
//
// 2. Install the jsdom globals BEFORE react-dom evaluates. react-dom probes
//    the environment at module-eval time (canUseDOM, `"oninput" in document`)
//    to pick between the normal input-event path and an IE9 attachEvent
//    polyfill. If the globals are installed inline in the test file, the
//    hoisted react-dom import evaluates first with no document, React takes
//    the polyfill path, and every focus of a text input crashes with
//    "attachEvent is not a function" while onChange silently stops firing.
//    jsdom's Document also genuinely lacks an own `oninput`, so we define it
//    explicitly.

import { register } from "node:module";
import { JSDOM } from "jsdom";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { radix: ["dialog", "alert-dialog"] },
});

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Make react-dom's `"oninput" in document` support probe pass (see above).
dom.window.document.oninput = null;
