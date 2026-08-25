// Setup for tests/client/confirm-dialog-channel-info-kick.test.tsx (Task #4757).
// Registers the shared heavy-client loader to (a) shim the Radix AlertDialog
// the ConfirmActionDialog renders through — its Portal+Presence pair never
// mounts in the raw jsdom harness, so the dialog's confirm/cancel buttons
// would never be queryable — and (b) stub Clerk (ChannelInfoSheet calls
// useAuth() for the team-lead admin shortcut; the test drives admin-ness via
// the member roster instead). ChannelInfoSheet's OTHER AlertDialogs (privacy
// conversion / archive) ride the same shim; the test never clicks them.
// Passed via `--import ./tests/client/confirm-dialog-channel-info-kick-setup.mjs`.

import { register } from "node:module";

// Classic-JSX resilience for bare `tsx --import` repros without
// TSX_TSCONFIG_PATH (see .agents/memory/batched-classic-jsx-primitives.md).
globalThis.React = (await import("react")).default;

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["alert-dialog-lifecycle"],
    stubClerk: { signedIn: true },
    stubCss: true,
  },
});
