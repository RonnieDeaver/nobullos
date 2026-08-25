// Entry passed via `tsx --import` for
// tests/client/global-nav-width-budget.test.tsx (Task #4698).
//
// Same harness recipe as global-nav-sheets-adsos-placement-setup.mjs: the
// Radix DropdownMenu portal never mounts in raw jsdom, so shim it to inline
// pass-throughs; NotificationBell / FeedbackButton are stubbed (their
// query/SSE machinery is irrelevant to band-width modeling — the model
// prices them at their fixed h-9 w-9 footprint); Clerk is stubbed signed-in
// so the real use-auth hook fetches the CEO fixture through the suite's
// fetch stub.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["dropdown-menu"],
    stubComponents: {
      NotificationBell: ["NotificationBell"],
      FeedbackButton: [],
    },
    stubCss: true,
    stubClerk: { signedIn: true },
  },
});
