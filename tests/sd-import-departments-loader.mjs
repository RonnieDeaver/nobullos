// Node ESM resolve hook for tests/service-desk-import-departments-route.test.ts.
// Redirects imports of `server/services/clickUpClient` and
// `server/services/clickUpIntegration` to in-memory stubs so the
// import-departments route can be exercised without hitting the real ClickUp
// API or needing database token rows.
//
// The ClickUp client stub is the shared module at
// tests/vendor-stubs/clickup-stub.mjs (Task #5313 — see TESTING.md, "Shared
// vendor test stubs"); the token stub remains suite-specific.
//
// Each stub re-exports the REAL module; when a stub itself imports the real
// file, context.parentURL is the stub's own URL, so that resolution passes
// through untouched (avoids a self-redirect loop).
// Registered via `--import ./tests/sd-import-departments-loader.mjs`.

const CU_STUB_URL = new URL("./vendor-stubs/clickup-stub.mjs", import.meta.url).href;
const TOKEN_STUB_URL = new URL("./sd-import-departments-token-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved?.url) {
    if (
      /\/server\/services\/clickUpClient\.[tj]s$/.test(resolved.url) &&
      context.parentURL !== CU_STUB_URL
    ) {
      return { url: CU_STUB_URL, shortCircuit: true, format: "module" };
    }
    if (
      /\/server\/services\/clickUpIntegration\.[tj]s$/.test(resolved.url) &&
      context.parentURL !== TOKEN_STUB_URL
    ) {
      return { url: TOKEN_STUB_URL, shortCircuit: true, format: "module" };
    }
  }
  return resolved;
}
