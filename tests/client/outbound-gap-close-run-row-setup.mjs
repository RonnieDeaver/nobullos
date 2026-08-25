// Setup for tests/client/outbound-gap-close-run-row.test.tsx (Task #2294).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// only to stub @clerk/react: the mounted FrontHistoricalRecoveryPanel reaches
// `@/hooks/use-auth`, whose @clerk/react hooks throw outside a live
// <ClerkProvider>. `stubClerk: { signedIn: true }` lets the REAL use-auth hook
// fetch the DB user (ceo) through the suite's `/api/auth/user` fetch stub, so
// the admin role gate that renders the outbound-gap section stays genuine.
// (This suite has no rrule dependency, so it does not need mock-loader.mjs.)
// Passed via `--import ./tests/client/outbound-gap-close-run-row-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true } },
});
