// Task #2228 — entry passed via `tsx --import` so the resolve hook in
// `reArmRaceDrainMockLoader.mjs` is registered before the re-arm
// unpark-race drain test evaluates its dynamic imports of the real
// helper module graph.

import { register } from "node:module";

register("./reArmRaceDrainMockLoader.mjs", import.meta.url);
