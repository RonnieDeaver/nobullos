// Task #866 — Node ESM resolve hook used by the
// `scheduling-panel-failure-modes` test to redirect bare-specifier
// imports of `rrule` to the local shim (see `rrule-shim.mjs`).
// Registered via `--import ./tests/client/setup-mocks.mjs`.

//
// The mounted graph also reaches `@/hooks/use-auth`, whose `@clerk/react`
// hooks throw outside a live <ClerkProvider>. This loader stubs `@clerk/react`
// with a signed-OUT session (the STUB_CLERK pattern from
// tests/helpers/heavyClientLoader.mjs — `useAuth` + `useClerk` only). This
// suite does not care about roles (its `/api/auth/user` route returns 401),
// and signed-out keeps use-auth's `/api/auth/user` query disabled (no fetch).

import { fileURLToPath } from "node:url";

const SHIM_URL = new URL("./rrule-shim.mjs", import.meta.url).href;
const SHIM_PATH = fileURLToPath(SHIM_URL);
const STUB_CLERK = "scheduling-panel-mock:clerk-react";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "rrule") {
    // Don't redirect the shim's own internal `require("rrule")` —
    // createRequire goes through CJS resolution, not this hook, so
    // there's no real loop to guard against, but we still skip when
    // the parent is the shim file itself just to be defensive.
    const parent = context?.parentURL ? fileURLToPath(context.parentURL) : "";
    if (parent !== SHIM_PATH) {
      return { url: SHIM_URL, shortCircuit: true, format: "module" };
    }
  }
  if (specifier === "@clerk/react") {
    return { url: STUB_CLERK, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_CLERK) {
    // Only the two hooks `@/hooks/use-auth` imports. A loaded, signed-OUT
    // session (query disabled — no fetch); sign-out is a no-op.
    const source = `
export function useAuth() { return { isLoaded: true, isSignedIn: false }; }
export function useClerk() { return { signOut: async () => {} }; }
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
