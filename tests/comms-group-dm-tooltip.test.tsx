/* test-registration
{
  "name": "Comms group-DM presence-dot name tooltips — ChannelHeader + popup title bar render title=\"Name — Status\" per dot, status-only fallback for unknown names, unknown presence = offline (Tasks #3342/#3383)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3383 (behavior from Task #3342): group-DM presence-dot name tooltips — both the /comms ChannelHeader and the docked popup title bar must render each dot's title as \"Name — Status\" (dnd spelled out as \"Do not disturb\"), fall back to status-only when the participant has no dmParticipants entry, and render unknown presence as Offline. Rendered jsdom test mounting the real ChannelHeader + CommsPopupManager with a stubbed CommsContext + stubbed heavy children; DB-free, network-free.",
  "extraNodeArgs": [
    "--import",
    "./tests/comms-group-dm-tooltip-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Rendered coverage for group-DM presence-dot name tooltips (Task #3383,
 * behavior shipped in Task #3342).
 *
 * Mounts BOTH real surfaces that render per-participant presence dots for a
 * group DM — the /comms channel header (ChannelHeader in pages/Comms.tsx)
 * and the docked popup title bar (CommsPopupManager) — via a stubbed
 * CommsContext + stubbed heavy children (see
 * tests/comms-group-dm-tooltip-setup.mjs), and asserts each dot's `title`
 * attribute:
 *   - "Name — Status" when the participant's name is known via
 *     channel.dmParticipants (e.g. "Jane Doe — Online");
 *   - "Do not disturb" spelled out (not "Dnd") with the name prefix;
 *   - status-only fallback when the participant has no dmParticipants entry;
 *   - unknown presence renders as an Offline dot (name — Offline).
 *
 * DB-free, network-free. Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json and
 * --import ./tests/comms-group-dm-tooltip-setup.mjs.
 * Registered in tests/run-all.ts.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

const CHANNEL_ID = "chan-gdm-1";
const ME = "user-me";
const JANE = "user-jane";
const BOB = "user-bob";
const GHOST = "user-ghost"; // member with NO dmParticipants entry (unknown name)

const groupDmChannel = {
  id: CHANNEL_ID,
  name: null,
  slug: null,
  type: "group_dm",
  visibility: "private",
  topic: null,
  description: null,
  clientId: null,
  createdBy: ME,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  unreadCount: 0,
  mentionCount: 0,
  members: [
    { channelId: CHANNEL_ID, userId: ME, role: "member" },
    { channelId: CHANNEL_ID, userId: JANE, role: "member" },
    { channelId: CHANNEL_ID, userId: BOB, role: "member" },
    { channelId: CHANNEL_ID, userId: GHOST, role: "member" },
  ],
  // GHOST deliberately absent — its dot must fall back to status-only.
  dmParticipants: [
    { userId: ME, name: "Me Myself" },
    { userId: JANE, name: "Jane Doe" },
    { userId: BOB, name: "Bob Smith" },
  ],
};

// Presence: Jane online, Bob dnd, Ghost online; a fourth state (unknown map
// entry) is implicitly covered by leaving nobody at "away" — unknown users
// default to offline, asserted via a second channel below.
const userStatuses = new Map<string, any>([
  [JANE, { effectiveStatus: "online" }],
  [BOB, { effectiveStatus: "dnd" }],
  [GHOST, { effectiveStatus: "online" }],
]);

function titleOf(testId: string): string | null {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  return el ? el.getAttribute("title") : null;
}

async function main(): Promise<void> {
  (globalThis as any).__COMMS_POPUP_TEST_CTX = {
    channels: [groupDmChannel],
    channelsLoaded: true,
    popups: [{ channelId: CHANNEL_ID, minimized: true }],
    archivedChannelOverrides: {},
    userStatuses,
    closePopup: () => {},
    setPopupMinimized: () => {},
    promotePopup: () => {},
  };

  const { ChannelHeader } = await import("../client/src/pages/Comms");
  const { CommsPopupManager } = await import(
    "../client/src/components/comms/CommsPopupManager"
  );

  const container = document.getElementById("root")!;
  const root: Root = createRoot(container);

  // ── /comms channel header ──────────────────────────────────────────────
  await act(async () => {
    root.render(
      React.createElement(ChannelHeader as any, {
        channel: groupDmChannel,
        onStartCall: () => {},
        onJoinCall: () => {},
        onEndCall: () => {},
        callActive: false,
        callsConfigured: false,
        onOpenSettings: () => {},
        currentUserId: ME,
      }),
    );
  });

  section("ChannelHeader — group DM presence-dot tooltips");
  assert(
    document.querySelector('[data-testid="channel-header-group-statuses"]') != null,
    "group status dot container renders",
  );
  assert(
    titleOf(`channel-header-group-status-${JANE}`) === "Jane Doe — Online",
    `Jane's dot title is "Jane Doe — Online" (got '${titleOf(`channel-header-group-status-${JANE}`)}')`,
  );
  assert(
    titleOf(`channel-header-group-status-${BOB}`) === "Bob Smith — Do not disturb",
    `Bob's dnd dot title is "Bob Smith — Do not disturb" (got '${titleOf(`channel-header-group-status-${BOB}`)}')`,
  );
  assert(
    titleOf(`channel-header-group-status-${GHOST}`) === "Online",
    `unknown-name dot falls back to status-only "Online" (got '${titleOf(`channel-header-group-status-${GHOST}`)}')`,
  );
  assert(
    document.querySelector(`[data-testid="channel-header-group-status-${ME}"]`) == null,
    "current user gets no dot in the header",
  );

  // Unknown presence → offline, still name-prefixed.
  const noPresenceChannel = {
    ...groupDmChannel,
    id: "chan-gdm-2",
    members: [
      { channelId: "chan-gdm-2", userId: ME, role: "member" },
      { channelId: "chan-gdm-2", userId: "user-quiet", role: "member" },
    ],
    dmParticipants: [
      { userId: ME, name: "Me Myself" },
      { userId: "user-quiet", name: "Quiet Person" },
    ],
  };
  await act(async () => {
    root.render(
      React.createElement(ChannelHeader as any, {
        channel: noPresenceChannel,
        onStartCall: () => {},
        onJoinCall: () => {},
        onEndCall: () => {},
        callActive: false,
        callsConfigured: false,
        onOpenSettings: () => {},
        currentUserId: ME,
      }),
    );
  });
  assert(
    titleOf("channel-header-group-status-user-quiet") === "Quiet Person — Offline",
    `unknown presence renders "Quiet Person — Offline" (got '${titleOf("channel-header-group-status-user-quiet")}')`,
  );

  // ── Docked popup title bar ─────────────────────────────────────────────
  await act(async () => {
    root.render(React.createElement(CommsPopupManager, { currentUserId: ME }));
  });

  section("CommsPopupManager — popup title-bar presence-dot tooltips");
  assert(
    document.querySelector(`[data-testid="popup-group-statuses-${CHANNEL_ID}"]`) != null,
    "popup group status dot container renders",
  );
  assert(
    titleOf(`popup-group-status-${CHANNEL_ID}-${JANE}`) === "Jane Doe — Online",
    `popup Jane's dot title is "Jane Doe — Online" (got '${titleOf(`popup-group-status-${CHANNEL_ID}-${JANE}`)}')`,
  );
  assert(
    titleOf(`popup-group-status-${CHANNEL_ID}-${BOB}`) === "Bob Smith — Do not disturb",
    `popup Bob's dnd dot title is "Bob Smith — Do not disturb" (got '${titleOf(`popup-group-status-${CHANNEL_ID}-${BOB}`)}')`,
  );
  assert(
    titleOf(`popup-group-status-${CHANNEL_ID}-${GHOST}`) === "Online",
    `popup unknown-name dot falls back to "Online" (got '${titleOf(`popup-group-status-${CHANNEL_ID}-${GHOST}`)}')`,
  );
  assert(
    document.querySelector(`[data-testid="popup-group-status-${CHANNEL_ID}-${ME}"]`) == null,
    "current user gets no dot in the popup title bar",
  );

  await act(async () => {
    root.unmount();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().then(
  () => process.exit(failed > 0 ? 1 : 0),
  (err) => {
    console.error("Test run crashed:", err);
    process.exit(1);
  },
);
