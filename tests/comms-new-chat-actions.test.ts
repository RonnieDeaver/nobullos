/* test-registration
{
  "name": "Comms new-chat actions — picker-safe /api/comms/users, new-channel in rail, call buttons in popup (Task #3168)",
  "smoke": true,
  "smokeReason": "Task #3168: static source scan for the three new-chat-action gaps: (1) rail teammate picker uses /api/comms/users (not gated /api/users), (2) \"New channel\" action in the rail popover creates via POST /api/comms/channels and opens as a popup, (3) popup title bar has voice/video call buttons that POST to /api/comms/channels/:id/calls + navigate; Comms.tsx handles ?autoStartCall and ?joinCall params with a ref guard. DB-free, network-free.",
  "scanPaths": [
    "client/src/components/comms/CommsPopupManager.tsx",
    "client/src/components/comms/CommsRail.tsx",
    "client/src/pages/Comms.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3168 — New chats, DMs, and calls from the chat sidebar.
 *
 * Static source-scan gate proving the three shipped behaviours:
 *
 *   1. PICKER FIX: NewChatPopover in CommsRail uses the picker-safe
 *      GET /api/comms/users endpoint (not the gated /api/users), so
 *      account_manager roles see the teammate list instead of a 403.
 *
 *   2. NEW CHANNEL: The "+" popover exposes a "New channel" action that
 *      opens RailCreateChannelDialog (same POST /api/comms/channels flow as
 *      the full Comms page); on success the new channel opens as a popup.
 *
 *   3. CALL BUTTONS: CommsPopupManager's popup title bar has voice and video
 *      call buttons; clicking one POSTs to /api/comms/channels/:id/calls and
 *      navigates into the /comms full-view experience. Comms.tsx handles the
 *      resulting ?autoStartCall and ?joinCall URL params to auto-enter the
 *      call without user having to press again.
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

const railSrc = readSrc("client/src/components/comms/CommsRail.tsx");
const popupSrc = readSrc("client/src/components/comms/CommsPopupManager.tsx");
const commsSrc = readSrc("client/src/pages/Comms.tsx");

// ─── 1. Picker fix: /api/comms/users instead of /api/users ───────────────────

assert(
  railSrc.includes('"/api/comms/users"'),
  "NewChatPopover queries /api/comms/users (picker-safe, no role gate)",
);
assert(
  !railSrc.includes('queryKey: ["/api/users"]'),
  "NewChatPopover does NOT use the gated /api/users query key",
);
assert(
  !railSrc.includes('"GET", "/api/users"'),
  "NewChatPopover does NOT fetch from the gated /api/users endpoint",
);

// ─── 2. New channel action in the rail popover ────────────────────────────────

assert(
  railSrc.includes("RailCreateChannelDialog") || railSrc.includes("showCreateChannel"),
  "CommsRail defines a create-channel dialog state/component for the rail popover",
);
assert(
  railSrc.includes('data-testid="rail-new-channel-button"'),
  "Rail popover renders a 'New channel' button with the expected testid",
);
assert(
  railSrc.includes('"POST", "/api/comms/channels"'),
  "Rail create-channel dialog POSTs to /api/comms/channels (same endpoint as full Comms page)",
);
assert(
  railSrc.includes('data-testid="rail-create-channel-submit"') ||
    railSrc.includes('data-testid="rail-new-channel-name-input"'),
  "Rail create-channel dialog renders name input / submit testids",
);
{
  const createBlock = railSrc.slice(
    railSrc.indexOf("RailCreateChannelDialog") !== -1
      ? railSrc.indexOf("function RailCreateChannelDialog")
      : 0,
    railSrc.indexOf("// ─── New-chat composer"),
  );
  assert(
    createBlock.includes("onCreated") || railSrc.includes("onCreated"),
    "Rail create-channel dialog calls onCreated with the new channelId on success",
  );
}
assert(
  railSrc.includes("handleNewChannel") || railSrc.includes("setShowCreateChannel"),
  "Rail popover has a handler that opens the create-channel dialog",
);

// ─── 3a. Call buttons in the popup title bar ──────────────────────────────────

assert(
  popupSrc.includes("`popup-voice-call-${"),
  "CommsPopupManager renders per-popup voice-call button testid",
);
assert(
  popupSrc.includes("`popup-video-call-${"),
  "CommsPopupManager renders per-popup video-call button testid",
);
assert(
  popupSrc.includes("Phone") && popupSrc.includes("Video"),
  "CommsPopupManager imports Phone and Video icons for call buttons",
);

// ─── 3b. Call start POSTs to the channel and navigates to /comms ─────────────

assert(
  popupSrc.includes("/api/comms/channels/") && popupSrc.includes("/calls"),
  "Popup call handler POSTs to /api/comms/channels/:id/calls",
);
assert(
  popupSrc.includes("joinCall=") || popupSrc.includes("autoStartCall="),
  "Popup call handler navigates with joinCall= or autoStartCall= param",
);
assert(
  popupSrc.includes("startingCall"),
  "Popup call button has in-flight state to prevent double-clicks",
);

// ─── 3c. Popup call buttons disabled when LiveKit is not configured ───────────

assert(
  popupSrc.includes("callsConfigured") && popupSrc.includes("setCallsConfigured"),
  "CommsPopup tracks callsConfigured state to disable call buttons when LiveKit is absent",
);
assert(
  popupSrc.includes("503") && popupSrc.includes("setCallsConfigured(false)"),
  "CommsPopup sets callsConfigured=false on 503 response (LiveKit not set up)",
);
assert(
  popupSrc.includes("!callsConfigured"),
  "Popup call buttons are disabled when callsConfigured is false (parity with /comms header)",
);
assert(
  popupSrc.includes("Calls not configured"),
  "Popup call button tooltip explains the not-configured state to the user",
);

// ─── 3d. Comms.tsx handles autoStartCall and joinCall URL params ──────────────

assert(
  commsSrc.includes("autoStartCall"),
  "Comms.tsx reads autoStartCall from URL params",
);
assert(
  commsSrc.includes("joinCallId") || commsSrc.includes("joinCall"),
  "Comms.tsx reads joinCall from URL params",
);
assert(
  commsSrc.includes("autoStartFiredRef") &&
    commsSrc.includes("autoStartCallType") &&
    commsSrc.includes("handleStartCall"),
  "Comms.tsx auto-triggers handleStartCall when autoStartCall param is present",
);
assert(
  commsSrc.includes("enterCall") && commsSrc.includes("joinCallId"),
  "Comms.tsx auto-joins a call when joinCall param is present",
);

// Per-param-value key guard: the ref stores a string key (not a boolean true),
// so navigating to /comms from two different popup call buttons in the same
// session each fire once independently.
assert(
  commsSrc.includes("autoStartFiredRef.current === key"),
  "Comms.tsx auto-start ref uses a per-param string key (not a boolean) so repeated navigations with different params each fire once",
);
assert(
  commsSrc.includes("`start:${autoStartCallType}") &&
    commsSrc.includes("`join:${joinCallId}"),
  "Comms.tsx derives distinct keys for start vs join actions so both can coexist in the same session",
);

// ─── 3e. Room context in URL prevents stale-cache 400 on token request ───────

// When popup navigates to /comms the POST response roomName is embedded in the URL
// so Comms.tsx never relies on selectedChannel.activeCall (which can be stale).
assert(
  popupSrc.includes("joinRoom:") || popupSrc.includes("joinRoom"),
  "CommsPopupManager embeds joinRoom in the navigation URL (avoids stale channel-cache lookup)",
);
assert(
  popupSrc.includes("joinCallType"),
  "CommsPopupManager embeds joinCallType in the navigation URL alongside joinRoom",
);
assert(
  commsSrc.includes("joinRoomFromUrl") && commsSrc.includes("joinCallTypeFromUrl"),
  "Comms.tsx reads joinRoom and joinCallType URL params to pass directly to enterCall()",
);
assert(
  commsSrc.includes("joinRoomFromUrl || ch.activeCall") ||
    commsSrc.includes("joinRoomFromUrl ||"),
  "Comms.tsx uses joinRoomFromUrl as primary room source with channel-cache as fallback",
);

// ─── 3f. No second LiveKit implementation ────────────────────────────────────

assert(
  !popupSrc.includes("LiveKitRoom") && !popupSrc.includes("@livekit"),
  "CommsPopupManager does NOT duplicate the LiveKit call UI (reuses /comms)",
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\ncomms-new-chat-actions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
