// Setup for tests/client/comms-status-picker-updates-dots.test.tsx (Task #3444).
// Tasks #3343/#3362 pinned the rendered colors of presence dots, but only as
// static reads of /api/comms/status/bulk + /status/me. This companion test
// exercises the INTERACTIVE path — opening the real UserStatusPicker from the
// sidebar footer, selecting Away / DND / a custom status, and verifying the
// PUT plus the SSE-broadcast-driven re-render of the footer StatusDot and the
// message avatar dots. UserStatusPicker + MessagePane stay REAL; only deep
// heavy leaves are stubbed. The Radix dropdown-menu shim is wired so the
// picker's menu items actually mount in jsdom (the real Radix portal never
// mounts in this harness), and the dialog shim so the custom-status dialog
// content mounts.
// Passed via `--import ./tests/client/comms-status-picker-updates-dots-setup.mjs`.

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
    radix: ["dialog", "dropdown-menu", "alert-dialog"],
    stubCss: true,
    // stubClerk (signed IN): the Comms graph reaches `@/hooks/use-auth`, whose
    // @clerk/react hooks throw outside a live <ClerkProvider>. The page reads
    // the DB `user` (role, identity) to drive the footer + presence surfaces, so
    // a signed-IN stub lets the REAL use-auth hook fetch /api/auth/user through
    // this suite's fetch stub (which returns the ceo USER).
    stubClerk: { signedIn: true },
  },
});
