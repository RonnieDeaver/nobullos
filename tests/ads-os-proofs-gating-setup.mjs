// Node ESM customization hooks for tests/ads-os-proofs-gating.test.ts.
//
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs):
//  - stubCss: AdsOsShell side-effect-imports ../adsOs.css, which bare tsx can't
//    evaluate (ERR_UNKNOWN_FILE_EXTENSION).
//  - stubClerk (signed IN): @clerk/react's hooks throw outside a live
//    <ClerkProvider>. A signed-in stub lets the REAL use-auth hook fetch
//    /api/auth/user through the test's fetch stub, so the role gating under
//    test (Task #4375: CEO-only System Checks tab/page) stays genuine.
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubCss: true, stubClerk: { signedIn: true } },
});
