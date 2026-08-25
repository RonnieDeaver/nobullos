// Setup for tests/client/integrations-hub-google-ads-single-lane.test.tsx (Task #4445 sweep).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// to stub @clerk/react: the mounted IntegrationsHub reads useAuth(), whose
// @clerk/react hooks throw outside a live <ClerkProvider>. The suite role-gates
// on user.role (team_lead), so a signed-IN stub lets the REAL use-auth hook
// fetch /api/auth/user through this suite's fetch stub (which returns the
// team_lead ADMIN_USER), keeping the role gating genuine.
// Passed via `--import ./tests/client/integrations-hub-google-ads-single-lane-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true } },
});
