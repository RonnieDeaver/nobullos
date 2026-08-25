// Resolve hook for tests/client/comms-sidebar-pin-collapse.test.tsx:
// redirects the CommsContext module (both the `@/contexts/CommsContext`
// alias import inside Comms.tsx and the test's own relative import) to the
// stub shim so the sidebar and the test share one lightweight context.

const SHIM_URL = new URL("./comms-sidebar-pin-collapse-shim.mjs", import.meta.url).href;

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

const USE_AUTH_STUB = "comms-sidebar-stub:use-auth";

export async function load(url, context, nextLoad) {
  if (url === USE_AUTH_STUB) {
    return {
      format: "module",
      shortCircuit: true,
      source:
        "export function useAuth() { return { user: null, isLoading: false, isAuthenticated: true }; }\n",
    };
  }
  return nextLoad(url, context);
}
