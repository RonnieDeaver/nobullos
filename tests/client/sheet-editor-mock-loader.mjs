/**
 * Node ESM resolve hook — redirects @univerjs/* imports to a lightweight stub
 * so the SheetEditor page can be mounted in the bare jsdom harness without
 * pulling in the full ~10 MB Univer browser bundle, and @clerk/react to a
 * fixed signed-in stub (its hooks throw outside a live <ClerkProvider>; the
 * REAL use-auth hook still runs and fetches /api/auth/user through the
 * suite's fetch stub — Clerk migration tail, Task #4646).
 *
 * Registered via `--import ./tests/client/sheet-editor-mock-setup.mjs`.
 */

const STUB_URL = new URL("./sheet-editor-univer-stub.mjs", import.meta.url)
  .href;
const CLERK_STUB_URL = new URL("./sheet-editor-clerk-stub.mjs", import.meta.url)
  .href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@univerjs/")) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "@clerk/react") {
    return { url: CLERK_STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
