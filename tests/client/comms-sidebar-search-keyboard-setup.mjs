// Setup for tests/client/comms-sidebar-search-keyboard.test.tsx (Task #3398).
// Reuses the shared heavy-client loader stubs (LiveKit, MessagePane, Composer,
// panels — none rendered by CommsSidebar) plus CSS stubbing, and the existing
// pin-collapse loader that redirects CommsContext to the lightweight stateful
// shim and stubs use-auth. Passed via
// `--import ./tests/client/comms-sidebar-search-keyboard-setup.mjs`.

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

// Same CommsContext shim + use-auth stub as the pin-collapse test.
register("./comms-sidebar-pin-collapse-loader.mjs", import.meta.url);
