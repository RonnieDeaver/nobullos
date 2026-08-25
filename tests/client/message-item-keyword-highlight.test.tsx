/* test-registration
{
  "name": "Comms MessageItem keyword highlighting — flag+underline only other users' non-system word-boundary matches; code/mentions/links protected (Task #3292)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3292: keyword-match highlighting in the message thread (Task #3285) had no rendered coverage — a refactor of renderContent/keywordify or MessageItem could silently drop the amber flag or the underline spans. Mounts the REAL MessageItem in jsdom and pins: data-keyword-match=\"true\" only on other users' non-system matching messages; keyword-highlight spans wrap exactly the word-boundary matches (case-insensitive, partial words excluded, multi-word phrases as one span); keywords inside inline code spans, @mentions, and URLs are NOT wrapped. Fast, DB-free, network-free jsdom render with fetch fully stubbed.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/message-item-keyword-highlight-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3292 — Keyword highlights can't silently break in the message thread.
 *
 * Task #3285 added visual keyword-match highlighting driven by the viewing
 * user's own notification keywords: an amber left border on matching messages
 * (data-keyword-match="true" on the message container) plus underlined
 * matching words (data-testid="keyword-highlight" spans from keywordify in
 * components/comms/helpers.tsx). This mounts the REAL MessageItem in jsdom
 * and pins:
 *
 *   (A) another user's plain-text message containing a keyword gets
 *       data-keyword-match="true" and keyword-highlight spans wrapping
 *       exactly the word-boundary matches (case-insensitive; "urgently"
 *       is NOT a match for "urgent");
 *   (B) the viewer's OWN matching message is never flagged or underlined;
 *   (C) a system message containing a keyword is never flagged;
 *   (D) keywords inside inline `code` spans, @[Name](user:id) mentions, and
 *       URLs are NOT wrapped — only plain-text occurrences are;
 *   (E) a non-matching message from another user carries no flag/highlight.
 *
 * Run: TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx tests/client/message-item-keyword-highlight.test.tsx
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
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
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
(globalThis as any).EventSource =
  (globalThis as any).EventSource ??
  class { addEventListener() {} removeEventListener() {} close() {} };
(dom.window as any).EventSource = (globalThis as any).EventSource;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fetch stub: unauthenticated auth probe keeps CommsProvider on the stable
// NULL_CONTEXT branch (MessageItem only reads userStatuses from context);
// custom emoji list is empty.
// ---------------------------------------------------------------------------

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", status: 401, json: { message: "Unauthorized" } },
    { method: "GET", path: "/api/comms/emoji", json: [] },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME = "user-me-3292";
const OTHER = {
  id: "user-other-3292",
  firstName: "Alice",
  lastName: "Ng",
  profileImageUrl: null,
};
const KEYWORDS = ["urgent", "acme corp"];

let msgSeq = 0;
function makeMsg(overrides: Record<string, unknown>) {
  msgSeq++;
  return {
    id: `msg-3292-${msgSeq}`,
    channelId: "ch-3292",
    userId: OTHER.id,
    parentId: null,
    content: "",
    contentType: "text" as const,
    editedAt: null,
    deletedAt: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    user: OTHER,
    reactionCounts: {},
    replyCount: 0,
    ...overrides,
  };
}

const MSG_MATCH = makeMsg({
  content: "This is Urgent: the urgency of urgently doesn't count, but urgent, does.",
});
const MSG_PHRASE = makeMsg({ content: "News from Acme Corp today" });
const MSG_OWN = makeMsg({ userId: ME, user: { id: ME, firstName: "Me", lastName: "Self", profileImageUrl: null }, content: "my own urgent note" });
const MSG_SYSTEM = makeMsg({ userId: null, user: null, contentType: "system", content: "urgent system notice" });
const MSG_NO_MATCH = makeMsg({ content: "nothing interesting here" });
const MSG_PROTECTED = makeMsg({
  content:
    "run `urgent --now` or ping @[Urgent Bot](user:u-bot) or see https://example.com/urgent but this urgent counts",
});

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");
const { MessageItem } = await import("../../client/src/components/comms/MessageItem");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function container(msgId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="comms-message-${msgId}"]`) as HTMLElement | null;
}

function highlightsIn(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('[data-testid="keyword-highlight"]')).map(
    (n) => n.textContent ?? "",
  );
}

async function main(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const noop = () => {};
  const item = (msg: any) =>
    React.createElement(MessageItem, {
      key: msg.id,
      msg,
      currentUserId: ME,
      onReact: noop,
      onEdit: noop,
      onDelete: noop,
      highlightKeywords: KEYWORDS,
    });

  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          CommsProvider,
          null,
          React.createElement(
            TooltipProvider,
            null,
            item(MSG_MATCH),
            item(MSG_PHRASE),
            item(MSG_OWN),
            item(MSG_SYSTEM),
            item(MSG_NO_MATCH),
            item(MSG_PROTECTED),
          ),
        ),
      ),
    );
  });
  await flush();

  console.log("— A. other user's matching message is flagged + underlined —");
  const elMatch = container(MSG_MATCH.id);
  assert(elMatch, "A: matching message rendered");
  assert(
    elMatch!.getAttribute("data-keyword-match") === "true",
    "A: container carries data-keyword-match=\"true\"",
  );
  const hlA = highlightsIn(elMatch!);
  assert(
    hlA.length === 2,
    `A: exactly the two word-boundary matches are wrapped (got ${JSON.stringify(hlA)})`,
  );
  assert(hlA[0] === "Urgent", `A: case-insensitive match keeps original casing (got "${hlA[0]}")`);
  assert(hlA[1] === "urgent", `A: second standalone "urgent" wrapped (got "${hlA[1]}")`);
  assert(
    !hlA.some((t) => t.includes("urgently") || t.includes("urgency")),
    "A: partial-word 'urgently'/'urgency' are NOT wrapped",
  );

  console.log("— A2. multi-word keyword phrase is wrapped —");
  const elPhrase = container(MSG_PHRASE.id)!;
  assert(elPhrase.getAttribute("data-keyword-match") === "true", "A2: phrase message flagged");
  const hlPhrase = highlightsIn(elPhrase);
  assert(
    hlPhrase.length === 1 && hlPhrase[0] === "Acme Corp",
    `A2: the phrase "Acme Corp" is wrapped as one span (got ${JSON.stringify(hlPhrase)})`,
  );

  console.log("— B. own matching message is never flagged —");
  const elOwn = container(MSG_OWN.id)!;
  assert(elOwn.getAttribute("data-keyword-match") === null, "B: own message has no data-keyword-match");
  assert(highlightsIn(elOwn).length === 0, "B: own message has no keyword-highlight spans");

  console.log("— C. system message is never flagged —");
  assert(
    container(MSG_SYSTEM.id) === null,
    "C: system message renders as a divider (no comms-message container)",
  );
  assert(
    document.querySelectorAll("[data-keyword-match]").length === 3,
    "C: only the three matching non-system, non-own messages are flagged anywhere",
  );

  console.log("— D. code spans / mentions / links are protected —");
  const elProt = container(MSG_PROTECTED.id)!;
  assert(
    elProt.getAttribute("data-keyword-match") === "true",
    "D: message with one plain-text occurrence is still flagged",
  );
  const hlD = highlightsIn(elProt);
  assert(
    hlD.length === 1 && hlD[0] === "urgent",
    `D: only the plain-text 'urgent' is wrapped (got ${JSON.stringify(hlD)})`,
  );
  const codeEl = elProt.querySelector("code");
  assert(codeEl && codeEl.textContent === "urgent --now", "D: code span rendered intact");
  assert(
    codeEl!.querySelector('[data-testid="keyword-highlight"]') === null,
    "D: no highlight inside the code span",
  );
  const linkEl = elProt.querySelector('a[href="https://example.com/urgent"]');
  assert(linkEl, "D: URL rendered as a link");
  assert(
    linkEl!.querySelector('[data-testid="keyword-highlight"]') === null,
    "D: no highlight inside the link",
  );
  assert(elProt.textContent!.includes("@Urgent Bot"), "D: mention chip rendered");
  const mentionSpan = Array.from(elProt.querySelectorAll("span")).find(
    (s) => s.textContent === "@Urgent Bot",
  );
  assert(mentionSpan, "D: mention chip is its own span");
  assert(
    mentionSpan!.querySelector('[data-testid="keyword-highlight"]') === null &&
      mentionSpan!.getAttribute("data-testid") !== "keyword-highlight",
    "D: no highlight inside the mention chip",
  );

  console.log("— E. non-matching message carries nothing —");
  const elNone = container(MSG_NO_MATCH.id)!;
  assert(elNone.getAttribute("data-keyword-match") === null, "E: no data-keyword-match");
  assert(highlightsIn(elNone).length === 0, "E: no keyword-highlight spans");

  await act(async () => {
    root.unmount();
  });
  console.log("\nAll MessageItem keyword-highlight checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
