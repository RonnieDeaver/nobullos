// Setup for tests/client/confirm-dialog-bookmarks-remove.test.tsx (Task #4757).
// Registers the shared heavy-client loader to shim the Radix AlertDialog the
// ConfirmActionDialog renders through — its Portal+Presence pair never mounts
// in the raw jsdom harness, so without the shim the dialog's confirm/cancel
// buttons are never queryable. The real @radix-ui/react-dialog stays
// un-shimmed (the AddBookmarkDialog stays closed — no Dialog content is under
// test), which also sidesteps the "shimming dialog requires shimming
// alert-dialog" coupling.
// Passed via `--import ./tests/client/confirm-dialog-bookmarks-remove-setup.mjs`.

import { register } from "node:module";

// Classic-JSX resilience for bare `tsx --import` repros without
// TSX_TSCONFIG_PATH (see .agents/memory/batched-classic-jsx-primitives.md).
globalThis.React = (await import("react")).default;

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["alert-dialog-lifecycle"],
    stubCss: true,
  },
});
