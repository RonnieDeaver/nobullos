// Entry passed via `tsx --import` for
// tests/client/global-nav-sheets-adsos-placement.test.tsx.
//
// GlobalAppNav's "More" dropdown is a Radix DropdownMenu whose portal never
// mounts in the raw jsdom harness, so the shared loader shims
// `@radix-ui/react-dropdown-menu` to inline pass-throughs (content renders
// next to the trigger with all props preserved). NotificationBell and
// FeedbackButton are stubbed — they carry their own query/SSE machinery
// that's irrelevant to nav placement.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["dropdown-menu"],
    stubComponents: {
      NotificationBell: ["NotificationBell"],
      FeedbackButton: [],
    },
    stubCss: true,
    // QuicklinksBar mounts use-auth, whose @clerk/react hooks throw outside
    // a live <ClerkProvider>. Signed-IN stub (same recipe as
    // ceo-insights-red-pill-guard-setup.mjs): the real use-auth hook then
    // fetches the role through this suite's fetch stub, which already
    // serves /api/auth/user with the CEO fixture. (The 2026-08 Clerk port
    // missed this raw-jsdom harness; reconciled during Task #4554's gate.)
    stubClerk: { signedIn: true },
  },
});
