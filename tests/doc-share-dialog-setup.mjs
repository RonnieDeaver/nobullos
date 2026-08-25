// Entry passed via `tsx --import` for tests/doc-share-dialog.test.ts.
// Registers the shared heavy-client loader (Radix Dialog shim + CSS stubbing)
// plus a dedicated hook that swaps `@radix-ui/react-select` for an
// interactive shim (the shared one can't pick items).
import { register } from "node:module";

register("./helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { radix: ["dialog", "alert-dialog"], stubCss: true },
});
register("./doc-share-dialog-loader.mjs", import.meta.url);
