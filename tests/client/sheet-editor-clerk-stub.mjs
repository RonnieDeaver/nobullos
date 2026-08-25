/**
 * Minimal @clerk/react stub for the sheet-editor jsdom harness (Clerk
 * migration tail, Task #4646): @clerk/react hooks THROW outside a live
 * <ClerkProvider>, and this bare-jsdom suite mounts SheetEditor (whose
 * @/hooks/use-auth wraps Clerk's useAuth/useClerk) without the provider.
 *
 * A fixed loaded + signed-in session lets the REAL use-auth hook run and
 * fetch /api/auth/user through the suite's fetch stub, so role handling
 * stays genuine — the same seam shape as the shared
 * tests/helpers/heavyClientLoader.mjs `stubClerk: { signedIn: true }`.
 */
export function useAuth() {
  return { isLoaded: true, isSignedIn: true };
}

export function useClerk() {
  return { signOut: async () => {}, addListener: () => () => {} };
}

export function ClerkProvider({ children }) {
  return children;
}
