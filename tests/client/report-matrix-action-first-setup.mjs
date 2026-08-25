// Entry passed via `tsx --import` for report-matrix-action-first-render.test.tsx.
//
// The test mounts TWO real report surfaces in one process:
//   1. ReportMatrix — light graph (OsTable, StatusPill, HideDemoToggle), but
//      it reaches `@/hooks/use-auth`, whose `@clerk/react` hooks throw outside
//      a live <ClerkProvider>.
//   2. ReportForm — statically imports three heavy leaf components the bare
//      tsx/jsdom harness can't evaluate (ObjectUploader → @uppy/* + css,
//      InteractiveHeatmap → maplibre-gl/WebGL, HeatmapPicker).
//
// `stubClerk: { signedIn: true }` lets the REAL use-auth hook fetch the DB
// user through the suite's fetch stub (which serves `/api/auth/user`), so
// role gating stays genuine (same seam as report-form-heavy-deps-setup.mjs).

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
