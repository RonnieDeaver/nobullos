// Entry passed via `tsx --import` so the shared heavy-client customization
// hook is registered before the test file evaluates its dynamic imports of the
// real CommandPanel component graph.
//
// CommandPanel statically imports two heavy, browser-only leaf components
// (`PdfPreviewWithSearch` → react-pdf + `.css` side-effects;
// that the bare tsx/jsdom harness can't evaluate, and
// renders Radix Dialog/Select primitives whose portals never mount here. We stub
// the leaves and shim those two Radix primitives via the shared loader.

import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: { PdfPreviewWithSearch: [] },
    radix: ["dialog", "select", "alert-dialog"],
    stubCss: true,
  },
});
