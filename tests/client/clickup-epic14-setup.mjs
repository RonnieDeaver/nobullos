// Entry passed via `tsx --import` so the resolve hook in
// `clickup-epic14-loader.mjs` is registered before the test file evaluates
// its dynamic imports of the real ClickUpModule component graph (mirrors the
// `ris-setup-bigquery-mock-setup.mjs` / `sheets-library-setup.mjs` patterns).

import { register } from "node:module";

register("./clickup-epic14-loader.mjs", import.meta.url);
