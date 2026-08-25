// Entry passed via `tsx --import` so the client-profile stub hooks are
// registered before the test file evaluates its dynamic imports of the
// profile graph (Task #3989). See ads-os-cp-chip-hooks.mjs.
import { register } from "node:module";

register("./ads-os-cp-chip-hooks.mjs", import.meta.url);
