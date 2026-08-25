// Node ESM resolve hook — redirects Radix Dialog/AlertDialog to inline shims
// for the SheetsLibrary rendered test (Task #2931).
//
// Radix Dialog's Portal + FocusScope use MutationObserver and dispatch custom
// DOM events that break jsdom; the shims render content inline without
// portal/focus-trap overhead so the create-workbook form is queryable and
// submittable in tests.
//
// Registered via `--import ./tests/client/sheets-library-setup.mjs`.

const DIALOG_SHIM = new URL("./sheets-library-dialog-shim.mjs", import.meta.url).href;
const ALERT_DIALOG_SHIM = new URL("./sheets-library-alert-dialog-shim.mjs", import.meta.url).href;
const STUB_CLERK = "sheets-library-stub:clerk-react";

export async function resolve(specifier, context, nextResolve) {
  // Task #4371 — the Clerk auth migration (Task #4349) rewired
  // `@/hooks/use-auth` through `@clerk/react`, whose hooks throw outside a
  // live <ClerkProvider>. Present a loaded, signed-in Clerk session and let
  // the REAL use-auth hook fetch the DB user through this harness's
  // /api/auth/user fetch stub (same seam as client-detail-tab-from-url).
  if (specifier === "@clerk/react") {
    return { url: STUB_CLERK, shortCircuit: true, format: "module" };
  }
  if (specifier === "@radix-ui/react-dialog") {
    return { url: DIALOG_SHIM, shortCircuit: true, format: "module" };
  }
  if (specifier === "@radix-ui/react-alert-dialog") {
    return { url: ALERT_DIALOG_SHIM, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_CLERK) {
    // Union of every export client/src imports from @clerk/react, so this
    // stub keeps working if other Clerk-consuming components join the
    // SheetsLibrary closure (see memory: test-stub-export-fanout).
    const source = `
export const useAuth = () => ({ isLoaded: true, isSignedIn: true });
export const useClerk = () => ({ signOut: async () => {} });
export const ClerkProvider = ({ children }) => children;
export const SignIn = () => null;
export const SignUp = () => null;
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
