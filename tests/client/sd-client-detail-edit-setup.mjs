// Entry passed via `tsx --import` for the Task #4198 ClientDetail SD Team
// EDIT/SAVE mount test. Composes three existing loaders:
//   - client-detail-tab-from-url-loader.mjs — stubs ClientDetail's heavy
//     sibling panels (CommandPanel, LocalDominanceDashboard, …) + CSS imports,
//     exactly like the Task #4174 badges suite.
//   - doc-share-dialog-loader.mjs — INTERACTIVE @radix-ui/react-select shim
//     (tests/doc-share-select-shim.mjs): this test must actually PICK options
//     in the three assignment selects; the shared tests/select-shim.mjs
//     renders the listbox Portal as null and can't.
//   - dashboard-toast-stub-loader.mjs — records every toast() call on
//     globalThis.__capturedToasts so the "Assignment saved" / destructive
//     "Save failed" toasts can be asserted without mounting the Toaster.

import { register } from "node:module";

register("./client-detail-tab-from-url-loader.mjs", import.meta.url);
register("../doc-share-dialog-loader.mjs", import.meta.url);
register("../dashboard-toast-stub-loader.mjs", import.meta.url);
