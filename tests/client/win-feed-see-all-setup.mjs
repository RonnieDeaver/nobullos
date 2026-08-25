// Task #4917 — `--import` setup for tests/client/win-feed-see-all.test.tsx.
//
// Registers the shared heavyClientLoader so the full Dashboard mounts in
// jsdom without pulling in Radix portals (Dialog shimmed) or Clerk provider
// (stubClerk). Also registers the dashboard toast stub so any stray toast
// calls are captured instead of crashing.
import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["select", "dialog", "popover", "alert-dialog"],
    stubComponents: { DismissReasonDialog: ["DismissReasonDialog"] },
    stubClerk: { signedIn: true },
  },
});

register("../dashboard-toast-stub-loader.mjs", import.meta.url);
