/* test-registration
{
  "name": "Comms file-search thumbnail (FileThumb) render behavior (Task #3305)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3305: file-search thumbnail behavior (FileThumb in SearchPanel). Pins that image/* results render an <img> pointed at /api/comms/attachments/{objectKey} with data-testid file-result-thumb-{id}, non-image results render the file-type emoji icon, and the img onError fallback flips to the icon. Fast, DB-free, network-free jsdom render test.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Frontend coverage for the file-search thumbnail behavior (Task #3305,
 * pinning behavior added in Task #3297).
 *
 * Renders the FileThumb component from
 * client/src/components/comms/SearchPanel.tsx (the per-row thumbnail used by
 * the SearchPanel Files tab) with stubbed file-search attachment results and
 * asserts:
 *   - image/* results render an <img> with src /api/comms/attachments/{objectKey}
 *     and data-testid file-result-thumb-{id}
 *   - non-image results render the file-type emoji icon instead (no <img>)
 *   - the img onError fallback flips an image result to the emoji icon
 *
 * Run with TSX_TSCONFIG_PATH=./tsconfig.tests.json (client render tests need
 * the tests tsconfig for the automatic JSX runtime).
 *
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  FileThumb,
  type AttachmentResult,
} from "../client/src/components/comms/SearchPanel";

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

function makeAtt(overrides: Partial<AttachmentResult>): AttachmentResult {
  return {
    id: "att-x",
    messageId: "msg-1",
    channelId: "chan-1",
    objectKey: "uploads/whatever.bin",
    filename: "whatever.bin",
    contentType: "application/octet-stream",
    sizeBytes: 1234,
    createdAt: "2026-07-01T12:00:00Z",
    uploadedBy: "user-1",
    uploaderFirstName: "Uma",
    uploaderLastName: "Uploader",
    channelName: "general",
    channelSlug: "general",
    channelType: "public",
    messageCreatedAt: "2026-07-01T12:00:00Z",
    ...overrides,
  };
}

async function render(att: AttachmentResult): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(FileThumb, { att }));
  });
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

async function main(): Promise<void> {
  section("Image result — renders <img> thumbnail with attachment src");

  const imgAtt = makeAtt({
    id: "att-img-1",
    objectKey: "uploads/photos/pic-123.png",
    filename: "pic-123.png",
    contentType: "image/png",
  });
  let root = await render(imgAtt);

  const thumb = $(`file-result-thumb-${imgAtt.id}`);
  assert(thumb != null, `image result renders data-testid file-result-thumb-${imgAtt.id}`);
  assert(thumb?.tagName === "IMG", `thumbnail element is an <img> (got '${thumb?.tagName}')`);
  assert(
    thumb?.getAttribute("src") === `/api/comms/attachments/${imgAtt.objectKey}`,
    `img src is /api/comms/attachments/{objectKey} (got '${thumb?.getAttribute("src")}')`,
  );
  assert(
    thumb?.getAttribute("alt") === imgAtt.filename,
    `img alt is the filename (got '${thumb?.getAttribute("alt")}')`,
  );
  assert(
    (document.getElementById("root")?.textContent ?? "") === "",
    "no emoji icon rendered alongside the image thumbnail",
  );

  section("Image onError fallback — flips to the image emoji icon");

  await act(async () => {
    thumb!.dispatchEvent(new dom.window.Event("error", { bubbles: false }));
  });
  assert(
    $(`file-result-thumb-${imgAtt.id}`) == null,
    "after img error, the <img> thumbnail is removed",
  );
  assert(
    (document.getElementById("root")?.textContent ?? "").includes("🖼️"),
    "after img error, the image-type emoji icon 🖼️ renders instead",
  );
  await unmount(root);

  section("Non-image results — emoji icon per file type, no <img>");

  const iconCases: Array<{ contentType: string; emoji: string; label: string }> = [
    { contentType: "video/mp4", emoji: "🎬", label: "video" },
    { contentType: "audio/mpeg", emoji: "🎵", label: "audio" },
    { contentType: "application/pdf", emoji: "📄", label: "pdf" },
    {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      emoji: "📊",
      label: "spreadsheet",
    },
    {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      emoji: "📝",
      label: "word document",
    },
    { contentType: "application/octet-stream", emoji: "📎", label: "generic/unknown" },
  ];

  for (const c of iconCases) {
    const att = makeAtt({ id: `att-${c.label.replace(/[^a-z]/g, "")}`, contentType: c.contentType });
    root = await render(att);
    const rootEl = document.getElementById("root")!;
    assert(
      rootEl.querySelector("img") == null && $(`file-result-thumb-${att.id}`) == null,
      `${c.label} (${c.contentType}) renders no <img> thumbnail`,
    );
    assert(
      (rootEl.textContent ?? "").includes(c.emoji),
      `${c.label} renders the ${c.emoji} icon (got '${rootEl.textContent}')`,
    );
    await unmount(root);
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error("comms-file-search-thumbnail: FAILED");
    process.exit(1);
  }
  console.log("comms-file-search-thumbnail: PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("comms-file-search-thumbnail: FAILED");
  console.error(err);
  process.exit(1);
});
