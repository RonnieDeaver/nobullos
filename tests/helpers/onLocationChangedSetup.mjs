// Entry passed via `tsx --import` so the resolve hook in
// `onLocationChangedLoader.mjs` is registered before
// `tests/add-stale-location-route.test.ts` (and `server/routes/clients`'s
// static `import { onLocationChanged } from "../mcu/worker"`) resolve the
// worker module.
import { register } from "node:module";

register("./onLocationChangedLoader.mjs", import.meta.url);
