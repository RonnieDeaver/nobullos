/* test-registration
{
  "name": "Comms page inline attachment previews — /comms MessagePane path renders image thumbnail via /api/comms/attachments, opens/closes the lightbox, and shows filename+size+download for non-image files (Task #3317)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3317: the /comms page's message list historically forked a local MessageItem that silently dropped attachment previews. Guard: the page's MessagePane path (hideComposer/hideHeader as Comms.tsx mounts it) renders the inline image thumbnail via /api/comms/attachments/<key>, opens/closes the lightbox, and renders non-image attachments as filename+size+download. DB-free, no network (stubbed fetch/EventSource).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-page-inline-image-previews-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3317 — inline image previews render in the /comms page's message list.
 *
 * The /comms page (client/src/pages/Comms.tsx) renders its channel messages
 * through the shared MessagePane → MessageItem path (with
 * hideComposer/hideHeader — the page owns its own header/composer). A historic
 * local-copy MessageItem in Comms.tsx silently dropped attachment previews;
 * this test mounts MessagePane exactly as the page does and pins the behavior
 * so a future local fork or preview regression fails loudly.
 *
 * Proves, with a message carrying an image attachment AND a PDF attachment:
 *
 *   (A) the image attachment renders an inline <img> preview whose src is
 *       /api/comms/attachments/<encoded objectKey>;
 *   (B) clicking the image opens the ImageLightbox (data-testid
 *       lightbox-overlay) showing the full-res attachment, and clicking the
 *       backdrop closes it;
 *   (C) the PDF attachment renders as a file card with filename, formatted
 *       size, and a download link to /api/comms/attachments/<encoded key>.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/comms" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).HTMLImageElement = dom.window.HTMLImageElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).history = dom.window.history;
(globalThis as any).location = dom.window.location;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }));
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
class ResizeObserverStub {
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// CommsProviderInner opens the shared SSE connection on mount — stub it.
class EventSourceStub {
  url: string;
  constructor(url: string) { this.url = url; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as any).EventSource = EventSourceStub;
(dom.window as any).EventSource = EventSourceStub;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures: one channel; one message carrying an image + a PDF attachment.
// ---------------------------------------------------------------------------

const CHANNEL_ID = "ch-att-3317";

const CHANNEL = {
  id: CHANNEL_ID,
  name: "attachments",
  slug: "attachments",
  type: "channel",
  visibility: "public",
  topic: null,
  description: null,
  clientId: null,
  createdBy: "user-1",
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  unreadCount: 0,
};

const USER = {
  id: "user-1",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

const MSG_USER = {
  id: "user-2",
  firstName: "Ann",
  lastName: "Author",
  email: "ann@nobull.test",
  profileImageUrl: null,
};

const IMG_OBJECT_KEY = "comms/att-img-3317.png";
const PDF_OBJECT_KEY = "comms/att-pdf-3317.pdf";
const PDF_SIZE_BYTES = 345678; // formatBytes → "337.6 KB"

const MESSAGES = [
  {
    id: "msg-attachments",
    channelId: CHANNEL_ID,
    userId: MSG_USER.id,
    user: MSG_USER,
    content: "screenshot + contract attached",
    contentType: "text",
    parentId: null,
    replyCount: 0,
    reactionCounts: {},
    attachments: [
      {
        id: "att-img-1",
        objectKey: IMG_OBJECT_KEY,
        filename: "screenshot.png",
        contentType: "image/png",
        sizeBytes: 12345,
      },
      {
        id: "att-pdf-1",
        objectKey: PDF_OBJECT_KEY,
        filename: "contract.pdf",
        contentType: "application/pdf",
        sizeBytes: PDF_SIZE_BYTES,
      },
    ],
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  },
];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: `/api/comms/channels/${CHANNEL_ID}/messages`, json: MESSAGES },
    { method: "GET", path: /\/api\/comms\/channels(\?|$)/, json: [CHANNEL] },
    { method: "GET", path: /\/api\/comms\/emoji(\?|$)/, json: [] },
    { method: "POST", path: /\/api\/comms\/presence\/heartbeat$/, json: { ok: true } },
    { method: "POST", path: /\/api\/comms\/channels\/[^/]+\/read-state$/, json: { ok: true } },
  ],
  defaultJson: {},
  onCall: ({ url, method }: any) => {
    if (process.env.DEBUG_FETCH) console.log(`[fetch] ${method} ${url}`);
  },
}) as any;

// ---------------------------------------------------------------------------
// Mount — MessagePane exactly as client/src/pages/Comms.tsx mounts it
// (hideComposer + hideHeader; the page owns its own header/composer).
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");
const { MessagePane } = await import(
  "../../client/src/components/comms/MessagePane"
);

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function main(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(
            CommsProvider,
            null,
            React.createElement(MessagePane, {
              channel: CHANNEL as any,
              currentUserId: USER.id,
              hideComposer: true,
              hideHeader: true,
            }),
          ),
        ),
      ),
    );
  });
  await flush();

  assert(
    $("comms-message-msg-attachments"),
    "message with attachments renders via the shared MessagePane/MessageItem path",
  );

  console.log("— A. image attachment renders an inline preview —");
  const imgBtn = $("attachment-image-att-img-1") as HTMLButtonElement | null;
  assert(imgBtn, "A: image attachment renders as a clickable preview button");
  const inlineImg = imgBtn!.querySelector("img") as HTMLImageElement | null;
  assert(inlineImg, "A: inline <img> thumbnail renders inside the preview button");
  const expectedSrc = `/api/comms/attachments/${encodeURIComponent(IMG_OBJECT_KEY)}`;
  assert(
    (inlineImg!.getAttribute("src") ?? "") === expectedSrc,
    `A: preview img src is the attachment-serving route (got ${inlineImg!.getAttribute("src")})`,
  );
  assert(
    inlineImg!.getAttribute("alt") === "screenshot.png",
    "A: preview img alt is the attachment filename",
  );

  console.log("— B. clicking the image opens (and backdrop-click closes) the lightbox —");
  assert(!$("lightbox-overlay"), "B: lightbox closed before any click");
  await act(async () => {
    imgBtn!.click();
  });
  await flush(2);
  const overlay = $("lightbox-overlay");
  assert(overlay, "B: lightbox overlay opens after clicking the image preview");
  const lightboxImg = $("lightbox-image") as HTMLImageElement | null;
  assert(lightboxImg, "B: lightbox image renders inside the overlay");
  assert(
    (lightboxImg!.getAttribute("src") ?? "").includes(encodeURIComponent(IMG_OBJECT_KEY)),
    `B: lightbox shows the clicked attachment (src=${lightboxImg!.getAttribute("src")})`,
  );
  await act(async () => {
    overlay!.click();
  });
  await flush(2);
  assert(!$("lightbox-overlay"), "B: clicking the backdrop closes the lightbox");

  console.log("— C. PDF attachment renders filename + size + download link —");
  const fileCard = $("attachment-file-att-pdf-1") as HTMLAnchorElement | null;
  assert(fileCard, "C: non-image attachment renders as a file card");
  assert(
    fileCard!.tagName.toLowerCase() === "a",
    "C: file card is a link element",
  );
  const expectedPdfHref = `/api/comms/attachments/${encodeURIComponent(PDF_OBJECT_KEY)}`;
  assert(
    fileCard!.getAttribute("href") === expectedPdfHref,
    `C: file card links to the attachment-serving route (got ${fileCard!.getAttribute("href")})`,
  );
  assert(
    fileCard!.getAttribute("download") === "contract.pdf",
    "C: file card download attribute carries the filename",
  );
  assert(
    fileCard!.textContent!.includes("contract.pdf"),
    "C: file card shows the filename",
  );
  assert(
    /KB/i.test(fileCard!.textContent!),
    `C: file card shows a formatted size (got "${fileCard!.textContent}")`,
  );
  // No inline <img> preview for the PDF — it must stay a file card.
  assert(
    !$("attachment-image-att-pdf-1"),
    "C: PDF does not render as an inline image preview",
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("comms-page-inline-image-previews: ALL TESTS PASSED");
}

await main();
process.exit(0);
