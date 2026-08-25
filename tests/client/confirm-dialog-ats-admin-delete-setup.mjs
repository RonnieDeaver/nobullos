// Setup for tests/client/confirm-dialog-ats-admin-delete.test.tsx (Task #4757).
// Registers the shared heavy-client loader to shim BOTH Radix Dialog and
// Radix AlertDialog:
//   - "alert-dialog": the ConfirmActionDialog renders through it, and its
//     Portal+Presence pair never mounts in the raw jsdom harness — without
//     the shim the dialog's confirm/cancel buttons are never queryable.
//   - "dialog": AtsAdmin's candidate DETAIL panel (which hosts the second
//     converted delete dialog, `dialog-confirm-detail-delete`) lives inside a
//     real Radix Dialog portal that likewise never mounts headlessly. Any
//     setup shimming "dialog" must also shim "alert-dialog" (Task #4757 plan
//     note) — both are shimmed here.
// Clerk is stubbed because AtsAdmin gates on useAuth() (team_lead/ceo only).
// Passed via `--import ./tests/client/confirm-dialog-ats-admin-delete-setup.mjs`.

import { register } from "node:module";

// Classic-JSX resilience for bare `tsx --import` repros without
// TSX_TSCONFIG_PATH (see .agents/memory/batched-classic-jsx-primitives.md).
globalThis.React = (await import("react")).default;

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["dialog", "alert-dialog-lifecycle"],
    stubClerk: { signedIn: true },
    stubCss: true,
  },
});
