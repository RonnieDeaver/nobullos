// Stub for client/src/contexts/CommsContext.tsx used by
// tests/client/comms-sidebar-pin-collapse.test.tsx.
//
// The real CommsProvider is heavy (SSE stream, queries, presence). The
// CommsSidebar under test only reads { totalThreadUnread, totalThreadMentions,
// pinnedChannelIds, togglePin } (plus myStatus in the footer), so this shim
// exposes a plain React context the test can drive with its own stateful
// provider. The test imports StubCommsContext from the SAME redirected module
// so both sides share one context instance.

import * as React from "react";

const Ctx = React.createContext(null);

export const StubCommsContext = Ctx;

export function useCommsContext() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("stub useCommsContext used outside stub provider");
  return ctx;
}

// Narrow-selector hook: the stub has no store/subscription machinery — the
// test drives updates by re-rendering its stateful provider — so selecting
// from the current context value is behaviorally equivalent (same pattern as
// tests/comms-popup-narrow-viewport-stub.mjs). Unused until CommsSidebar
// adopts per-field selectors; present so that adoption doesn't break this
// suite the way it broke the rail suites.
export function useCommsSelector(selector) {
  return selector(useCommsContext());
}

export function CommsProvider({ children }) {
  return children;
}
