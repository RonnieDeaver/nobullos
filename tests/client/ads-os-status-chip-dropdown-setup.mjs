// Entry passed via `tsx --import` for tests/client/ads-os-status-chip-dropdown.test.tsx.
//
// Installs jsdom globals BEFORE react-dom evaluates (react-dom probes the
// environment at module-eval time and caches the result — see
// .agents/memory/jsdom-globals-before-react-dom-eval.md), then registers the
// CSS stub loader so any transitively imported .css file does not crash node.

import { register } from "node:module";
import { JSDOM } from "jsdom";

register("./css-stub-loader.mjs", import.meta.url);

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div><div id='outside'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Make react-dom's `"oninput" in document` support probe pass.
dom.window.document.oninput = null;
