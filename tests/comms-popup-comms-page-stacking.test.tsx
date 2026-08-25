/* test-registration
{
  "name": "Comms-page popup stacking — /comms branch drops the base right offset (newest at right 0), older popups stack left in 340px+8px slots, narrow-viewport shrink + vertical bar stacking still apply on /comms (Task #3367)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3367: comms-page popup stacking — the /comms branch drops the base right offset (newest popup at right 0), older popups stack left in 340px+8px slots, and the narrow-viewport shrink + vertical bar stacking still apply on /comms. Same DB-free/network-free jsdom harness as the narrow-viewport test above.",
  "extraNodeArgs": [
    "--import",
    "./tests/comms-popup-narrow-viewport-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Rendered coverage for the /comms-page popup layout branch + multi-popup
 * side-by-side stacking (Task #3367; behavior shipped in Tasks #3345/#3391).
 *
 * The full Comms page hides the right-hand rail, so CommsPopupManager's
 * onCommsPage branch drops the base right offset entirely:
 *   rightOffset = (totalPopups - 1 - index) * (POPUP_WIDTH + POPUP_GAP)
 *
 * Mounts the real CommsPopupManager (same stubbed CommsContext + stubbed
 * heavy children as tests/comms-popup-narrow-viewport.test.tsx — see
 * tests/comms-popup-narrow-viewport-setup.mjs) with the JSDOM URL set to
 * /comms and 3 open popups, and asserts through rendered inline styles:
 *   - Desktop (1280px): newest popup (last index) sits at right: 0; older
 *     popups stack left in 340px + 8px-gap slots (348 / 696), even with
 *     railOpen=true (the rail is hidden on /comms so it must not shift
 *     popups).
 *   - All three popups fit on screen side-by-side at 1280px.
 *   - Narrow (375px) still applies on /comms: every popup collapses to the
 *     8px right offset, width shrinks to fit the viewport, and older popups
 *     stack vertically above the newest (title-bar slots with the 8px gap).
 *
 * Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json and
 * --import ./tests/comms-popup-narrow-viewport-setup.mjs.
 * Registered in tests/run-all.ts (SMOKE_FILES: DB-free, network-free).
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  pretendToBeVisual: true,
  // wouter's useLocation reads from the JSDOM URL — mount "on" the Comms page.
  url: "http://localhost/comms",
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

function setViewportWidth(width: number): void {
  Object.defineProperty(dom.window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

async function resizeTo(width: number): Promise<void> {
  await act(async () => {
    setViewportWidth(width);
    dom.window.dispatchEvent(new dom.window.Event("resize"));
  });
}

function popupEl(channelId: string): HTMLElement | null {
  return document.querySelector(
    `[data-testid="comms-popup-${channelId}"]`,
  ) as HTMLElement | null;
}

function px(value: string): number {
  return Number.parseFloat(value);
}

// Layout constants mirrored from CommsPopupManager.tsx.
const POPUP_WIDTH = 340;
const POPUP_GAP = 8;
const POPUP_TITLE_HEIGHT = 40;
const NARROW_RIGHT_OFFSET = 8;
const NARROW_LEFT_MARGIN = 8;

const CHANNEL_IDS = ["chan-oldest", "chan-middle", "chan-newest"];

async function main(): Promise<void> {
  setViewportWidth(1280);

  (globalThis as any).__COMMS_POPUP_TEST_CTX = {
    channels: CHANNEL_IDS.map((id, i) => ({
      id,
      type: "public",
      name: `channel-${i}`,
      slug: `channel-${i}`,
      unreadCount: 0,
      mentionCount: 0,
      members: [],
    })),
    channelsLoaded: true,
    // All minimized: keeps heights deterministic (title-bar-only slots on
    // narrow) — width/right-offset slot math is identical either way.
    popups: CHANNEL_IDS.map((channelId) => ({ channelId, minimized: true })),
    archivedChannelOverrides: {},
    userStatuses: new Map(),
    // railOpen=true on purpose: the rail is hidden on /comms, so the
    // expanded-rail offset must NOT leak into the comms-page branch.
    railOpen: true,
    closePopup: () => {},
    setPopupMinimized: () => {},
    promotePopup: () => {},
  };

  const { CommsPopupManager } = await import(
    "../client/src/components/comms/CommsPopupManager"
  );

  const container = document.getElementById("root")!;
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(CommsPopupManager, { currentUserId: "user-1" }));
  });

  section("Desktop 1280px on /comms — newest popup flush at right: 0");
  const [oldest, middle, newest] = CHANNEL_IDS;
  let elNewest = popupEl(newest);
  let elMiddle = popupEl(middle);
  let elOldest = popupEl(oldest);
  assert(elNewest != null && elMiddle != null && elOldest != null, "all 3 popups render");
  assert(
    px(elNewest!.style.right) === 0,
    `newest popup ignores the base right offset on /comms (right 0, got '${elNewest!.style.right}')`,
  );

  section("Desktop 1280px on /comms — older popups stack left with 8px gap");
  const slot = POPUP_WIDTH + POPUP_GAP; // 348
  assert(
    px(elMiddle!.style.right) === slot,
    `middle popup sits one slot left (right ${slot}, got '${elMiddle!.style.right}')`,
  );
  assert(
    px(elOldest!.style.right) === 2 * slot,
    `oldest popup sits two slots left (right ${2 * slot}, got '${elOldest!.style.right}')`,
  );
  for (const [label, el] of [["newest", elNewest], ["middle", elMiddle], ["oldest", elOldest]] as const) {
    assert(
      el!.style.width === `${POPUP_WIDTH}px`,
      `${label} popup keeps the 340px desktop width (got '${el!.style.width}')`,
    );
    assert(
      px(el!.style.bottom) === 0,
      `${label} popup is bottom-anchored on desktop (got '${el!.style.bottom}')`,
    );
  }
  // Gap check: left edge of one popup minus right edge of the next-left popup.
  const gapNewestMiddle = px(elMiddle!.style.right) - (px(elNewest!.style.right) + POPUP_WIDTH);
  const gapMiddleOldest = px(elOldest!.style.right) - (px(elMiddle!.style.right) + POPUP_WIDTH);
  assert(gapNewestMiddle === POPUP_GAP, `8px gap between newest and middle (got ${gapNewestMiddle})`);
  assert(gapMiddleOldest === POPUP_GAP, `8px gap between middle and oldest (got ${gapMiddleOldest})`);
  assert(
    px(elOldest!.style.right) + POPUP_WIDTH <= 1280,
    `all 3 popups fit within the 1280px viewport (leftmost extent ${px(elOldest!.style.right) + POPUP_WIDTH})`,
  );

  section("Narrow 375px on /comms — offset collapses and width shrinks");
  await resizeTo(375);
  elNewest = popupEl(newest);
  elMiddle = popupEl(middle);
  elOldest = popupEl(oldest);
  assert(elNewest != null && elMiddle != null && elOldest != null, "all 3 popups still mounted at 375px");
  const expectedNarrowWidth = Math.min(
    POPUP_WIDTH,
    375 - NARROW_RIGHT_OFFSET - NARROW_LEFT_MARGIN,
  );
  for (const [label, el] of [["newest", elNewest], ["middle", elMiddle], ["oldest", elOldest]] as const) {
    assert(
      px(el!.style.right) === NARROW_RIGHT_OFFSET,
      `${label} popup right offset collapses to 8px on /comms (got '${el!.style.right}')`,
    );
    assert(
      px(el!.style.width) === expectedNarrowWidth,
      `${label} popup width shrinks to fit (expected ${expectedNarrowWidth}, got '${el!.style.width}')`,
    );
    assert(
      px(el!.style.right) + px(el!.style.width) <= 375,
      `${label} popup fits within the 375px viewport`,
    );
  }

  section("Narrow 375px on /comms — older popups stack vertically above newest");
  // All minimized → newest occupies a title-bar slot at bottom 0; older popups
  // stack above it in title-bar slots separated by the 8px gap.
  assert(
    px(elNewest!.style.bottom) === 0,
    `newest popup anchored at bottom 0 (got '${elNewest!.style.bottom}')`,
  );
  const slotV = POPUP_TITLE_HEIGHT + POPUP_GAP; // 48
  assert(
    px(elMiddle!.style.bottom) === slotV,
    `middle popup stacks one bar above (bottom ${slotV}, got '${elMiddle!.style.bottom}')`,
  );
  assert(
    px(elOldest!.style.bottom) === 2 * slotV,
    `oldest popup stacks two bars above (bottom ${2 * slotV}, got '${elOldest!.style.bottom}')`,
  );

  section("Back to desktop 1280px — comms-page slot layout restores");
  await resizeTo(1280);
  elNewest = popupEl(newest);
  elOldest = popupEl(oldest);
  assert(
    px(elNewest!.style.right) === 0 && elNewest!.style.width === "340px",
    `newest popup restores right 0 / 340px (got right '${elNewest!.style.right}', width '${elNewest!.style.width}')`,
  );
  assert(
    px(elOldest!.style.right) === 2 * slot,
    `oldest popup restores the two-slot offset (got '${elOldest!.style.right}')`,
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
