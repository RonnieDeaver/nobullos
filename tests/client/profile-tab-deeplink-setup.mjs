// Task #3105 — entry passed via `tsx --import` so the resolve/load hook in
// `profile-tab-deeplink-loader.mjs` is registered before the test file
// evaluates its dynamic import of the real `Profile` component graph.

import { register } from "node:module";

register("./profile-tab-deeplink-loader.mjs", import.meta.url);
