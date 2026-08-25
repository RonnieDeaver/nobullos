// Entry passed via `tsx --import` for tests/feedback-submit-resilience.test.ts.
// Registers, in order:
//   1. The shared heavy-client loader (Radix Dialog shim + CSS stubbing
//      + Clerk stub so FeedbackButton mounts without a live ClerkProvider).
//   2. The shared use-toast recording stub loader so toast() calls are captured
//      on globalThis.__capturedToasts rather than needing a real toast context.
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["dialog"],
    stubCss: true,
    stubClerk: { signedIn: true },
  },
});

register("./dashboard-toast-stub-loader.mjs", import.meta.url);
