// Stub for client/src/contexts/CommsContext.tsx used by
// tests/client/rail-channel-grouping.test.tsx (Task #3366).
//
// The real CommsProvider is heavy (SSE stream, queries, presence). CommsRail
// reads a wider slice of the context than the Comms page sidebar (channels,
// railOpen, sidebarCategories, draftsByChannelId, userStatuses, …), so the
// test's stateful provider supplies the full value object through this plain
// context. The test imports StubCommsContext from the SAME redirected module
// so both sides share one context instance.

import * as React from "react";

const Ctx = React.createContext(null);

export const StubCommsContext = Ctx;

export function useCommsContext() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("stub useCommsContext used outside stub provider");
  return ctx;
}

// Narrow-slice hook added by the comms-store split: CommsRail reads
// per-field slices (channels, totals, presence, per-DM status) through it.
// The stub provider's value object IS the snapshot, so the selector applies
// directly — updates still propagate because the provider re-renders.
export function useCommsSelector(selector) {
  return selector(useCommsContext());
}

export function CommsProvider({ children }) {
  return children;
}
