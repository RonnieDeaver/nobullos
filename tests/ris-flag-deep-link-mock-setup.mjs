// Entry passed via `tsx --import` so the resolve hook in
// `ris-flag-deep-link-loader.mjs` is registered before the test file evaluates
// its imports of `server/services/ris/risFlagging.ts`. Mirrors the
// `ris-setup-bigquery-mock-setup.mjs` pattern.

import { register } from "node:module";

register("./ris-flag-deep-link-loader.mjs", import.meta.url);
