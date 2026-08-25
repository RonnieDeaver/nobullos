// Entry passed via `tsx --import` so the resolve hooks in
// `sheets-library-loader.mjs` are registered before the test file evaluates
// its dynamic imports of the React component graph.
//
// Mirrors the `ris-setup-bigquery-mock-setup.mjs` / `setup-mocks.mjs` patterns.

import { register } from "node:module";

register("./sheets-library-loader.mjs", import.meta.url);
