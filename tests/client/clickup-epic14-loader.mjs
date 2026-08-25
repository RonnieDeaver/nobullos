// Node ESM resolve hook for the ClickUp Epic 14 tabs smoke test
// (tests/client/clickup-epic14-people-shared-access.test.tsx).
//
// Two Radix primitives never mount under the raw jsdom + react-dom/client
// harness:
//   - `@radix-ui/react-select` (workspace picker) portals its listbox, so the
//     workspace options would never be clickable → reuse the RIS inline
//     select shim (renders items inline + wires onValueChange).
//   - `@radix-ui/react-dialog` (SharingDialog) renders through
//     Portal + FocusScope + DismissableLayer → reuse the SheetsLibrary
//     inline dialog shim.
//   - `@radix-ui/react-alert-dialog` (ClickUpModule's disconnect
//     confirmation, Task #4357) composes the real react-dialog's
//     `createDialogScope`, which the dialog shim above deliberately does
//     not export → reuse the SheetsLibrary inline alert-dialog shim so the
//     module graph loads.
//
// Registered via `--import ./tests/client/clickup-epic14-setup.mjs`.

const SELECT_SHIM = new URL("./ris-setup-select-shim.mjs", import.meta.url).href;
const DIALOG_SHIM = new URL("./sheets-library-dialog-shim.mjs", import.meta.url).href;
const ALERT_DIALOG_SHIM = new URL("./sheets-library-alert-dialog-shim.mjs", import.meta.url).href;

// The ClickUpModule graph reaches `@/hooks/use-auth`, whose @clerk/react
// hooks throw outside a live <ClerkProvider>. Stub the bare `@clerk/react`
// package with a signed-in session (only the two hooks use-auth imports),
// mirroring heavyClientLoader.mjs's STUB_CLERK pattern — the REAL use-auth
// hook then fetches /api/auth/user through the test's fetch stub so role
// gating stays genuine.
const STUB_CLERK = "clickup-epic14-stub:clerk-react";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@radix-ui/react-select") {
    return { url: SELECT_SHIM, shortCircuit: true, format: "module" };
  }
  if (specifier === "@radix-ui/react-dialog") {
    return { url: DIALOG_SHIM, shortCircuit: true, format: "module" };
  }
  if (specifier === "@radix-ui/react-alert-dialog") {
    return { url: ALERT_DIALOG_SHIM, shortCircuit: true, format: "module" };
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
