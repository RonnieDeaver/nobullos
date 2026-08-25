// Task #2705 — entry passed via `tsx --import` so the resolve hook in
// `frontBringTo100OrchestratorLoader.mjs` is registered before the "Bring it to
// 100%" orchestration test imports `startFrontBringTo100`'s module graph (and
// its dynamic imports of the Front breaker / queue / recovery / prod-actions).

import { register } from "node:module";

register("./frontBringTo100OrchestratorLoader.mjs", import.meta.url);
