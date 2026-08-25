/* test-registration
{
  "name": "Comms SearchPanel Files tab — live SSE attachment prepend + message-delete removal keeps file results current (Task #3311)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3311: SearchPanel Files tab live SSE overlay — comms:message events carrying an attachment whose filename matches the active query prepend to the Files results without a re-fetch (channel/uploader/term scoping enforced), and comms:message_delete removes the deleted message's files (live-prepended AND snapshot rows). Rendered jsdom test mounting the real CommsProvider + SearchPanel; DB-free, network-free (fetch stubbed).",
  "extraNodeArgs": [
    "--import",
    "./tests/client/search-panel-files-live-sse-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3311 — SearchPanel Files tab stays current when new files arrive
 * via SSE.
 *
 * Mounts the REAL CommsProvider + SearchPanel in jsdom with a controllable
 * EventSource stub and proves:
 *
 *   (A) submitting a query + switching to the Files tab renders the fetched
 *       file snapshot;
 *   (B) a comms:message SSE event carrying an attachment whose filename
 *       matches the active query is PREPENDED to the Files results without a
 *       re-fetch of the file-search endpoint;
 *   (C) non-matching attachments (wrong channel, filename without the term)
 *       are ignored;
 *   (D) comms:message_delete removes the deleted message's files from the
 *       results — both live-prepended and snapshot rows.
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

// Controllable EventSource stub.
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
  id: "ch-general-3311",
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
const CH_OTHER = { ...CH_GENERAL, id: "ch-other-3311", name: "random", slug: "random" };
const CHANNELS = [CH_GENERAL, CH_OTHER];

const EXISTING_FILE = {
  id: "att-existing-1",
  messageId: "msg-file-existing",
  channelId: CH_GENERAL.id,
  objectKey: "comms-attachments/existing.pdf",
  filename: "report-snapshot.pdf",
  contentType: "application/pdf",
  sizeBytes: 1024,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  uploadedBy: "user-alice",
  uploaderFirstName: "Alice",
  uploaderLastName: "Ng",
  channelName: "general",
  channelSlug: "general",
  channelType: "channel",
  messageCreatedAt: new Date(Date.now() - 60_000).toISOString(),
};

const QUERY = "report in:general";
dom.window.localStorage.setItem(
  `comms_recent_searches_${USER.id}`,
  JSON.stringify([QUERY]),
);

let fileFetchCount = 0;

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: "/api/comms/channels", json: CHANNELS },
    { method: "GET", path: "/api/comms/users", json: [
      { id: "user-alice", firstName: "Alice", lastName: "Ng" },
      { id: "user-bob", firstName: "Bob", lastName: "Lo" },
    ] },
    {
      method: "GET",
      path: /\/api\/comms\/search\/files\?/,
      json: () => {
        fileFetchCount++;
        return [EXISTING_FILE];
      },
    },
    { method: "GET", path: /\/api\/comms\/search\?/, json: [] },
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

function fileResultIds(): string[] {
  return Array.from(
    document.querySelectorAll('[data-testid^="file-result-"]'),
  )
    .map((el) => el.getAttribute("data-testid")!)
    .filter((id) => !id.includes("-jump-") && !id.includes("-download-") && !id.includes("-thumb-"))
    .map((id) => id.replace("file-result-", ""));
}

function liveMessage(over: Record<string, unknown>) {
  return {
    id: "msg-live",
    channelId: CH_GENERAL.id,
    userId: "user-bob",
    parentId: null,
    content: "",
    contentType: "text",
    editedAt: null,
    deletedAt: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    user: { id: "user-bob", firstName: "Bob", lastName: "Lo" },
    ...over,
  };
}

function liveAttachment(over: Record<string, unknown>) {
  return {
    id: "att-live",
    messageId: "msg-live",
    objectKey: "comms-attachments/live.pdf",
    filename: "report-live.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
    uploadedBy: "user-bob",
    createdAt: new Date().toISOString(),
    ...over,
  };
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

  // Apply the query via the seeded recent-search entry, then switch to Files.
  const recent = $(`recent-search-${QUERY}`);
  assert(recent, "seeded recent search renders");
  await act(async () => {
    recent!.click();
  });
  await flush();

  const filesTrigger = $("tab-files");
  assert(filesTrigger, "Files tab trigger renders");
  await act(async () => {
    // Radix Tabs selects on mousedown (then focus); jsdom .click() alone
    // does not fire it, so dispatch the full sequence.
    filesTrigger!.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    (filesTrigger as HTMLElement).focus();
    filesTrigger!.dispatchEvent(
      new dom.window.MouseEvent("mouseup", { bubbles: true, button: 0 }),
    );
    filesTrigger!.click();
  });
  await flush();

  console.log("— A. file snapshot renders —");
  assert($(`file-result-${EXISTING_FILE.id}`), "A: fetched file snapshot renders");
  assert(fileFetchCount >= 1, "A: file-search endpoint was fetched");
  const fetchesAfterSnapshot = fileFetchCount;

  console.log("— B. matching SSE attachment is prepended without re-fetch —");
  await act(async () => {
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: liveMessage({ id: "msg-live-1" }),
      attachment: liveAttachment({ id: "att-live-1", messageId: "msg-live-1" }),
    });
  });
  await flush(2);
  const idsB = fileResultIds();
  assert(idsB[0] === "att-live-1", `B: live file is prepended first (got ${idsB.join(",")})`);
  assert(idsB.includes(EXISTING_FILE.id), "B: snapshot file is still present");
  assert(
    fileFetchCount === fetchesAfterSnapshot,
    `B: no file-search re-fetch happened (got ${fileFetchCount}, expected ${fetchesAfterSnapshot})`,
  );
  const liveRow = $(`file-result-att-live-1`);
  assert(liveRow!.textContent!.includes("report-live.pdf"), "B: live filename rendered");
  assert(liveRow!.textContent!.includes("Bob"), "B: uploader name from message.user rendered");
  assert(
    liveRow!.textContent!.includes("#general"),
    "B: live row shows the channel name label (· #general) like snapshot rows",
  );

  console.log("— C. non-matching attachments are ignored —");
  await act(async () => {
    // wrong channel
    emitSse("comms:message", {
      channelId: CH_OTHER.id,
      message: liveMessage({ id: "msg-wrong-ch", channelId: CH_OTHER.id }),
      attachment: liveAttachment({ id: "att-wrong-ch", messageId: "msg-wrong-ch" }),
    });
    // filename without the term
    emitSse("comms:message", {
      channelId: CH_GENERAL.id,
      message: liveMessage({ id: "msg-no-term" }),
      attachment: liveAttachment({
        id: "att-no-term",
        messageId: "msg-no-term",
        filename: "vacation-photo.png",
        contentType: "image/png",
      }),
    });
  });
  await flush(2);
  const idsC = fileResultIds();
  assert(!idsC.includes("att-wrong-ch"), "C: wrong-channel attachment ignored");
  assert(!idsC.includes("att-no-term"), "C: attachment whose filename lacks the term ignored");

  console.log("— D. message delete removes its files —");
  await act(async () => {
    emitSse("comms:message_delete", {
      channelId: CH_GENERAL.id,
      messageId: "msg-live-1",
      deletedAt: new Date().toISOString(),
    });
  });
  await flush(2);
  assert(!$(`file-result-att-live-1`), "D: deleted live message's file removed");
  // Snapshot rows are also removed when their message is deleted.
  await act(async () => {
    emitSse("comms:message_delete", {
      channelId: CH_GENERAL.id,
      messageId: EXISTING_FILE.messageId,
      deletedAt: new Date().toISOString(),
    });
  });
  await flush(2);
  assert(!$(`file-result-${EXISTING_FILE.id}`), "D: deleted snapshot message's file removed");

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("search-panel-files-live-sse: ALL TESTS PASSED");
}

await main();
process.exit(0);
