// Registers the module loader for the emoji-panel popup-clipping guard test.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  new URL("./emoji-panel-popup-clipping-loader.mjs", import.meta.url),
  pathToFileURL("./"),
);
