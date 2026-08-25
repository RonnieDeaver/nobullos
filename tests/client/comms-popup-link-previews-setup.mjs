// Setup for tests/client/comms-popup-link-previews.test.tsx.
// Unlike the popup-rehydrate setup, MessagePane stays REAL here — the test
// proves the popup body renders link previews + opens the image lightbox via
// the shared MessagePane → MessageItem path. Only the composer and the
// side-panel/dialog leaves MessagePane statically imports are stubbed so the
// dependency tree stays evaluable in the bare tsx + jsdom harness.
// Passed via `--import ./tests/client/comms-popup-link-previews-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: {
      Composer: ["Composer"],
      ChannelInfoSheet: ["ChannelInfoSheet"],
      BookmarksBar: ["BookmarksBar", "makeBookmarkSseHandler"],
      EditHistoryDialog: ["EditHistoryDialog"],
      ReminderDialog: ["ReminderDialog"],
      ForwardDialog: ["ForwardDialog"],
      SearchPanel: ["SearchPanel"],
    },
    radix: ["dropdown-menu"],
    stubCss: true,
    // The CommsProvider + CommsPopupManager graph reaches `@/hooks/use-auth`,
    // whose @clerk/react hooks throw outside a live <ClerkProvider>. A
    // signed-in stub lets the REAL use-auth hook fetch /api/auth/user through
    // the test's fetch stub.
    stubClerk: { signedIn: true },
  },
});
