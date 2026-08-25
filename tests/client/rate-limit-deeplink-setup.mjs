// Setup for tests/client/rate-limit-deeplink.test.tsx (Task #1234).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// only to stub @clerk/react: the mounted RateLimitUsers page reaches
// `@/hooks/use-auth`, whose @clerk/react hooks throw outside a live
// <ClerkProvider>. `stubClerk: { signedIn: true }` lets the REAL use-auth hook
// fetch the DB user (ceo/admin) through the suite's `/api/auth/user` fetch
// stub, so the admin role gate stays genuine.
// Passed via `--import ./tests/client/rate-limit-deeplink-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true } },
});
