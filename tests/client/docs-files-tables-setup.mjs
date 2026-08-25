// Entry passed via `tsx --import` for tests/client/docs-files-tables.test.tsx
// (Tasks #4489 + #4523). Composes two existing loaders:
//   - sheets-library-loader.mjs — @clerk/react stub + Radix Dialog/AlertDialog
//     shims (the original #4489 harness).
//   - ../doc-share-dialog-loader.mjs — INTERACTIVE @radix-ui/react-select shim
//     (tests/doc-share-select-shim.mjs): the #4523 kind-filter section must
//     actually PICK a file type; real Radix Select portals its listbox through
//     Presence and never mounts under this raw jsdom harness.

import { register } from "node:module";

register("./sheets-library-loader.mjs", import.meta.url);
register("../doc-share-dialog-loader.mjs", import.meta.url);
