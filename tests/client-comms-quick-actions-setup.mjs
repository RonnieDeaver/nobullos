// Entry passed via `tsx --import` so the shared heavy-client customization
// hook is registered before the test file evaluates the real component graph.
// Radix DropdownMenu's portal never mounts in the raw jsdom harness, so the
// multi-number picker is shimmed via the shared loader (see
// `dropdown-menu-shim.mjs`): content renders inline next to the trigger with
// every prop preserved, so menu items are queryable and clickable.

import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { radix: ["dropdown-menu"] },
});
