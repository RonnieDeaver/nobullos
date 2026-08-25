/* test-registration
{
  "name": "Comms SearchPanel — live SSE prepend/edit/delete keeps search results current, incl. full-name from:First_Last gating (Tasks #3296, #3427)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3296: SearchPanel live SSE overlay — new comms:message events that match the active parsed query (channel scope + free-text terms/excluded) prepend without a re-fetch, comms:message_edit updates rows in place (dropping rows that no longer match), comms:message_delete removes rows. Rendered jsdom test mounting the real CommsProvider + SearchPanel with a capturing EventSource stub; DB-free, network-free (fetch stubbed).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/search-panel-live-sse-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
// future-date-literal-reviewed: 2026-12-31/2027-01-05 are the literal after:/before: bounds of the seeded search query and the message createdAt values tested against them — literal-vs-literal window checks with no real-clock comparison; they cannot rot.
/**
 * Task #3296 — SearchPanel results stay current after new messages arrive
 * via SSE.
 *
 * Mounts the REAL CommsProvider + SearchPanel in jsdom with a controllable
 * EventSource stub and proves:
 *
 *   (A) submitting a query renders the fetched snapshot results;
 *   (B) a comms:message SSE event matching the active parsed query (same
 *       channel scope + free-text terms) is PREPENDED to the results list
 *       without a re-fetch of the search endpoint;
 *   (C) non-matching events (wrong channel, missing term, excluded term,
 *       wrong sender) are ignored;
 *   (D) comms:message_edit updates the relevant result row in-place, and an
 *       edit that removes the matched term drops the row;
 *   (E) comms:message_delete removes the relevant result row.
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Controllable EventSource stub: capture instances so the test can emit
// named SSE events into the provider's listeners.
const esInstances: EventSourceStub[] = [];
class EventSourceStub {
  url: string;
  listeners = new Map<string, Array<(e: any) => void>>();
  constructor(url: string) {
    this.url = url;
    esInstances.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener() {}
  close() {}
  emit(type: string, payload: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(payload) });
    }
  }
}
(globalThis as any).EventSource = EventSourceStub;
(dom.window as any).EventSource = EventSourceStub;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = {
  id: "user-me",
  email: "ceo@nobull.test",
  firstName: "Test",
  lastName: "CEO",
  role: "ceo",
};

const CH_GENERAL = {
  id: "ch-general-3296",
  name: "general",
  slug: "general",
  type: "channel",
  visibility: "public" as const,
  topic: null,
  description: null,
  clientId: null,
  createdBy: USER.id,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  unreadCount: 0,
};
const CH_OTHER = { ...CH_GENERAL, id: "ch-other-3296", name: "random", slug: "random" };
const CHANNELS = [CH_GENERAL, CH_OTHER];

const EXISTING = {
  id: "msg-existing-1",
  channelId: CH_GENERAL.id,
  content: "alpha existing snapshot hit",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  user: { id: "user-alice", firstName: "Alice", lastName: "Ng" },
};

const QUERY = "alpha -junk in:general";
const QUERY_FROM_DATES = "alpha from:bob after:2026-01-01 before:2026-12-31";
// Task #3427 — full-name (autocomplete-inserted, underscore-joined) from: query
const QUERY_FROM_FULLNAME = "alpha from:bob_lo";
// Seed recent searches so the test can apply queries by clicking them —
// the Radix PopoverTrigger marks the search input type="button" in jsdom,
// which defeats React's input-event value tracking for direct typing.
dom.window.localStorage.setItem(
  `comms_recent_searches_${"user-me"}`,
  JSON.stringify([QUERY, QUERY_FROM_DATES, QUERY_FROM_FULLNAME]),
);

let searchFetchCount = 0;

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: "/api/comms/channels", json: CHANNELS },
    { method: "GET", path: "/api/comms/users", json: [
      { id: "user-alice", firstName: "Alice", lastName: "Ng" },
      { id: "user-bob", firstName: "Bob", lastName: "Lo" },
    ] },
    { method: "GET", path: /\/api\/comms\/search\/files\?/, json: [] },
    {
      method: "GET",
      path: /\/api\/comms\/search\?/,
      json: () => {
        searchFetchCount++;
        return [EXISTING];
      },
    },
    { method: "POST", path: /\/api\/comms\/presence\/heartbeat$/, json: { ok: true } },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CommsProvider } = await import("../../client/src/contexts/CommsContext");
const { SearchPanel } = await import("../../client/src/components/comms/SearchPanel");

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

function emitSse(type: string, payload: Record<string, unknown>): void {
  assert(esInstances.length > 0, "CommsProvider opened an SSE connection");
  esInstances[esInstances.length - 1].emit(type, { type, ...payload });
}

function resultIds(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid^="msg-result-"]'),
  ).map((el) => el.getAttribute("data-testid")!.replace("msg-result-", ""));
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
          CommsProvider,
          null,
          React.createElement(SearchPanel, {
            currentUserId: USER.id,
            channels: CHANNELS as any,
            onClose: () => {},
          }),
        ),
      ),
    );
  });
  await flush();

  // Apply the query (free-text "alpha", scoped to #general, excluding "junk")
  // via the seeded recent-search entry.
  const recent = $(`recent-search-${QUERY}`);
  assert(recent, "seeded recent search renders");
  await act(async () => {
    recent!.click();
  });
  await flush();

  console.log("— A. snapshot results render —");
  assert($(`msg-result-${EXISTING.id}`), "A: fetched snapshot result renders");
  assert(searchFetchCount >= 1, "A: search endpoint was fetched");
  const fetchesAfterSnapshot = searchFetchCount;

  console.log("— B. matching SSE message is prepended without re-fetch —");
  await act(async () => {
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: {
        id: "msg-live-1",
        channelId: CH_GENERAL.id,
        userId: "user-bob",
        parentId: null,
        content: "fresh alpha from the stream",
        contentType: "text",
        editedAt: null,
        deletedAt: null,
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        user: { id: "user-bob", firstName: "Bob", lastName: "Lo" },
      },
    });
  });
  await flush(2);
  const idsB = resultIds();
  assert(idsB[0] === "msg-live-1", `B: live message is prepended first (got ${idsB.join(",")})`);
  assert(idsB.includes(EXISTING.id), "B: snapshot result is still present");
  assert(
    searchFetchCount === fetchesAfterSnapshot,
    `B: no search re-fetch happened (got ${searchFetchCount}, expected ${fetchesAfterSnapshot})`,
  );

  console.log("— C. non-matching SSE messages are ignored —");
  const baseMsg = (over: Record<string, unknown>) => ({
    id: "msg-nomatch",
    channelId: CH_GENERAL.id,
    userId: "user-bob",
    parentId: null,
    content: "alpha",
    contentType: "text",
    editedAt: null,
    deletedAt: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    user: null,
    ...over,
  });
  await act(async () => {
    // wrong channel
    emitSse("comms:message", {
      channelId: CH_OTHER.id,
      message: baseMsg({ id: "msg-wrong-channel", channelId: CH_OTHER.id }),
    });
    // missing free-text term
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: baseMsg({ id: "msg-no-term", content: "beta only, no match" }),
    });
    // contains excluded term
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: baseMsg({ id: "msg-excluded", content: "alpha but junk too" }),
    });
  });
  await flush(2);
  const idsC = resultIds();
  assert(!idsC.includes("msg-wrong-channel"), "C: wrong-channel message ignored");
  assert(!idsC.includes("msg-no-term"), "C: message without the term ignored");
  assert(!idsC.includes("msg-excluded"), "C: message with excluded term ignored");

  console.log("— D. edit updates the row in-place / drops non-matching edits —");
  await act(async () => {
    emitSse("comms:message_edit", {
      channelId: CH_GENERAL.id,
      messageId: "msg-live-1",
      content: "edited alpha content",
      editedAt: new Date().toISOString(),
    });
  });
  await flush(2);
  const liveRow = $(`msg-result-msg-live-1`);
  assert(liveRow, "D: edited row still present");
  assert(
    liveRow!.textContent!.includes("edited alpha content"),
    "D: edited content rendered in-place",
  );
  // Edit the snapshot row so it no longer matches "alpha" — it must drop.
  await act(async () => {
    emitSse("comms:message_edit", {
      channelId: CH_GENERAL.id,
      messageId: EXISTING.id,
      content: "no longer relevant",
      editedAt: new Date().toISOString(),
    });
  });
  await flush(2);
  assert(!$(`msg-result-${EXISTING.id}`), "D: row whose edit removed the term is dropped");

  console.log("— E. delete removes the row —");
  await act(async () => {
    emitSse("comms:message_delete", {
      channelId: CH_GENERAL.id,
      messageId: "msg-live-1",
      deletedAt: new Date().toISOString(),
    });
  });
  await flush(2);
  assert(!$(`msg-result-msg-live-1`), "E: deleted live row removed from results");

  console.log("— F. from: and date filters gate live-added results —");
  // Clear the current query, then apply the seeded from:/date query.
  const clearBtn = $("search-panel-clear");
  assert(clearBtn, "F: clear button present");
  await act(async () => {
    clearBtn!.click();
  });
  await flush();
  const recentFrom = $(`recent-search-${QUERY_FROM_DATES}`);
  assert(recentFrom, "F: seeded from:/date recent search renders");
  await act(async () => {
    recentFrom!.click();
  });
  await flush();
  assert($(`msg-result-${EXISTING.id}`), "F: snapshot result renders for new query");

  const inWindow = new Date("2026-07-20T12:00:00Z").toISOString();
  const beforeWindow = new Date("2025-12-01T12:00:00Z").toISOString();
  const afterWindow = new Date("2027-01-05T12:00:00Z").toISOString();
  await act(async () => {
    // Wrong sender (from:bob active, sender is alice) — must be ignored.
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: baseMsg({
        id: "msg-wrong-sender",
        userId: "user-alice",
        content: "alpha from the wrong person",
        createdAt: inWindow,
        user: { id: "user-alice", firstName: "Alice", lastName: "Ng" },
      }),
    });
    // Right sender but before the after: bound — must be ignored.
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: baseMsg({
        id: "msg-too-early",
        content: "alpha too early",
        createdAt: beforeWindow,
        user: { id: "user-bob", firstName: "Bob", lastName: "Lo" },
      }),
    });
    // Right sender but on/after the before: bound — must be ignored.
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: baseMsg({
        id: "msg-too-late",
        content: "alpha too late",
        createdAt: afterWindow,
        user: { id: "user-bob", firstName: "Bob", lastName: "Lo" },
      }),
    });
    // Right sender, inside the window — must be prepended.
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: baseMsg({
        id: "msg-in-window",
        content: "alpha right on time",
        createdAt: inWindow,
        user: { id: "user-bob", firstName: "Bob", lastName: "Lo" },
      }),
    });
  });
  await flush(2);
  const idsF = resultIds();
  assert(!idsF.includes("msg-wrong-sender"), "F: message from non-matching from: user ignored");
  assert(!idsF.includes("msg-too-early"), "F: message before the after: bound ignored");
  assert(!idsF.includes("msg-too-late"), "F: message past the before: bound ignored");
  assert(
    idsF[0] === "msg-in-window",
    `F: matching-sender in-window message prepended first (got ${idsF.join(",")})`,
  );

  console.log("— G. full-name from:First_Last query keeps gating live results —");
  // Task #3427: the autocomplete inserts from:Bob_Lo (underscore-joined full
  // name); resolveFilters must resolve it to user-bob so live SSE gating
  // keeps working for full-name searches.
  const clearBtnG = $("search-panel-clear");
  assert(clearBtnG, "G: clear button present");
  await act(async () => {
    clearBtnG!.click();
  });
  await flush();
  const recentFull = $(`recent-search-${QUERY_FROM_FULLNAME}`);
  assert(recentFull, "G: seeded full-name recent search renders");
  await act(async () => {
    recentFull!.click();
  });
  await flush();
  assert($(`msg-result-${EXISTING.id}`), "G: snapshot result renders for full-name query");
  const fetchesAfterFullName = searchFetchCount;

  await act(async () => {
    // Wrong sender (from:bob_lo active, sender is alice) — must be ignored.
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: baseMsg({
        id: "msg-fullname-wrong-sender",
        userId: "user-alice",
        content: "alpha from alice not bob",
        user: { id: "user-alice", firstName: "Alice", lastName: "Ng" },
      }),
    });
    // Matching sender — must be prepended live, without a re-fetch.
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: baseMsg({
        id: "msg-fullname-live",
        content: "alpha live from full-name match",
        user: { id: "user-bob", firstName: "Bob", lastName: "Lo" },
      }),
    });
  });
  await flush(2);
  const idsG = resultIds();
  assert(
    !idsG.includes("msg-fullname-wrong-sender"),
    "G: non-matching sender ignored under full-name from: filter",
  );
  assert(
    idsG[0] === "msg-fullname-live",
    `G: matching sender's message prepended live for from:bob_lo (got ${idsG.join(",")})`,
  );
  assert(
    searchFetchCount === fetchesAfterFullName,
    `G: live update needed no re-fetch (got ${searchFetchCount}, expected ${fetchesAfterFullName})`,
  );

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("search-panel-live-sse: ALL TESTS PASSED");
}

await main();
process.exit(0);
