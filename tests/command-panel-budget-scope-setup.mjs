// Task #4022 — `--import` setup for
// tests/client/command-panel-budget-validation-scope.test.tsx.
//
// Registers, in order:
//   1. The shared heavyClientLoader with the same shims the GBP-location
//      CommandPanel test established (tests/command-panel-gbp-setup.mjs):
//      CommandPanel statically imports two heavy, browser-only leaf components
//      (`PdfPreviewWithSearch` → react-pdf + `.css` side-effects;
//      that the bare tsx/jsdom harness can't
//      evaluate, and renders Radix Dialog/Select primitives whose portals
//      never mount here.
//   2. The shared use-toast recording stub loader
//      (tests/dashboard-toast-stub-loader.mjs — generic despite the name: it
//      redirects any `use-toast` import by basename). The budget-validation
//      block fires ONLY a toast, so the test asserts on
//      `globalThis.__capturedToasts` to tell "save blocked with the budget
//      error" apart from "save went through" on both sides of the contract.

import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: { PdfPreviewWithSearch: [] },
    radix: ["dialog", "select", "alert-dialog"],
    stubCss: true,
  },
});

register("./dashboard-toast-stub-loader.mjs", import.meta.url);
