// Setup for tests/client/comms-clients-view-persistence.test.tsx (Task #4490).
// Stubs the heavy leaves of the Comms.tsx import graph (LiveKit, message
// pane, composer, panels — not exercised by the clients-view persistence
// assertions) plus CSS, stubs @clerk/react as a loaded signed-in session so
// the REAL use-auth hook fetches /api/auth/user through the test's fetch
// stub, and redirects CommsContext + useTwilioDevice via the local loader.
// Passed via `--import ./tests/client/comms-clients-view-persistence-setup.mjs`.

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
    stubClerk: { signedIn: true },
  },
});

register("./comms-clients-view-persistence-loader.mjs", import.meta.url);
