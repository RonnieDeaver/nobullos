// Task #3704 — `--import` setup for tests/client/judgment-basis-render.test.tsx.
//
// Registers the shared heavyClientLoader to:
//   - shim the Radix primitives reached by Dashboard's and DailyJudgmentStream's
//     graphs (Select filter, Dialogs, Popover, DropdownMenu row actions) —
//     their Portal+Presence pair never mounts in the raw jsdom harness;
//   - stub the heavy leaves not under test: DismissReasonDialog (Dashboard's
//     unmatched-comms card) and SavePlaysPanel (judgment-stream sidebar, its
//     own query graph is irrelevant here).
import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["select", "dialog", "popover", "dropdown-menu", "alert-dialog"],
    stubComponents: {
      DismissReasonDialog: ["DismissReasonDialog"],
      SavePlaysPanel: [],
    },
    // Dashboard/DailyJudgmentStream reach @/hooks/use-auth, whose @clerk/react
    // hooks throw outside a live <ClerkProvider>. This suite role-gates on
    // user.role (team_lead), so a signed-IN stub lets the REAL use-auth hook
    // fetch /api/auth/user through this suite's fetch stub (returns TEST_USER),
    // keeping the role gating genuine.
    stubClerk: { signedIn: true },
  },
});
