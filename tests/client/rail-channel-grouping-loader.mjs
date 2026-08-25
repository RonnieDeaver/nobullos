// Resolve hook for tests/client/rail-channel-grouping.test.tsx (Task #3366):
// redirects the CommsContext module (both the `@/contexts/CommsContext`
// alias import inside CommsRail.tsx and the test's own relative import) to
// the stub shim so the rail and the test share one lightweight context, and
// stubs the use-auth hook.

const SHIM_URL = new URL("./rail-channel-grouping-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === SHIM_URL) {
    return nextResolve(specifier, context);
  }
  if (/contexts\/CommsContext(\.tsx?)?$/.test(specifier)) {
    return { url: SHIM_URL, shortCircuit: true, format: "module" };
  }
  if (/hooks\/use-auth(\.tsx?)?$/.test(specifier)) {
    return { url: USE_AUTH_STUB, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

const USE_AUTH_STUB = "rail-grouping-stub:use-auth";

export async function load(url, context, nextLoad) {
  if (url === USE_AUTH_STUB) {
    return {
      format: "module",
      shortCircuit: true,
      source:
        "export function useAuth() { return { user: { id: 'u-me-3366', role: 'account_manager' }, isLoading: false, isAuthenticated: true }; }\n",
    };
  }
  return nextLoad(url, context);
}
