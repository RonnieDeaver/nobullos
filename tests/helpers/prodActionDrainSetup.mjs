// Task #1980 — entry passed via `tsx --import` so the resolve hook in
// `prodActionDrainMockLoader.mjs` is registered before the drain unit
// test evaluates its dynamic import of the real helper module graph.

import { register } from "node:module";

register("./prodActionDrainMockLoader.mjs", import.meta.url);
