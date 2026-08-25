// Setup for tests/client/rail-closed-right-edge.test.tsx (Task #3334).
// Mounts the REAL CommsRail inside the REAL CommsProvider, so the heavy
// leaves of the CommsContext import graph (desktop notifications) and the
// Radix portal primitives are shimmed via the shared heavyClientLoader.
// Passed via `--import ./tests/client/rail-closed-right-edge-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      useDesktopNotifications: [
        "useDesktopNotifications",
        "requestNotificationPermission",
        "getNotificationPermission",
        "getSoundPlaybackState",
        "subscribeSoundPlaybackState",
        "playNotificationSound",
      ],
    },
    radix: ["popover", "dialog", "alert-dialog"],
    stubCss: true,
    // The CommsRail graph reaches `@/hooks/use-auth`, whose `@clerk/react`
    // hooks throw outside a live <ClerkProvider>. Signed-IN lets the REAL
    // use-auth hook fetch the DB user (account_manager) through the suite's
    // fetch stub, which serves `/api/auth/user`.
    stubClerk: { signedIn: true },
  },
});
