// Task #3897 — entry passed via `tsx --import` for the combined PaceCell
// reconciliation render test. Installs jsdom globals BEFORE react-dom
// evaluates (react-dom probes the environment at module-eval time and caches
// the result — see .agents/memory/jsdom-globals-before-react-dom-eval.md),
// then registers the css stub loader because the CombinedPaceCell import
// graph (MainDashboard → AdsOsShell) imports adsOs.css (Vite handles that in
// the real build; node cannot).

import { register } from "node:module";
import { JSDOM } from "jsdom";

register("./css-stub-loader.mjs", import.meta.url);

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
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
globalThis.history = dom.window.history;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Make react-dom's `"oninput" in document` support probe pass (see above).
dom.window.document.oninput = null;
