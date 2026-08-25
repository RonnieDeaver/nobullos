/* test-registration
{
  "name": "Comms attachment inline image preview + lightbox (Task #3303)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3303: Comms attachment inline image preview. Renders AttachmentCard and ImageLightbox from MessageItem.tsx: image/* attachments render an <img> thumbnail hitting the auth-gated /api/comms/attachments/{objectKey} endpoint, clicking opens the lightbox at the right gallery index, non-image attachments keep the filename+download-link treatment, and the lightbox supports Escape/overlay close + arrow-key gallery navigation. Fast, DB-free, network-free jsdom render test.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Frontend coverage for inline image previews on Comms message attachments
 * (Task #3303).
 *
 * Renders AttachmentCard and ImageLightbox from
 * client/src/components/comms/MessageItem.tsx with stubbed attachments and
 * asserts:
 *   - image/* attachments render an <img> thumbnail inside a button with
 *     data-testid attachment-image-{id}, src /api/comms/attachments/{objectKey}
 *     (objectKey URI-encoded), alt = filename
 *   - clicking the thumbnail calls onOpenLightbox with the image's gallery index
 *   - non-image attachments render the filename + download link treatment
 *     (data-testid attachment-file-{id}, href to the attachment endpoint,
 *     download attribute set) and no <img>
 *   - ImageLightbox renders the full-size image, Escape/overlay-click closes,
 *     and arrow keys navigate a multi-image gallery
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
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AttachmentCard, ImageLightbox } from "../client/src/components/comms/MessageItem";
import type { CommsAttachment } from "../client/src/components/comms/types";

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

function makeAtt(overrides: Partial<CommsAttachment>): CommsAttachment {
  return {
    id: "att-x",
    messageId: "msg-1",
    uploadedBy: "user-1",
    objectKey: "comms-attachments/whatever.bin",
    thumbnailKey: null,
    filename: "whatever.bin",
    contentType: "application/octet-stream",
    sizeBytes: 1234,
    createdAt: "2026-07-20T12:00:00Z",
    ...overrides,
  };
}

async function render(el: React.ReactElement): Promise<Root> {
  const container = document.getElementById("root")!;
  container.innerHTML = "";
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

async function pressKey(key: string): Promise<void> {
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key }));
  });
}

async function main(): Promise<void> {
  section("Image attachment — renders inline <img> thumbnail");

  const imgAtt = makeAtt({
    id: "att-img-1",
    objectKey: "comms-attachments/pic 123.png",
    filename: "pic 123.png",
    contentType: "image/png",
  });
  const gallery = [
    { src: `/api/comms/attachments/${encodeURIComponent(imgAtt.objectKey)}`, alt: imgAtt.filename },
  ];
  const openedWith: number[] = [];
  let root = await render(
    React.createElement(AttachmentCard, {
      att: imgAtt,
      allImages: gallery,
      imageIndex: 0,
      onOpenLightbox: (i: number) => openedWith.push(i),
    }),
  );

  const imgBtn = $(`attachment-image-${imgAtt.id}`);
  assert(imgBtn != null, `image attachment renders data-testid attachment-image-${imgAtt.id}`);
  assert(imgBtn?.tagName === "BUTTON", `thumbnail wrapper is a <button> (got '${imgBtn?.tagName}')`);
  const img = imgBtn?.querySelector("img") ?? null;
  assert(img != null, "an <img> element renders inside the thumbnail button");
  assert(
    img?.getAttribute("src") === `/api/comms/attachments/${encodeURIComponent(imgAtt.objectKey)}`,
    `img src is the auth-gated attachment endpoint with URI-encoded objectKey (got '${img?.getAttribute("src")}')`,
  );
  assert(
    img?.getAttribute("alt") === imgAtt.filename,
    `img alt is the filename (got '${img?.getAttribute("alt")}')`,
  );
  assert(
    $(`attachment-file-${imgAtt.id}`) == null,
    "image attachment does NOT render the filename/download-link treatment",
  );

  section("Clicking the thumbnail opens the lightbox at the gallery index");

  await act(async () => {
    imgBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert(
    openedWith.length === 1 && openedWith[0] === 0,
    `onOpenLightbox called once with index 0 (got [${openedWith.join(",")}])`,
  );
  await unmount(root);

  // Second image at a non-zero gallery index
  const imgAtt2 = makeAtt({
    id: "att-img-2",
    objectKey: "comms-attachments/second.jpg",
    filename: "second.jpg",
    contentType: "image/jpeg",
  });
  openedWith.length = 0;
  root = await render(
    React.createElement(AttachmentCard, {
      att: imgAtt2,
      allImages: gallery,
      imageIndex: 1,
      onOpenLightbox: (i: number) => openedWith.push(i),
    }),
  );
  await act(async () => {
    $(`attachment-image-${imgAtt2.id}`)!.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  assert(
    openedWith.length === 1 && openedWith[0] === 1,
    `second image opens lightbox at its own index 1 (got [${openedWith.join(",")}])`,
  );
  await unmount(root);

  section("Non-image attachment — keeps filename + download-link treatment");

  const fileAtt = makeAtt({
    id: "att-pdf-1",
    objectKey: "comms-attachments/report.pdf",
    filename: "report.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
  });
  root = await render(
    React.createElement(AttachmentCard, {
      att: fileAtt,
      allImages: [],
      imageIndex: -1,
      onOpenLightbox: () => {},
    }),
  );
  const fileLink = $(`attachment-file-${fileAtt.id}`);
  assert(fileLink != null, `non-image attachment renders data-testid attachment-file-${fileAtt.id}`);
  assert(fileLink?.tagName === "A", `file treatment is an <a> link (got '${fileLink?.tagName}')`);
  assert(
    fileLink?.getAttribute("href") ===
      `/api/comms/attachments/${encodeURIComponent(fileAtt.objectKey)}`,
    `file link href is the attachment endpoint (got '${fileLink?.getAttribute("href")}')`,
  );
  assert(
    fileLink?.getAttribute("download") === fileAtt.filename,
    `file link has download="${fileAtt.filename}" (got '${fileLink?.getAttribute("download")}')`,
  );
  assert(
    (fileLink?.textContent ?? "").includes("report.pdf"),
    "file treatment shows the filename",
  );
  assert(
    document.getElementById("root")!.querySelector("img") == null,
    "non-image attachment renders no <img>",
  );
  assert(
    $(`attachment-image-${fileAtt.id}`) == null,
    "non-image attachment renders no thumbnail button",
  );
  await unmount(root);

  section("Image attachment — onError falls back to filename + download link");

  // No thumbnailKey: preview IS the full-res original, so a single error
  // drops straight to the file-link treatment.
  const brokenAtt = makeAtt({
    id: "att-broken-1",
    objectKey: "comms-attachments/gone.png",
    filename: "gone.png",
    contentType: "image/png",
    sizeBytes: 4321,
  });
  root = await render(
    React.createElement(AttachmentCard, {
      att: brokenAtt,
      allImages: [],
      imageIndex: 0,
      onOpenLightbox: () => {},
    }),
  );
  let brokenImg = $(`attachment-image-${brokenAtt.id}`)?.querySelector("img") ?? null;
  assert(brokenImg != null, "broken attachment initially renders an <img> thumbnail");
  await act(async () => {
    brokenImg!.dispatchEvent(new dom.window.Event("error"));
  });
  assert(
    $(`attachment-image-${brokenAtt.id}`) == null,
    "after onError the thumbnail button is removed",
  );
  const fallbackLink = $(`attachment-file-${brokenAtt.id}`);
  assert(fallbackLink != null, `fallback renders data-testid attachment-file-${brokenAtt.id}`);
  assert(
    fallbackLink?.getAttribute("href") ===
      `/api/comms/attachments/${encodeURIComponent(brokenAtt.objectKey)}`,
    `fallback link href is the attachment endpoint (got '${fallbackLink?.getAttribute("href")}')`,
  );
  assert(
    fallbackLink?.getAttribute("download") === brokenAtt.filename,
    `fallback link has download="${brokenAtt.filename}"`,
  );
  assert(
    (fallbackLink?.textContent ?? "").includes("gone.png"),
    "fallback shows the filename",
  );
  assert(
    document.getElementById("root")!.querySelector("img") == null,
    "no broken <img> remains after fallback",
  );
  await unmount(root);

  section("Image attachment — thumbnail error retries full-res before falling back");

  const thumbAtt = makeAtt({
    id: "att-thumb-1",
    objectKey: "comms-attachments/orig.png",
    thumbnailKey: "comms-attachments/thumbs/orig.png",
    filename: "orig.png",
    contentType: "image/png",
  });
  const thumbDownloadUrl = `/api/comms/attachments/${encodeURIComponent(thumbAtt.objectKey)}`;
  root = await render(
    React.createElement(AttachmentCard, {
      att: thumbAtt,
      allImages: [],
      imageIndex: 0,
      onOpenLightbox: () => {},
    }),
  );
  brokenImg = $(`attachment-image-${thumbAtt.id}`)?.querySelector("img") ?? null;
  assert(
    brokenImg?.getAttribute("src") ===
      `/api/comms/attachments/${encodeURIComponent(thumbAtt.thumbnailKey!)}`,
    "thumbnail attachment initially loads the thumbnail key",
  );
  await act(async () => {
    brokenImg!.dispatchEvent(new dom.window.Event("error"));
  });
  brokenImg = $(`attachment-image-${thumbAtt.id}`)?.querySelector("img") ?? null;
  assert(
    brokenImg?.getAttribute("src") === thumbDownloadUrl,
    `first error retries the full-res original (got '${brokenImg?.getAttribute("src")}')`,
  );
  assert(
    $(`attachment-file-${thumbAtt.id}`) == null,
    "no fallback yet after the first (thumbnail) error",
  );
  await act(async () => {
    brokenImg!.dispatchEvent(new dom.window.Event("error"));
  });
  assert(
    $(`attachment-image-${thumbAtt.id}`) == null &&
      $(`attachment-file-${thumbAtt.id}`) != null,
    "second error (full-res) falls back to the filename + download link",
  );
  await unmount(root);

  section("ImageLightbox — full-size view, close, and gallery navigation");

  const images = [
    { src: "/api/comms/attachments/comms-attachments%2Fa.png", alt: "a.png" },
    { src: "/api/comms/attachments/comms-attachments%2Fb.png", alt: "b.png" },
  ];
  let closed = 0;
  root = await render(
    React.createElement(ImageLightbox, {
      images,
      initialIndex: 0,
      onClose: () => closed++,
    }),
  );
  const lbImg = $("lightbox-image") as HTMLImageElement | null;
  assert(lbImg != null, "lightbox renders data-testid lightbox-image");
  assert(
    lbImg?.getAttribute("src") === images[0].src,
    `lightbox shows the initial image (got '${lbImg?.getAttribute("src")}')`,
  );
  assert($("lightbox-prev") != null && $("lightbox-next") != null, "multi-image gallery shows prev/next controls");

  await pressKey("ArrowRight");
  assert(
    $("lightbox-image")?.getAttribute("src") === images[1].src,
    "ArrowRight advances to the next image",
  );
  await pressKey("ArrowLeft");
  assert(
    $("lightbox-image")?.getAttribute("src") === images[0].src,
    "ArrowLeft returns to the previous image",
  );

  await pressKey("Escape");
  assert(closed === 1, `Escape calls onClose (got ${closed})`);

  await act(async () => {
    $("lightbox-overlay")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert(closed === 2, `clicking the overlay calls onClose (got ${closed})`);

  await act(async () => {
    $("lightbox-image")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert(closed === 2, "clicking the image itself does NOT close the lightbox");
  await unmount(root);

  section("ImageLightbox — failed image shows a graceful fallback");

  closed = 0;
  root = await render(
    React.createElement(ImageLightbox, {
      images,
      initialIndex: 0,
      onClose: () => closed++,
    }),
  );
  const lbImg2 = $("lightbox-image");
  assert(lbImg2 != null, "lightbox renders the image before the error");
  await act(async () => {
    lbImg2!.dispatchEvent(new dom.window.Event("error"));
  });
  assert($("lightbox-image") == null, "failed lightbox image is removed");
  const lbFallback = $("lightbox-image-fallback");
  assert(lbFallback != null, "failed image shows data-testid lightbox-image-fallback");
  assert(
    (lbFallback?.textContent ?? "").includes(images[0].alt),
    "fallback shows the image's filename",
  );
  await act(async () => {
    lbFallback!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert(closed === 0, "clicking the fallback does NOT close the lightbox");
  await pressKey("ArrowRight");
  assert(
    $("lightbox-image")?.getAttribute("src") === images[1].src,
    "navigating past a failed image still renders the next (good) image",
  );
  await pressKey("ArrowLeft");
  assert(
    $("lightbox-image") == null && $("lightbox-image-fallback") != null,
    "returning to the failed image shows the fallback again (failure remembered)",
  );
  await pressKey("Escape");
  assert(closed === 1, "Escape still closes from the fallback state");
  await unmount(root);

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error("comms-attachment-image-preview: FAILED");
    process.exit(1);
  }
  console.log("comms-attachment-image-preview: PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("comms-attachment-image-preview: FAILED");
  console.error(err);
  process.exit(1);
});
