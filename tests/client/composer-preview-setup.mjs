// Setup for tests/client/composer-preview.test.tsx (Task #3320).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// only to stub @clerk/react: the mounted CommsProvider reads useAuth(), whose
// @clerk/react hooks throw outside a live <ClerkProvider>. This suite asserts
// the Composer's live formatting preview, not role gating, so a signed-OUT stub
// keeps use-auth's /api/auth/user query disabled (no fetch, user stays null).
// Passed via `--import ./tests/client/composer-preview-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: false } },
});
