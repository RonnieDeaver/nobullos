// Entry passed via `tsx --import` so the shared heavy-client customization hook
// is registered before the test file evaluates its dynamic imports of the real
// React component graph.
//
// The ClientManagement edit form renders Radix Dialog + Select primitives whose
// portals never mount in the raw jsdom harness, so without shims the edit
// dialog's form + submit button never become queryable. We shim both via the
// shared loader.

import { register } from "node:module";

// stubClerk (signed IN): the ClientManagement graph reaches
// `@/hooks/use-auth`, whose @clerk/react hooks throw outside a live
// <ClerkProvider>. A signed-in stub lets the REAL use-auth hook fetch
// /api/auth/user through the test's fetch stub, so role gating stays genuine.
register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { radix: ["dialog", "select", "alert-dialog"], stubClerk: { signedIn: true } },
});
