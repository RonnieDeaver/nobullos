// Node ESM resolve hook for tests/client/ads-hygiene-reconnect-banner.test.tsx.
// Extends the RIS setup pattern (`ris-setup-bigquery-mock-loader.mjs`):
// - `@radix-ui/react-select` → inline select shim (legacy run picker)
// - `@radix-ui/react-popover` + `cmdk` → inline combobox shims, because
//   Task #3091 replaced the account picker's plain Select with a searchable
//   Popover+Command combobox that never portals into the bare jsdom harness.
const SELECT_SHIM_URL = new URL("./ris-setup-select-shim.mjs", import.meta.url).href;
const POPOVER_SHIM_URL = new URL("./ads-hygiene-popover-shim.mjs", import.meta.url).href;
const CMDK_SHIM_URL = new URL("./ads-hygiene-cmdk-shim.mjs", import.meta.url).href;

// The /admin/ads-hygiene page graph reaches `@/hooks/use-auth`, whose
// @clerk/react hooks throw outside a live <ClerkProvider>. Stub the bare
// `@clerk/react` package with a signed-in session (only the two hooks
// use-auth imports), mirroring heavyClientLoader.mjs's STUB_CLERK pattern —
// the REAL use-auth hook then fetches /api/auth/user through the test's fetch
// stub so role gating stays genuine.
const STUB_CLERK = "ads-hygiene-stub:clerk-react";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@radix-ui/react-select") {
    return { url: SELECT_SHIM_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "@radix-ui/react-popover") {
    return { url: POPOVER_SHIM_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "cmdk") {
    return { url: CMDK_SHIM_URL, shortCircuit: true, format: "module" };
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
