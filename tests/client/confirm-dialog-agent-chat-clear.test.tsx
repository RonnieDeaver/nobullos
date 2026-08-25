/* test-registration
{
  "name": "ClientAgentChat clear-chat ConfirmActionDialog (trigger mode) — trigger opens only, cancel fires nothing, confirm DELETEs /api/clients/:id/agent-chat (Task #4757)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4757: Task #4621 swapped ClientAgentChat's clear-chat window.confirm() for the shared ConfirmActionDialog in TRIGGER mode, and no test clicked the converted path — a per-surface wiring mistake (clearing straight from the trigger click, or never firing on confirm) would ship unnoticed. Mounts the REAL ClientAgentChat in jsdom with a fully stubbed fetch and a lifecycle-modeling AlertDialog shim, and pins the full sequence: dialog starts closed, trigger click opens it without firing a DELETE, cancel closes it without firing (confirm unreachable until reopened), reopen + confirm fires exactly one DELETE /api/clients/:id/agent-chat (the old confirm() endpoint) and closes the dialog. Fast, DB-free, deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-agent-chat-clear-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4757 — the TRIGGER-mode ConfirmActionDialog conversion (Task #4621)
 * on ClientAgentChat's clear-chat action actually gates the mutation:
 *
 *   (A) the dialog starts CLOSED (no confirm button reachable); clicking the
 *       "Clear Chat" trigger opens it and fires NO DELETE (the old
 *       window.confirm() path cleared straight from this click);
 *   (B) clicking Cancel fires NO DELETE and closes the dialog — the confirm
 *       button is gone until the trigger is clicked again;
 *   (C) reopening via the trigger and clicking confirm fires exactly ONE
 *       DELETE /api/clients/:id/agent-chat — the same endpoint the old
 *       confirm() path used — and the dialog closes again.
 *
 * The Radix AlertDialog is shimmed with the LIFECYCLE shim (content renders
 * only while open; Trigger/Cancel/Action drive the open state — see the
 * setup file); the ConfirmActionDialog wiring and clearMutation are the
 * real code. The messages query has no inline queryFn
 * (it rides the app's default), so the test QueryClient supplies a default
 * queryFn that fetches the queryKey URL — the trigger is disabled until at
 * least one message loads.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/clients/c-4757" },
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
(globalThis as any).location = dom.window.location;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
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

// ---------------------------------------------------------------------------
// Fixtures + fetch stub with a DELETE recorder
// ---------------------------------------------------------------------------

const CLIENT_ID = "c-4757";

const MESSAGES = [
  {
    id: "msg-4757",
    clientId: CLIENT_ID,
    role: "user",
    content: "What changed last month?",
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
        return jsonResponse(200, { ok: true });
      },
    },
    { method: "GET", path: `/api/clients/${CLIENT_ID}/agent-chat`, json: MESSAGES },
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
const ClientAgentChat = (await import("../../client/src/components/ClientAgentChat")).default;

function $(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}

async function flush(times = 8): Promise<void> {
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
  await flush(4);
}

async function main(): Promise<void> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        // ClientAgentChat's messages query has no inline queryFn — mirror the
        // app's default "fetch the queryKey URL" behavior.
        queryFn: async ({ queryKey }: any) => {
          const res = await fetch(String(queryKey[0]), { credentials: "include" });
          if (!res.ok) throw new Error(`${res.status}`);
          return res.json();
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(ClientAgentChat, { clientId: CLIENT_ID }),
      ),
    );
  });
  await flush(12);

  const trigger = $("button-clear-chat");
  assert(trigger, "the Clear Chat trigger must render");
  assert(
    !(trigger as HTMLButtonElement).disabled,
    "the Clear Chat trigger must be enabled once the stubbed message loads (it is disabled at 0 messages)",
  );

  // ── A. dialog starts CLOSED, trigger click opens it without a DELETE ──────
  assert(
    !$("dialog-confirm-clear-chat-confirm"),
    "A: before the trigger is clicked the dialog must be closed — no confirm button in the DOM",
  );
  await click(trigger!);
  assert(
    deleteCalls.length === 0,
    `A: clicking the trigger must fire NO DELETE (old confirm() path cleared here) — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    $("dialog-confirm-clear-chat-confirm"),
    "A: the dialog must now be open (confirm button rendered)",
  );
  console.log("  ✓ A: trigger opens the dialog without firing a DELETE");

  // ── B. cancel closes the dialog, fires nothing ─────────────────────────────
  const cancel = $("dialog-confirm-clear-chat-cancel");
  assert(cancel, "B: dialog cancel button is queryable while open");
  await click(cancel!);
  assert(
    deleteCalls.length === 0,
    `B: Cancel must fire NO DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    !$("dialog-confirm-clear-chat-confirm"),
    "B: Cancel must CLOSE the dialog — confirm button must be gone until the trigger is clicked again",
  );
  console.log("  ✓ B: cancel fires nothing and closes the dialog");

  // ── C. reopen, confirm fires exactly one DELETE, dialog closes again ──────
  await click($("button-clear-chat")!);
  const confirm = $("dialog-confirm-clear-chat-confirm");
  assert(confirm, "C: reopening via the trigger renders the confirm button again");
  await click(confirm!);
  assert(
    deleteCalls.length === 1,
    `C: confirm must fire exactly ONE DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    deleteCalls[0].endsWith(`/api/clients/${CLIENT_ID}/agent-chat`),
    `C: DELETE must hit /api/clients/${CLIENT_ID}/agent-chat (the pre-#4621 confirm() endpoint) — got ${deleteCalls[0]}`,
  );
  assert(
    !$("dialog-confirm-clear-chat-confirm"),
    "C: confirming must close the dialog (confirm button gone)",
  );
  console.log("  ✓ C: reopen + confirm fires exactly one DELETE and closes the dialog");

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-agent-chat-clear: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
