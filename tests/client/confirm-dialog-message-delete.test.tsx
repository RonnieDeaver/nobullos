/* test-registration
{
  "name": "MessagePane delete-message ConfirmActionDialog (controlled) — menu opens only, cancel fires nothing, confirm DELETEs /api/comms/messages/:id once (Task #4636)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4636: Task #4621 swapped MessagePane's delete-message window.confirm() for the shared ConfirmActionDialog in CONTROLLED mode (delete fires from the hover-menu callback, no wrappable trigger). No test clicked that path, so a dialog that deletes straight from the menu item, fires with no pending id, or double-fires after confirm would ship unnoticed. Mounts the REAL MessagePane against a stubbed fetch and pins: menu Delete fires no DELETE, cancel fires no DELETE, confirm fires exactly one DELETE /api/comms/messages/:id and clears the pending id (a second confirm click fires nothing). Fast, DB-free, deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-message-delete-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4636 — the CONTROLLED-mode ConfirmActionDialog conversion (Task
 * #4621) on MessagePane's delete-message action actually gates the mutation:
 *
 *   (A) with no pending delete, clicking the (shim-rendered) confirm button
 *       fires NO DELETE — the onConfirm guard requires a pendingDeleteId;
 *   (B) clicking the hover-menu Delete item fires NO DELETE (the old
 *       window.confirm() path deleted straight from this click);
 *   (C) clicking Cancel fires NO DELETE;
 *   (D) clicking confirm fires exactly ONE DELETE /api/comms/messages/:id —
 *       the same endpoint the old confirm() path used — and clears the
 *       pending id, so a second confirm click fires nothing.
 *
 * Radix AlertDialog + DropdownMenu are shimmed (their portals never mount in
 * this raw jsdom harness — see the setup file); the ConfirmActionDialog
 * wiring, pendingDeleteId state, and performDelete are the real code.
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
// Fixtures + fetch stub with a DELETE recorder
// ---------------------------------------------------------------------------

const CHANNEL_ID = "ch-del-4636";
const MESSAGE_ID = "msg-del-4636";

const CHANNEL = {
  id: CHANNEL_ID,
  name: "general",
  slug: "general",
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

const MESSAGES = [
  {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    userId: USER.id,
    user: { id: USER.id, firstName: "Test", lastName: "CEO", email: USER.email, profileImageUrl: null },
    content: "message to delete",
    contentType: "text",
    parentId: null,
    replyCount: 0,
    reactionCounts: {},
    attachments: [],
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  },
];

const deleteCalls: string[] = [];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      method: "DELETE",
      respond: ({ url, jsonResponse }: any) => {
        deleteCalls.push(url);
        return jsonResponse(200, {});
      },
    },
    { path: "/api/auth/user", json: USER },
    { method: "GET", path: `/api/comms/channels/${CHANNEL_ID}/messages`, json: MESSAGES },
    { method: "GET", path: /\/api\/comms\/channels(\?|$)/, json: [CHANNEL] },
    { method: "GET", path: /\/api\/comms\/emoji(\?|$)/, json: [] },
    { method: "POST", path: /\/api\/comms\/presence\/heartbeat$/, json: { ok: true } },
    { method: "POST", path: /\/api\/comms\/channels\/[^/]+\/read-state$/, json: { ok: true } },
  ],
  defaultJson: {},
}) as any;

// ---------------------------------------------------------------------------
// Mount — MessagePane as client/src/pages/Comms.tsx mounts it
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

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(3);
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
  await flush(10);

  assert($(`comms-message-${MESSAGE_ID}`), "message renders via the real MessagePane/MessageItem path");

  const confirmBtn = $("dialog-confirm-delete-message-confirm");
  const cancelBtn = $("dialog-confirm-delete-message-cancel");
  assert(confirmBtn, "controlled ConfirmActionDialog confirm button is queryable (shim renders content)");
  assert(cancelBtn, "controlled ConfirmActionDialog cancel button is queryable");

  // ── A. confirm with no pending delete fires nothing ───────────────────────
  await click(confirmBtn!);
  assert(
    deleteCalls.length === 0,
    `A: confirm with no pendingDeleteId must fire NO DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  console.log("  ✓ A: confirm without a pending delete fires nothing");

  // ── B. hover-menu Delete item fires no DELETE ──────────────────────────────
  const deleteItem = $(`delete-msg-${MESSAGE_ID}`);
  assert(deleteItem, "B: hover-menu Delete item is queryable (dropdown shim)");
  await click(deleteItem!);
  assert(
    deleteCalls.length === 0,
    `B: menu Delete click must fire NO DELETE (old confirm() path deleted here) — got ${JSON.stringify(deleteCalls)}`,
  );
  console.log("  ✓ B: menu Delete only stages the pending delete, no DELETE fired");

  // ── C. cancel fires nothing ────────────────────────────────────────────────
  await click(cancelBtn!);
  assert(
    deleteCalls.length === 0,
    `C: Cancel must fire NO DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  console.log("  ✓ C: cancel fires nothing");

  // ── D. confirm fires exactly one DELETE, then clears the pending id ───────
  await click(confirmBtn!);
  assert(
    deleteCalls.length === 1,
    `D: confirm must fire exactly ONE DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    deleteCalls[0].endsWith(`/api/comms/messages/${MESSAGE_ID}`),
    `D: DELETE must hit /api/comms/messages/${MESSAGE_ID} (the pre-#4621 confirm() endpoint) — got ${deleteCalls[0]}`,
  );
  // pendingDeleteId is cleared by onConfirm — a second confirm click is a no-op.
  await click(confirmBtn!);
  assert(
    deleteCalls.length === 1,
    `D: a second confirm click after the pending id cleared must fire NOTHING — got ${JSON.stringify(deleteCalls)}`,
  );
  console.log(`  ✓ D: confirm fires exactly one DELETE /api/comms/messages/${MESSAGE_ID}, second click is a no-op`);

  await act(async () => {
    root.unmount();
  });
  queryClient.clear();

  console.log("\nconfirm-dialog-message-delete: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
