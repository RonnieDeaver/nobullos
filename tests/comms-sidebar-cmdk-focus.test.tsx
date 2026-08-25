/* test-registration
{
  "name": "Comms sidebar Cmd/Ctrl+K channel-search shortcut — body focus focuses the filter input; presses originating in input/textarea/contenteditable are ignored (composer typing never interrupted); unmount removes the listener (Task #3399)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3399: comms sidebar Cmd/Ctrl+K channel-search shortcut — pressing the shortcut with focus inside an input, textarea, or contenteditable (i.e. the message composer) must NOT move focus to the sidebar filter input, while pressing it with focus on the body MUST focus the filter. Rendered jsdom test mounting the real CommsSidebar with a stubbed CommsContext + use-auth + stubbed heavy children; DB-free, network-free.",
  "extraNodeArgs": [
    "--import",
    "./tests/comms-sidebar-cmdk-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Rendered coverage for the comms sidebar's Cmd/Ctrl+K channel-search
 * shortcut staying out of the message composer (Task #3399, behavior shipped
 * with the quick channel search).
 *
 * Mounts the real CommsSidebar (pages/Comms.tsx) via a stubbed CommsContext,
 * stubbed use-auth hook, and stubbed heavy children (see
 * tests/comms-sidebar-cmdk-setup.mjs), and asserts the window keydown
 * handler's focus behavior:
 *   - Cmd+K / Ctrl+K with focus on the body DOES focus the sidebar filter
 *     input (and preventDefault fires);
 *   - Cmd/Ctrl+K originating inside an <input>, <textarea>, or
 *     contenteditable element does NOT steal focus (typing in the message
 *     composer is never interrupted) and does NOT preventDefault;
 *   - plain "k" (no modifier) on the body does nothing.
 *
 * DB-free, network-free. Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json and
 * --import ./tests/comms-sidebar-cmdk-setup.mjs.
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
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).localStorage = dom.window.localStorage;
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

const CHANNEL = {
  id: "chan-general",
  name: "general",
  slug: "general",
  type: "public",
  visibility: "public",
  topic: null,
  description: null,
  clientId: null,
  clientFirmName: null,
  createdBy: "user-me",
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  unreadCount: 0,
  mentionCount: 0,
  members: [],
};

function filterInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(
    '[data-testid="sidebar-channel-search-input"]',
  );
  if (!el) throw new Error("sidebar filter input not rendered");
  return el;
}

/** Dispatch a keydown that bubbles from `target` up to window (where the
 * sidebar's global handler listens) and report whether preventDefault fired. */
async function pressKey(
  target: EventTarget,
  key: string,
  opts: { meta?: boolean; ctrl?: boolean } = {},
): Promise<boolean> {
  const ev = new dom.window.KeyboardEvent("keydown", {
    key,
    metaKey: !!opts.meta,
    ctrlKey: !!opts.ctrl,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    target.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}

async function main(): Promise<void> {
  (globalThis as any).__COMMS_POPUP_TEST_CTX = {
    channels: [CHANNEL],
    channelsLoaded: true,
    popups: [],
    archivedChannelOverrides: {},
    userStatuses: new Map(),
    totalThreadUnread: 0,
    totalThreadMentions: 0,
    pinnedChannelIds: [],
    togglePin: () => {},
    myStatus: { effectiveStatus: "online" },
    closePopup: () => {},
    setPopupMinimized: () => {},
    promotePopup: () => {},
  };

  const { CommsSidebar } = await import("../client/src/pages/Comms");

  const container = document.getElementById("root")!;
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(CommsSidebar as any, {
        channels: [CHANNEL],
        selectedId: null,
        onSelect: () => {},
        onNewChannel: () => {},
        onNewDm: () => {},
        open: false,
        onClose: () => {},
        selectedView: "channel",
        onSelectView: () => {},
      }),
    );
  });

  assert(
    document.querySelector('[data-testid="comms-sidebar"]') != null,
    "CommsSidebar renders",
  );
  const input = filterInput();

  // Standalone "composer-like" elements the shortcut must never fire from.
  const textarea = document.createElement("textarea");
  textarea.setAttribute("data-testid", "fake-composer-textarea");
  document.body.appendChild(textarea);

  const otherInput = document.createElement("input");
  otherInput.setAttribute("data-testid", "fake-other-input");
  document.body.appendChild(otherInput);

  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "true");
  editable.tabIndex = 0; // focusable in jsdom
  document.body.appendChild(editable);
  // jsdom does not implement isContentEditable; the handler checks that exact
  // property, so mirror what a real browser reports for this element.
  if (!editable.isContentEditable) {
    Object.defineProperty(editable, "isContentEditable", { value: true });
  }

  // ── Body focus → shortcut focuses the filter input ─────────────────────
  section("Cmd/Ctrl+K from the body focuses the sidebar filter");

  (document.activeElement as HTMLElement | null)?.blur?.();
  let prevented = await pressKey(document.body, "k", { meta: true });
  assert(document.activeElement === input, "Cmd+K on body focuses the filter input");
  assert(prevented, "Cmd+K on body is preventDefault-ed (browser default suppressed)");

  input.blur();
  await act(async () => {});
  assert(document.activeElement !== input, "sanity: filter input blurred between cases");

  prevented = await pressKey(document.body, "k", { ctrl: true });
  assert(document.activeElement === input, "Ctrl+K on body also focuses the filter input");
  assert(prevented, "Ctrl+K on body is preventDefault-ed");

  // Plain "k" without a modifier must do nothing.
  input.blur();
  await act(async () => {});
  prevented = await pressKey(document.body, "k");
  assert(document.activeElement !== input, "plain 'k' (no modifier) does not focus the filter");
  assert(!prevented, "plain 'k' is not preventDefault-ed");

  // ── Composer-like origins → shortcut must stay out ─────────────────────
  section("Cmd/Ctrl+K originating in an input/textarea/contenteditable is ignored");

  textarea.focus();
  assert(document.activeElement === textarea, "sanity: textarea focused");
  prevented = await pressKey(textarea, "k", { meta: true });
  assert(
    document.activeElement === textarea,
    "Cmd+K inside a textarea keeps focus in the textarea (composer typing uninterrupted)",
  );
  assert(!prevented, "Cmd+K inside a textarea is NOT preventDefault-ed");

  prevented = await pressKey(textarea, "k", { ctrl: true });
  assert(
    document.activeElement === textarea,
    "Ctrl+K inside a textarea keeps focus in the textarea",
  );
  assert(!prevented, "Ctrl+K inside a textarea is NOT preventDefault-ed");

  otherInput.focus();
  assert(document.activeElement === otherInput, "sanity: other input focused");
  prevented = await pressKey(otherInput, "k", { meta: true });
  assert(
    document.activeElement === otherInput,
    "Cmd+K inside another input keeps focus in that input",
  );
  assert(!prevented, "Cmd+K inside another input is NOT preventDefault-ed");

  editable.focus();
  assert(document.activeElement === editable, "sanity: contenteditable focused");
  prevented = await pressKey(editable, "k", { meta: true });
  assert(
    document.activeElement === editable,
    "Cmd+K inside a contenteditable keeps focus in the contenteditable",
  );
  assert(!prevented, "Cmd+K inside a contenteditable is NOT preventDefault-ed");

  // ── Re-check the happy path still works after the ignored presses ──────
  section("Shortcut still works from the body afterwards");
  editable.blur();
  await act(async () => {});
  prevented = await pressKey(document.body, "k", { meta: true });
  assert(
    document.activeElement === input,
    "Cmd+K on body still focuses the filter input after ignored presses",
  );
  assert(prevented, "and is preventDefault-ed");

  // ── Unmount removes the listener ────────────────────────────────────────
  section("Unmount cleans up the global listener");
  input.blur();
  await act(async () => {
    root.unmount();
  });
  prevented = await pressKey(document.body, "k", { meta: true });
  assert(!prevented, "after unmount, Cmd+K on body is no longer handled");

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().then(
  () => process.exit(failed > 0 ? 1 : 0),
  (err) => {
    console.error("Test run crashed:", err);
    process.exit(1);
  },
);
