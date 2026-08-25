// Entry passed via `tsx --import` so the resolve hook in
// `geocodeLocationTextLoader.mjs` is registered before
// `tests/add-stale-location-route.test.ts` (and the route handler's dynamic
// `await import("../mcu/geocoding")`) resolve the geocoding module.
import { register } from "node:module";

register("./geocodeLocationTextLoader.mjs", import.meta.url);
