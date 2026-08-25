// Task #2501 — entry passed via `tsx --import` so the resolve hook in
// `triggerFrontAutoClosureTickMockLoader.mjs` is registered before the
// status/apply safety-net test evaluates the prod-actions registry graph
// (and its dynamic import of the Front auto-closure scheduler).

import { register } from "node:module";

register("./triggerFrontAutoClosureTickMockLoader.mjs", import.meta.url);
