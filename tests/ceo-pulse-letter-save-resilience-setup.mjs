// Entry passed via `tsx --import` for tests/ceo-pulse-letter-save-resilience.test.ts.
// Registers, in order:
//   1. The shared heavy-client loader — dropdown-menu Radix shim (the month
//      picker renders inline so the test can select a pulse), CSS stubbing,
//      a Clerk stub (signed-in; the REAL use-auth hook then fetches
//      /api/auth/user through the test's fetch stub so role gating stays
//      genuine), and a stub for the heavy CeoPulseVisual leaf
//      (framer-motion + chart renderer — not under test).
//   2. The shared use-toast recording stub loader so BOTH the page's local
//      toasts AND the global queryClient cache toasts land on
//      globalThis.__capturedToasts (that is what lets the test prove
//      single-toast behavior — no generic double toast).
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: ["CeoPulseVisual"],
    // alert-dialog-lifecycle (Task #4901): the page's visual step now renders
    // a Re-analyze confirm AlertDialog, so the specifier must be shimmed or
    // the real Radix package loads in this raw jsdom harness. The lifecycle
    // shim keeps closed dialog content OUT of the DOM (this suite never opens
    // it), so the letter-save assertions are unaffected.
    radix: ["dropdown-menu", "alert-dialog-lifecycle"],
    stubCss: true,
    stubClerk: { signedIn: true },
  },
});

register("./dashboard-toast-stub-loader.mjs", import.meta.url);
