// Entry passed via `tsx --import` for
// tests/client/ads-os-tools-read-only-roles.test.tsx.
//
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs):
//  - stubCss: BudgetPacingTool's AdsOsShell side-effect-imports ../adsOs.css,
//    which bare tsx can't evaluate (ERR_UNKNOWN_FILE_EXTENSION).
//  - stubClerk (signed IN): the tool graph reaches `@/hooks/use-auth` for the
//    Task #4977 useIsCeo() role gate. A signed-IN stub lets the REAL use-auth
//    hook fetch /api/auth/user through the test's fetch stub, so role gating
//    stays genuine (the test drives it with role=account_manager vs ceo).
import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubCss: true, stubClerk: { signedIn: true } },
});
