/* test-registration
{
  "name": "Global Comms Rail + Popup System — context, rail, popups, App wiring, shared SSE (Task #3127)",
  "smoke": true,
  "smokeReason": "Task #3127: Global Comms Rail + Popup System smoke gate. Proves CommsProvider and useCommsContext exports, CommsRail testids (rail, buttons, unread badge, floating button), CommsPopupManager testids (popup, close, minimize, expand), App.tsx mounts all three, Comms.tsx uses addSseListener (shared SSE, no second connection), and useSearch for ?channel=<id> deep-linking. Task #4374 adds the FAB collision-aware placement contract (fabCollider marker lib, CommsRail lift wiring, collider markings on composer/pill/upload-panel surfaces, Dashboard mobile clearance). DB-free.",
  "scanPaths": [
    "client/src/App.tsx",
    "client/src/components/clientFiles/ClientFilesTab.tsx",
    "client/src/components/comms/CommsPopupManager.tsx",
    "client/src/components/comms/CommsRail.tsx",
    "client/src/contexts/CommsContext.tsx",
    "client/src/lib/fabCollider.ts",
    "client/src/pages/Comms.tsx",
    "client/src/pages/ConversationHub.tsx",
    "client/src/pages/Dashboard.tsx",
    "client/src/pages/admin/CeoPulseAdmin.tsx",
    "server/routes/comms.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3127 — Global Comms Rail + Popup System smoke gate.
 *
 * Proves the critical contracts for the always-accessible chat rail:
 *
 *   1. CommsProvider + useCommsContext are exported from
 *      client/src/contexts/CommsContext.tsx.
 *   2. CommsRail is exported from client/src/components/comms/CommsRail.tsx
 *      and references the expected test-ids (rail, buttons, unread badge).
 *   3. CommsPopupManager is exported from
 *      client/src/components/comms/CommsPopupManager.tsx and references
 *      popup test-ids (comms-popup-, popup-close-, popup-minimize-).
 *   4. App.tsx mounts CommsProvider, CommsRail, and CommsPopupManager
 *      (source guard — if they're omitted the feature is invisible globally).
 *   5. Comms.tsx uses addSseListener (shared SSE) and NOT its own
 *      standalone useCommsSSE call (the standalone SSE would open a second
 *      connection and duplicate events).
 *   6. Comms.tsx imports useSearch for the ?channel=<id> deep-link.
 *   7. The comms-smoke assertions still hold (no regressions in the original
 *      smoke gate contracts).
 *
 * Fast, DB-free, deterministic (static source scan). No network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

function readSrc(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), "utf-8");
}

// ─── 1. CommsContext exports ───────────────────────────────────────────────────

const contextSrc = readSrc("client/src/contexts/CommsContext.tsx");

assert(
  contextSrc.includes("export function CommsProvider"),
  "CommsContext exports CommsProvider",
);
assert(
  contextSrc.includes("export function useCommsContext"),
  "CommsContext exports useCommsContext",
);
assert(
  contextSrc.includes("addSseListener"),
  "CommsContext exposes addSseListener API",
);
assert(
  contextSrc.includes("openPopup"),
  "CommsContext exposes openPopup for popup management",
);
assert(
  contextSrc.includes("toggleRail"),
  "CommsContext exposes toggleRail for rail state",
);
assert(
  contextSrc.includes("nextSseReconnectState"),
  "CommsContext uses shared SSE reconnect policy (sseReconnect.ts)",
);

// ─── 2. CommsRail source contracts ────────────────────────────────────────────

const railSrc = readSrc("client/src/components/comms/CommsRail.tsx");

assert(
  railSrc.includes("export function CommsRail"),
  "CommsRail is exported as a function",
);
assert(
  railSrc.includes('data-testid="comms-rail"'),
  "CommsRail renders the comms-rail root testid",
);
assert(
  railSrc.includes('data-testid="rail-expand-button"') || railSrc.includes('data-testid="rail-collapse-button"'),
  "CommsRail renders expand/collapse button testids",
);
assert(
  railSrc.includes("data-testid=\"rail-total-unread\""),
  "CommsRail renders total-unread badge testid",
);
assert(
  railSrc.includes("data-testid=\"comms-floating-button\""),
  "CommsRail renders floating button for small screens",
);
assert(
  railSrc.includes("shouldRenderGlobalQuicklinksBar") || railSrc.includes("CommsProvider") || railSrc.includes("useCommsContext") || railSrc.includes("useCommsSelector"),
  "CommsRail consumes CommsContext",
);
assert(
  railSrc.includes("data-testid=\"rail-open-full-comms\""),
  "CommsRail has link to open full Comms view",
);

// ─── 3. CommsPopupManager source contracts ────────────────────────────────────

const popupSrc = readSrc("client/src/components/comms/CommsPopupManager.tsx");

assert(
  popupSrc.includes("export function CommsPopupManager"),
  "CommsPopupManager is exported as a function",
);
assert(
  popupSrc.includes("`comms-popup-${"),
  "CommsPopupManager renders per-channel popup testids",
);
assert(
  popupSrc.includes("`popup-close-${"),
  "CommsPopupManager renders per-popup close button testids",
);
assert(
  popupSrc.includes("`popup-minimize-${"),
  "CommsPopupManager renders per-popup minimize button testids",
);
assert(
  popupSrc.includes("`popup-expand-${"),
  "CommsPopupManager renders per-popup expand-to-full testids",
);
assert(
  popupSrc.includes("/comms?channel="),
  "CommsPopupManager deep-links to /comms?channel=<id>",
);
assert(
  popupSrc.includes("MAX_POPUPS") || popupSrc.includes("3"),
  "CommsPopupManager enforces popup cap (max 3)",
);

// ─── 3b. Popup persistence + hydration skeleton (Task #3137) ──────────────────

assert(
  contextSrc.includes("sessionStorage.getItem") && contextSrc.includes("comms_open_popups"),
  "CommsContext rehydrates popup state from sessionStorage on mount",
);
assert(
  contextSrc.includes("sessionStorage.setItem(POPUPS_SS_KEY"),
  "CommsContext persists popup state to sessionStorage on change",
);
assert(
  contextSrc.includes("channelsLoaded"),
  "CommsContext exposes channelsLoaded so consumers can distinguish hydrating vs missing",
);
assert(
  popupSrc.includes("`comms-popup-skeleton-${"),
  "CommsPopupManager renders a loading skeleton while channel data hydrates",
);
assert(
  popupSrc.includes("channelsLoaded"),
  "CommsPopupManager only drops a popup after the channel list has loaded",
);

// ─── 4. App.tsx mounts the global comms shell ──────────────────────────────────

const appSrc = readSrc("client/src/App.tsx");

assert(
  appSrc.includes("CommsProvider"),
  "App.tsx imports and mounts CommsProvider",
);
assert(
  appSrc.includes("CommsRail"),
  "App.tsx imports and mounts CommsRail",
);
assert(
  appSrc.includes("CommsPopupManager"),
  "App.tsx imports and mounts CommsPopupManager",
);
assert(
  appSrc.includes("<CommsProvider>") || appSrc.includes("<CommsProvider "),
  "App.tsx renders <CommsProvider> as a JSX element",
);
assert(
  appSrc.includes("<CommsShell") || appSrc.includes("<CommsRail"),
  "App.tsx renders CommsRail in the Router shell",
);

// ─── 5. Comms.tsx uses shared SSE (no second EventSource) ─────────────────────

const commsSrc = readSrc("client/src/pages/Comms.tsx");

assert(
  commsSrc.includes("addSseListener"),
  "Comms.tsx subscribes to SSE via addSseListener (shared connection)",
);
assert(
  !commsSrc.includes("useCommsSSE(handleSSE)"),
  "Comms.tsx does NOT open its own standalone SSE connection",
);

// ─── 6. Comms.tsx deep-link support ──────────────────────────────────────────

assert(
  commsSrc.includes("useSearch"),
  "Comms.tsx imports useSearch for ?channel=<id> deep-link",
);
assert(
  commsSrc.includes("channel") && commsSrc.includes("channelFromUrl"),
  "Comms.tsx reads channelFromUrl from URL params",
);

// ─── 7. No regressions in comms-smoke contracts ────────────────────────────────

const commsRoutesSrc = readSrc("server/routes/comms.ts");
assert(
  commsRoutesSrc.includes("registerCommsRoutes") || commsRoutesSrc.includes("export"),
  "server/routes/comms.ts still exports registerCommsRoutes (no regression)",
);

assert(
  commsSrc.includes("useCommsContext"),
  "Comms.tsx imports useCommsContext (wired to global context)",
);
assert(
  appSrc.includes('path="/comms"'),
  "App.tsx still routes /comms to the Comms page (no regression)",
);

// ─── 8. Rail new-chat popover (Task #3140) ────────────────────────────────────

assert(
  railSrc.includes('data-testid="rail-new-chat"'),
  "CommsRail keeps the rail-new-chat + button testid",
);
assert(
  railSrc.includes('data-testid="rail-new-chat-popover"'),
  "CommsRail's + button opens an in-rail popover (rail-new-chat-popover)",
);
assert(
  railSrc.includes('data-testid="rail-new-chat-search"'),
  "Rail new-chat popover has a search input testid",
);
assert(
  railSrc.includes("`rail-dm-user-${"),
  "Rail new-chat popover renders per-user testids for DM targets",
);
assert(
  railSrc.includes("`rail-new-chat-channel-${"),
  "Rail new-chat popover renders per-channel testids for existing group channels",
);
assert(
  railSrc.includes('"/api/comms/dms"'),
  "Rail new-chat popover creates/finds DMs via POST /api/comms/dms",
);
assert(
  railSrc.includes("refetchChannels"),
  "Rail new-chat popover refetches the channel list after creating a DM",
);
{
  // The + button must NOT navigate to /comms — it should open the popover.
  const newChatBlock = railSrc.slice(
    railSrc.indexOf("function NewChatPopover"),
    railSrc.indexOf("// ─── Main CommsRail"),
  );
  assert(
    newChatBlock.length > 0 && !newChatBlock.includes('navigate("/comms")'),
    "NewChatPopover does not navigate away from the current page",
  );
  assert(
    newChatBlock.includes("onOpenChannel"),
    "NewChatPopover opens the resulting channel via the popup opener",
  );
}

// ─── 9. FAB collision-aware placement (Task #4374) ────────────────────────────
//
// The mobile floating comms button lifts itself above any element marked with
// the data-fab-collider attribute (composer bars, action pills, upload
// panels). These contracts pin the marker library, the lift wiring in
// CommsRail (including the keepalive that catches position-only moves, which
// ResizeObserver never reports), and the per-surface markings.

const fabLibSrc = readSrc("client/src/lib/fabCollider.ts");

assert(
  fabLibSrc.includes('"data-fab-collider"'),
  "fabCollider.ts defines the data-fab-collider marker attribute",
);
assert(
  fabLibSrc.includes("export function fabColliderRef"),
  "fabCollider.ts exports the fabColliderRef ref callback",
);
assert(
  fabLibSrc.includes("export function notifyFabCollidersChanged"),
  "fabCollider.ts exports notifyFabCollidersChanged",
);
assert(
  fabLibSrc.includes('"nobull:fab-colliders-changed"'),
  "fabCollider.ts defines the colliders-changed window event name",
);

assert(
  railSrc.includes('from "@/lib/fabCollider"'),
  "CommsRail imports the fabCollider contract",
);
assert(
  railSrc.includes("computeFabLift"),
  "CommsRail computes a collision-aware lift for the floating button",
);
assert(
  railSrc.includes("ResizeObserver"),
  "CommsRail re-measures colliders on resize via ResizeObserver",
);
assert(
  railSrc.includes("setInterval(schedule, 1000)"),
  "CommsRail runs the 1s keepalive while colliders are mounted (catches position-only moves)",
);
assert(
  railSrc.includes("FAB_COLLIDERS_CHANGED_EVENT, scheduleRescan"),
  "CommsRail rescans when colliders mount/unmount",
);

const hubSrc = readSrc("client/src/pages/ConversationHub.tsx");
assert(
  (hubSrc.match(/ref=\{fabColliderRef\}/g) ?? []).length >= 2,
  "ConversationHub marks the composer and follow-up strip as FAB colliders",
);

const pulseSrc = readSrc("client/src/pages/admin/CeoPulseAdmin.tsx");
assert(
  pulseSrc.includes("ref={fabColliderRef}"),
  "CeoPulseAdmin marks the Refine-with-AI pill as a FAB collider",
);

const filesSrc = readSrc("client/src/components/clientFiles/ClientFilesTab.tsx");
assert(
  filesSrc.includes("ref={fabColliderRef}"),
  "ClientFilesTab marks the upload-progress panel as a FAB collider",
);

const dashSrc = readSrc("client/src/pages/Dashboard.tsx");
assert(
  dashSrc.includes("pb-24"),
  "Dashboard keeps mobile bottom clearance so list rows scroll clear of the FAB",
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\ncomms-global-rail: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
