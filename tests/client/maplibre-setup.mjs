// Entry passed via `tsx --import` so the MapLibre resolve hook is active before
// a test imports the real InteractiveHeatmap component graph.
import { register } from "node:module";

register("./maplibre-loader.mjs", import.meta.url);