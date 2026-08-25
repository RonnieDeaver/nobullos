// Node ESM resolve hook for the ads-os-pyramid-engine test (Task #3601).
//
// Redirects the pyramid engine's impure collaborators to stubs in
// tests/pyrStubs/ so the orchestration logic (dormant drops, rule passes,
// relevancy batching, strategist payload/guards, ai_status ladder, snapshot
// persistence, cache/single-flight) runs DB-free and network-free:
//   - enrollment.ts        -> enrollment gate + labeled campaigns from test state
//   - criteriaService.ts   -> loadCriteria from test state (derive/effective real)
//   - pyramid/queries.ts   -> fetchPyramidData from test state (termKey real)
//   - store.ts             -> in-memory pyramidBreakdownStore (others real)
//   - openai (npm package) -> fake transport via globalThis.__pyrOpenAiCreate,
//     so the REAL openAiHelper strip-and-retry + ai.ts model-not-found fallback
//     are exercised (the gpt5-param-compatibility memory note's requirement).
//
// Each TS stub `export *`s the real module and shadows only the impure parts.
// The parentURL guard lets the stubs' own imports of the real modules pass
// through un-redirected.

const STUBS = [
  ["/server/services/adsOs/enrollment.ts", new URL("./pyrStubs/enrollment.ts", import.meta.url).href],
  ["/server/services/adsOs/criteriaService.ts", new URL("./pyrStubs/criteriaService.ts", import.meta.url).href],
  ["/server/services/adsOs/pyramid/queries.ts", new URL("./pyrStubs/queries.ts", import.meta.url).href],
  ["/server/services/adsOs/store.ts", new URL("./pyrStubs/store.ts", import.meta.url).href],
];
const STUB_URLS = new Set(STUBS.map(([, url]) => url));
const OPENAI_STUB = new URL("./pyrStubs/openai.ts", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // The bare npm package: swap the specifier for the stub URL and let the rest
  // of the chain (tsx) resolve it, so tsx marks the .ts stub for transpilation.
  // No parentURL guard needed; the stub never imports the real package.
  if (specifier === "openai") {
    return nextResolve(OPENAI_STUB, context);
  }
  const resolved = await nextResolve(specifier, context);
  if (STUB_URLS.has(context?.parentURL)) return resolved; // stub -> real passthrough
  for (const [suffix, stubUrl] of STUBS) {
    if (resolved.url.endsWith(suffix)) {
      return { ...resolved, url: stubUrl, shortCircuit: true };
    }
  }
  return resolved;
}
