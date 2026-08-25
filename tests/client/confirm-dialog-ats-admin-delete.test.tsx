/* test-registration
{
  "name": "AtsAdmin delete-candidate ConfirmActionDialogs (kanban + detail, trigger mode) — triggers open only, cancel fires nothing, confirm DELETEs /api/ats/candidates/:id (Task #4757)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4757: Task #4621 swapped AtsAdmin's two delete-candidate window.confirm() calls (kanban card + detail panel) for the shared ConfirmActionDialog in TRIGGER mode, and no test clicked either converted path — a per-surface wiring mistake (deleting straight from the trigger click, or never firing on confirm) would ship unnoticed on the highest-blast-radius ATS action (irreversible candidate purge). Mounts the REAL AtsAdmin page in jsdom with a fully stubbed fetch + stubbed Clerk and a lifecycle-modeling AlertDialog shim, and pins the full sequence for BOTH dialogs: dialog starts closed, trigger click opens it without firing a DELETE, cancel closes it without firing (confirm unreachable until reopened), reopen + confirm fires exactly one DELETE /api/ats/candidates/:id (the old confirm() endpoint) and closes the dialog. Fast, DB-free, deterministic.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/confirm-dialog-ats-admin-delete-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "timeoutMs": 300000,
  "tier": "small"
}
test-registration */
/**
 * Task #4757 — the TRIGGER-mode ConfirmActionDialog conversions (Task #4621)
 * on AtsAdmin's two delete-candidate actions actually gate the mutation:
 *
 * Kanban card dialog (`dialog-confirm-delete-candidate-:id`):
 *   (A) the dialog starts CLOSED; clicking the card's Trash trigger opens it
 *       and fires NO DELETE (the old window.confirm() path deleted straight
 *       from this click);
 *   (B) clicking Cancel fires NO DELETE and closes the dialog — confirm is
 *       unreachable until the trigger is clicked again;
 *   (C) reopening and clicking confirm fires exactly ONE
 *       DELETE /api/ats/candidates/:id — the same endpoint the old confirm()
 *       path used — and the dialog closes again.
 *
 * Detail panel dialog (`dialog-confirm-detail-delete`, inside the Radix
 * Dialog the candidate card opens):
 *   (D) it starts CLOSED; clicking the detail delete trigger opens it and
 *       fires NO further DELETE;
 *   (E) clicking its Cancel fires NO further DELETE and closes it;
 *   (F) reopening and clicking its confirm fires exactly ONE more DELETE
 *       /api/ats/candidates/:id and closes it.
 *
 * The detail panel's Radix Dialog uses the plain inline dialog shim; the
 * AlertDialogs use the LIFECYCLE shim (content renders only while open;
 * Trigger/Cancel/Action drive the open state). Clerk is stubbed (see the
 * setup file); the ConfirmActionDialog wiring and deleteCandidateMutation
 * are the real code. The page mounts with a team_lead auth probe (AtsAdmin
 * renders an access-denied card for everyone else).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/admin/ats" },
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
(globalThis as any).location = dom.window.location;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).CustomEvent = dom.window.CustomEvent;
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

const JOB_ID = "job-4757";
const CANDIDATE_ID = "cand-4757";

const TEAM_LEAD = {
  id: "u-tl-4757",
  email: "lead@example.test",
  firstName: "Team",
  lastName: "Lead",
  role: "team_lead",
};

const JOB = {
  id: JOB_ID,
  title: "AM — Growth",
  status: "active",
  description: null,
  scorecardJson: null,
  formJson: null,
  createdAt: new Date().toISOString(),
};

const CANDIDATE = {
  id: CANDIDATE_ID,
  jobId: JOB_ID,
  name: "Dee Candidate",
  email: "dee@example.test",
  phone: null,
  stage: "invited",
  notes: null,
  portalToken: "tok-4757",
  riskTier: null,
  totalScore: null,
  calibratedScore: null,
  finalDisplayScore: null,
  cohortRank: null,
  cohortSize: null,
  evidenceStageCount: null,
  aiScoreJson: null,
  createdAt: new Date().toISOString(),
};

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
    { path: "/api/auth/user", json: TEAM_LEAD },
    // Cursor-paginated ATS lists (candidates route must precede the jobs
    // prefix route — both start with /api/ats/jobs).
    { path: new RegExp(`/api/ats/jobs/${JOB_ID}/candidates`), json: { candidates: [CANDIDATE], nextCursor: null } },
    { path: new RegExp(`/api/ats/jobs/${JOB_ID}/submissions`), json: { submissions: [], nextCursor: null } },
    { path: new RegExp(`/api/ats/jobs/${JOB_ID}/interviews`), json: { interviews: [], nextCursor: null } },
    { path: /\/api\/ats\/jobs(\?|$)/, json: { jobs: [JOB], nextCursor: null } },
    { path: new RegExp(`/api/ats/candidates/${CANDIDATE_ID}/interviews`), json: [] },
    { path: new RegExp(`/api/ats/candidates/${CANDIDATE_ID}/final-decision`), json: null },
    { path: /\/api\/ats\/candidates\/[^/]+\/submission/, json: null },
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
const AtsAdmin = (await import("../../client/src/pages/AtsAdmin")).default;

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
        React.createElement(AtsAdmin),
      ),
    );
  });
  await flush(20);

  const card = $(`card-candidate-${CANDIDATE_ID}`);
  assert(card, "the kanban candidate card must render (team_lead auth + auto-selected job + stubbed candidates)");

  // ── Kanban dialog ──────────────────────────────────────────────────────────
  // A. dialog starts CLOSED; trigger click opens it without a DELETE
  assert(
    !$(`dialog-confirm-delete-candidate-${CANDIDATE_ID}-confirm`),
    "A: before the kanban trigger is clicked its dialog must be closed — no confirm button in the DOM",
  );
  const kanbanTrigger = $(`button-delete-candidate-${CANDIDATE_ID}`);
  assert(kanbanTrigger, "A: kanban delete trigger renders on the candidate card");
  await click(kanbanTrigger!);
  assert(
    deleteCalls.length === 0,
    `A: clicking the kanban trigger must fire NO DELETE (old confirm() path deleted here) — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    $(`dialog-confirm-delete-candidate-${CANDIDATE_ID}-confirm`),
    "A: the kanban dialog must now be open (confirm button rendered)",
  );
  console.log("  ✓ A: kanban trigger opens the dialog without firing a DELETE");

  // B. cancel closes the dialog, fires nothing
  const kanbanCancel = $(`dialog-confirm-delete-candidate-${CANDIDATE_ID}-cancel`);
  assert(kanbanCancel, "B: kanban dialog cancel button is queryable while open");
  await click(kanbanCancel!);
  assert(
    deleteCalls.length === 0,
    `B: kanban Cancel must fire NO DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    !$(`dialog-confirm-delete-candidate-${CANDIDATE_ID}-confirm`),
    "B: kanban Cancel must CLOSE the dialog — confirm button gone until the trigger is clicked again",
  );
  console.log("  ✓ B: kanban cancel fires nothing and closes the dialog");

  // C. reopen, confirm fires exactly one DELETE to the old confirm() endpoint
  await click($(`button-delete-candidate-${CANDIDATE_ID}`)!);
  const kanbanConfirm = $(`dialog-confirm-delete-candidate-${CANDIDATE_ID}-confirm`);
  assert(kanbanConfirm, "C: reopening via the kanban trigger renders the confirm button again");
  await click(kanbanConfirm!);
  assert(
    deleteCalls.length === 1,
    `C: kanban confirm must fire exactly ONE DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    deleteCalls[0].endsWith(`/api/ats/candidates/${CANDIDATE_ID}`),
    `C: DELETE must hit /api/ats/candidates/${CANDIDATE_ID} (the pre-#4621 confirm() endpoint) — got ${deleteCalls[0]}`,
  );
  assert(
    !$(`dialog-confirm-delete-candidate-${CANDIDATE_ID}-confirm`),
    "C: confirming must close the kanban dialog (confirm button gone)",
  );
  console.log("  ✓ C: kanban reopen + confirm fires exactly one DELETE /api/ats/candidates/:id");

  // ── Detail panel dialog ────────────────────────────────────────────────────
  // The card click opens the detail Radix Dialog (dialog shim renders inline).
  const cardAgain = $(`card-candidate-${CANDIDATE_ID}`);
  assert(cardAgain, "D: the kanban card must still render after the kanban dialog flow");
  await click(cardAgain!);
  assert(
    !$("dialog-confirm-detail-delete-confirm"),
    "D: before the detail trigger is clicked its dialog must be closed — no confirm button in the DOM",
  );
  const detailTrigger = $("button-detail-delete");
  assert(detailTrigger, "D: detail delete trigger renders once the candidate detail panel opens");
  await click(detailTrigger!);
  assert(
    deleteCalls.length === 1,
    `D: clicking the detail trigger must fire NO further DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    $("dialog-confirm-detail-delete-confirm"),
    "D: the detail dialog must now be open (confirm button rendered)",
  );
  console.log("  ✓ D: detail trigger opens the dialog without firing a DELETE");

  // E. detail cancel closes the dialog, fires nothing
  const detailCancel = $("dialog-confirm-detail-delete-cancel");
  assert(detailCancel, "E: detail dialog cancel button is queryable while open");
  await click(detailCancel!);
  assert(
    deleteCalls.length === 1,
    `E: detail Cancel must fire NO further DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    !$("dialog-confirm-detail-delete-confirm"),
    "E: detail Cancel must CLOSE the dialog — confirm button gone until the trigger is clicked again",
  );
  console.log("  ✓ E: detail cancel fires nothing and closes the dialog");

  // F. reopen, detail confirm fires exactly one more DELETE
  await click($("button-detail-delete")!);
  const detailConfirm = $("dialog-confirm-detail-delete-confirm");
  assert(detailConfirm, "F: reopening via the detail trigger renders the confirm button again");
  await click(detailConfirm!);
  assert(
    deleteCalls.length === 2,
    `F: detail confirm must fire exactly ONE more DELETE — got ${JSON.stringify(deleteCalls)}`,
  );
  assert(
    deleteCalls[1].endsWith(`/api/ats/candidates/${CANDIDATE_ID}`),
    `F: DELETE must hit /api/ats/candidates/${CANDIDATE_ID} — got ${deleteCalls[1]}`,
  );
  assert(
    !$("dialog-confirm-detail-delete-confirm"),
    "F: confirming must close the detail dialog (confirm button gone)",
  );
  console.log("  ✓ F: detail reopen + confirm fires exactly one DELETE /api/ats/candidates/:id");

  await act(async () => {
    root.unmount();
  });
  qc.clear();

  console.log("\nconfirm-dialog-ats-admin-delete: ALL TESTS PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
