// Entry passed via `--import` to register the resolve hook before
// serviceDesk's static imports (clickUpClient, clickUpIntegration, middleware)
// evaluate. Task #3571.

import { register } from "node:module";

register("./sd-sync-client-options-loader.mjs", import.meta.url);
