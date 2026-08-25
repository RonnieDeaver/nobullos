// Entry passed via `tsx --import` for ris-layer-switch.test.tsx.
//
// The suite mounts the REAL RisDashboard graph, which reaches
// `@/hooks/use-auth`, whose `@clerk/react` hooks throw outside a live
// <ClerkProvider>. Register the shared heavy-client loader with only the Clerk
// seam: `stubClerk: { signedIn: true }` lets the REAL use-auth hook fetch the
// DB user through the suite's fetch stub (which serves `/api/auth/user`) so the
// RIS manage gate stays genuine. RisDashboard here pulls no heavy browser-only
// leaves, so no component/radix/CSS stubbing is needed.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    stubClerk: { signedIn: true },
  },
});
