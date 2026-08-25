/* test-registration
{
  "name": "Comms sidebar channel-search keyboard navigation (Task #3398)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3398: channel quick-search keyboard flow end to end. Mounts the real CommsSidebar, types a query, and proves ArrowDown/ArrowUp move and clamp the highlight (never out of bounds), scrollIntoView fires on the highlighted row, Enter selects the highlighted channel + clears + closes, Escape clears without selecting, and a query change resets the index.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/comms-sidebar-search-keyboard-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3398 — Channel quick-search keyboard navigation, end to end.
 *
 * Mounts the REAL CommsSidebar from client/src/pages/Comms.tsx in jsdom with a
 * stub channel list, types a query into the sidebar search input, and proves
 * the full keyboard flow:
 *
 *   (1) Typing a query renders the filtered result list; the FIRST row is
 *       highlighted (activeResultIndex resets to 0 on query change).
 *   (2) ArrowDown/ArrowUp move the highlight; the index is clamped at both
 *       ends (repeated ArrowDown at the last row and ArrowUp at row 0 never
 *       go out of bounds — exactly one row stays highlighted).
 *   (3) scrollIntoView is invoked on the highlighted row when the active
 *       index changes (the auto-scroll keep-visible behavior).
 *   (4) Enter selects the currently highlighted channel: onSelect receives
 *       that channel's id, the query clears (results disappear), and onClose
 *       fires.
 *   (5) Enter on an empty/whitespace query is a no-op (no selection).
 *   (6) Escape clears the query and blurs the input without selecting.
 *   (7) Changing the query after arrowing down resets the highlight to the
 *       first result (no stale out-of-bounds index against a shorter list).
 *   (8) Task #3476 — the global Cmd/Ctrl+K shortcut focuses the search input,
 *       selects its text, and prevents the browser default; it is IGNORED
 *       (no focus steal, no preventDefault) when the event target is an
 *       input, textarea, or contenteditable element (composer typing).
 *
 * Task #3477 extends this with the mouse path (shares selectFilteredChannel
 * with the keyboard path):
 *
 *   (9) Hovering a row moves the highlight there (onMouseEnter sets
 *       activeResultIndex), and Enter then selects the hovered channel.
 *   (10) Clicking a row directly selects it: onSelect receives its id,
 *       onClose fires, and the query clears.
 *
 * Heavy leaves of the Comms.tsx graph are stubbed via the shared heavy-client
 * loader; CommsContext is redirected to the stub shim. DB-free, network-free.
 *
 * Run with:
 *   TSX_TSCONFIG_PATH=./tsconfig.tests.json npx tsx \
 *     --import ./tests/client/comms-sidebar-search-keyboard-setup.mjs \
 *     tests/client/comms-sidebar-search-keyboard.test.tsx
 *
 * Registered in tests/run-all.ts.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/comms" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).SVGElement = dom.window.SVGElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
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

// Track scrollIntoView calls per element so we can assert the auto-scroll
// behavior fires on the highlighted row when the active index changes.
const scrollCalls: Array<{ testId: string | null }> = [];
(dom.window.HTMLElement.prototype as any).scrollIntoView = function () {
  scrollCalls.push({ testId: (this as HTMLElement).getAttribute?.("data-testid") ?? null });
};

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

// No network expected; fail loudly if anything fetches.
globalThis.fetch = (async (input: any) => {
  throw new Error(`unexpected fetch in sidebar search test: ${String(input)}`);
}) as any;

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

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = ReturnType<typeof createRoot>;
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
// Redirected by the loader to the stub shim — same instance Comms.tsx sees.
const { StubCommsContext } = (await import(
  "../../client/src/contexts/CommsContext"
)) as any;
const { CommsSidebar } = (await import("../../client/src/pages/Comms")) as any;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// Three recent channels sharing an "alpha" prefix (the search hits), one
// non-matching channel, and one stale client-linked channel that also matches
// (search spans pinned + recent + client buckets).
const CHANNELS = [
  {
    id: "ch-alpha-support",
    name: "alpha-support",
    slug: "alpha-support",
    type: "channel",
    clientId: null,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageAt: new Date(NOW - 1 * DAY).toISOString(),
  },
  {
    id: "ch-alpha-billing",
    name: "alpha-billing",
    slug: "alpha-billing",
    type: "channel",
    clientId: null,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageAt: new Date(NOW - 2 * DAY).toISOString(),
  },
  {
    id: "ch-unrelated",
    name: "zeta-random",
    slug: "zeta-random",
    type: "channel",
    clientId: null,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageAt: new Date(NOW - 3 * DAY).toISOString(),
  },
  {
    // Stale client-linked → Clients bucket; matches via firm name too.
    id: "ch-alpha-client",
    name: "alpha-law",
    slug: "alpha-law",
    type: "channel",
    clientId: "client-alpha",
    clientFirmName: "Alpha Law Group",
    unreadCount: 0,
    mentionCount: 0,
    lastMessageAt: new Date(NOW - 45 * DAY).toISOString(),
  },
];

const onSelectCalls: string[] = [];
let onCloseCalls = 0;

function TestProvider({ children }: { children: any }) {
  const value = React.useMemo(
    () => ({
      totalThreadUnread: 0,
      totalThreadMentions: 0,
      pinnedChannelIds: [] as string[],
      togglePin: () => {},
      myStatus: null,
    }),
    [],
  );
  return React.createElement(StubCommsContext.Provider, { value }, children);
}

function sidebarElement() {
  return React.createElement(
    TooltipProvider,
    null,
    React.createElement(
      TestProvider,
      null,
      React.createElement(CommsSidebar, {
        channels: CHANNELS,
        selectedId: null,
        onSelect: (id: string) => { onSelectCalls.push(id); },
        onNewChannel: () => {},
        onNewDm: () => {},
        open: false,
        onClose: () => { onCloseCalls++; },
        selectedView: "channel",
        onSelectView: () => {},
      }),
    ),
  );
}

let root: Root | null = null;
async function mount(): Promise<void> {
  const container = document.getElementById("root")!;
  if (root) {
    await act(async () => { root!.unmount(); });
    container.innerHTML = "";
  }
  root = createRoot(container);
  await act(async () => { root!.render(sidebarElement()); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

// ─── Interaction helpers ──────────────────────────────────────────────────────

const nativeValueSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLInputElement.prototype,
  "value",
)!.set!;

async function typeQuery(value: string): Promise<void> {
  const input = $("sidebar-channel-search-input") as HTMLInputElement;
  await act(async () => {
    nativeValueSetter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

// React synthesizes onMouseEnter from native mouseover events.
async function hoverRow(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function clickRow(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function pressKey(key: string): Promise<void> {
  const input = $("sidebar-channel-search-input") as HTMLInputElement;
  await act(async () => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function resultRows(): HTMLElement[] {
  return [...document.querySelectorAll('[data-testid^="search-result-channel-"]')] as HTMLElement[];
}

// The highlighted row (and only it, with selectedId=null) carries bg-primary/10.
function highlightedIds(): string[] {
  return resultRows()
    .filter((el) => el.className.includes("bg-primary/10"))
    .map((el) => el.getAttribute("data-testid")!.replace("search-result-channel-", ""));
}

async function main(): Promise<void> {
  section("1. Typing a query renders results with the first row highlighted");
  await mount();
  assert(!!$("sidebar-channel-search-input"), "search input renders");

  await typeQuery("alpha");
  const rows = resultRows();
  const ids = rows.map((el) => el.getAttribute("data-testid")!.replace("search-result-channel-", ""));
  assert(rows.length === 3, `three matching channels render (got ${rows.length})`);
  assert(!ids.includes("ch-unrelated"), "non-matching channel is filtered out");
  assert(
    ids.includes("ch-alpha-client"),
    "stale client-bucket channel appears in the search results",
  );
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([ids[0]]),
    `first result is highlighted after typing (got ${JSON.stringify(highlightedIds())})`,
  );

  section("2. ArrowDown/ArrowUp move the highlight and clamp at both ends");
  scrollCalls.length = 0;
  await pressKey("ArrowDown");
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([ids[1]]),
    "ArrowDown moves the highlight to the second result",
  );
  assert(
    scrollCalls.some((c) => c.testId === `search-result-channel-${ids[1]}`),
    "scrollIntoView fires on the newly highlighted row after ArrowDown",
  );

  await pressKey("ArrowDown");
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([ids[2]]),
    "second ArrowDown reaches the last result",
  );
  await pressKey("ArrowDown");
  await pressKey("ArrowDown");
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([ids[2]]),
    "further ArrowDown presses clamp at the last result (no out-of-bounds index)",
  );
  assert(
    highlightedIds().length === 1,
    "exactly one row stays highlighted after clamping at the bottom",
  );

  await pressKey("ArrowUp");
  await pressKey("ArrowUp");
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([ids[0]]),
    "two ArrowUp presses return the highlight to the first result",
  );
  await pressKey("ArrowUp");
  await pressKey("ArrowUp");
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([ids[0]]),
    "further ArrowUp presses clamp at the first result (index never < 0)",
  );

  section("3. Enter selects the highlighted channel, clears the query, closes");
  await pressKey("ArrowDown");
  const expectedId = ids[1];
  onSelectCalls.length = 0;
  onCloseCalls = 0;
  await pressKey("Enter");
  assert(
    onSelectCalls.length === 1 && onSelectCalls[0] === expectedId,
    `Enter selects the highlighted channel (expected ${expectedId}, got ${JSON.stringify(onSelectCalls)})`,
  );
  assert(onCloseCalls === 1, "Enter fires onClose (mobile sheet dismissal)");
  assert(
    ($("sidebar-channel-search-input") as HTMLInputElement).value === "",
    "Enter clears the search query",
  );
  assert(resultRows().length === 0, "result list disappears after selection");
  // Flush the deferred composer-focus setTimeout(80) so nothing leaks.
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

  section("4. Enter/arrows on an empty query are no-ops");
  onSelectCalls.length = 0;
  await pressKey("Enter");
  await pressKey("ArrowDown");
  assert(onSelectCalls.length === 0, "Enter with no query selects nothing");
  await typeQuery("   ");
  await pressKey("Enter");
  assert(
    onSelectCalls.length === 0 && resultRows().length === 0,
    "whitespace-only query renders no results and Enter selects nothing",
  );

  section("5. Escape clears the query without selecting");
  await typeQuery("alpha");
  assert(resultRows().length === 3, "results render again for a fresh query");
  onSelectCalls.length = 0;
  await pressKey("Escape");
  assert(
    ($("sidebar-channel-search-input") as HTMLInputElement).value === "",
    "Escape clears the search query",
  );
  assert(resultRows().length === 0, "Escape hides the result list");
  assert(onSelectCalls.length === 0, "Escape selects nothing");

  section("6. Query change after arrowing resets the highlight to the first row");
  await typeQuery("alpha");
  await pressKey("ArrowDown");
  await pressKey("ArrowDown");
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([resultRows()[2].getAttribute("data-testid")!.replace("search-result-channel-", "")]),
    "highlight sits on the third result before the query change",
  );
  // Narrow to a single-result query — the old index (2) would be out of
  // bounds; the reset effect must bring it back to 0.
  await typeQuery("alpha law");
  const narrowRows = resultRows();
  assert(narrowRows.length === 1, `narrowed query matches exactly one channel (got ${narrowRows.length})`);
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify(["ch-alpha-client"]),
    "highlight resets to the (only) first result after the query change",
  );
  onSelectCalls.length = 0;
  await pressKey("Enter");
  assert(
    onSelectCalls.length === 1 && onSelectCalls[0] === "ch-alpha-client",
    "Enter after narrowing selects the correct (in-bounds) channel",
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

  section("7. Cmd/Ctrl+K focuses and selects the search input (Task #3476)");
  const searchInput = $("sidebar-channel-search-input") as HTMLInputElement;
  await typeQuery("alpha");
  await pressKey("Escape"); // Escape blurs; leaves value empty
  await typeQuery("alpha");
  await act(async () => { searchInput.blur(); });
  assert(
    document.activeElement !== searchInput,
    "search input starts unfocused before the shortcut fires",
  );

  async function dispatchGlobalK(opts: { metaKey?: boolean; ctrlKey?: boolean }, target?: HTMLElement): Promise<KeyboardEvent> {
    const ev = new dom.window.KeyboardEvent("keydown", {
      key: "k",
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    await act(async () => {
      (target ?? (dom.window as unknown as { document: Document }).document.body).dispatchEvent(ev);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return ev as unknown as KeyboardEvent;
  }

  const cmdEv = await dispatchGlobalK({ metaKey: true });
  assert(document.activeElement === searchInput, "Cmd+K focuses the search input");
  assert(
    searchInput.selectionStart === 0 && searchInput.selectionEnd === searchInput.value.length && searchInput.value.length > 0,
    `Cmd+K selects the existing text (selection ${searchInput.selectionStart}-${searchInput.selectionEnd} of ${searchInput.value.length})`,
  );
  assert(cmdEv.defaultPrevented, "Cmd+K prevents the browser default");

  await act(async () => { searchInput.blur(); });
  const ctrlEv = await dispatchGlobalK({ ctrlKey: true });
  assert(document.activeElement === searchInput, "Ctrl+K also focuses the search input");
  assert(ctrlEv.defaultPrevented, "Ctrl+K prevents the browser default");

  section("8. Cmd+K is ignored while typing in an input/textarea/contenteditable");
  const composerTextarea = document.createElement("textarea");
  composerTextarea.setAttribute("data-testid", "fake-composer-textarea");
  document.body.appendChild(composerTextarea);
  const otherInput = document.createElement("input");
  otherInput.setAttribute("data-testid", "fake-other-input");
  document.body.appendChild(otherInput);
  const editableDiv = document.createElement("div");
  editableDiv.setAttribute("contenteditable", "true");
  document.body.appendChild(editableDiv);
  // jsdom supports isContentEditable via the contentEditable IDL attribute.
  if (!editableDiv.isContentEditable) {
    Object.defineProperty(editableDiv, "isContentEditable", { value: true });
  }

  await act(async () => { composerTextarea.focus(); });
  const textareaEv = await dispatchGlobalK({ metaKey: true }, composerTextarea);
  assert(
    document.activeElement === composerTextarea,
    "Cmd+K from a textarea does NOT steal focus (composer typing preserved)",
  );
  assert(!textareaEv.defaultPrevented, "Cmd+K from a textarea does not preventDefault");

  await act(async () => { otherInput.focus(); });
  const inputEv = await dispatchGlobalK({ ctrlKey: true }, otherInput);
  assert(
    document.activeElement === otherInput,
    "Ctrl+K from another input does NOT steal focus",
  );
  assert(!inputEv.defaultPrevented, "Ctrl+K from an input does not preventDefault");

  await act(async () => { editableDiv.focus(); });
  const editableEv = await dispatchGlobalK({ metaKey: true }, editableDiv);
  assert(
    document.activeElement !== searchInput,
    "Cmd+K from a contenteditable element does NOT jump to the search input",
  );
  assert(!editableEv.defaultPrevented, "Cmd+K from a contenteditable does not preventDefault");

  // Sanity: with focus back on body, the shortcut still works after the
  // ignored cases (listener not accidentally removed).
  await act(async () => { editableDiv.blur(); });
  const finalEv = await dispatchGlobalK({ metaKey: true });
  assert(
    document.activeElement === searchInput && finalEv.defaultPrevented,
    "Cmd+K still works after the ignored-target cases",
  );

  composerTextarea.remove();
  otherInput.remove();
  editableDiv.remove();

  section("9. Hovering a row moves the highlight; Enter selects the hovered channel");
  await typeQuery("alpha");
  const hoverRows = resultRows();
  const hoverIds = hoverRows.map((el) =>
    el.getAttribute("data-testid")!.replace("search-result-channel-", ""),
  );
  assert(hoverRows.length === 3, "results render again for the hover section");
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([hoverIds[0]]),
    "first result starts highlighted before any hover",
  );
  await hoverRow(hoverRows[2]);
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([hoverIds[2]]),
    `hovering the third row moves the highlight there (got ${JSON.stringify(highlightedIds())})`,
  );
  assert(highlightedIds().length === 1, "hover leaves exactly one row highlighted (no fight with keyboard highlight)");
  await hoverRow(hoverRows[1]);
  assert(
    JSON.stringify(highlightedIds()) === JSON.stringify([hoverIds[1]]),
    "hovering the second row moves the highlight off the previous row",
  );
  onSelectCalls.length = 0;
  onCloseCalls = 0;
  await pressKey("Enter");
  assert(
    onSelectCalls.length === 1 && onSelectCalls[0] === hoverIds[1],
    `Enter after hover selects the hovered channel (expected ${hoverIds[1]}, got ${JSON.stringify(onSelectCalls)})`,
  );
  assert(onCloseCalls === 1, "Enter after hover fires onClose");
  assert(
    ($("sidebar-channel-search-input") as HTMLInputElement).value === "",
    "Enter after hover clears the search query",
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

  section("10. Clicking a row selects it directly");
  await typeQuery("alpha");
  const clickRows = resultRows();
  const clickIds = clickRows.map((el) =>
    el.getAttribute("data-testid")!.replace("search-result-channel-", ""),
  );
  assert(clickRows.length === 3, "results render again for the click section");
  onSelectCalls.length = 0;
  onCloseCalls = 0;
  await clickRow(clickRows[2]);
  assert(
    onSelectCalls.length === 1 && onSelectCalls[0] === clickIds[2],
    `clicking the third row selects that channel (expected ${clickIds[2]}, got ${JSON.stringify(onSelectCalls)})`,
  );
  assert(onCloseCalls === 1, "click fires onClose (mobile sheet dismissal)");
  assert(
    ($("sidebar-channel-search-input") as HTMLInputElement).value === "",
    "click clears the search query",
  );
  assert(resultRows().length === 0, "result list disappears after click selection");
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

  if (root) await act(async () => { root!.unmount(); });

  if (failed > 0) {
    console.error(`\ncomms-sidebar-search-keyboard: ${failed} assertion(s) FAILED (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\ncomms-sidebar-search-keyboard: all ${passed} assertions passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error("comms-sidebar-search-keyboard: fatal error", err);
  process.exit(1);
});
