// Entry passed via `tsx --import` for tests/client/ceo-insights-red-pill-guard.test.tsx:
// registers the shared heavy-client loader so the CeoInsights page graph mounts
// under node/tsx + jsdom.
//
// stubClerk signed-IN: CeoInsights role-gates on `useAuth()` (CEO-only page);
// @clerk/react's hooks throw outside a live <ClerkProvider>. A signed-in stub
// lets the real use-auth hook fetch the role through the test's fetch stub
// (/api/auth/user serves the CEO fixture).
import { register } from "node:module";

// Defensive: if any file in the mounted page graph gets compiled with the
// CLASSIC JSX transform (solo runs use --tsconfig ./tsconfig.tests.json →
// react-jsx, but other transforms reference a bare `React` binding), a
// global React keeps the mount from throwing "React is not defined".
globalThis.React = (await import("react")).default;

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubClerk: { signedIn: true } },
});
