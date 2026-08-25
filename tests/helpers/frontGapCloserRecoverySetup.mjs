// Task #2022 — entry passed via `tsx --import` so the resolve hook in
// `frontGapCloserRecoveryLoader.mjs` is registered before the gap-closer
// test file evaluates the tick's dynamic import of
// `frontHistoricalRecovery`.

import { register } from "node:module";

register("./frontGapCloserRecoveryLoader.mjs", import.meta.url);
