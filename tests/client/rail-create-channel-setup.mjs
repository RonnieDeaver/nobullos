// Setup for tests/client/rail-create-channel.test.tsx (Task #3235).
// Shims Radix Popover + Dialog (portal content never mounts in the raw jsdom
// harness — see .agents/memory/radix-portal-jsdom-tests.md) so the rail "+"
// popover content and the RailCreateChannelDialog form are queryable; CSS
// imports map to empty modules.
// Passed via `--import ./tests/client/rail-create-channel-setup.mjs`.

import { register } from "node:module";

register("../helpers/heavyClientLoader.mjs", import.meta.url, {
  data: {
    radix: ["popover", "dialog", "alert-dialog"],
    stubCss: true,
    // NewChatPopover's graph reaches `@/hooks/use-auth`, whose `@clerk/react`
    // hooks throw outside a live <ClerkProvider>. Signed-IN lets the REAL
    // use-auth hook fetch the DB user (account_manager) through the suite's
    // fetch stub, which serves `/api/auth/user`, so role gating stays genuine.
    stubClerk: { signedIn: true },
  },
});

// CommsContext stub (comms-store split): NewChatPopover now subscribes to
// presence via useCommsSelector, which requires the real provider store —
// redirect the module to a static stub instead (see the loader's header).
register("./rail-create-channel-loader.mjs", import.meta.url);
