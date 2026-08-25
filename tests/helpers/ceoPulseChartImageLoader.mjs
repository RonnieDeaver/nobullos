// Task #2107 — Node ESM resolve hook that redirects the CEO Pulse refine
// route's static `import("../services/chartImageGenerator")` to the
// in-memory stub (`ceoPulseChartImageStub.mjs`). Registered via
// `--import ./tests/helpers/ceoPulseChartImageSetup.mjs` so it is active
// before `tests/ceo-pulse-refine-dropped-charts.test.ts` imports
// `server/routes/reports.ts`. This keeps the chart-drop unit test off the
// real object-storage write path without per-test monkey-patching of an
// ESM named export (which is immutable and cannot be reassigned at
// runtime).

const STUB_URL = new URL("./ceoPulseChartImageStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/services\/chartImageGenerator\.[tj]s$/.test(resolved.url)
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
