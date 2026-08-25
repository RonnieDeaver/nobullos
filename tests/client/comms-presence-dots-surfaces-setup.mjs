// Setup for tests/client/comms-presence-dots-surfaces.test.tsx (Task #3362).
// Task #3343 covered the channel-header + popup title-bar dots with
// MessagePane and UserStatusPicker stubbed. This companion test covers the
// REMAINING presence surfaces, so those two must be REAL here:
//   - the sidebar footer StatusDot (CommsSidebarStatusFooter → StatusDot from
//     UserStatusPicker.tsx),
//   - the message-list avatar dots (MessagePane → MessageItem → Avatar
//     status prop),
//   - the New-DM dialog member rows (per-user Circle dot + custom status).
// Only the deeper heavy leaves are stubbed: composer, side panels/dialogs
// MessagePane pulls in, and the LiveKit suite. The Radix dialog shim is
// wired so the New-DM dialog content actually mounts in jsdom.
// Passed via `--import ./tests/client/comms-presence-dots-surfaces-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
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
    radix: ["dialog", "alert-dialog"],
    stubCss: true,
    // The Comms page graph reaches `@/hooks/use-auth`, whose @clerk/react
    // hooks throw outside a live <ClerkProvider>. A signed-in stub lets the
    // REAL use-auth hook fetch /api/auth/user through the test's fetch stub.
    stubClerk: { signedIn: true },
  },
});
