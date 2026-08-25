/* test-registration
{
  "name": "IntelligenceFeed archive-entry ConfirmActionDialog (controlled) — archive opens only, cancel fires nothing, confirm PATCHes /api/clients/:id/intelligence-feed/:eid/archive (Task #4757)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4757: Task #4621 swapped IntelligenceFeed's archive-entry window.confirm() for the shared ConfirmActionDialog in CONTROLLED mode (archive lives inside entry cards, no wrappable trigger), and no test clicked the converted path — a per-surface wiring mistake (archiving straight from the card button, cancel not clearing the pending entry, or never firing on confirm) would ship unnoticed. Mounts the REAL IntelligenceFeed in jsdom with a fully stubbed fetch and a lifecycle-modeling AlertDialog shim, and pins the full sequence: dialog starts closed (no confirm button reachable), card archive opens it without firing a PATCH, cancel closes it AND clears the pending entry (confirm unreachable until reopened), reopen + confirm fires exactly one PATCH /api/clients/:id/intelligence-feed/:eid/archive (the old confirm() endpoint) and closes the dialog. Fast, DB-free, deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-intelligence-archive-setup.mjs"
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
 * #4621) on IntelligenceFeed's archive-entry action actually gates the
 * mutation:
 *
 *   (A) with no pending archive the dialog is CLOSED — no confirm button is
 *       reachable at all;
 *   (B) clicking an entry card's archive button opens the dialog and fires
 *       NO write (the old window.confirm() path archived straight from this
 *       click);
 *   (C) clicking Cancel fires NO write, closes the dialog, and clears the
 *       pending entry — the confirm button is gone until reopened;
 *   (D) reopening via the card archive and clicking confirm fires exactly
 *       ONE PATCH /api/clients/:id/intelligence-feed/:eid/archive — the same
 *       endpoint the old confirm() path used — and the dialog closes again.
 *
 * The Radix AlertDialog is shimmed with the LIFECYCLE shim (content renders
 * only while open; Trigger/Cancel/Action drive onOpenChange — see the setup
 * file); the ConfirmActionDialog wiring, the pendingArchive state, and
 * archiveMutation are the real code. The create/edit Dialog and filter
 * Selects stay closed throughout.
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
// Fixtures + fetch stub with a write recorder
// ---------------------------------------------------------------------------

const CLIENT_ID = "c-4757";
const ENTRY_ID = "if-4757";
const CEO_ID = "u-ceo-4757";

const NOW_ISO = new Date().toISOString();

const ENTRY = {
  id: ENTRY_ID,
  clientId: CLIENT_ID,
  createdBy: CEO_ID,
  entryType: "strategy_insight",
  title: "Q3 positioning insight",
  body: "Short body.",
  tags: null,
  sourceReferences: null,
  aiConfidence: null,
  status: "approved",
  pinned: false,
  linkedActionLogIds: null,
  linkedCommandPanelFields: null,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const CURRENT_USER = {
  id: CEO_ID,
  firstName: "Cee",
  lastName: "Oh",
  email: "ceo@example.test",
  role: "ceo",
};

const writeCalls: Array<{ method: string; url: string }> = [];

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    {
      test: (_url: string, method: string) => method !== "GET",
      respond: ({ url, method, jsonResponse }: any) => {
        writeCalls.push({ method, url });
        return jsonResponse(200, { ok: true });
      },
    },
    { path: `/api/clients/${CLIENT_ID}/intelligence-feed`, json: [ENTRY] },
    { path: "/api/users", json: [CURRENT_USER] },
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
const IntelligenceFeed = (await import("../../client/src/components/IntelligenceFeed")).default;

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
        React.createElement(IntelligenceFeed, {
          clientId: CLIENT_ID,
          currentUser: CURRENT_USER,
        }),
      ),
    );
  });
  await flush(12);

  assert($(`card-intelligence-entry-${ENTRY_ID}`), "the entry card must render from the stubbed payload");

  // ── A. dialog starts CLOSED: no confirm button anywhere ───────────────────
  assert(
    !$("dialog-confirm-archive-entry-confirm"),
    "A: with no pending entry the dialog must be closed — no confirm button in the DOM",
  );
  console.log("  ✓ A: dialog starts closed (no confirm button reachable)");

  // ── B. card archive click opens the dialog, fires no write ────────────────
  const archiveBtn = $(`button-archive-entry-${ENTRY_ID}`);
  assert(archiveBtn, "B: archive button renders for a CEO on a non-archived entry");
  await click(archiveBtn!);
  assert(
    writeCalls.length === 0,
    `B: clicking the card archive must fire NO write (old confirm() path archived here) — got ${JSON.stringify(writeCalls)}`,
  );
  assert(
    $("dialog-confirm-archive-entry-confirm"),
    "B: the dialog must now be open (confirm button rendered)",
  );
  console.log("  ✓ B: card archive opens the dialog without firing a write");

  // ── C. cancel closes + clears the pending entry, fires nothing ────────────
  const cancel = $("dialog-confirm-archive-entry-cancel");
  assert(cancel, "C: dialog cancel button is queryable while open");
  await click(cancel!);
  assert(
    writeCalls.length === 0,
    `C: Cancel must fire NO write — got ${JSON.stringify(writeCalls)}`,
  );
  assert(
    !$("dialog-confirm-archive-entry-confirm"),
    "C: Cancel must CLOSE the dialog (onOpenChange(false) clears the pending entry) — confirm button must be gone until reopened",
  );
  console.log("  ✓ C: cancel fires nothing, closes the dialog, and clears the pending entry");

  // ── D. reopen, confirm fires exactly one PATCH, dialog closes again ───────
  await click($(`button-archive-entry-${ENTRY_ID}`)!);
  const confirm = $("dialog-confirm-archive-entry-confirm");
  assert(confirm, "D: reopening via the card archive renders the confirm button again");
  await click(confirm!);
  assert(
    writeCalls.length === 1,
    `D: confirm must fire exactly ONE write — got ${JSON.stringify(writeCalls)}`,
  );
  assert(
    writeCalls[0].method === "PATCH" &&
      writeCalls[0].url.endsWith(`/api/clients/${CLIENT_ID}/intelligence-feed/${ENTRY_ID}/archive`),
    `D: write must be PATCH /api/clients/${CLIENT_ID}/intelligence-feed/${ENTRY_ID}/archive (the pre-#4621 confirm() endpoint) — got ${JSON.stringify(writeCalls[0])}`,
  );
  assert(
    !$("dialog-confirm-archive-entry-confirm"),
    "D: confirming must close the dialog and clear the pending entry (confirm button gone)",
  );
  console.log("  ✓ D: reopen + confirm fires exactly one PATCH and closes the dialog");

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-intelligence-archive: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
