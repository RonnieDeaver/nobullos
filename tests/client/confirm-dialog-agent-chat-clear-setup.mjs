// Setup for tests/client/confirm-dialog-agent-chat-clear.test.tsx (Task #4757).
// Registers the shared heavy-client loader to shim the Radix AlertDialog the
// ConfirmActionDialog renders through — its Portal+Presence pair never mounts
// in the raw jsdom harness, so without the shim the dialog's confirm/cancel
// buttons are never queryable. ClientAgentChat has no other Radix portal
// surfaces, so nothing else needs shimming.
// Passed via `--import ./tests/client/confirm-dialog-agent-chat-clear-setup.mjs`.

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
