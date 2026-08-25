// Entry passed via `tsx --import` so the criteriaService stub is registered
// before the test evaluates its dynamic imports of the route/service graph
// (Task #3681). See ads-os-lsa-schedule-hooks.mjs for what gets redirected.
import { register } from "node:module";

register("./ads-os-lsa-schedule-hooks.mjs", import.meta.url);
