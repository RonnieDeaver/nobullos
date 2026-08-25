// Entry point passed via `--import` so the resolve hooks in
// `sd-submit-status-fallback-loader.mjs` are registered before
// serviceDesk.ts's static imports of clickUpClient, clickUpIntegration,
// and userInbox are evaluated (Task #3569).

import { register } from "node:module";

register("./sd-submit-status-fallback-loader.mjs", import.meta.url);
