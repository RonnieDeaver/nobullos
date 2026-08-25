/* test-registration
{
  "name": "Emoji panels escape the 300px overflow-hidden comms popup — message + composer panels portaled, fixed, clickable, dismissable (Tasks #3332, #3347)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3332: the emoji quick-pick panel and full EmojiPicker used to render `absolute right-0 bottom-8` inside the message row, so the 300px overflow-hidden comms popup clipped them (the w-72 full picker overflowed the popup's left edge — unreachable). Guard: both panels portal to document.body via AnchoredPortalPanel with fixed viewport-clamped positioning, every quick emoji + full-picker option stays clickable, outside-mousedown still dismisses, and the message menu stays a Radix (portal-based) DropdownMenu. Task #3347 extended it: the compact Composer's emoji picker (last hand-rolled `absolute bottom-10` panel in the popup body) also portals out, inserts into the textarea, and a structural guard asserts no absolute+z-50 interactive overlay remains inside the popup. DB-free, stubbed fetch.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/emoji-panel-popup-clipping-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3332 — emoji quick-pick panel and full EmojiPicker stay accessible
 * inside a narrow (300px, overflow-hidden) comms popup.
 *
 * The hover toolbar's emoji panels used to render `absolute right-0 bottom-8`
 * inside the message row. The comms popup windows are 300px wide with
 * `overflow-hidden`, and the full EmojiPicker is w-72 (288px) anchored to a
 * button ~60px from the popup's right edge — so it overflowed the popup's left
 * boundary and was clipped (left-overflow inside an overflow container is
 * unreachable: scrollable area only extends right/down).
 *
 * The fix portals both panels to document.body via AnchoredPortalPanel with
 * `position: fixed` clamped to the viewport, so no ancestor overflow boundary
 * can clip them. jsdom has no real layout, so the testable invariant is the
 * escape itself; this test mounts the REAL MessageItem inside a 300px
 * overflow-hidden container and proves:
 *
 *   (A) the quick-emoji panel renders OUTSIDE the overflow container, directly
 *       under document.body, with fixed positioning;
 *   (B) every quick emoji is present and clicking one fires onReact + closes;
 *   (C) "More emoji…" swaps to the full EmojiPicker, also portaled outside the
 *       container with fixed positioning, and its options are clickable
 *       (selection fires onReact);
 *   (D) mousedown outside dismisses the panel (portal-aware outside-click);
 *   (E) the message dropdown menu trigger is a Radix DropdownMenu (portals via
 *       Radix, so it was never at risk — asserted so a regression to an inline
 *       absolute menu would be caught);
 *   (F) Task #3347 — the compact Composer's emoji picker (the last remaining
 *       hand-rolled `absolute bottom-10 right-0` panel inside the popup body)
 *       also portals to document.body with fixed positioning, its options are
 *       clickable, and outside mousedown dismisses it.
 *
 * Run: TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx --import ./tests/client/emoji-panel-popup-clipping-setup.mjs tests/client/emoji-panel-popup-clipping.test.tsx
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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── fetch stub: custom emoji list is the only network dependency ────────────
(globalThis as any).fetch = createFetchStub({
  routes: [{ match: "/api/comms/emoji", json: [] }],
  defaultJson: [],
});

const MSG_ID = "msg-clip-3332";

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
  const { MessageItem } = await import("../../client/src/components/comms/MessageItem");
  const { Composer } = await import("../../client/src/components/comms/Composer");
  const { QUICK_EMOJIS } = await import("../../client/src/components/comms/helpers");

  const msg = {
    id: MSG_ID,
    channelId: "ch-1",
    userId: "user-2",
    parentId: null,
    content: "hello from a narrow popup",
    contentType: "text" as const,
    editedAt: null,
    deletedAt: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    user: { id: "user-2", firstName: "Popup", lastName: "Author", profileImageUrl: null },
    reactionCounts: {},
    replyCount: 0,
  };

  const reactions: Array<{ id: string; emoji: string }> = [];

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          {/* Mimic the 300px comms popup window: fixed width + overflow-hidden */}
          <div
            data-testid="narrow-popup"
            style={{ width: 300, height: 380, overflow: "hidden", position: "relative" }}
          >
            <MessageItem
              msg={msg as any}
              currentUserId="user-1"
              onReact={(id: string, emoji: string) => reactions.push({ id, emoji })}
              onEdit={() => {}}
              onDelete={() => {}}
            />
            <Composer channelId="ch-1" placeholder="Message #general" compact />
          </div>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  const doc = dom.window.document;
  const popupEl = doc.querySelector('[data-testid="narrow-popup"]')!;

  const trigger = doc.querySelector(
    `[data-testid="emoji-trigger-${MSG_ID}"]`,
  ) as HTMLButtonElement | null;
  assert(trigger, "emoji trigger button renders");
  assert(popupEl.contains(trigger!), "trigger lives inside the narrow popup");

  // (A) open quick panel — must escape the overflow container
  await act(async () => {
    trigger!.click();
  });
  const quickPanel = doc.querySelector(
    `[data-testid="quick-emoji-panel-${MSG_ID}"]`,
  ) as HTMLElement | null;
  assert(quickPanel, "quick-emoji panel renders");
  assert(
    !popupEl.contains(quickPanel!),
    "quick panel is NOT inside the overflow-hidden popup (portaled out)",
  );
  assert(
    quickPanel!.parentElement === doc.body,
    "quick panel is portaled directly under document.body",
  );
  assert(
    quickPanel!.className.includes("fixed"),
    "quick panel uses fixed positioning (viewport-anchored, unclippable)",
  );
  console.log("  ok - (A) quick panel escapes the 300px overflow-hidden popup");

  // (B) all quick emojis present and clickable
  const quickButtons = Array.from(quickPanel!.querySelectorAll("button"));
  const findQuick = (e: string) =>
    quickButtons.find((b) => b.getAttribute("data-testid") === `quick-emoji-${e}`);
  for (const e of QUICK_EMOJIS) {
    assert(findQuick(e), `quick emoji ${e} is reachable in the panel`);
  }
  const firstQuick = findQuick(QUICK_EMOJIS[0]) as HTMLButtonElement;
  await act(async () => {
    firstQuick.click();
  });
  assert(
    reactions.length === 1 && reactions[0].emoji === QUICK_EMOJIS[0],
    "clicking a quick emoji fires onReact with that emoji",
  );
  assert(
    !doc.querySelector(`[data-testid="quick-emoji-panel-${MSG_ID}"]`),
    "quick panel closes after selecting",
  );
  console.log("  ok - (B) every quick emoji reachable; selection fires onReact and closes");

  // (C) full EmojiPicker via "More emoji…" — also portaled out
  await act(async () => {
    trigger!.click();
  });
  const moreBtn = Array.from(
    doc.querySelectorAll(`[data-testid="quick-emoji-panel-${MSG_ID}"] button`),
  ).find((b) => b.textContent?.includes("More emoji")) as HTMLButtonElement | undefined;
  assert(moreBtn, '"More emoji…" button present in quick panel');
  await act(async () => {
    moreBtn!.click();
  });
  const fullPanel = doc.querySelector(
    `[data-testid="full-emoji-panel-${MSG_ID}"]`,
  ) as HTMLElement | null;
  assert(fullPanel, "full EmojiPicker panel renders");
  assert(
    !popupEl.contains(fullPanel!),
    "full picker is NOT inside the overflow-hidden popup (portaled out)",
  );
  assert(
    fullPanel!.parentElement === doc.body,
    "full picker is portaled directly under document.body",
  );
  assert(
    fullPanel!.className.includes("fixed"),
    "full picker uses fixed positioning",
  );
  const anyOption = fullPanel!.querySelector(
    '[data-testid^="emoji-option-"]',
  ) as HTMLButtonElement | null;
  assert(anyOption, "full picker exposes emoji option buttons");
  await act(async () => {
    anyOption!.click();
  });
  assert(reactions.length === 2, "selecting from the full picker fires onReact");
  assert(
    !doc.querySelector(`[data-testid="full-emoji-panel-${MSG_ID}"]`),
    "full picker closes after selecting",
  );
  console.log("  ok - (C) full EmojiPicker portals out of the popup and options are clickable");

  // (D) outside mousedown dismisses (portal-aware outside-click)
  await act(async () => {
    trigger!.click();
  });
  assert(
    doc.querySelector(`[data-testid="quick-emoji-panel-${MSG_ID}"]`),
    "quick panel reopened for dismiss check",
  );
  await act(async () => {
    doc.body.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true }),
    );
  });
  assert(
    !doc.querySelector(`[data-testid="quick-emoji-panel-${MSG_ID}"]`),
    "mousedown outside dismisses the portaled panel",
  );
  assert(reactions.length === 2, "outside-click dismiss fired no extra reactions");
  console.log("  ok - (D) outside mousedown dismisses the portaled panel");

  // (F) short-viewport safety (Task #3346): the portaled panel wrapper caps
  // its own height to the viewport and scrolls internally, so even a ~480px
  // (or shorter) landscape-phone viewport can never leave emoji unreachable.
  // jsdom has no real layout, so the testable invariant is the cap itself:
  // maxHeight bound to the viewport + internal overflow scrolling.
  Object.defineProperty(dom.window, "innerHeight", {
    value: 480,
    configurable: true,
    writable: true,
  });
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event("resize"));
  });
  await act(async () => {
    trigger!.click();
  });
  const shortQuick = doc.querySelector(
    `[data-testid="quick-emoji-panel-${MSG_ID}"]`,
  ) as HTMLElement | null;
  assert(shortQuick, "quick panel opens at a 480px-tall viewport");
  assert(
    shortQuick!.style.maxHeight === "calc(100vh - 16px)",
    "panel wrapper caps its height to the viewport (maxHeight = 100vh - margins)",
  );
  assert(
    shortQuick!.className.includes("overflow-y-auto"),
    "panel wrapper scrolls internally when content exceeds the cap",
  );
  const topPx = parseFloat(shortQuick!.style.top || "NaN");
  assert(
    Number.isFinite(topPx) && topPx >= 8,
    `panel top is clamped to >= 8px viewport margin (got ${shortQuick!.style.top})`,
  );
  // Full picker gets the same wrapper guarantees
  const moreBtn2 = Array.from(
    doc.querySelectorAll(`[data-testid="quick-emoji-panel-${MSG_ID}"] button`),
  ).find((b) => b.textContent?.includes("More emoji")) as HTMLButtonElement | undefined;
  assert(moreBtn2, '"More emoji…" available at short viewport');
  await act(async () => {
    moreBtn2!.click();
  });
  const shortFull = doc.querySelector(
    `[data-testid="full-emoji-panel-${MSG_ID}"]`,
  ) as HTMLElement | null;
  assert(shortFull, "full picker opens at a 480px-tall viewport");
  assert(
    shortFull!.style.maxHeight === "calc(100vh - 16px)",
    "full picker wrapper caps its height to the viewport",
  );
  assert(
    shortFull!.className.includes("overflow-y-auto"),
    "full picker wrapper scrolls internally",
  );
  await act(async () => {
    doc.body.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true }),
    );
  });
  assert(
    !doc.querySelector(`[data-testid="full-emoji-panel-${MSG_ID}"]`),
    "short-viewport picker dismissed cleanly",
  );
  console.log("  ok - (F) panel caps to viewport height and scrolls internally on short screens");

  // (E) dropdown menu trigger present (Radix — portals its own content)
  const menuTrigger = doc.querySelector(`[data-testid="msg-menu-${MSG_ID}"]`);
  assert(menuTrigger, "message dropdown menu trigger renders");
  assert(
    menuTrigger!.getAttribute("aria-haspopup") === "menu",
    "menu trigger is a Radix DropdownMenu trigger (portals content, never clipped)",
  );
  console.log("  ok - (E) dropdown remains a Radix portal-based menu");

  // (F) Task #3347 — compact Composer's emoji picker also escapes the popup
  const composerTrigger = doc.querySelector(
    '[data-testid="emoji-trigger-composer"]',
  ) as HTMLButtonElement | null;
  assert(composerTrigger, "composer emoji trigger renders");
  assert(
    popupEl.contains(composerTrigger!),
    "composer trigger lives inside the narrow popup",
  );
  await act(async () => {
    composerTrigger!.click();
  });
  const composerPanel = doc.querySelector(
    '[data-testid="composer-emoji-panel"]',
  ) as HTMLElement | null;
  assert(composerPanel, "composer emoji panel renders");
  assert(
    !popupEl.contains(composerPanel!),
    "composer emoji panel is NOT inside the overflow-hidden popup (portaled out)",
  );
  assert(
    composerPanel!.parentElement === doc.body,
    "composer emoji panel is portaled directly under document.body",
  );
  assert(
    composerPanel!.className.includes("fixed"),
    "composer emoji panel uses fixed positioning",
  );
  const composerOption = composerPanel!.querySelector(
    '[data-testid^="emoji-option-"]',
  ) as HTMLButtonElement | null;
  assert(composerOption, "composer emoji panel exposes emoji option buttons");
  await act(async () => {
    composerOption!.click();
  });
  const composerTextarea = popupEl.querySelector(
    "textarea",
  ) as HTMLTextAreaElement | null;
  assert(composerTextarea, "composer textarea renders inside the popup");
  assert(
    composerTextarea!.value.length > 0,
    "selecting an emoji from the portaled panel inserts it into the composer",
  );
  assert(
    !doc.querySelector('[data-testid="composer-emoji-panel"]'),
    "composer emoji panel closes after selecting (EmojiPicker onClose fires)",
  );
  // Reopen and verify outside mousedown dismisses (portal-aware outside-click)
  await act(async () => {
    composerTrigger!.click();
  });
  assert(
    doc.querySelector('[data-testid="composer-emoji-panel"]'),
    "composer emoji panel reopened for dismiss check",
  );
  await act(async () => {
    doc.body.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true }),
    );
  });
  assert(
    !doc.querySelector('[data-testid="composer-emoji-panel"]'),
    "mousedown outside dismisses the composer emoji panel",
  );
  console.log("  ok - (F) composer emoji panel escapes the popup, inserts, and dismisses");

  // (G) structural guard: no absolute-positioned overlay panel (the old
  // `absolute … z-50` pattern) containing interactive elements remains inside
  // the popup. The hover toolbar (z-10) is a row decoration, not an overlay
  // panel, and is excluded by the z-50 requirement.
  const absoluteInteractive = Array.from(
    popupEl.querySelectorAll<HTMLElement>('[class*="absolute"]'),
  ).filter(
    (el) =>
      /\bz-(40|50|\[\d+\])\b/.test(el.className) &&
      el.querySelector("button, input, textarea, a, select"),
  );
  assert(
    absoluteInteractive.length === 0,
    `no absolute-positioned overlay panel remains inside the popup (found ${absoluteInteractive.length})`,
  );
  console.log("  ok - (G) no absolute-positioned overlay panels remain in the popup");

  await act(async () => {
    root.unmount();
  });

  console.log("All emoji-panel popup-clipping assertions passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
