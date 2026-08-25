/* test-registration
{
  "name": "ChannelInfoSheet kick-member ConfirmActionDialog (controlled) — kick opens only, cancel fires nothing, confirm DELETEs /api/comms/channels/:id/members/:uid (Task #4757)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4757: Task #4621 swapped ChannelInfoSheet's remove-member window.confirm() for the shared ConfirmActionDialog in CONTROLLED mode (kick lives inside member rows, no wrappable trigger), and no test clicked the converted path — a per-surface wiring mistake (kicking straight from the row button, cancel not clearing the pending member, or never firing on confirm) would ship unnoticed. Mounts the REAL ChannelInfoSheet in jsdom with a fully stubbed fetch + stubbed Clerk and a lifecycle-modeling AlertDialog shim, and pins the full sequence: dialog starts closed (no confirm button reachable), row kick opens it without firing a DELETE, cancel closes it AND clears the pending member (confirm unreachable until reopened), reopen + confirm fires exactly one DELETE /api/comms/channels/:id/members/:uid (the old confirm() endpoint) and closes the dialog. Fast, DB-free, deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-channel-info-kick-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4757 — the CONTROLLED-mode ConfirmActionDialog conversion (Task
 * #4621) on ChannelInfoSheet's kick-member action actually gates the
 * mutation:
 *
 *   (A) with no pending kick the dialog is CLOSED — no confirm button is
 *       reachable at all;
 *   (B) clicking a member row's kick button opens the dialog and fires NO
 *       DELETE (the old window.confirm() path kicked straight from this
 *       click);
 *   (C) clicking Cancel fires NO DELETE, closes the dialog, and clears the
 *       pending member — the confirm button is gone until reopened;
 *   (D) reopening via the row kick and clicking confirm fires exactly ONE
 *       DELETE /api/comms/channels/:id/members/:uid — the same endpoint the
 *       old confirm() path used — and the dialog closes again.
 *
 * The Radix AlertDialog is shimmed with the LIFECYCLE shim (content renders
 * only while open; Trigger/Cancel/Action drive onOpenChange) and Clerk is
 * stubbed (see the setup file); the ConfirmActionDialog wiring,
 * pendingKickUid state, and handleKick are the real code. Admin-ness comes
 * from the member roster (the current user is the channel owner), not the
 * team-lead shortcut.
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
(globalThis as any).location = dom.window.location;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
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

// ---------------------------------------------------------------------------
// Fixtures + fetch stub with a DELETE recorder
// ---------------------------------------------------------------------------

const CHANNEL_ID = "ch-4757-kick";
const SELF_UID = "user-self-4757";
const TARGET_UID = "user-target-4757";

const CHANNEL = {
  id: CHANNEL_ID,
  name: "ops",
  slug: "ops",
  type: "channel",
  visibility: "public",
  topic: null,
  description: null,
  archivedAt: null,
  createdBy: SELF_UID,
  createdAt: new Date().toISOString(),
};

const MEMBERS = [
  {
    userId: SELF_UID,
    channelId: CHANNEL_ID,
    role: "owner",
    user: { id: SELF_UID, firstName: "Op", lastName: "Owner", email: "owner@example.test" },
  },
  {
    userId: TARGET_UID,
    channelId: CHANNEL_ID,
    role: "member",
    user: { id: TARGET_UID, firstName: "Kick", lastName: "Target", email: "target@example.test" },
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
    { path: `/api/comms/channels/${CHANNEL_ID}/members`, json: MEMBERS },
    { path: `/api/comms/channels/${CHANNEL_ID}/stats`, json: { memberCount: 2, messageCount: 5 } },
    // useAuth()'s DB-user probe (role irrelevant — roster drives admin-ness).
    { path: "/api/auth/user", json: { id: SELF_UID, email: "owner@example.test", role: "account_manager" } },
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
const { ChannelInfoSheet } = await import("../../client/src/components/comms/ChannelInfoSheet");

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
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc } as any,
        React.createElement(ChannelInfoSheet, {
          channel: CHANNEL,
          currentUserId: SELF_UID,
          onClose: () => {},
          onChannelUpdated: () => {},
        }),
      ),
    );
  });
  await flush(12);

  assert($(`member-row-${TARGET_UID}`), "the target member row must render from the stubbed roster");

  // ── A. dialog starts CLOSED: no confirm button anywhere ───────────────────
  assert(
    !$("dialog-confirm-kick-member-confirm"),
    "A: with no pending member the dialog must be closed — no confirm button in the DOM",
  );
  console.log("  ✓ A: dialog starts closed (no confirm button reachable)");

  // ── B. row kick click opens the dialog, fires no DELETE ───────────────────
  const kick = $(`member-kick-${TARGET_UID}`);
  assert(kick, "B: kick button renders for a channel owner on a non-self member row");
  await click(kick!);
  assert(
    deleteCalls.length === 0,
    `B: clicking the row kick must fire NO DELETE (old confirm() path kicked here) — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    $("dialog-confirm-kick-member-confirm"),
    "B: the dialog must now be open (confirm button rendered)",
  );
  console.log("  ✓ B: row kick opens the dialog without firing a DELETE");

  // ── C. cancel closes + clears the pending member, fires nothing ───────────
  const cancel = $("dialog-confirm-kick-member-cancel");
  assert(cancel, "C: dialog cancel button is queryable while open");
  await click(cancel!);
  assert(
    deleteCalls.length === 0,
    `C: Cancel must fire NO DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    !$("dialog-confirm-kick-member-confirm"),
    "C: Cancel must CLOSE the dialog (onOpenChange(false) clears the pending member) — confirm button must be gone until reopened",
  );
  console.log("  ✓ C: cancel fires nothing, closes the dialog, and clears the pending member");

  // ── D. reopen, confirm fires exactly one DELETE, dialog closes again ──────
  await click($(`member-kick-${TARGET_UID}`)!);
  const confirm = $("dialog-confirm-kick-member-confirm");
  assert(confirm, "D: reopening via the row kick renders the confirm button again");
  await click(confirm!);
  assert(
    deleteCalls.length === 1,
    `D: confirm must fire exactly ONE DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    deleteCalls[0].endsWith(`/api/comms/channels/${CHANNEL_ID}/members/${TARGET_UID}`),
    `D: DELETE must hit /api/comms/channels/${CHANNEL_ID}/members/${TARGET_UID} (the pre-#4621 confirm() endpoint) — got ${deleteCalls[0]}`,
  );
  assert(
    !$("dialog-confirm-kick-member-confirm"),
    "D: confirming must close the dialog and clear the pending member (confirm button gone)",
  );
  console.log("  ✓ D: reopen + confirm fires exactly one DELETE and closes the dialog");

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-channel-info-kick: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
