// Entry passed via `tsx --import` for tests/ceo-pulse-reanalyze-confirm.test.ts.
// Mirrors the letter-save-resilience harness (same page, same seams):
//   1. The shared heavy-client loader — dropdown-menu Radix shim (the month
//      picker renders inline so the test can select a pulse), the LIFECYCLE
//      alert-dialog shim (tests/alert-dialog-lifecycle-shim.mjs: content
//      renders ONLY while open, Trigger opens, Cancel/Action close via
//      onOpenChange — so the suite proves the real closed → open →
//      cancel-closes → reopen → confirm-fires-once sequence of the Task #4901
//      Re-analyze dialog, not just reach an always-rendered confirm button),
//      CSS stubbing, a Clerk stub (signed-in; the REAL use-auth hook then
//      fetches /api/auth/user through the test's fetch stub so role gating
//      stays genuine), and a stub for the heavy CeoPulseVisual leaf
//      (framer-motion + chart renderer — not under test).
//   2. The shared use-toast recording stub loader so BOTH the page's local
//      toasts AND the global queryClient cache toasts land on
//      globalThis.__capturedToasts (that is what lets the test prove the
//      single "Visual regenerated!" toast fires only after server confirm).
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubComponents: ["CeoPulseVisual"],
    radix: ["dropdown-menu", "alert-dialog-lifecycle"],
    stubCss: true,
    stubClerk: { signedIn: true },
  },
});

register("./dashboard-toast-stub-loader.mjs", import.meta.url);
