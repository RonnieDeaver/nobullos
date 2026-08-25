// Task #2675 — `--import` setup for tests/client/dashboard-transient-resilience.test.tsx.
//
// Registers, in order:
//   1. The shared heavyClientLoader to shim the Radix primitives Dashboard's
//      graph reaches (the owner-filter `Select` in ClientCRMTable, the closed
//      duplicate-report `Dialog`) — their Portal+Presence pair never mounts in
//      the raw jsdom harness. Stubs the unused-at-mount `DismissReasonDialog`
//      heavy leaf so its import graph isn't evaluated.
//   2. The toast-stub loader so the global "Request failed" toast is captured
//      (and asserted absent) instead of fired.
import { register } from "node:module";

// stubClerk (signed IN): Dashboard's graph reaches `@/hooks/use-auth`, whose
// @clerk/react hooks throw outside a live <ClerkProvider>. Dashboard reads the
// DB `user` (role team_lead) to render, so a signed-IN stub lets the REAL
// use-auth hook fetch /api/auth/user through this suite's fetch stub (which
// returns TEST_USER).
register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["select", "dialog", "popover", "alert-dialog"],
    stubComponents: { DismissReasonDialog: ["DismissReasonDialog"] },
    stubClerk: { signedIn: true },
  },
});

register("./dashboard-toast-stub-loader.mjs", import.meta.url);
