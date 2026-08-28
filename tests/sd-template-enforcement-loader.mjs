// Node ESM resolve hook for the service-desk template-enforcement smoke test
// (Task #3395).
//
// Redirects:
//   server/services/clickUpClient      → recording ClickUp API stub
//   server/services/clickUpIntegration → getAccessToken stub
//
// The ClickUp client stub is the shared module at
// tests/vendor-stubs/clickup-stub.mjs (Task #5313 — see TESTING.md, "Shared
// vendor test stubs"); it also serves service-desk-submit-status-fallback,
// so the `?stubMode=template-enforcement` query picks this suite's
// ledger/return shape for the two ClickUp functions both suites override
// (createChecklist/createChecklistItem/updateTask).
//
// Each stub `export *`s the real module and overrides only the functions the
// template-enforcement path calls; the stubs' own re-export imports must pass
// straight through or resolution loops forever.

const CLIENT_STUB_URL = new URL(
  "./vendor-stubs/clickup-stub.mjs?stubMode=template-enforcement",
  import.meta.url,
).href;
const INTEGRATION_STUB_URL = new URL(
  "./sd-template-enforcement-integration-stub.mjs",
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  // The stubs re-exporting the real modules must pass straight through.
  if (context.parentURL === CLIENT_STUB_URL || context.parentURL === INTEGRATION_STUB_URL) {
    return resolved;
  }
  if (/\/server\/services\/clickUpClient\.[tj]s$/.test(resolved.url)) {
    return { url: CLIENT_STUB_URL, shortCircuit: true, format: "module" };
  }
  if (/\/server\/services\/clickUpIntegration\.[tj]s$/.test(resolved.url)) {
    return { url: INTEGRATION_STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
