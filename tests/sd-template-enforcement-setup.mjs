// Entry passed via `--import` so the resolve hook in
// `sd-template-enforcement-loader.mjs` is registered before
// clickUpWorkerHandlers' static `import * as cu from "./clickUpClient"` and
// `import { getAccessToken } from "./clickUpIntegration"` evaluate (Task #3395).

import { register } from "node:module";

register("./sd-template-enforcement-loader.mjs", import.meta.url);
