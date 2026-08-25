// Entry passed via `tsx --import` for report-reimport-hide-other-consent.test.tsx.
//
// The test mounts the REAL ReportForm graph and drives the reimport
// consent dialog, so it needs:
//   1. The heavy browser-only leaf stubs ReportForm statically imports
//      (`ObjectUploader` → @uppy/* + .css, `InteractiveHeatmap` → maplibre-gl,
//      `HeatmapPicker`) — same as report-form-heavy-deps-setup.mjs.
//   2. The Radix Dialog shim: the import-review consent dialog renders through
//      a Portal + Presence pair that never mounts in the raw jsdom harness, so
//      without the shim `dialog-import-review` / `button-apply-import` are
//      never queryable (see tests/dialog-shim.mjs).
//   3. The Clerk seam: ReportForm's graph reaches `@/hooks/use-auth`, whose
//      `@clerk/react` hooks throw outside a live <ClerkProvider>.
//      `stubClerk: { signedIn: true }` lets the REAL use-auth hook fetch the
//      DB user through the suite's fetch stub (which serves `/api/auth/user`),
//      so role gating stays genuine.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      ObjectUploader: ["ObjectUploader"],
      InteractiveHeatmap: [],
      HeatmapPicker: [],
    },
    radix: ["dialog", "alert-dialog"],
    stubCss: true,
    stubClerk: { signedIn: true },
  },
});
