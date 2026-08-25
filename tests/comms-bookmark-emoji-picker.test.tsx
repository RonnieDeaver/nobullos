/* test-registration
{
  "name": "Bookmark dialog emoji picker — create/edit/clear flows, preview + saved payload carry the emoji (Task #3407)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3407: the Add/Edit bookmark dialog's shared EmojiPicker integration — bookmark-emoji-button opens the anchored picker, a picked emoji lands in the preview and in the POST/PATCH payload, the clear (X) button removes it, and the edit dialog prefills the saved emoji. Also pins the AddBookmarkDialog remount-on-editTarget fix (key prop) that makes edit prefill work. Fast, DB-free, network-free jsdom render test (Radix Dialog via the shared dialog shim; jsdom globals installed pre-import).",
  "extraNodeArgs": [
    "--import",
    "./tests/comms-bookmark-emoji-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Bookmark dialog emoji picker rendered smoke (Task #3407).
 *
 * Mounts the real BookmarksBar (client/src/components/comms/BookmarksBar.tsx)
 * with a stubbed global fetch and covers the Add/Edit bookmark dialog's
 * shared EmojiPicker integration:
 *   - Create flow: add-bookmark-btn opens the dialog, bookmark-emoji-button
 *     opens the AnchoredPortalPanel-hosted picker, clicking an emoji option
 *     closes the picker and shows the preview, the clear (X) button removes
 *     it, re-picking works, and Save POSTs the picked emoji in the payload
 *   - Edit flow: bookmark-edit-{id} opens the dialog prefilled with the
 *     bookmark's saved emoji, picking a different emoji updates the preview,
 *     and Save PATCHes the new emoji
 *
 * Radix Dialog's portal never mounts in the raw jsdom harness, so the shared
 * dialog shim is wired in via `--import ./tests/comms-bookmark-emoji-setup.mjs`
 * (see tests/dialog-shim.mjs). The emoji panel itself (AnchoredPortalPanel)
 * is a plain createPortal to document.body and mounts fine in jsdom.
 *
 * Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json. Registered in
 * tests/run-all.ts and gated in SMOKE_FILES.
 */

// The jsdom globals (window, document, MouseEvent, …) are installed by the
// --import setup file (tests/comms-bookmark-emoji-setup.mjs) BEFORE this
// module's hoisted imports evaluate — react-dom probes the environment at
// module-eval time (canUseDOM, `"oninput" in document`), and installing the
// globals inline here would be too late: React would take its IE9 input-event
// polyfill path, crash on focus ("attachEvent is not a function"), and drop
// onChange for text inputs.
const win: any = (globalThis as any).window;

// --- fetch stub -------------------------------------------------------------
type RecordedCall = { url: string; method: string; body: any };
const fetchCalls: RecordedCall[] = [];

const CHANNEL_ID = "chan-1";
const BOOKMARKS_URL = `/api/comms/channels/${CHANNEL_ID}/bookmarks`;

const BOOKMARKS = [
  {
    id: "bm-1",
    channelId: CHANNEL_ID,
    type: "link",
    label: "Docs",
    emoji: "📄",
    url: "https://example.com/docs",
    position: 0,
  },
];

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  const method = (init?.method ?? "GET").toUpperCase();
  let body: any = null;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch {}
  }
  fetchCalls.push({ url, method, body });

  if (url === "/api/comms/emoji/frequently-used" && method === "GET") {
    return { ok: true, status: 200, json: async () => [] } as any;
  }
  if (url === "/api/comms/emoji/usage" && method === "POST") {
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
  }
  if (url === "/api/comms/emoji" && method === "GET") {
    return { ok: true, status: 200, json: async () => [] } as any;
  }
  if (url === BOOKMARKS_URL && method === "GET") {
    // Fresh clone per call (see .agents/memory/fetch-stub-fresh-clone-refetch.md)
    return { ok: true, status: 200, json: async () => BOOKMARKS.map((b) => ({ ...b })) } as any;
  }
  if (url === BOOKMARKS_URL && method === "POST") {
    return { ok: true, status: 200, json: async () => ({ id: "bm-new" }) } as any;
  }
  if (url === `${BOOKMARKS_URL}/bm-1` && method === "PATCH") {
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
  }
  return { ok: false, status: 404, json: async () => ({ error: `not stubbed: ${method} ${url}` }) } as any;
};

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { BookmarksBar } from "../client/src/components/comms/BookmarksBar";
import { TooltipProvider } from "../client/src/components/ui/tooltip";

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

function $(testId: string): HTMLElement | null {
  // Iterate instead of using an attribute selector: jsdom's CSS parser
  // chokes on non-BMP emoji inside `[data-testid="emoji-option-😀"]`.
  for (const el of Array.from(document.querySelectorAll("[data-testid]"))) {
    if (el.getAttribute("data-testid") === testId) return el as HTMLElement;
  }
  return null;
}

async function click(el: HTMLElement): Promise<void> {
  // No mousedown: react-dom's input-event polyfill crashes in jsdom when a
  // mousedown is dispatched while the picker's autofocused search input is
  // the active element (attachEvent is not a function). Click alone drives
  // every handler under test; outside-click dismissal is not in scope here.
  await act(async () => {
    el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    win.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    // Dispatch both: react-dom in jsdom can take the input-event-polyfill
    // path (attachEvent misdetection) where only "change" reaches onChange.
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
  });
}

async function main(): Promise<void> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const container = document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(BookmarksBar, {
            channelId: CHANNEL_ID,
            isChannelAdmin: true,
            isArchived: false,
          }),
        ),
      ),
    );
  });
  await flush();

  section("Mount — bookmarks bar renders the seeded chip");
  assert($("bookmarks-bar") != null, "bookmarks bar mounts");
  assert($("bookmark-chip-bm-1") != null, "seeded bookmark chip renders");

  section("Create flow — picker opens, selection lands in preview + POST body");
  await click($("add-bookmark-btn")!);
  assert($("bookmark-emoji-button") != null, "Add dialog opens with the emoji icon button");
  assert($("bookmark-emoji-preview") == null, "no emoji preview before picking");
  assert($("bookmark-emoji-panel") == null, "picker panel closed before clicking the button");

  await click($("bookmark-emoji-button")!);
  await flush();
  assert($("bookmark-emoji-panel") != null, "clicking the emoji button opens the anchored panel");
  assert($("emoji-picker") != null, "shared EmojiPicker renders inside the panel");

  await click($("emoji-option-😀")!);
  await flush();
  assert($("bookmark-emoji-panel") == null, "picking an emoji closes the picker");
  assert($("bookmark-emoji-preview")?.textContent === "😀", "preview shows the picked emoji 😀");
  assert(
    fetchCalls.some((c) => c.method === "POST" && c.url === "/api/comms/emoji/usage" && c.body?.emoji === "😀"),
    "usage tracking POST fired for the picked emoji",
  );

  section("Clear (X) — removes the picked emoji, re-pick works");
  await click($("bookmark-emoji-clear")!);
  assert($("bookmark-emoji-preview") == null, "clear button removes the emoji preview");
  assert($("bookmark-emoji-clear") == null, "clear button disappears when no emoji is set");

  await click($("bookmark-emoji-button")!);
  await flush();
  await click($("emoji-option-😎")!);
  await flush();
  assert($("bookmark-emoji-preview")?.textContent === "😎", "re-picking after clear shows 😎");

  await setInputValue($("bookmark-label-input") as HTMLInputElement, "Launch plan");
  await setInputValue($("bookmark-url-input") as HTMLInputElement, "https://example.com/launch");
  await click($("bookmark-save-btn")!);
  await flush();

  const post = fetchCalls.find((c) => c.method === "POST" && c.url === BOOKMARKS_URL);
  assert(post != null, "Save fires POST to the bookmarks endpoint");
  assert(post?.body?.emoji === "😎", `POST payload carries the picked emoji (got ${JSON.stringify(post?.body)})`);
  assert(post?.body?.label === "Launch plan" && post?.body?.url === "https://example.com/launch",
    "POST payload carries label + url");
  assert($("bookmark-label-input") == null || ($("bookmark-label-input") as HTMLInputElement).value === "",
    "dialog closes (or resets) after a successful save");

  section("Edit flow — prefilled emoji, new pick saved via PATCH");
  await click($("bookmark-edit-bm-1")!);
  await flush();
  assert($("bookmark-emoji-preview")?.textContent === "📄",
    `edit dialog opens prefilled with the saved emoji (got ${$("bookmark-emoji-preview")?.textContent ?? "none"})`);
  assert(($("bookmark-label-input") as HTMLInputElement)?.value === "Docs", "edit dialog prefills the label");

  await click($("bookmark-emoji-button")!);
  await flush();
  await click($("emoji-option-🤣")!);
  await flush();
  assert($("bookmark-emoji-preview")?.textContent === "🤣", "picking a different emoji updates the preview to 🤣");

  await click($("bookmark-save-btn")!);
  await flush();
  const patch = fetchCalls.find((c) => c.method === "PATCH" && c.url === `${BOOKMARKS_URL}/bm-1`);
  assert(patch != null, "Save fires PATCH to the bookmark's endpoint");
  assert(patch?.body?.emoji === "🤣", `PATCH payload carries the new emoji (got ${JSON.stringify(patch?.body)})`);
  assert(patch?.body?.label === "Docs", "PATCH payload keeps the unchanged label");

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error("comms-bookmark-emoji-picker: FAILED");
    process.exit(1);
  }
  console.log("comms-bookmark-emoji-picker: PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("comms-bookmark-emoji-picker: FAILED");
  console.error(err);
  process.exit(1);
});
