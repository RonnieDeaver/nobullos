// Setup for tests/client/recovery-revert-buttons.test.tsx (Task #1162).
// Registers the shared heavy-client loader (tests/helpers/heavyClientLoader.mjs)
// only to stub @clerk/react: the mounted FrontHistoricalRecoveryPanel reaches
// `@/hooks/use-auth`, whose @clerk/react hooks throw outside a live
// <ClerkProvider>. `stubClerk: { signedIn: true }` lets the REAL use-auth hook
// fetch the DB user through the suite's `/api/auth/user` fetch stub, so the
// admin role gate that renders the panel stays genuine.
// (This suite has no rrule dependency, so it does not need mock-loader.mjs.)
// Task #4589: the Revert buttons now confirm via the shared
// ConfirmActionDialog (Radix AlertDialog), whose portal never mounts in the
// raw jsdom harness — shim it so the dialog's confirm button is queryable.
// Passed via `--import ./tests/client/recovery-revert-buttons-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true }, radix: ["alert-dialog"] },
});
