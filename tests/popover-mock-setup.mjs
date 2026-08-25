// Entry passed via `tsx --import` so the shared heavy-client customization hook
// is registered before the test file evaluates its dynamic imports of the real
// React component graph. Radix Popover's portal never mounts in the raw jsdom
// harness, so we shim it via the shared loader (see `popover-shim.mjs`).

import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { radix: ["popover"] },
});
