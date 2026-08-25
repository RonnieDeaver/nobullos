// Task #4791 — `--import` setup for tests/client/connection-lost-recovery.test.tsx.
//
// Registers the shared toast-recording stub (globalThis.__capturedToasts) so
// the suite can assert that network-class failures NEVER fire the global
// destructive toast — the connection-lost banner replaces the toast for the
// network/offline classes only, and recovery must stay toast-free too.
import { register } from "node:module";

register("./dashboard-toast-stub-loader.mjs", import.meta.url);
