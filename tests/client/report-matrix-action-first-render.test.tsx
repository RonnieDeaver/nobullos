/* test-registration
{
  "name": "Report matrix opens action-first + grid toggle + due styling + finalized-cell edit affordance; ReportForm autosave indicator + transition-only finalize confirms (Tasks #4442, #4801)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4442: the triage MATH is unit-tested but nothing asserted the RENDERED behavior of Task #4351's action-first default. A refactor could silently revert the reports page to the ~95%-empty grid (the exact audit finding) with every existing test green. This is the only guard that the page mounts in the needs-action list by default, that the toggle reaches the grid, that a due-month empty cell carries the dashed-amber due treatment, and that the edit form's 4-state autosave indicator truthfully reports 'Unsaved changes' vs 'All changes saved'. Task #4801 extends it: a final+share-token grid cell must pair the deck click with a pencil edit affordance, and ReportForm must save an already-final report directly (no finalize re-confirm) while showing the live-report notice — the exact UX gap that taught operators finalized reports were locked. Deterministic jsdom render of the real ReportMatrix + ReportForm — no DB, fully stubbed fetch.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/client/report-matrix-action-first-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4442 — rendered-behavior guard for the action-first reports page
 * (Task #4351) and the report form's autosave indicator.
 * Task #4801 — finalized reports must stay editable in practice: the grid
 * pairs deck-routed final cells with an edit affordance, and the form saves
 * already-final reports without re-prompting the finalize confirm.
 *
 * PHASE 1 — ReportMatrix:
 *   - Mounts the REAL ReportMatrix against a stubbed /api/reports/matrix
 *     payload (one due client, one up-to-date client, one finalized client).
 *   - Default view must render `list-needs-action` and must NOT render the
 *     grid (`table-report-matrix`) — the action-first default is the point.
 *   - The due client carries `pill-due-<id>`; the up-to-date client is
 *     absent from the needs-action list.
 *   - Clicking `button-view-grid` switches to `table-report-matrix` (and the
 *     needs-action list unmounts).
 *   - In the grid, the due-month EMPTY cell (`cell-empty-<id>-<dueMonth>`)
 *     carries the dashed-amber due treatment (border-dashed +
 *     border-status-warn/60 + a "Due" label); an older empty cell does not.
 *   - Task #4801: a final+share-token cell renders the pencil edit button
 *     (`button-edit-report-…`) next to the deck-opening main cell; draft
 *     cells and token-less final cells (whose main click already edits) do
 *     not. Main click → /share/<token>; pencil click → /reports/<id>.
 *
 * PHASE 2 — ReportForm autosave indicator (`text-autosave-status`):
 *   - Mount the real ReportForm for an existing DRAFT report, edit a field.
 *   - While the debounced autosave is pending the indicator must read
 *     "Unsaved changes"; after the debounce fires and the section PUT
 *     resolves it must read "All changes saved".
 *   - Task #4801: a draft report never shows `notice-live-report`.
 *
 * PHASE 3 — Task #4801, transition-only finalize confirms:
 *   - Mount the real ReportForm for an already-FINAL report whose sections
 *     are deliberately empty (detectMissingFields() is non-empty, so the old
 *     always-on confirm WOULD have fired).
 *   - `notice-live-report` renders and says the report is live on its share
 *     link with edits publishing immediately.
 *   - Clicking Save must PATCH the report directly (status stays "final")
 *     with NO `dialog-missing-fields` — that confirm is for draft → final
 *     transitions only.
 *
 * Fixture months are clock-derived via monthKeyOffset (never hardcoded
 * YYYY-MM literals) so the test stays calendar-proof.
 *
 * Heavy browser-only deps are stubbed by report-matrix-action-first-setup.mjs
 * (registered via --import).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/reports" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLImageElement = dom.window.HTMLImageElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).HTMLTableElement = dom.window.HTMLTableElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
(globalThis as any).ShadowRoot = dom.window.ShadowRoot;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).FocusEvent = (dom.window as any).FocusEvent ?? dom.window.Event;
(globalThis as any).PointerEvent =
  (dom.window as any).PointerEvent ?? (dom.window as any).MouseEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(dom.window as any).matchMedia =
  (dom.window as any).matchMedia ||
  ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
(globalThis as any).matchMedia = (dom.window as any).matchMedia;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;
(dom.window as any).ResizeObserver = ResizeObserverStub;
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
(globalThis as any).IntersectionObserver = IntersectionObserverStub;
(dom.window as any).IntersectionObserver = IntersectionObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true;
(dom.window as any).confirm = () => true;
(globalThis as any).scrollTo = () => {};
(dom.window as any).scrollTo = () => {};
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
(dom.window.HTMLElement.prototype as any).hasPointerCapture =
  (dom.window.HTMLElement.prototype as any).hasPointerCapture || (() => false);
(dom.window.HTMLElement.prototype as any).releasePointerCapture =
  (dom.window.HTMLElement.prototype as any).releasePointerCapture || (() => {});

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const testUser = {
  id: "user-4442",
  email: "editor@test.local",
  firstName: "Matrix",
  lastName: "Tester",
  role: "ceo",
};

// ---------------------------------------------------------------------------
// Clock-derived month keys (same derivation as reportMatrixTriage) — the due
// month is the most recently completed calendar month.
// ---------------------------------------------------------------------------
const { monthKeyOffset } = await import("../../client/src/lib/reportMatrixTriage");
const now = new Date();
const dueMonth = monthKeyOffset(now, -1);
const olderMonth = monthKeyOffset(now, -3);

// client-due: zero reports → owes the due month (pill + dashed grid cell).
// client-current: has a final due-month report (NO share token) → up to date,
//   grid-only row; its final cell's main click already opens the edit form.
// client-final: a finalized+share-token report (older month) plus a draft
//   (due month) — Task #4801's grid subject: the final cell must pair the
//   deck click with a pencil edit button; the draft cell must not.
const matrixFixture = [
  {
    clientId: "client-due",
    firmName: "Due Firm",
    clientCode: "DUE",
    reports: {},
  },
  {
    clientId: "client-current",
    firmName: "Current Firm",
    clientCode: "CUR",
    reports: {
      [dueMonth]: {
        id: "report-current-due",
        status: "final",
        shareToken: null,
        totalLeads: 3,
        totalCases: 1,
        updatedAt: new Date().toISOString(),
      },
    },
  },
  {
    clientId: "client-final",
    firmName: "Final Firm",
    clientCode: "FIN",
    reports: {
      [olderMonth]: {
        id: "report-final-old",
        status: "final",
        shareToken: "token-final-old",
        totalLeads: 5,
        totalCases: 2,
        updatedAt: new Date().toISOString(),
      },
      [dueMonth]: {
        id: "report-final-draft",
        status: "draft",
        shareToken: null,
        totalLeads: 0,
        totalCases: 0,
        updatedAt: new Date().toISOString(),
      },
    },
  },
];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    { path: "/api/reports/matrix", json: matrixFixture },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router, Route } = await import("wouter");
const ReportMatrix = (await import("../../client/src/pages/ReportMatrix")).default;

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function $(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await flush(4);
}

// ===========================================================================
// PHASE 1 — ReportMatrix: action-first default, grid toggle, due styling.
// ===========================================================================
const container = document.getElementById("root")!;
const qc = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
let root: any = null;
await act(async () => {
  root = createRoot(container);
  root.render(
    React.createElement(
      QueryClientProvider,
      { client: qc } as any,
      React.createElement(Router as any, null, React.createElement(ReportMatrix as any)),
    ),
  );
});
await flush();

// 1) Action-first DEFAULT: the needs-action list renders, the grid does not.
assert(
  $("list-needs-action"),
  "default view must render list-needs-action (the action-first triage list) — " +
    "if this is missing the page has silently reverted to the old grid default",
);
assert(
  !$("table-report-matrix"),
  "default view must NOT render table-report-matrix — the ~95%-empty grid is the " +
    "secondary mode behind the view toggle, never the landing view",
);
const actionToggle = $("button-view-action");
assert(actionToggle, "button-view-action must render in the view toggle group");
assert(
  actionToggle!.getAttribute("aria-pressed") === "true",
  "button-view-action must be pressed (aria-pressed=true) on initial load",
);

// 2) Triage content: the due client shows its due pill; the up-to-date client
//    is not in the needs-action list at all.
const duePill = $("pill-due-client-due");
assert(duePill, "the due client's action row must carry pill-due-client-due");
assert(
  (duePill!.textContent ?? "").includes("due"),
  `pill-due-client-due must label the due month, got "${duePill!.textContent}"`,
);
assert(
  !$("action-row-client-current"),
  "an up-to-date client (final report for the due month, no drafts) must NOT " +
    "appear in the needs-action list",
);

// 3) Toggle to the grid.
await clickEl($("button-view-grid")!);
assert(
  $("table-report-matrix"),
  "clicking button-view-grid must render table-report-matrix (the full grid)",
);
assert(
  !$("list-needs-action"),
  "the needs-action list must unmount when the grid view is active",
);
assert(
  $("button-view-grid")!.getAttribute("aria-pressed") === "true",
  "button-view-grid must be pressed (aria-pressed=true) after the toggle",
);

// 4) Due-month empty cell carries the dashed-amber due treatment; an older
//    empty cell stays quiet.
const dueCell = $(`cell-empty-client-due-${dueMonth}`);
assert(dueCell, `the grid must render cell-empty-client-due-${dueMonth} (due-month empty cell)`);
assert(
  dueCell!.className.includes("border-dashed") && dueCell!.className.includes("border-status-warn/60"),
  `the due-month empty cell must carry the dashed-amber due treatment ` +
    `(border-dashed + border-status-warn/60 — Task #4662 moved the due tint ` +
    `from border-amber-400 to the status-warn token), got class="${dueCell!.className}"`,
);
assert(
  (dueCell!.textContent ?? "").includes("Due"),
  `the due-month empty cell must carry the "Due" label, got "${dueCell!.textContent}"`,
);
const olderCell = $(`cell-empty-client-due-${olderMonth}`);
assert(olderCell, `the grid must render cell-empty-client-due-${olderMonth} (older empty cell)`);
assert(
  !olderCell!.className.includes("border-dashed") &&
    !olderCell!.className.includes("border-status-warn"),
  `a non-due empty cell must NOT carry the due treatment, got class="${olderCell!.className}"`,
);
// The up-to-date client's due-month cell is a filled report cell, not empty.
assert(
  $(`cell-report-client-current-${dueMonth}`),
  `client-current's due-month cell must render as a report cell (cell-report-…)`,
);

// 5) Task #4801 — a final+share-token cell pairs the deck-opening main cell
//    with an explicit pencil edit button; cells whose main click ALREADY
//    opens the edit form (drafts, token-less finals) render no pencil.
const finalCell = $(`cell-report-client-final-${olderMonth}`);
assert(
  finalCell,
  `the grid must render cell-report-client-final-${olderMonth} (final+share-token cell)`,
);
const editBtn = $(`button-edit-report-client-final-${olderMonth}`);
assert(
  editBtn,
  "a final+share-token cell must render button-edit-report-… (the pencil edit " +
    "affordance) — without it the edit form is tribal knowledge and operators " +
    "believe finalized reports are locked (Task #4801)",
);
assert(
  !$(`button-edit-report-client-final-${dueMonth}`),
  "a DRAFT cell must NOT render the pencil edit button — its main click already " +
    "opens the edit form",
);
assert(
  !$(`button-edit-report-client-current-${dueMonth}`),
  "a final cell WITHOUT a share token must NOT render the pencil edit button — " +
    "openReport already routes it to the edit form",
);
// Main click on the final cell still reaches the client deck…
await clickEl(finalCell!);
assert(
  dom.window.location.pathname === "/share/token-final-old",
  `clicking a final+token cell must open the share deck (/share/token-final-old), ` +
    `got ${dom.window.location.pathname}`,
);
// …and the pencil opens the edit form for the same report.
await clickEl(editBtn!);
assert(
  dom.window.location.pathname === "/reports/report-final-old",
  `clicking the pencil edit button must open the edit form (/reports/report-final-old), ` +
    `got ${dom.window.location.pathname}`,
);

await act(async () => {
  root.unmount();
});

// ===========================================================================
// PHASE 2 — ReportForm autosave indicator: "Unsaved changes" while an edit is
// pending, "All changes saved" after the section PUT resolves.
// ===========================================================================
dom.reconfigure({ url: "http://localhost/reports/report-4442" });
document.getElementById("root")!.innerHTML = "";

const sectionSaves: Array<{ sectionKey: string; body: any }> = [];
(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-4442\/sections\/([^/?]+)$/,
      respond: ({ url, init }: any) => {
        const sectionKey = url.split("/").pop()!;
        const body = JSON.parse(init?.body ?? "{}");
        sectionSaves.push({ sectionKey, body });
        return {
          status: 200,
          json: { sectionKey, data: body.data, updatedAt: new Date().toISOString() },
        };
      },
    },
    {
      test: (url: string) => /^\/api\/reports\/report-4442$/.test(url),
      json: {
        id: "report-4442",
        clientId: "client-4442",
        reportMonth: dueMonth,
        status: "draft",
        shareToken: null,
        privacyMode: false,
        hideLeadQuality: false,
        webhookImportLogId: null,
        sections: [],
      },
    },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/locations"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access/detection"),
      json: {},
    },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/command-panel"),
      json: null,
    },
    { path: "/api/clients", json: [] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
}) as any;

const ReportForm = (await import("../../client/src/pages/ReportForm")).default;
const qc2 = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
let root2: any = null;
await act(async () => {
  root2 = createRoot(document.getElementById("root")!);
  root2.render(
    React.createElement(
      QueryClientProvider,
      { client: qc2 } as any,
      React.createElement(
        Router as any,
        null,
        React.createElement(Route as any, { path: "/reports/:id", component: ReportForm }),
      ),
    ),
  );
});
await flush();

// Before any edit the indicator is idle (never rendered) — a lie here would
// mean the form claims a save state with nothing to save.
assert(
  !$("text-autosave-status"),
  "text-autosave-status must not render before any edit (idle state)",
);
// Task #4801 — the live-report notice is for FINAL reports only; a draft
// form must never claim it is live.
assert(
  !$("notice-live-report"),
  "notice-live-report must NOT render for a draft report (Task #4801)",
);

// Edit a sales field. The controlled input commits to form state immediately;
// the debounced autosave (1.5s) is now pending → "Unsaved changes".
await clickEl($("tab-sales")!);
const caseValueInput = $("input-case-value") as HTMLInputElement | null;
assert(caseValueInput, "input-case-value must render on the Sales tab");
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLInputElement.prototype,
  "value",
)!.set!;
await act(async () => {
  nativeValueSetter.call(caseValueInput, "4242");
  caseValueInput!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
});
await flush(2); // ~10ms — well inside the 1.5s debounce window

const dirtyStatus = $("text-autosave-status");
assert(dirtyStatus, "text-autosave-status must render once an edit is pending");
assert(
  (dirtyStatus!.textContent ?? "").includes("Unsaved changes"),
  `text-autosave-status must read "Unsaved changes" while the debounced autosave ` +
    `is pending, got "${dirtyStatus!.textContent}"`,
);

// Let the 1.5s debounce fire and the (stubbed) section PUT resolve.
await act(async () => {
  await new Promise((r) => setTimeout(r, 1700));
});
await flush(8);

assert(
  sectionSaves.some((s) => s.sectionKey === "sales"),
  `the debounced autosave must PUT /api/reports/report-4442/sections/sales ` +
    `(captured: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedStatus = $("text-autosave-status");
assert(savedStatus, "text-autosave-status must still render after the save settles");
assert(
  (savedStatus!.textContent ?? "").includes("All changes saved"),
  `text-autosave-status must read "All changes saved" after the autosave ` +
    `mutation resolves, got "${savedStatus!.textContent}"`,
);

await act(async () => {
  root2.unmount();
});
await flush(4);

// ===========================================================================
// PHASE 3 — Task #4801: saving an already-FINAL report never re-prompts the
// finalize confirm (that flow is draft→final transition-only), and the form
// shows the live-report notice. The fixture report is deliberately EMPTY so
// detectMissingFields() is non-empty — the old always-on confirm WOULD have
// opened dialog-missing-fields and returned early without PATCHing.
// ===========================================================================
dom.reconfigure({ url: "http://localhost/reports/report-4801" });
document.getElementById("root")!.innerHTML = "";

const finalReportJson = {
  id: "report-4801",
  clientId: "client-4801",
  reportMonth: dueMonth,
  status: "final",
  shareToken: "tok-4801",
  privacyMode: false,
  hideLeadQuality: false,
  webhookImportLogId: null,
  sections: [],
};
const patchCalls: any[] = [];
(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "PATCH",
      path: /^\/api\/reports\/report-4801$/,
      respond: ({ init }: any) => {
        patchCalls.push(JSON.parse(init?.body ?? "{}"));
        return {
          status: 200,
          json: { ...finalReportJson, updatedAt: new Date().toISOString() },
        };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-4801\/sections\/([^/?]+)$/,
      respond: ({ url, init }: any) => {
        const sectionKey = url.split("/").pop()!;
        const body = JSON.parse(init?.body ?? "{}");
        return {
          status: 200,
          json: { sectionKey, data: body.data, updatedAt: new Date().toISOString() },
        };
      },
    },
    { test: (url: string) => /^\/api\/reports\/report-4801$/.test(url), json: finalReportJson },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/locations"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access/detection"),
      json: {},
    },
    { test: (url: string) => url.startsWith("/api/clients") && url.includes("/data-access"), json: [] },
    {
      test: (url: string) => url.startsWith("/api/clients") && url.includes("/command-panel"),
      json: null,
    },
    { path: "/api/clients", json: [] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
}) as any;

const qc3 = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
let root3: any = null;
await act(async () => {
  root3 = createRoot(document.getElementById("root")!);
  root3.render(
    React.createElement(
      QueryClientProvider,
      { client: qc3 } as any,
      React.createElement(
        Router as any,
        null,
        React.createElement(Route as any, { path: "/reports/:id", component: ReportForm }),
      ),
    ),
  );
});
await flush();

// The live-report notice renders for a FINAL report and states the contract:
// live on its share link, edits publish immediately.
const liveNotice = $("notice-live-report");
assert(
  liveNotice,
  "notice-live-report must render when the loaded report is final (Task #4801)",
);
const noticeText = liveNotice!.textContent ?? "";
assert(
  noticeText.includes("live on its share link") && noticeText.includes("publish immediately"),
  `notice-live-report must say the report is live on its share link and that ` +
    `edits publish immediately, got "${noticeText}"`,
);

// Save must PATCH directly — no missing-fields/finalize-anyway confirm — even
// though this empty report has plenty of "missing" fields.
const saveBtn = $("button-save-status");
assert(saveBtn, "button-save-status must render for the final report");
await clickEl(saveBtn!);
await flush(6);

assert(
  !$("dialog-missing-fields"),
  "saving an already-final report must NOT open dialog-missing-fields — the " +
    "confirm flow is transition-only (Task #4801); re-prompting here is what " +
    "taught operators that finalized reports can't be edited",
);
assert(
  patchCalls.length === 1,
  `saving an already-final report must PATCH /api/reports/report-4801 exactly ` +
    `once (the old code returned early into the confirm dialog instead), got ` +
    `${patchCalls.length}`,
);
assert(
  patchCalls[0]?.status === "final",
  `the direct save must keep status "final", got ${JSON.stringify(patchCalls[0])}`,
);

await act(async () => {
  root3.unmount();
});
await flush(4);

keyWarningGuard.assertNoKeyWarnings("report-matrix-action-first-render.test.tsx");

console.log(
  "report-matrix-action-first-render.test.tsx: PASS — ReportMatrix opens in the " +
    "needs-action list (grid absent), the toggle reaches table-report-matrix, the " +
    `due-month empty cell (${dueMonth}) carries the dashed-amber Due treatment, a ` +
    "final+share-token cell pairs the deck click with the pencil edit button " +
    "(drafts/token-less finals don't), ReportForm's indicator reads 'Unsaved " +
    "changes' while dirty then 'All changes saved', and an already-final report " +
    "saves directly (no finalize re-confirm) while showing the live-report notice",
);
process.exit(0);
