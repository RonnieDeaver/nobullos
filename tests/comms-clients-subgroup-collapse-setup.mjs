// Entry passed via `tsx --import` for tests/comms-clients-subgroup-collapse.test.tsx.
// Same loader stack as the sidebar-categories DnD test: heavy-client stubs
// (useDesktopNotifications + CSS), truthy QuicklinksBar gate, and the use-auth
// stub so the REAL CommsProvider can mount without a live auth query.

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
