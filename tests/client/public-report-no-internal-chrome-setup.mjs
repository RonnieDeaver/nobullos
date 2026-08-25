// Setup for tests/client/public-report-no-internal-chrome.test.tsx (Task #4257).
// The test mounts the REAL App shell (client/src/App.tsx) at /demo-report, so
// the import graph pulls the full PublicReport page (recharts, framer-motion,
// react-markdown) plus the app chrome. Only CSS side-effect imports need
// stubbing for tsx/node to evaluate the graph; everything else stays real so
// the CommsShell / use-auth / GlobalTitleManager public-path gates under test
// are the production code paths.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubCss: true,
    // Clerk cutover (Task #4548): App.tsx now mounts <ClerkProvider> at the
    // root; the shared stub keeps it a passthrough. signedIn: true keeps the
    // REAL use-auth hook fetching /api/auth/user through this suite's fetch
    // stub on internal paths (the positive control), while the public-path
    // gates under test stay the production code paths.
    stubClerk: { signedIn: true },
  },
});
