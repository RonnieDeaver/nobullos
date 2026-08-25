// Setup for tests/client/rail-channel-grouping.test.tsx (Task #3366).
// Shims Radix Popover/Dialog/DropdownMenu (portal content never mounts in the
// raw jsdom harness), stubs the heavy leaves the rail's channel-list section
// never renders (status picker, notification settings panel), maps CSS to
// empty modules, and redirects CommsContext + use-auth to lightweight stubs.
// Passed via `--import ./tests/client/rail-channel-grouping-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["popover", "dialog", "dropdown-menu", "alert-dialog"],
    stubComponents: {
      UserStatusPicker: ["UserStatusPicker", "StatusDot"],
      NotificationSettingsPanel: ["NotificationSettingsPanel"],
    },
    stubCss: true,
  },
});

register("./rail-channel-grouping-loader.mjs", import.meta.url);
