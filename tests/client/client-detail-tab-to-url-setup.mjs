// Task #2552 — entry passed via `tsx --import` so the resolve/load hook in
// `client-detail-tab-from-url-loader.mjs` is registered before the test file
// evaluates its dynamic import of the real `ClientDetail` component graph.
//
// This test pins the *write* half of `?tab=` round-tripping (clicking a tab
// rewrites the URL), so it reuses the exact same heavy-panel stub loader the
// Task #2517 *read* test relies on — no need for a second loader.

import { register } from "node:module";

// Classic-JSX resilience — same shim as the from-url setup: rescues
// invocations that pass this --import but miss the registered
// TSX_TSCONFIG_PATH env (root tsconfig "jsx": "preserve" compiles classic,
// and React-import-free app modules crash with "React is not defined").
globalThis.React = (await import("react")).default;

register("./client-detail-tab-from-url-loader.mjs", import.meta.url);
