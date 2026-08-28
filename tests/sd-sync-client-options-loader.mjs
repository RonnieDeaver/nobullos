// ESM resolve hook for tests/sd-sync-client-options.test.ts (Task #3571).
// Redirects three modules to in-memory stubs so the sync + accept routes can
// be exercised without real ClickUp API calls, database token rows, or OpenAI.
//
// Stubs:
//   vendor-stubs/clickup-stub.mjs            → clickUpClient (shared module,
//     Task #5313 — see TESTING.md, "Shared vendor test stubs")
//   sd-sync-client-options-token-stub.mjs   → clickUpIntegration
//   sd-sync-client-options-openai-stub.mjs  → routes/middleware (openai only)

const CU_STUB_URL = new URL("./vendor-stubs/clickup-stub.mjs", import.meta.url).href;
const TOKEN_STUB_URL = new URL("./sd-sync-client-options-token-stub.mjs", import.meta.url).href;
const OPENAI_STUB_URL = new URL("./sd-sync-client-options-openai-stub.mjs", import.meta.url).href;

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
    if (
      /\/server\/routes\/middleware\.[tj]s$/.test(resolved.url) &&
      context.parentURL !== OPENAI_STUB_URL
    ) {
      return { url: OPENAI_STUB_URL, shortCircuit: true, format: "module" };
    }
  }
  return resolved;
}
