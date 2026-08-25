/* test-registration
{
  "name": "Custom Emoji admin panel — list, delete confirmation guard, upload validation (Task #3314)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3314: Custom Emoji admin panel (CustomEmojiManager, the Comms sidebar view for team leads/CEOs). Mounts the real component with a stubbed fetch and pins: /api/comms/emoji rows render, the delete button opens the confirmation dialog (Cancel fires nothing, confirming fires exactly one DELETE /api/comms/emoji/{id}), and invalid-type / oversize files show the inline errors. Fast, DB-free, network-free jsdom render test (Radix AlertDialog via the shared alert-dialog shim).",
  "extraNodeArgs": [
    "--import",
    "./tests/alert-dialog-mock-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Custom Emoji admin panel rendered smoke (Task #3314).
 *
 * Mounts the real CustomEmojiManager
 * (client/src/components/comms/CustomEmojiManager.tsx) — the panel wired into
 * the Comms sidebar for team leads/CEOs — with a stubbed global fetch and
 * asserts:
 *   - the /api/comms/emoji list renders one row per emoji (name + testid)
 *   - clicking a row's delete button opens the confirmation dialog (the
 *     dialog description names the :emoji:) and confirming fires
 *     DELETE /api/comms/emoji/{id}; Cancel does NOT fire a DELETE
 *   - an invalid file type shows the inline "Only PNG, JPEG, GIF, and WebP"
 *     error, and an oversize (>256 KB) file shows the "256 KB or smaller"
 *     error; neither leaves a selected file
 *
 * Radix AlertDialog's portal never mounts in the raw jsdom harness, so the
 * shared alert-dialog shim is wired in via
 * `--import ./tests/alert-dialog-mock-setup.mjs` (see tests/alert-dialog-shim.mjs).
 * With the shim the dialog content div is always mounted; "open" is asserted
 * via the deleteTarget-driven description text, which is empty until a delete
 * button is clicked.
 *
 * Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json. Registered in
 * tests/run-all.ts and gated in SMOKE_FILES.
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
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).File = dom.window.File;
(globalThis as any).FileReader = dom.window.FileReader;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// --- fetch stub -------------------------------------------------------------
type RecordedCall = { url: string; method: string };
const fetchCalls: RecordedCall[] = [];

const EMOJI_LIST = [
  {
    id: "emoji-1",
    name: "party-parrot",
    imageUrl: "/objects/emoji/party-parrot.png",
    createdAt: "2026-07-01T12:00:00Z",
    createdByName: "Casey CEO",
  },
  {
    id: "emoji-2",
    name: "ship_it",
    imageUrl: "/objects/emoji/ship_it.png",
    createdAt: "2026-07-02T12:00:00Z",
  },
];

(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  const method = (init?.method ?? "GET").toUpperCase();
  fetchCalls.push({ url, method });
  if (url.startsWith("/api/comms/emoji") && method === "GET") {
    return {
      ok: true,
      status: 200,
      json: async () => EMOJI_LIST,
    } as any;
  }
  if (url.startsWith("/api/comms/emoji/") && method === "DELETE") {
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
  }
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as any;
};

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CustomEmojiManager } from "../client/src/components/comms/CustomEmojiManager";

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
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush(): Promise<void> {
  // Let react-query settle its fetch/microtask chain.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function setFileOnInput(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => [file],
  });
  await act(async () => {
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
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
        React.createElement(CustomEmojiManager, null),
      ),
    );
  });
  await flush();

  section("List — stubbed /api/comms/emoji rows render");
  assert($("custom-emoji-manager") != null, "panel mounts (custom-emoji-manager)");
  assert(
    fetchCalls.some((c) => c.method === "GET" && c.url.startsWith("/api/comms/emoji")),
    "panel fetched GET /api/comms/emoji",
  );
  const row1 = $("custom-emoji-row-party-parrot");
  const row2 = $("custom-emoji-row-ship_it");
  assert(row1 != null, "row for :party-parrot: renders");
  assert(row2 != null, "row for :ship_it: renders");
  assert(
    (row1?.textContent ?? "").includes(":party-parrot:") &&
      (row1?.textContent ?? "").includes("by Casey CEO"),
    "row shows the :name: and the creator attribution",
  );
  const rowImg = row1?.querySelector("img");
  assert(
    rowImg?.getAttribute("src") === "/objects/emoji/party-parrot.png",
    "row renders the emoji image from imageUrl",
  );

  section("Delete — confirmation dialog guards the DELETE");
  const dialog = $("emoji-delete-confirm-dialog");
  assert(dialog != null, "confirmation dialog element is mounted (shimmed portal)");
  assert(
    !(dialog?.textContent ?? "").includes(":party-parrot:"),
    "before clicking delete, the dialog names no emoji (closed state)",
  );

  await click($("emoji-delete-party-parrot")!);
  assert(
    ($("emoji-delete-confirm-dialog")?.textContent ?? "").includes(":party-parrot:"),
    "clicking the row's delete button opens the dialog naming :party-parrot:",
  );
  assert(
    fetchCalls.every((c) => c.method !== "DELETE"),
    "opening the dialog alone fires no DELETE request",
  );

  // Cancel does not delete
  await click($("emoji-delete-cancel")!);
  await flush();
  assert(
    fetchCalls.every((c) => c.method !== "DELETE"),
    "Cancel closes without firing a DELETE request",
  );

  // Re-open and confirm
  await click($("emoji-delete-party-parrot")!);
  await click($("emoji-delete-confirm")!);
  await flush();
  const deletes = fetchCalls.filter((c) => c.method === "DELETE");
  assert(
    deletes.length === 1 && deletes[0].url === "/api/comms/emoji/emoji-1",
    `confirming fires exactly one DELETE /api/comms/emoji/emoji-1 (got ${JSON.stringify(deletes)})`,
  );

  section("Upload validation — invalid type and oversize show inline errors");
  const fileInput = $("emoji-file-input") as HTMLInputElement;
  assert(fileInput != null, "hidden file input is present");

  const badType = new dom.window.File(["hello"], "notes.txt", { type: "text/plain" });
  await setFileOnInput(fileInput, badType as unknown as File);
  assert(
    (container.textContent ?? "").includes("Only PNG, JPEG, GIF, and WebP images are allowed."),
    "invalid file type shows the inline allowed-types error",
  );

  const bigBytes = new Uint8Array(300 * 1024);
  const oversize = new dom.window.File([bigBytes], "huge.png", { type: "image/png" });
  await setFileOnInput(fileInput, oversize as unknown as File);
  assert(
    (container.textContent ?? "").includes("Image must be 256 KB or smaller."),
    "oversize (>256 KB) file shows the inline size error",
  );
  assert(
    ($("emoji-upload-button") as HTMLButtonElement)?.disabled === true,
    "upload button stays disabled after rejected files (no file accepted)",
  );

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error("comms-custom-emoji-manager: FAILED");
    process.exit(1);
  }
  console.log("comms-custom-emoji-manager: PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("comms-custom-emoji-manager: FAILED");
  console.error(err);
  process.exit(1);
});
