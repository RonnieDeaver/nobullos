// Entry passed via `tsx --import` so the shared heavy-client customization hook
// is registered before the test file evaluates its dynamic imports of the real
// React component graph.
//
// The Leads page renders its lead-detail dialog through Radix Dialog and the
// stage filters through Radix Select — neither portals into the raw jsdom
// harness, so both are shimmed via the shared loader. stubClerk (signed IN)
// lets the REAL use-auth hook fetch /api/auth/user through the test's fetch
// stub, keeping the canManage role gating genuine.

import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { radix: ["dialog", "select"], stubClerk: { signedIn: true } },
});
