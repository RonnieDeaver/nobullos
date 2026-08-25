// Entry passed via `tsx --import` so the pyramid collaborator stubs are
// registered before the test file evaluates its dynamic imports of the engine
// graph (Task #3601). See ads-os-pyramid-hooks.mjs for what gets redirected.
import { register } from "node:module";

register("./ads-os-pyramid-hooks.mjs", import.meta.url);
