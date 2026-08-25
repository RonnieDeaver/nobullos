// `--import` setup for tests/client/query-transient-retry.test.ts.
//
// Registers the shared toast-stub loader so the global QueryCache.onError
// "Request failed" toast (fired via `@/hooks/use-toast`) is captured on
// `globalThis.__capturedToasts` instead of evaluating the real toast module's
// Radix-backed import graph in plain Node.
import { register } from "node:module";

register("./dashboard-toast-stub-loader.mjs", import.meta.url);
