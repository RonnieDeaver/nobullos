/* test-registration
{
  "name": "Comms popup link previews + image lightbox — popup body renders shared MessageItem link-preview cards (metadata + typed field) and opens/closes the lightbox (Task #3299)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3299: link previews + image lightbox in the POPUP comms view. The popup must render messages through the shared MessagePane → MessageItem path (a historic local-copy MessageItem in Comms.tsx skipped both). Mounts the REAL CommsProvider + CommsPopupManager + MessagePane + MessageItem and asserts: metadata.linkPreviews AND the typed linkPreviews field render LinkPreviewCards (title/description/domain/href) inside the popup, and clicking an image attachment opens/closes the lightbox. DB-free, no network (stubbed fetch/EventSource).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-popup-link-previews-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3299 — link previews + image lightbox render in the POPUP comms view.
 *
 * The popup system (CommsPopupManager) must delegate its message rendering to
 * the shared MessagePane → MessageItem path so `linkPreviews` (typed field or
 * `metadata.linkPreviews`) render as LinkPreviewCards and image attachments
 * open the lightbox — exactly like the main /comms channel pane. A historic
 * local-copy MessageItem in Comms.tsx skipped both; this test pins the popup
 * to the shared path so a future local fork regresses loudly.
 *
 * Mounts the REAL CommsProvider + CommsPopupManager + MessagePane + MessageItem
 * in jsdom (only Composer and MessagePane's side-panel/dialog leaves are
 * stubbed) and proves, inside the popup body:
 *
 *   (A) a message whose metadata carries linkPreviews renders the
 *       link-previews container with one LinkPreviewCard per preview —
 *       title, description, domain, and outbound href intact;
 *   (B) a message using the typed top-level `linkPreviews` field renders too
 *       (both read paths of the shared MessageItem work in the popup);
 *   (C) clicking an image attachment opens the ImageLightbox overlay
 *       (`lightbox-image` with the attachment's src), and clicking the
 *       overlay closes it;
 *   (D) Task #3415 — a message carrying BOTH an image attachment and link
 *       previews renders both blocks, and inside the 340px popup the preview
 *       cards use the compact variant (data-compact="true": no side
 *       thumbnail, no description, one-line title) while the image preview
 *       is height-capped (max-h-32 instead of max-h-48).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/dashboard" },
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
// Fixtures: one persisted popup; its messages carry link previews + an image.
// ---------------------------------------------------------------------------

const CHANNEL_ID = "ch-lp-3299";
const POPUPS_SS_KEY = "comms_open_popups";

const CHANNEL = {
  id: CHANNEL_ID,
  name: "link-drop",
  slug: "link-drop",
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

const PREVIEW_META = {
  url: "https://example.com/article",
  title: "Example Article Title",
  description: "A concise description of the example article.",
  siteName: "Example",
  imageUrl: null,
  faviconUrl: null,
};

const PREVIEW_TYPED = {
  url: "https://docs.example.org/guide",
  title: "Typed-Field Guide",
  description: "Preview delivered on the typed linkPreviews field.",
  siteName: "Docs",
  imageUrl: null,
  faviconUrl: null,
};

const IMG_OBJECT_KEY = "comms/att-img-3299.png";

const PREVIEW_BOTH = {
  url: "https://news.example.net/story",
  title: "Story With Screenshot",
  description: "Description that the compact popup variant should hide.",
  siteName: "News",
  imageUrl: "https://news.example.net/og.png",
  faviconUrl: null,
};

const BOTH_IMG_OBJECT_KEY = "comms/att-img-both-3415.png";

const MESSAGES = [
  {
    // (A) preview via metadata.linkPreviews — the persisted JSONB path
    id: "msg-meta-preview",
    channelId: CHANNEL_ID,
    userId: MSG_USER.id,
    user: MSG_USER,
    content: `check ${PREVIEW_META.url}`,
    contentType: "text",
    parentId: null,
    replyCount: 0,
    reactionCounts: {},
    attachments: [],
    metadata: { linkPreviews: [PREVIEW_META] },
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  },
  {
    // (B) preview via the typed top-level field
    id: "msg-typed-preview",
    channelId: CHANNEL_ID,
    userId: MSG_USER.id,
    user: MSG_USER,
    content: `guide: ${PREVIEW_TYPED.url}`,
    contentType: "text",
    parentId: null,
    replyCount: 0,
    reactionCounts: {},
    attachments: [],
    linkPreviews: [PREVIEW_TYPED],
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  },
  {
    // (C) image attachment → lightbox
    id: "msg-image",
    channelId: CHANNEL_ID,
    userId: MSG_USER.id,
    user: MSG_USER,
    content: "screenshot attached",
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
    ],
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  },
  {
    // (D) BOTH an image attachment AND link previews on one message
    id: "msg-both",
    channelId: CHANNEL_ID,
    userId: MSG_USER.id,
    user: MSG_USER,
    content: `story ${PREVIEW_BOTH.url} with screenshot`,
    contentType: "text",
    parentId: null,
    replyCount: 0,
    reactionCounts: {},
    attachments: [
      {
        id: "att-img-both",
        objectKey: BOTH_IMG_OBJECT_KEY,
        filename: "story-shot.png",
        contentType: "image/png",
        sizeBytes: 23456,
      },
    ],
    metadata: { linkPreviews: [PREVIEW_BOTH] },
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  },
];

dom.window.sessionStorage.setItem(
  POPUPS_SS_KEY,
  JSON.stringify([{ channelId: CHANNEL_ID, minimized: false }]),
);

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
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");
const { CommsPopupManager } = await import(
  "../../client/src/components/comms/CommsPopupManager"
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

function popupEl(): HTMLElement {
  const el = $(`comms-popup-${CHANNEL_ID}`);
  assert(el, "popup renders for the seeded channel");
  return el!;
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
            React.createElement(CommsPopupManager, { currentUserId: USER.id }),
          ),
        ),
      ),
    );
  });
  await flush();

  const popup = popupEl();
  assert(
    popup.querySelector(`[data-testid="comms-message-msg-meta-preview"]`),
    "popup renders messages via the shared MessagePane/MessageItem path",
  );

  console.log("— A. metadata.linkPreviews renders a LinkPreviewCard in the popup —");
  const metaContainer = popup.querySelector(
    `[data-testid="link-previews-msg-meta-preview"]`,
  ) as HTMLElement | null;
  assert(metaContainer, "A: link-previews container renders for the metadata-path message");
  const metaCard = metaContainer!.querySelector("a[href]") as HTMLAnchorElement | null;
  assert(metaCard, "A: LinkPreviewCard anchor renders");
  assert(
    metaCard!.getAttribute("href") === PREVIEW_META.url,
    `A: preview links out to the unfurled URL (got ${metaCard!.getAttribute("href")})`,
  );
  assert(
    metaCard!.textContent!.includes(PREVIEW_META.title),
    "A: preview shows the unfurled title",
  );
  // Task #3415: inside the 340px popup, preview cards render the compact
  // variant which deliberately hides the description to keep messages legible.
  assert(
    !metaCard!.textContent!.includes(PREVIEW_META.description),
    "A: compact popup preview hides the unfurled description",
  );
  assert(
    metaCard!.textContent!.includes("example.com"),
    "A: preview shows the source domain",
  );

  console.log("— B. typed linkPreviews field renders too —");
  const typedContainer = popup.querySelector(
    `[data-testid="link-previews-msg-typed-preview"]`,
  ) as HTMLElement | null;
  assert(typedContainer, "B: link-previews container renders for the typed-field message");
  const typedCard = typedContainer!.querySelector("a[href]") as HTMLAnchorElement | null;
  assert(
    typedCard?.getAttribute("href") === PREVIEW_TYPED.url,
    "B: typed-field preview links to its URL",
  );
  assert(
    typedCard!.textContent!.includes(PREVIEW_TYPED.title),
    "B: typed-field preview shows its title",
  );

  console.log("— C. image attachment opens + closes the lightbox from the popup —");
  assert(!$("lightbox-image"), "C: lightbox closed before any click");
  const imgBtn = popup.querySelector(
    `[data-testid="attachment-image-att-img-1"]`,
  ) as HTMLButtonElement | null;
  assert(imgBtn, "C: image attachment button renders in the popup");
  await act(async () => {
    imgBtn!.click();
  });
  await flush(2);
  const lightboxImg = $("lightbox-image") as HTMLImageElement | null;
  assert(lightboxImg, "C: lightbox image opens after clicking the attachment");
  assert(
    (lightboxImg!.getAttribute("src") ?? "").includes(encodeURIComponent(IMG_OBJECT_KEY)),
    `C: lightbox shows the clicked attachment (src=${lightboxImg!.getAttribute("src")})`,
  );
  // Clicking the backdrop closes it.
  await act(async () => {
    (lightboxImg!.parentElement as HTMLElement).click();
  });
  await flush(2);
  assert(!$("lightbox-image"), "C: clicking the backdrop closes the lightbox");

  console.log("— D. image + previews on one message → both render, compact in popup —");
  const bothMsg = popup.querySelector(
    `[data-testid="comms-message-msg-both"]`,
  ) as HTMLElement | null;
  assert(bothMsg, "D: the both-image-and-preview message renders in the popup");
  const bothImgBtn = bothMsg!.querySelector(
    `[data-testid="attachment-image-att-img-both"]`,
  ) as HTMLButtonElement | null;
  assert(bothImgBtn, "D: image attachment renders alongside the previews");
  const bothImg = bothImgBtn!.querySelector("img") as HTMLImageElement | null;
  assert(
    bothImg?.className.includes("max-h-32") && !bothImg?.className.includes("max-h-48"),
    `D: popup image preview is height-capped to max-h-32 (got ${bothImg?.className})`,
  );
  const bothPreviews = bothMsg!.querySelector(
    `[data-testid="link-previews-msg-both"]`,
  ) as HTMLElement | null;
  assert(bothPreviews, "D: link-previews container renders alongside the image");
  const bothCard = bothPreviews!.querySelector("a[href]") as HTMLAnchorElement | null;
  assert(
    bothCard?.getAttribute("href") === PREVIEW_BOTH.url,
    "D: preview card links to its URL",
  );
  assert(
    bothCard!.getAttribute("data-compact") === "true",
    "D: popup preview card renders the compact variant",
  );
  assert(
    bothCard!.textContent!.includes(PREVIEW_BOTH.title),
    "D: compact preview still shows the title",
  );
  assert(
    !bothCard!.textContent!.includes(PREVIEW_BOTH.description),
    "D: compact preview hides the description",
  );
  assert(
    !bothCard!.querySelector(`img[src="${PREVIEW_BOTH.imageUrl}"]`),
    "D: compact preview drops the side thumbnail image",
  );
  // Non-popup surfaces are untouched: the metadata-path card from (A) rendered
  // in the SAME popup is also compact, so instead assert the compact flag is
  // driven by the popup (all cards here carry data-compact).
  assert(
    metaCard!.getAttribute("data-compact") === "true",
    "D: every preview card inside the popup uses the compact variant",
  );

  // Lightbox still opens full-res from the capped popup image.
  await act(async () => {
    bothImgBtn!.click();
  });
  await flush(2);
  const bothLightbox = $("lightbox-image") as HTMLImageElement | null;
  assert(
    (bothLightbox?.getAttribute("src") ?? "").includes(
      encodeURIComponent(BOTH_IMG_OBJECT_KEY),
    ),
    "D: lightbox opens the both-message image from the capped preview",
  );
  await act(async () => {
    (bothLightbox!.parentElement as HTMLElement).click();
  });
  await flush(2);
  assert(!$("lightbox-image"), "D: lightbox closes again");

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("comms-popup-link-previews: ALL TESTS PASSED");
}

await main();
process.exit(0);
