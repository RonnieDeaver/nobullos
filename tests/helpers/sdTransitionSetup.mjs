// Entry passed via `tsx --import` so the resolve hook in
// `sdTransitionLoader.mjs` is registered before
// `tests/sd-transition-waiting-fields.test.ts` evaluates its static import
// chain (serviceDesk routes → clickUpClient / clickUpIntegration).
import { register } from "node:module";

register("./sdTransitionLoader.mjs", import.meta.url);
