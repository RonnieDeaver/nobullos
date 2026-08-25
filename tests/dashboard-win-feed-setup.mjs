// Task #4916 — `--import` setup for tests/client/dashboard-win-feed-layout.test.tsx.
//
// Mirrors dashboard-resilience-setup.mjs: the same heavyClientLoader shims
// the Radix primitives (Select, Dialog, Popover, AlertDialog) that
// Dashboard's component graph reaches, stubs DismissReasonDialog so its
// import graph isn't evaluated, and presents a signed-in Clerk stub so
// Dashboard's use-auth hook can resolve /api/auth/user through the test's
// fetch stub.  The toast-stub loader is NOT needed here; these scenarios
// don't assert on toasts.
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["select", "dialog", "popover", "alert-dialog"],
    stubComponents: { DismissReasonDialog: ["DismissReasonDialog"] },
    stubClerk: { signedIn: true },
  },
});
