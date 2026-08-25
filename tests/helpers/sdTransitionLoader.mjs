// Node ESM resolve hook for tests/sd-transition-waiting-fields.test.ts.
// Redirects imports of `server/services/clickUpClient` and
// `server/services/clickUpIntegration` to in-memory stubs so the
// service-desk transition route can be driven end-to-end without hitting
// the real ClickUp API. Each stub re-exports the REAL module; when a stub
// itself imports the real file, context.parentURL is the stub's own URL,
// so that resolution passes through untouched (avoids a self-redirect
// loop). Registered via `--import ./tests/helpers/sdTransitionSetup.mjs`.

const CU_STUB_URL = new URL("./sdTransitionClickUpStub.mjs", import.meta.url).href;
const TOKEN_STUB_URL = new URL("./sdTransitionTokenStub.mjs", import.meta.url).href;

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
