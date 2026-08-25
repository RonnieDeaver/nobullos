// Setup for tests/client/front-autoheal-banner.test.tsx (Task #1708).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// only to stub @clerk/react: the mounted FrontHistoricalRecoveryPanel reads
// useAuth(), whose @clerk/react hooks throw outside a live <ClerkProvider>.
// The auto-heal banner's states are admin-gated (user.role ceo/team_lead), so a
// signed-IN stub lets the REAL use-auth hook fetch /api/auth/user through this
// suite's fetch stub (which returns the ceo ADMIN_USER), keeping the role gating
// genuine. (The panel imports no rrule, so the old rrule-shim loader it
// previously registered was vestigial.)
// Passed via `--import ./tests/client/front-autoheal-banner-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true } },
});
