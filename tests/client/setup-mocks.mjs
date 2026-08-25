// Task #866 — entry passed via `tsx --import` so the resolve hook in
// `mock-loader.mjs` is registered before the test file evaluates its
// dynamic imports of the real React component graph.

import { register } from "node:module";

register("./mock-loader.mjs", import.meta.url);
