import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { radix: ["alert-dialog-lifecycle"] },
});