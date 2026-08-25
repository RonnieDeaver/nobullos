// Task #2107 — in-memory stub for `server/services/chartImageGenerator`.
//
// The CEO Pulse refine route (`server/routes/reports.ts`) imports
// `generateAndStoreChartImages`, `resolveChartPlaceholders`, and
// `checkAvailableChartImages` from that service and calls
// `generateAndStoreChartImages` after a successful refine when the saved
// analysis still has charts. The real implementation renders PNGs and
// writes them to Replit Object Storage (a live network side effect we do
// NOT want a unit test to perform). The companion resolve hook
// (`ceoPulseChartImageLoader.mjs`) redirects the route's import of
// `chartImageGenerator` to THIS module so the refine route exercises its
// real chart-drop logic without touching object storage.

// Recording buffer so a test can assert exactly which charts (and in what
// order) the route asked us to render — the real generator writes
// `chart-(i+1).png` for index `i`, so the order of this array IS the
// position→image mapping. Additive: tests that don't read it are unaffected.
export const __chartImageCalls = [];

export function __resetChartImageCalls() {
  __chartImageCalls.length = 0;
}

export async function generateAndStoreChartImages(monthKey, charts) {
  const safeCharts = Array.isArray(charts) ? charts : [];
  __chartImageCalls.push({
    monthKey,
    charts: safeCharts.map((c) => (c && typeof c === "object" ? { ...c } : c)),
  });
  return { success: true, generatedCount: safeCharts.length };
}

export function resolveChartPlaceholders(html) {
  return html;
}

export async function checkAvailableChartImages() {
  return new Set();
}

// Task #4293 — `server/services/ceoPulseSupportingImages.ts` (statically
// imported by `server/routes/reports.ts`, so it is in every refine suite's
// module graph) imports `getPublicBucketPath` from the real generator to
// build object keys for uploaded supporting images. None of the refine
// suites exercise image upload/serving, but the named export must exist or
// module instantiation fails for the whole graph. Return a fixed fake
// bucket path (never dereferenced by these suites).
export function getPublicBucketPath() {
  return "/test-bucket/public";
}
