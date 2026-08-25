// Setup for tests/client/message-item-keyword-highlight.test.tsx (Task #4445 sweep).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// to stub @clerk/react: the mounted MessageItem's graph reaches useAuth(),
// whose @clerk/react hooks throw outside a live <ClerkProvider>. This suite
// does NOT care about roles (its /api/auth/user route returns 401), so a
// signed-OUT stub keeps use-auth's /api/auth/user query disabled (no fetch),
// matching the suite's intent.
// Passed via `--import ./tests/client/message-item-keyword-highlight-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: false } },
});
