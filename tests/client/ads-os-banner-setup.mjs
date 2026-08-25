// Entry passed via `tsx --import` for tests/client/ads-os-clickup-banner.test.tsx.
//
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs):
//  - stubCss: AdsOsShell side-effect-imports ../adsOs.css, which bare tsx can't
//    evaluate (ERR_UNKNOWN_FILE_EXTENSION).
//  - stubClerk (signed OUT): AdsOsShell reads `useAuth()` to role-gate the
//    CEO-only System Checks tab (Task #4375); @clerk/react's hooks throw
//    outside a live <ClerkProvider>. A signed-OUT stub keeps use-auth's
//    /api/auth/user query disabled — no fetch, user stays null, the CEO-only
//    tab stays hidden (this suite asserts the ClickUp degradation banner, not
//    the top bar). Mirrors the ads-os-pyramid-tool-render harness.
import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubCss: true, stubClerk: { signedIn: false } },
});
