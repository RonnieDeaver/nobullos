// Entry passed via `tsx --import` for
// tests/internal-usage-reconciliation-row.test.ts: registers the shared
// heavy-client loader so any `.css` side-effect import reachable from the
// InternalUsage page graph resolves to an empty module under node/tsx (see
// memory: mount-large-client-component-jsdom). No Radix portals are involved —
// the page renders only Card/Table/Badge/Button/Skeleton.
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubCss: true, stubClerk: { signedIn: true } },
});
