// Entry passed via `tsx --import` so the resolve hook in `fipsLookupLoader.mjs`
// is registered before `tests/edit-location-address-route.test.ts` (and the
// route handler's dynamic `await import("../mcu/fips")`) resolve the fips
// module.
import { register } from "node:module";

register("./fipsLookupLoader.mjs", import.meta.url);
