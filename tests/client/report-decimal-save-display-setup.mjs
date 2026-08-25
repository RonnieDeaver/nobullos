// Entry passed via `tsx --import` for report-decimal-save-display.test.tsx.
//
// The test mounts BOTH heavy report surfaces in one process:
//   1. ReportForm  — needs the ObjectUploader / InteractiveHeatmap /
//      HeatmapPicker leaf stubs (same as report-form-heavy-deps-setup.mjs).
//   2. PublicReport — needs the recharts / framer-motion / maplibre /
//      CeoPulseChartRenderer shims (same as review-velocity-render-loader.mjs).
//
// Node chains customization hooks (most recently registered runs first); the
// two loaders short-circuit disjoint specifier sets, so registering both gives
// the union. CSS + InteractiveHeatmap are handled by whichever hook sees them
// first — both stub them equivalently.

import { register } from "node:module";

register("./review-velocity-render-loader.mjs", import.meta.url);

// The ReportForm surface reaches `@/hooks/use-auth`, whose `@clerk/react`
// hooks throw outside a live <ClerkProvider>. `stubClerk: { signedIn: true }`
// lets the REAL use-auth hook fetch the DB user through the suite's fetch stub
// (which serves `/api/auth/user`), so role gating stays genuine. (The
// PublicReport surface sits on a public path, so use-auth's query stays
// disabled there regardless.)
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
