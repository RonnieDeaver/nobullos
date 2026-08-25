// Node ESM resolve hook for tests/service-desk-submit-status-fallback.test.ts.
// Redirects imports of clickUpClient, clickUpIntegration, and
// notifications/userInbox to in-memory stubs so the submit route can be
// exercised without hitting the real ClickUp API or sending notifications.
//
// Each stub re-exports the REAL module verbatim and overrides only the
// specific functions needed; when a stub itself imports the real file,
// context.parentURL is the stub's own URL, so that resolution passes
// through untouched (avoids a self-redirect loop).

const CU_STUB_URL = new URL("./sd-submit-status-fallback-cu-stub.mjs", import.meta.url).href;
const TOKEN_STUB_URL = new URL("./sd-submit-status-fallback-token-stub.mjs", import.meta.url).href;
const NOTIFY_STUB_URL = new URL("./sd-submit-status-fallback-notify-stub.mjs", import.meta.url).href;

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
      /\/server\/services\/notifications\/userInbox\.[tj]s$/.test(resolved.url) &&
      context.parentURL !== NOTIFY_STUB_URL
    ) {
      return { url: NOTIFY_STUB_URL, shortCircuit: true, format: "module" };
    }
  }
  return resolved;
}
