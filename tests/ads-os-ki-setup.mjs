// Entry passed via `tsx --import` so the keyword-intel collaborator stubs are
// registered before the test file evaluates its dynamic imports of the engine
// graph (Task #3600). See ads-os-ki-hooks.mjs for what gets redirected.
import { register } from "node:module";

register("./ads-os-ki-hooks.mjs", import.meta.url);
