// Entry passed via `tsx --import` for tests/churn-leaderboard-tab-render.test.ts:
// registers the shared heavy-client loader so CSS side-effect imports don't
// blow up under node/tsx and Radix Select (sort/owner filters) renders inline
// through the canonical select shim instead of an unmountable portal (see
// memory: mount-large-client-component-jsdom, radix-portal-jsdom-tests).
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubCss: true, radix: ["select"] },
});
