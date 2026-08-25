// Entry passed via `tsx --import` for
// tests/client/client-profile-criteria-access.test.tsx.
//
// ClientProfile side-effect-imports Ads OS CSS, and its real useIsCeo hook
// reaches Clerk through use-auth. Keep both seams real except for the browser
// provider itself: the test's /api/auth/user stub supplies the non-CEO role.
import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubCss: true, stubClerk: { signedIn: true } },
});