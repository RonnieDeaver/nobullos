// Setup for tests/client/deals-board-keyboard-move.test.tsx (Task #4663).
//
// The deals board renders its per-card "Move to stage" menu through Radix
// DropdownMenu and its create/required-fields dialogs through Radix Dialog —
// portal content never mounts in the raw jsdom harness, so both are shimmed
// via the shared loader ("dialog" in the list requires "alert-dialog" too —
// see .agents/memory/radix-portal-jsdom-tests.md). The header sort filters use
// Radix Select (shimmed; the test never opens a listbox). stubClerk (signed
// IN) lets the REAL use-auth hook fetch /api/auth/user through the test's
// fetch stub so the team-lead gating on the board header stays genuine.
// Passed via `--import ./tests/client/deals-board-keyboard-move-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["dropdown-menu", "dialog", "alert-dialog", "select"],
    stubClerk: { signedIn: true },
    stubCss: true,
  },
});
