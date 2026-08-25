// Setup for tests/client/comms-sidebar-pin-collapse.test.tsx (Task #3348).
// Stubs the heavy leaves of the Comms.tsx import graph (LiveKit, message
// pane, composer, panels — none rendered by CommsSidebar) plus CSS, and
// redirects CommsContext to a lightweight stateful shim.
// Passed via `--import ./tests/client/comms-sidebar-pin-collapse-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      // @livekit/components-react — named exports Comms.tsx imports.
      "components-react": [
        "LiveKitRoom",
        "VideoConference",
        "AudioConference",
        "ControlBar",
        "DisconnectButton",
        "RoomAudioRenderer",
        "useRoomContext",
      ],
      // @livekit/components-styles — side-effect CSS package.
      "components-styles": [],
      ChannelInfoSheet: ["ChannelInfoSheet"],
      DraftsView: ["DraftsView"],
      EditHistoryDialog: ["EditHistoryDialog"],
      ReminderDialog: ["ReminderDialog"],
      ForwardDialog: ["ForwardDialog"],
      ScheduledMessagesPanel: ["ScheduledMessagesPanel", "AllScheduledMessagesPanel"],
      ThreadsView: ["ThreadsView"],
      SearchPanel: ["SearchPanel"],
      CustomEmojiManager: ["CustomEmojiManager"],
      useDesktopNotifications: ["requestNotificationPermission"],
      MessagePane: ["MessagePane"],
      Composer: ["Composer"],
      UserStatusPicker: ["UserStatusPicker", "StatusDot"],
    },
    stubCss: true,
  },
});

register("./comms-sidebar-pin-collapse-loader.mjs", import.meta.url);
