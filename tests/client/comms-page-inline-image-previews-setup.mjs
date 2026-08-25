// Setup for tests/client/comms-page-inline-image-previews.test.tsx.
// MessagePane + MessageItem stay REAL — the test proves the /comms page's
// message path (MessagePane with hideComposer/hideHeader, exactly as
// client/src/pages/Comms.tsx mounts it) renders inline image previews via
// AttachmentCard, opens the ImageLightbox, and renders non-image attachments
// as filename + size + download link. Only the composer and the
// side-panel/dialog leaves MessagePane statically imports are stubbed so the
// dependency tree stays evaluable in the bare tsx + jsdom harness.
// Passed via `--import ./tests/client/comms-page-inline-image-previews-setup.mjs`.

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
    // The Comms page graph reaches `@/hooks/use-auth`, whose @clerk/react
    // hooks throw outside a live <ClerkProvider>. A signed-in stub lets the
    // REAL use-auth hook fetch /api/auth/user through the test's fetch stub.
    stubClerk: { signedIn: true },
  },
});
