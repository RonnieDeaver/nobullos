// Task #2517 — entry passed via `tsx --import` so the resolve/load hook in
// `client-detail-tab-from-url-loader.mjs` is registered before the test file
// evaluates its dynamic import of the real `ClientDetail` component graph.

import { register } from "node:module";

// Classic-JSX resilience: the registered lane runs with
// TSX_TSCONFIG_PATH=tsconfig.tests.json ("jsx": "react-jsx", automatic
// runtime). If the suite is invoked with this --import but WITHOUT that env
// (e.g. a bare `tsx --import … <file>` repro), tsx falls back to the root
// tsconfig's "jsx": "preserve", which esbuild compiles as CLASSIC
// React.createElement — and app modules that never import React locally
// (e.g. ui/skeleton-loaders.tsx) crash at render with "React is not
// defined". Publishing React as a global rescues that partial lane without
// affecting the automatic-runtime one.
globalThis.React = (await import("react")).default;

register("./client-detail-tab-from-url-loader.mjs", import.meta.url);
