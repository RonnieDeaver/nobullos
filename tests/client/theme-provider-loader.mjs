// Resolve hook for tests/client/theme-provider-switch-persist.test.ts
// (Task #4377). Redirects, by suffix (so both the `@/` alias and any
// tsx-resolved absolute form hit the stubs):
//   - hooks/use-auth   → theme-provider-use-auth-stub.mjs
//   - lib/queryClient  → theme-provider-queryclient-stub.mjs
// Never redirects the stubs' own imports (parentURL check) to avoid loops.

const AUTH_STUB_URL = new URL("./theme-provider-use-auth-stub.mjs", import.meta.url).href;
const QC_STUB_URL = new URL("./theme-provider-queryclient-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === AUTH_STUB_URL || context.parentURL === QC_STUB_URL) {
    return nextResolve(specifier, context);
  }
  const cleaned = specifier.replace(/\.(tsx?|jsx?)$/, "");
  if (cleaned.endsWith("hooks/use-auth")) {
    return { url: AUTH_STUB_URL, shortCircuit: true, format: "module" };
  }
  if (cleaned.endsWith("lib/queryClient")) {
    return { url: QC_STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
