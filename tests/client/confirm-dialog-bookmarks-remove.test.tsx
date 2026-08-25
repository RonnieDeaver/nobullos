/* test-registration
{
  "name": "BookmarksBar remove-bookmark ConfirmActionDialog (controlled) — chip delete opens only, cancel fires nothing, confirm DELETEs /api/comms/channels/:id/bookmarks/:bid (Task #4757)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4757: Task #4621 swapped BookmarksBar's remove-bookmark window.confirm() for the shared ConfirmActionDialog in CONTROLLED mode (delete lives inside chips, no wrappable trigger), and no test clicked the converted path — a per-surface wiring mistake (deleting straight from the chip, cancel not clearing the pending bookmark, or never firing on confirm) would ship unnoticed. Mounts the REAL BookmarksBar in jsdom with a fully stubbed fetch and a lifecycle-modeling AlertDialog shim, and pins the full sequence: dialog starts closed (no confirm button reachable), chip delete opens it without firing a DELETE, cancel closes it AND clears the pending bookmark (confirm unreachable until reopened), reopen + confirm fires exactly one DELETE /api/comms/channels/:id/bookmarks/:bid (the old confirm() endpoint) and closes the dialog. Fast, DB-free, deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-bookmarks-remove-setup.mjs"
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
 * #4621) on BookmarksBar's remove-bookmark action actually gates the
 * mutation:
 *
 *   (A) with no pending delete the dialog is CLOSED — no confirm button is
 *       reachable at all;
 *   (B) clicking the chip's delete button opens the dialog and fires NO
 *       DELETE (the old window.confirm() path deleted straight from this
 *       click);
 *   (C) clicking Cancel fires NO DELETE, closes the dialog, and clears the
 *       pending bookmark — the confirm button is gone until reopened;
 *   (D) reopening via the chip delete and clicking confirm fires exactly ONE
 *       DELETE /api/comms/channels/:id/bookmarks/:bid — the same endpoint
 *       the old confirm() path used — and the dialog closes again.
 *
 * The Radix AlertDialog is shimmed with the LIFECYCLE shim (content renders
 * only while open; Trigger/Cancel/Action drive onOpenChange — see the setup
 * file); the ConfirmActionDialog wiring, the pendingDelete state, and
 * performDelete are the real code.
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

const CHANNEL_ID = "ch-4757-bookmarks";
const BOOKMARK_ID = "bm-4757";

const BOOKMARKS = [
  {
    id: BOOKMARK_ID,
    channelId: CHANNEL_ID,
    type: "link",
    label: "Runbook",
    url: "https://example.test/runbook",
    emoji: null,
    objectKey: null,
    filename: null,
    sortOrder: 0,
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
    { path: `/api/comms/channels/${CHANNEL_ID}/bookmarks`, json: BOOKMARKS },
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
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");
const { BookmarksBar } = await import("../../client/src/components/comms/BookmarksBar");

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
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(BookmarksBar, {
            channelId: CHANNEL_ID,
            isChannelAdmin: true,
            isArchived: false,
          }),
        ),
      ),
    );
  });
  await flush(12);

  assert($(`bookmark-chip-${BOOKMARK_ID}`), "the bookmark chip must render from the stubbed payload");

  // ── A. dialog starts CLOSED: no confirm button anywhere ───────────────────
  assert(
    !$("dialog-confirm-remove-bookmark-confirm"),
    "A: with no pending bookmark the dialog must be closed — no confirm button in the DOM",
  );
  console.log("  ✓ A: dialog starts closed (no confirm button reachable)");

  // ── B. chip delete click opens the dialog, fires no DELETE ────────────────
  const chipDelete = $(`bookmark-delete-${BOOKMARK_ID}`);
  assert(chipDelete, "B: chip delete button renders for a channel admin");
  await click(chipDelete!);
  assert(
    deleteCalls.length === 0,
    `B: clicking the chip delete must fire NO DELETE (old confirm() path deleted here) — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    $("dialog-confirm-remove-bookmark-confirm"),
    "B: the dialog must now be open (confirm button rendered)",
  );
  console.log("  ✓ B: chip delete opens the dialog without firing a DELETE");

  // ── C. cancel closes + clears the pending bookmark, fires nothing ─────────
  const cancel = $("dialog-confirm-remove-bookmark-cancel");
  assert(cancel, "C: dialog cancel button is queryable while open");
  await click(cancel!);
  assert(
    deleteCalls.length === 0,
    `C: Cancel must fire NO DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    !$("dialog-confirm-remove-bookmark-confirm"),
    "C: Cancel must CLOSE the dialog (onOpenChange(false) clears pendingDelete) — confirm button must be gone until reopened",
  );
  console.log("  ✓ C: cancel fires nothing, closes the dialog, and clears the pending bookmark");

  // ── D. reopen, confirm fires exactly one DELETE, dialog closes again ──────
  await click($(`bookmark-delete-${BOOKMARK_ID}`)!);
  const confirm = $("dialog-confirm-remove-bookmark-confirm");
  assert(confirm, "D: reopening via the chip delete renders the confirm button again");
  await click(confirm!);
  assert(
    deleteCalls.length === 1,
    `D: confirm must fire exactly ONE DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    deleteCalls[0].endsWith(`/api/comms/channels/${CHANNEL_ID}/bookmarks/${BOOKMARK_ID}`),
    `D: DELETE must hit /api/comms/channels/${CHANNEL_ID}/bookmarks/${BOOKMARK_ID} (the pre-#4621 confirm() endpoint) — got ${deleteCalls[0]}`,
  );
  assert(
    !$("dialog-confirm-remove-bookmark-confirm"),
    "D: confirming must close the dialog and clear the pending bookmark (confirm button gone)",
  );
  console.log("  ✓ D: reopen + confirm fires exactly one DELETE and closes the dialog");

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-bookmarks-remove: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
