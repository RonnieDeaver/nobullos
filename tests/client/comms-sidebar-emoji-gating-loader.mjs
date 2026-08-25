// Resolve hook for tests/client/comms-sidebar-emoji-gating.test.tsx:
// - redirects CommsContext to the shared pin-collapse stub shim (same
//   lightweight context instance for Comms.tsx and the test), and
// - stubs @/hooks/use-auth with a role-switchable useAuth that reads
//   globalThis.__TEST_AUTH_ROLE on every render, so the test can remount
//   the sidebar as different roles.

const SHIM_URL = new URL("./comms-sidebar-pin-collapse-shim.mjs", import.meta.url).href;
const USE_AUTH_STUB = "comms-sidebar-emoji-gating-stub:use-auth";

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

export async function load(url, context, nextLoad) {
  if (url === USE_AUTH_STUB) {
    return {
      format: "module",
      shortCircuit: true,
      source: [
        "export function useAuth() {",
        "  const role = globalThis.__TEST_AUTH_ROLE;",
        "  const user = role === undefined ? null : { dbUser: { role } };",
        "  return { user, isLoading: false, isAuthenticated: true };",
        "}",
        "",
      ].join("\n"),
    };
  }
  return nextLoad(url, context);
}
