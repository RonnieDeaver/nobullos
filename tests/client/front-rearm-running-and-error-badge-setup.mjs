// Setup for tests/client/front-rearm-running-and-error-badge.test.tsx (Task #4445 sweep).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// to stub @clerk/react: the mounted FrontHistoricalRecoveryPanel reads
// useAuth(), whose @clerk/react hooks throw outside a live <ClerkProvider>.
// The suite role-gates on user.role (ceo), so a signed-IN stub lets the REAL
// use-auth hook fetch /api/auth/user through this suite's fetch stub (which
// returns the ceo ADMIN_USER), keeping the role gating genuine.
// Passed via `--import ./tests/client/front-rearm-running-and-error-badge-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true } },
});
