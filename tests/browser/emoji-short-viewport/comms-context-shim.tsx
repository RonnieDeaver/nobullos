/**
 * Task #3372 — minimal CommsContext shim for the emoji short-viewport
 * browser harness. The real CommsProvider is heavy (auth, SSE, presence);
 * MessageItem only reads `userStatuses` from it, which is irrelevant to the
 * panel-scroll behavior under test. Mirrors the jsdom shim approach
 * (tests/client/comms-sidebar-pin-collapse-shim.mjs).
 *
 * `useCommsSelector` mirrors the same shim pattern: MessageItem switched its
 * userStatuses read to the narrow store selector (Task #3848); the jsdom
 * stubs were updated then, but this browser-harness shim was missed and the
 * suite broke at import time (MISSING_EXPORT). Applying the selector over the
 * same fake state keeps the harness faithful without store reactivity.
 */
import type { ReactNode } from "react";

export function useCommsContext() {
  return {
    userStatuses: new Map(),
    myStatus: null,
    notificationSettings: null,
    channels: [],
    sidebarCategories: [],
    addSseListener: () => () => {},
    refetchChannels: () => {},
    refetchDrafts: () => {},
    updateNotificationSettings: async () => {},
  } as any;
}

export function useCommsSelector<T>(selector: (state: any) => T): T {
  return selector(useCommsContext());
}

export function CommsProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
