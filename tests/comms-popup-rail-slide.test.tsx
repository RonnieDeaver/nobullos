/* test-registration
{
  "name": "Comms popup slides with the rail — rendered CommsPopupManager re-renders style.right 56px ↔ 268px when railOpen flips in CommsContext, incl. rapid flips (Task #3402)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3402: docked popup slides with the rail — rendered CommsPopupManager re-renders the popup's inline style.right 56px ↔ 268px when railOpen flips in CommsContext (incl. rapid flips). Complements Task #3391's pure computePopupLayouts unit test with the rendered wiring. Same DB-free/network-free jsdom harness as the narrow-viewport test above.",
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
 * Rendered coverage for the docked chat popup sliding with the rail (Task #3402,
 * layout logic unit-tested in Task #3391's computePopupLayouts test).
 *
 * Task #3391 covered computePopupLayouts as a pure function; this test covers
 * the rendered wiring: CommsPopupManager actually re-renders with the new
 * right offset when railOpen flips in CommsContext. Mounts the real manager
 * (stubbed CommsContext + stubbed heavy children — see
 * tests/comms-popup-narrow-viewport-setup.mjs) at a desktop viewport (1024px,
 * >= the 768px rail-visible breakpoint) and asserts the popup's inline
 * style.right toggles 56px (rail collapsed) ↔ 268px (rail expanded),
 * including after several rapid flips.
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

function popupEl(channelId: string): HTMLElement | null {
  return document.querySelector(
    `[data-testid="comms-popup-${channelId}"]`,
  ) as HTMLElement | null;
}

const CHANNEL_ID = "chan-rail-slide-1";
const RIGHT_COLLAPSED = "56px";
const RIGHT_EXPANDED = "268px";

async function main(): Promise<void> {
  // Desktop viewport, >= the 768px breakpoint where the rail is visible so
  // railOpen actually affects layout.
  Object.defineProperty(dom.window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1024,
  });

  // Minimal context surface CommsPopupManager/CommsPopup read. railOpen is
  // mutated by the test and driven into the tree via re-render (the stub
  // useCommsContext reads this global on every render).
  const ctx: any = {
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
    railOpen: false,
    closePopup: () => {},
    setPopupMinimized: () => {},
  };
  (globalThis as any).__COMMS_POPUP_TEST_CTX = ctx;

  const { CommsPopupManager } = await import(
    "../client/src/components/comms/CommsPopupManager"
  );

  const container = document.getElementById("root")!;
  const root: Root = createRoot(container);

  const render = async () => {
    await act(async () => {
      root.render(
        React.createElement(CommsPopupManager, { currentUserId: "user-1" }),
      );
    });
  };

  const setRailOpen = async (open: boolean) => {
    ctx.railOpen = open;
    await render();
  };

  await render();

  section("Initial mount — rail collapsed");
  let el = popupEl(CHANNEL_ID);
  assert(el != null, "popup renders at desktop width");
  assert(
    el?.style.right === RIGHT_COLLAPSED,
    `right offset is ${RIGHT_COLLAPSED} while the rail is collapsed (got '${el?.style.right}')`,
  );

  section("Rail opens — popup slides left to clear the expanded rail");
  await setRailOpen(true);
  el = popupEl(CHANNEL_ID);
  assert(el != null, "popup stays mounted when the rail opens");
  assert(
    el?.style.right === RIGHT_EXPANDED,
    `right offset becomes ${RIGHT_EXPANDED} when railOpen flips true (got '${el?.style.right}')`,
  );
  assert(
    el?.style.width === "340px",
    `width stays 340px while sliding (got '${el?.style.width}')`,
  );

  section("Rail closes — popup slides back to the collapsed offset");
  await setRailOpen(false);
  el = popupEl(CHANNEL_ID);
  assert(
    el?.style.right === RIGHT_COLLAPSED,
    `right offset returns to ${RIGHT_COLLAPSED} when railOpen flips false (got '${el?.style.right}')`,
  );

  section("Rapid flips — offset tracks the latest railOpen value every time");
  const sequence: boolean[] = [true, false, true, true, false, true, false, false, true];
  let allMatched = true;
  for (const open of sequence) {
    await setRailOpen(open);
    el = popupEl(CHANNEL_ID);
    const expected = open ? RIGHT_EXPANDED : RIGHT_COLLAPSED;
    if (el?.style.right !== expected) {
      allMatched = false;
      console.error(
        `    mismatch: railOpen=${open} expected right ${expected}, got '${el?.style.right}'`,
      );
    }
  }
  assert(
    allMatched,
    `right offset matched railOpen across ${sequence.length} rapid flips`,
  );
  assert(
    el?.style.right === RIGHT_EXPANDED,
    `final state after flip sequence ends open is ${RIGHT_EXPANDED} (got '${el?.style.right}')`,
  );
  await setRailOpen(false);
  el = popupEl(CHANNEL_ID);
  assert(
    el?.style.right === RIGHT_COLLAPSED,
    `one more close returns to ${RIGHT_COLLAPSED} (got '${el?.style.right}')`,
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
