// Entry passed via `tsx --import` for the Task #4204 scope-change confirmation
// dialog mount test (tests/client/sd-scope-dialog-cancel-confirm.test.tsx).
// Composes the shared loaders:
//   - helpers/heavyClientLoader.mjs — CSS stubbing + Radix Dialog shim
//     (tests/dialog-shim.mjs honours the controlled `open` prop, so the
//     scope-confirm dialog content is queryable once pendingScope is set).
//   - doc-share-dialog-loader.mjs — INTERACTIVE @radix-ui/react-select shim
//     (tests/doc-share-select-shim.mjs): the test must actually PICK a scope
//     option; the shared tests/select-shim.mjs renders the listbox as null.
//   - dashboard-toast-stub-loader.mjs — records toast() calls on
//     globalThis.__capturedToasts so the confirm-path success toast can be
//     asserted without mounting the Toaster.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubCss: true, radix: ["dialog", "alert-dialog"], stubClerk: { signedIn: true } },
});
register("../doc-share-dialog-loader.mjs", import.meta.url);
register("../dashboard-toast-stub-loader.mjs", import.meta.url);
