// Setup for tests/client/confirm-dialog-dashboard-delete-report.test.tsx (Task #4636).
// Registers the shared heavy-client loader to:
//   - shim the Radix primitives Dashboard's graph reaches (the owner-filter
//     `Select` in ClientCRMTable, the closed duplicate-report `Dialog`, and —
//     under test here — the ConfirmActionDialog's `AlertDialog`). Their
//     Portal+Presence pair never mounts in the raw jsdom harness, so without
//     the shims the dialog's confirm/cancel buttons are never queryable.
//     NOTE: any setup that shims "dialog" must also shim "alert-dialog" —
//     the real @radix-ui/react-alert-dialog imports createDialogScope from
//     the shimmed dialog module and crashes otherwise.
//   - stub the unused-at-mount `DismissReasonDialog` heavy leaf so its import
//     graph isn't evaluated.
//   - stub @clerk/react signed-in so the REAL use-auth hook fetches
//     /api/auth/user through this suite's fetch stub (role gating — the
//     team_lead-only delete button — stays genuine).
// Passed via `--import ./tests/client/confirm-dialog-dashboard-delete-report-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["select", "dialog", "popover", "alert-dialog"],
    stubComponents: { DismissReasonDialog: ["DismissReasonDialog"] },
    stubClerk: { signedIn: true },
  },
});
