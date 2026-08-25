// Entry passed via `tsx --import` so the shared heavy-client customization hook
// is registered before the test file evaluates its dynamic import of the real
// `ReportForm` component graph.
//
// ReportForm statically imports three heavy leaf components that pull in
// browser-only deps the bare tsx/jsdom harness can't evaluate:
//   - `@/components/ObjectUploader`    → `@uppy/*` + `.css` side-effects
//   - `@/components/InteractiveHeatmap`→ `maplibre-gl` (WebGL) + its `.css`
//   - `@/components/HeatmapPicker`
// We stub each to a no-op via the shared loader. `ObjectUploader` is also used
// as a named import, so the stub publishes that named export too.
//
// ReportForm's graph also reaches `@/hooks/use-auth`, whose `@clerk/react`
// hooks throw outside a live <ClerkProvider>. `stubClerk: { signedIn: true }`
// lets the REAL use-auth hook fetch the DB user through the suite's fetch stub
// (which serves `/api/auth/user`), so role gating stays genuine.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      ObjectUploader: ["ObjectUploader"],
      InteractiveHeatmap: [],
      HeatmapPicker: [],
    },
    stubCss: true,
    stubClerk: { signedIn: true },
  },
});
