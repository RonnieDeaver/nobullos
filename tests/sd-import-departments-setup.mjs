// Entry passed via `--import` so the resolve hook in
// `sd-import-departments-loader.mjs` is registered before
// serviceDesk's static `import * as cu from "./clickUpClient"` and
// `import { getAccessToken } from "./clickUpIntegration"` evaluate (Task #3540).

import { register } from "node:module";

register("./sd-import-departments-loader.mjs", import.meta.url);
