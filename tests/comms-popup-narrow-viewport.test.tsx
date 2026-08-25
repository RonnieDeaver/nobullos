/* test-registration
{
  "name": "Comms docked popup fits phone screens — 340px/56px desktop layout unchanged at >=480px, offset collapses + width shrinks at 375/320px (Tasks #3345/#3351)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3351: docked chat popup phone-screen fit — usePopupLayout keeps the legacy 340px width + 56px base right offset at >=480px viewports and collapses the offset to 8px (shrinking width when needed) below 480px so the popup fits a 375px/320px phone screen, live across resize events. Rendered jsdom test mounting the real CommsPopupManager with a stubbed CommsContext + stubbed heavy children; DB-free, network-free.",
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
 * Rendered coverage for the docked chat popup's phone-screen fit (Task #3351,
 * behavior shipped in Task #3345).
 *
 * Mounts the real CommsPopupManager (via a stubbed CommsContext + stubbed
 * heavy children — see tests/comms-popup-narrow-viewport-setup.mjs) and
 * asserts usePopupLayout's responsive behavior through the rendered inline
 * styles:
 *   - Desktop (>= 480px viewport): 340px width, 56px base right offset —
 *     unchanged legacy layout.
 *   - Narrow (< 480px, e.g. a 375px phone): the right offset collapses to 8px
 *     and width shrinks so the popup fits fully on screen
 *     (right offset + width <= viewport width).
 *   - Resize is live: crossing the 480px breakpoint in either direction
 *     re-lays-out already-mounted popups.
 *
 * Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json and
 * --import ./tests/comms-popup-narrow-viewport-setup.mjs.
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

const CHANNEL_ID = "chan-popup-1";

async function main(): Promise<void> {
  // Start at a desktop-width viewport before the component mounts.
  setViewportWidth(1024);

  // Minimal context surface CommsPopupManager/CommsPopup read.
  (globalThis as any).__COMMS_POPUP_TEST_CTX = {
    channels: [
      {
        id: CHANNEL_ID,
        type: "public",
        name: "general",
        slug: "general",
        unreadCount: 0,
        mentionCount: 0,
        members: [],
      },
    ],
    channelsLoaded: true,
    popups: [{ channelId: CHANNEL_ID, minimized: true }],
    archivedChannelOverrides: {},
    userStatuses: new Map(),
    closePopup: () => {},
    setPopupMinimized: () => {},
  };

  const { CommsPopupManager } = await import(
    "../client/src/components/comms/CommsPopupManager"
  );

  const container = document.getElementById("root")!;
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(CommsPopupManager, { currentUserId: "user-1" }));
  });

  section("Desktop (1024px) — legacy layout unchanged");
  let el = popupEl(CHANNEL_ID);
  assert(el != null, "popup renders at desktop width");
  assert(
    el?.style.width === "340px",
    `desktop width is 340px (got '${el?.style.width}')`,
  );
  assert(
    el?.style.right === "56px",
    `desktop base right offset is 56px (got '${el?.style.right}')`,
  );

  section("Phone (375px) — offset collapses and popup fits on screen");
  await resizeTo(375);
  el = popupEl(CHANNEL_ID);
  assert(el != null, "popup still mounted after resize to 375px");
  const narrowRight = px(el!.style.right);
  const narrowWidth = px(el!.style.width);
  assert(
    narrowRight === 8,
    `narrow right offset collapses to 8px (got '${el!.style.right}')`,
  );
  // 340px still fits at 375px once the 56px rail offset collapses:
  // 8 (right) + 340 (width) = 348 <= 375, with >= 8px left margin.
  assert(
    narrowWidth === Math.min(340, 375 - 8 - 8),
    `narrow width is min(340, viewport - margins) (got '${el!.style.width}')`,
  );
  assert(
    narrowRight + narrowWidth <= 375,
    `popup fits within the 375px viewport (right ${narrowRight} + width ${narrowWidth} <= 375)`,
  );
  assert(
    375 - narrowRight - narrowWidth >= 8,
    "at least an 8px left margin remains at 375px",
  );

  section("Very narrow (320px) — width shrinks below 340px to keep fitting");
  await resizeTo(320);
  el = popupEl(CHANNEL_ID);
  const tinyRight = px(el!.style.right);
  const tinyWidth = px(el!.style.width);
  assert(
    tinyWidth === 320 - 8 - 8,
    `width shrinks to viewport minus margins at 320px (got '${el!.style.width}')`,
  );
  assert(tinyRight === 8, `right offset stays 8px at 320px (got '${el!.style.right}')`);
  assert(
    tinyRight + tinyWidth <= 320,
    `popup fits within the 320px viewport (right ${tinyRight} + width ${tinyWidth} <= 320)`,
  );

  section("Back to desktop (>= 480px) — layout restores");
  await resizeTo(480);
  el = popupEl(CHANNEL_ID);
  assert(
    el?.style.width === "340px",
    `width restores to 340px at exactly 480px (got '${el?.style.width}')`,
  );
  assert(
    el?.style.right === "56px",
    `right offset restores to 56px at exactly 480px (got '${el?.style.right}')`,
  );

  await act(async () => {
    root.unmount();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().then(
  () => process.exit(failed > 0 ? 1 : 0),
  (err) => {
    console.error("Test run crashed:", err);
    process.exit(1);
  },
);
