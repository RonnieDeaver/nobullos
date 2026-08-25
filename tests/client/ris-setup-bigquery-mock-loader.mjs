// Node ESM resolve hook that redirects bare imports of `@radix-ui/react-select`
// and `@radix-ui/react-popover` to inline test shims (see
// `ris-setup-select-shim.mjs` / `ads-hygiene-popover-shim.mjs`). Radix Select
// and Popover never portal into the raw jsdom harness, so without this the
// RIS Setup panel's client picker and the Ads Hygiene account combobox
// (Task #3091) never become queryable.
// Registered via `--import ./tests/client/ris-setup-bigquery-mock-setup.mjs`.
//
// The mounted RisDashboard graph also reaches `@/hooks/use-auth`, whose
// `@clerk/react` hooks throw outside a live <ClerkProvider>. This loader stubs
// `@clerk/react` with a signed-in session (the STUB_CLERK pattern from
// tests/helpers/heavyClientLoader.mjs — `useAuth` + `useClerk` only) so the
// REAL use-auth hook fetches the DB user through the suite's fetch stub (which
// serves `/api/auth/user`) and the RIS manage gate stays genuine.

const SELECT_SHIM_URL = new URL("./ris-setup-select-shim.mjs", import.meta.url).href;
const POPOVER_SHIM_URL = new URL("./ads-hygiene-popover-shim.mjs", import.meta.url).href;
const STUB_CLERK = "ris-setup-bigquery-mock:clerk-react";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@radix-ui/react-select") {
    return { url: SELECT_SHIM_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "@radix-ui/react-popover") {
    return { url: POPOVER_SHIM_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "@clerk/react") {
    return { url: STUB_CLERK, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_CLERK) {
    // Only the two hooks `@/hooks/use-auth` imports. A loaded, signed-in
    // session; sign-out is a no-op.
    const source = `
export function useAuth() { return { isLoaded: true, isSignedIn: true }; }
export function useClerk() { return { signOut: async () => {} }; }
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
