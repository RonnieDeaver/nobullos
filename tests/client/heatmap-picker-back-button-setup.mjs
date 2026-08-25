// `--import` entry for heatmap-picker-back-button.test.tsx and
// heatmap-picker-preview-client-name.test.tsx.
//
// HeatmapPicker statically imports InteractiveHeatmap → maplibre-gl (WebGL +
// .css side-effect), which the bare tsx/jsdom harness can't evaluate.  Stub
// it out via the shared heavyClientLoader and shim the Radix Dialog portal so
// the picker's content (campaign list, Back button) is queryable.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: { InteractiveHeatmap: [] },
    radix: ["dialog", "alert-dialog"],
    stubCss: true,
  },
});
