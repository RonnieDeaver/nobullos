// Entry passed via `tsx --import` for tests/ads-os-pyramid-tool-render.test.ts:
// registers the shared heavy-client loader so the AdsOsShell's `import
// "../adsOs.css"` side-effect doesn't blow up under node/tsx
// (ERR_UNKNOWN_FILE_EXTENSION — see memory: mount-large-client-component-jsdom).
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  // stubClerk: AdsOsShell reads `useAuth()` to role-gate the System Checks
  // (proofs) tab (Task #4375); @clerk/react's hooks throw outside a live
  // <ClerkProvider>. A signed-OUT stub keeps use-auth's /api/auth/user query
  // disabled — no fetch, user stays null, the CEO-only tab simply stays hidden
  // (this suite asserts pyramid content, not the top bar).
  data: { stubCss: true, stubClerk: { signedIn: false } },
});
