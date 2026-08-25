// Setup for tests/client/comms-presence-dots-rendered.test.tsx.
// Mounts the REAL Comms page (ChannelHeader) + CommsPopupManager in jsdom, so
// every heavy leaf the page pulls in is stubbed: message pane/composer, the
// side panels/dialogs, the LiveKit component suite (WebGL/media deps), and the
// UserStatusPicker (Radix popover). CSS imports map to empty modules.
// Passed via `--import ./tests/client/comms-presence-dots-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      MessagePane: ["MessagePane"],
      Composer: ["Composer"],
      ChannelInfoSheet: ["ChannelInfoSheet"],
      DraftsView: ["DraftsView"],
      EditHistoryDialog: ["EditHistoryDialog"],
      ReminderDialog: ["ReminderDialog"],
      ForwardDialog: ["ForwardDialog"],
      ScheduledMessagesPanel: ["ScheduledMessagesPanel", "AllScheduledMessagesPanel"],
      ThreadsView: ["ThreadsView"],
      SearchPanel: ["SearchPanel"],
      CustomEmojiManager: ["CustomEmojiManager"],
      UserStatusPicker: ["UserStatusPicker", "StatusDot"],
      // "@livekit/components-react" / "@livekit/components-styles" resolve by
      // basename like any other stubbed leaf.
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
    },
    stubCss: true,
    // The Comms page + CommsPopupManager graph reaches `@/hooks/use-auth`,
    // whose @clerk/react hooks throw outside a live <ClerkProvider>. A
    // signed-in stub lets the REAL use-auth hook fetch /api/auth/user through
    // the test's fetch stub.
    stubClerk: { signedIn: true },
  },
});
