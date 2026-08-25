// Setup for tests/client/comms-popup-rehydrate.test.tsx.
// Stubs the heavy popup body leaves (MessagePane, Composer) so mounting the
// real CommsProvider + CommsPopupManager graph in jsdom doesn't pull in the
// full message-pane dependency tree; CSS imports map to empty modules.
// Passed via `--import ./tests/client/comms-popup-rehydrate-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      MessagePane: ["MessagePane"],
      Composer: ["Composer"],
    },
    stubCss: true,
    // The CommsProvider + CommsPopupManager graph reaches `@/hooks/use-auth`,
    // whose @clerk/react hooks throw outside a live <ClerkProvider>. A
    // signed-in stub lets the REAL use-auth hook fetch /api/auth/user through
    // the test's fetch stub.
    stubClerk: { signedIn: true },
  },
});
