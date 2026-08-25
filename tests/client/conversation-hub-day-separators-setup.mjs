// Setup for tests/client/conversation-hub-day-separators.test.tsx (Task #2780).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// only to stub @clerk/react: the mounted ConversationHub page reads useAuth(),
// whose @clerk/react hooks throw outside a live <ClerkProvider>. The Hub mounts
// cold and early-returns `null` until `user` resolves (Task #2791), so a
// signed-IN stub lets the REAL use-auth hook fetch /api/auth/user through this
// suite's fetch stub (which returns the ceo op user), letting the timeline
// render.
// Passed via `--import ./tests/client/conversation-hub-day-separators-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true } },
});
