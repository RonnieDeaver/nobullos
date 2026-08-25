// Setup for tests/client/integrations-hub-stalled-status-timeout.test.tsx (Task #4586).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// to stub @clerk/react: the mounted IntegrationsHub reads useAuth(), whose
// @clerk/react hooks throw outside a live <ClerkProvider>. A signed-IN stub
// lets the REAL use-auth hook fetch /api/auth/user through this suite's fetch
// stub (which returns a team_lead user), keeping the role gating genuine.
// Passed via `--import ./tests/client/integrations-hub-stalled-status-timeout-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true } },
});
