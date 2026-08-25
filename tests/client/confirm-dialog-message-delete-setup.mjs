// Setup for tests/client/confirm-dialog-message-delete.test.tsx (Task #4636).
// MessagePane + MessageItem stay REAL — the test proves the controlled-mode
// ConfirmActionDialog wired by Task #4621 (delete lives in the message hover
// menu, not a wrappable trigger) only fires DELETE /api/comms/messages/:id
// from the dialog's confirm button. Only the composer and the
// side-panel/dialog leaves MessagePane statically imports are stubbed so the
// dependency tree stays evaluable in the bare tsx + jsdom harness.
//
// Radix shims: "dropdown-menu" so the per-message ••• menu (and its Delete
// item) is queryable, and "alert-dialog" so the ConfirmActionDialog's
// confirm/cancel buttons render (the real portal never mounts in this
// harness) — cf. tests/client/recovery-revert-buttons-setup.mjs.
// Passed via `--import ./tests/client/confirm-dialog-message-delete-setup.mjs`.

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
    radix: ["dropdown-menu", "alert-dialog"],
    stubCss: true,
    // The MessagePane graph reaches `@/hooks/use-auth`, whose @clerk/react
    // hooks throw outside a live <ClerkProvider>. A signed-in stub lets the
    // REAL use-auth hook fetch /api/auth/user through the test's fetch stub.
    stubClerk: { signedIn: true },
  },
});
