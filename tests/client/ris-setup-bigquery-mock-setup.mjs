// Entry passed via `tsx --import` so the resolve hook in
// `ris-setup-bigquery-mock-loader.mjs` is registered before the test file
// evaluates its dynamic imports of the real React component graph (mirrors the
// `setup-mocks.mjs` / `client-edit-data-access-mock-setup.mjs` patterns).

import { register } from "node:module";

register("./ris-setup-bigquery-mock-loader.mjs", import.meta.url);
