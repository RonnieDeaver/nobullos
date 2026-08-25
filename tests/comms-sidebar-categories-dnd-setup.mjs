// Entry passed via `tsx --import` for tests/comms-sidebar-categories-dnd.test.tsx.
// Registers:
//   1. the shared heavy-client loader — stubs useDesktopNotifications (the
//      real hook touches the Notification API) and maps CSS imports to empty
//      modules;
//   2. the QuicklinksBar loader (CommsContext imports
//      shouldRenderGlobalQuicklinksBar; stub must return truthy — see the
//      loader's header comment);
//   3. the existing use-auth loader (CommsProvider reads useAuth(); the real
//      hook needs a live /api/auth/user query).
//
// NOTE: unlike the cmdk test, this test does NOT stub CommsContext — it mounts
// the REAL CommsProvider so drags exercise the real optimistic-update +
// apiRequest paths and the fetch stub can assert the exact API calls.

import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      useDesktopNotifications: ["useDesktopNotifications"],
    },
    stubCss: true,
  },
});

register("./comms-sidebar-categories-dnd-quicklinks-loader.mjs", import.meta.url);
register("./comms-sidebar-cmdk-use-auth-loader.mjs", import.meta.url);
