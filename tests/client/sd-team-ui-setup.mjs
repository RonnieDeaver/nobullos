// Entry passed via `tsx --import` for the Task #4174 service-desk team UI
// mount tests (ClientAdd team pre-fill, RoleAssignments company/defaults
// editor). Registers the shared heavy-client loader (CSS stubbing) plus the
// INTERACTIVE select shim: these tests must actually PICK an option, and the
// shared tests/select-shim.mjs renders the listbox Portal as null (see
// .agents/memory/mount-large-client-component-jsdom.md).

import { register } from "node:module";

// The mounted graph reaches `@/hooks/use-auth`, whose `@clerk/react` hooks
// throw outside a live <ClerkProvider>. `stubClerk: { signedIn: true }` lets
// the REAL use-auth hook fetch the DB user through the suite's fetch stub
// (which serves `/api/auth/user`) so role gating stays genuine.
register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: { stubCss: true, stubClerk: { signedIn: true } },
});
// Interactive @radix-ui/react-select → tests/doc-share-select-shim.mjs.
register("../doc-share-dialog-loader.mjs", import.meta.url);
// Record every toast() call on globalThis.__capturedToasts: TOAST_LIMIT=1
// means the partial-seed warning toast is replaced by the success toast in the
// same synchronous onSuccess before React ever renders it, so a render-time
// recorder misses it (generic stub despite the name).
register("../dashboard-toast-stub-loader.mjs", import.meta.url);
