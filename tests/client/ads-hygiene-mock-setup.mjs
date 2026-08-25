// Entry passed via `tsx --import` so the resolve hook in
// `ads-hygiene-mock-loader.mjs` is registered before the test file evaluates
// its dynamic imports of the real React component graph.
import { register } from "node:module";

register("./ads-hygiene-mock-loader.mjs", import.meta.url);
