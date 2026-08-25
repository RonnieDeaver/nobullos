// Entry passed via `tsx --import` so the resolve hooks are registered before
// the test evaluates its dynamic imports (Task #4865).
import { register } from "node:module";

register("./ads-os-dash-paused-chip-hooks.mjs", import.meta.url);
