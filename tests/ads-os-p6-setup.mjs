// Entry passed via `tsx --import` so the Phase 6 collaborator stubs are
// registered before the test file evaluates its dynamic imports of the
// alerts/notify/client-log graph (Task #3602). See ads-os-p6-hooks.mjs for
// what gets redirected.
import { register } from "node:module";

register("./ads-os-p6-hooks.mjs", import.meta.url);
