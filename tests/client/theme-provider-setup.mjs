// Entry passed via `tsx --import` for
// tests/client/theme-provider-switch-persist.test.ts (Task #4377).
// Registers the resolve hook that redirects the ThemeProvider's two app-side
// imports to tiny stubs:
//   - `@/hooks/use-auth`   → globalThis.__THEME_TEST_AUTH-driven stub (the
//     real hook needs Clerk + a QueryClientProvider + wouter location);
//   - `@/lib/queryClient`  → apiRequest recorder (the real module drags in
//     toast/chunk-reload machinery irrelevant to theme switching).
// Everything else (react, react-dom, @tanstack/react-query) stays real.

import { register } from "node:module";

register("./theme-provider-loader.mjs", import.meta.url);
