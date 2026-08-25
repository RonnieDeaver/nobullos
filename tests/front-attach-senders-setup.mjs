// Entry passed via `--import` so the resolve hook in
// `front-attach-senders-loader.mjs` is registered before the route file's
// dynamic `import("../services/frontIntegration")` evaluates (Task #2536).

import { register } from "node:module";

register("./front-attach-senders-loader.mjs", import.meta.url);
