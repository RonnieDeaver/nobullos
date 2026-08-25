// Task #2107 — entry passed via `tsx --import` so the resolve hook in
// `ceoPulseChartImageLoader.mjs` is registered before the CEO Pulse
// refine dropped-charts test imports `server/routes/reports.ts` (which
// statically imports the chart-image generator).

import { register } from "node:module";

register("./ceoPulseChartImageLoader.mjs", import.meta.url);
