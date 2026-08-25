// Entry passed via `tsx --import` for tests/comms-group-dm-tooltip.test.tsx.
// Registers:
//   1. the shared heavy-client loader to stub the heavy children of both
//      pages/Comms.tsx (ChannelHeader's module) and CommsPopupManager —
//      message panes, composers, dialogs, LiveKit, pickers; none of them
//      matter for the presence-dot tooltip text under test — plus the Radix
//      tooltip wrapper, with CSS imports mapped to empty modules;
//   2. the existing CommsContext loader that redirects
//      `@/contexts/CommsContext` to the tiny stub driven via
//      `globalThis.__COMMS_POPUP_TEST_CTX`.

import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      MessagePane: ["MessagePane"],
      Composer: ["Composer"],
      tooltip: ["Tooltip", "TooltipContent", "TooltipTrigger", "TooltipProvider"],
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
      UserStatusPicker: ["UserStatusPicker", "StatusDot"],
      // "@livekit/components-react" — basename match stubs the whole package.
      "components-react": [
        "LiveKitRoom",
        "VideoConference",
        "AudioConference",
        "ControlBar",
        "DisconnectButton",
        "RoomAudioRenderer",
        "useRoomContext",
      ],
      // "@livekit/components-styles" — side-effect style import.
      "components-styles": [],
    },
    stubCss: true,
  },
});

register("./comms-popup-narrow-viewport-loader.mjs", import.meta.url);
