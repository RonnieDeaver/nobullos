// Setup for tests/client/comms-sidebar-emoji-gating.test.tsx (Task #3314).
// Stubs the heavy leaves of the Comms.tsx import graph (LiveKit, message
// pane, composer, panels — none rendered by CommsSidebar) plus CSS, and
// redirects CommsContext + use-auth via the emoji-gating loader.
// Passed via `--import ./tests/client/comms-sidebar-emoji-gating-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      "components-react": [
        "LiveKitRoom",
        "VideoConference",
        "AudioConference",
        "ControlBar",
        "DisconnectButton",
        "RoomAudioRenderer",
        "useRoomContext",
      ],
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

register("./comms-sidebar-emoji-gating-loader.mjs", import.meta.url);
