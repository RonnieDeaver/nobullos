// Setup for tests/client/front-console-tabs.test.tsx (Task #1619).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// only to stub @clerk/react: the Front console shell reaches
// FrontHistoricalRecoveryPanel, which reads useAuth(); @clerk/react's hooks
// throw outside a live <ClerkProvider>. This suite asserts the tab shell + KPI
// header contract, not role gating, so a signed-OUT stub keeps use-auth's
// /api/auth/user query disabled (no fetch, user stays null).
// Passed via `--import ./tests/client/front-console-tabs-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: false } },
});
