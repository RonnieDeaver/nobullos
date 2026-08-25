// Task #2119 — entry passed via `tsx --import` so the resolve hook in
// `oneWindowReArmDrainMockLoader.mjs` is registered before the
// single-window re-arm drain test evaluates its dynamic imports of the
// real helper module graph.

import { register } from "node:module";

register("./oneWindowReArmDrainMockLoader.mjs", import.meta.url);
