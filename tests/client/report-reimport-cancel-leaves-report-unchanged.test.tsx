/* test-registration
{
  "name": "Cancelling the reimport review leaves the report exactly as it was (Task #2800)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2800: the CANCEL/dismiss complement of the reimport apply gates above. The #2790/#2799/#2810/#2816 gates only prove the APPLY path; a regression where Cancel (or the X close → onOpenChange(false)) half- applies pendingImportData, leaves stale dialog state, or dirties the marketing autosave would corrupt reports invisibly — the operator explicitly declined the overwrite — and every apply-path gate would stay green. Same deterministic jsdom render profile — no DB, fully stubbed fetch.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/client/report-reimport-hide-other-consent-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2800 — Cancelling the reimport consent dialog must leave the report
 * exactly as it was.
 *
 * The reimport consent dialog (dialog-import-review in ReportForm.tsx) holds
 * the parsed PDF in pendingImportData while the operator reviews. The #2790 /
 * #2799 tests prove the APPLY path persists RAW totals — but nothing proved
 * that pressing Cancel (button-cancel-import), or closing the dialog via the
 * X (the onOpenChange(false) path), discards the parsed data COMPLETELY:
 *
 *   - no field state mutated (a half-apply on cancel would corrupt reports
 *     invisibly — the operator explicitly declined the overwrite),
 *   - no autosave queued (cancel must not dirty the marketing payload), and
 *   - a subsequent Save PUTs the ORIGINAL section values unchanged.
 *
 * This test mounts the REAL ReportForm on the #2790 fixture (existing report:
 * raw 100 = 60 GBP "Lehi" + 40 Other; reimport parse: 110 = 65 GBP + 45
 * Other) and drives BOTH dismissal paths end to end in jsdom:
 *
 *   1. Click button-reimport-from-source → consent dialog opens with both
 *      changed fields (marketing.gbpLocations 60→65, marketing.otherLeads
 *      40→45) pre-checked — same precondition the apply tests establish.
 *   2. Click button-cancel-import → dialog closes and every
 *      pendingImportData-driven testid (import-section-*, import-field-*,
 *      checkbox-*) is gone from the DOM.
 *   3. Wait past the 1500 ms autosave debounce → ZERO section PUTs fire
 *      (cancel queued no autosave).
 *   4. Click the header Save → the flushed PUT /sections/marketing (if the
 *      flush emits one at all) carries the PRE-reimport values: totalLeads
 *      100, otherLeads.count 40, Lehi uniqueLeads 60 — and NO save in the
 *      whole run ever carries a reimported value (110 / 65 / 45).
 *   5. Reopen the dialog and dismiss it via the DialogContent X close button
 *      (DialogPrimitive.Close → onOpenChange(false)), then repeat the
 *      cleared-state + Save assertions for that second dismissal path.
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import) —
 * the same harness as the #2790 template.
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/reports/report-2800" },
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
  id: "user-2800",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

const hideOtherClient = {
  id: "client-2800",
  firmName: "Hide Other Firm",
  contactName: "Test Contact",
  products: ["gbp"],
  hideOtherLeads: true,
  terminology: null,
};

const zeroQuality = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

// Existing saved report: raw 100 = 60 GBP (Lehi) + 40 Other — the ORIGINAL
// values a cancelled reimport must leave untouched.
const reportFixture = {
  id: "report-2800",
  clientId: "client-2800",
  reportMonth: "2026-06",
  status: "draft",
  shareToken: null,
  privacyMode: false,
  hideLeadQuality: false,
  webhookImportLogId: null,
  hasStoredPdfUrl: true,
  sections: [
    {
      sectionKey: "marketing",
      updatedAt: "2026-07-01T00:00:00.000Z",
      data: {
        totalLeads: 100,
        posture: "stable",
        gbpLeadQuality: { good: 30, notQuotable: 20, missedCalls: 10, noData: 0 },
        gbp: {
          locations: [
            {
              id: "loc-lehi",
              name: "Lehi",
              uniqueLeads: 60,
              reviewsGenerated: 5,
              reviewsRespondedTo: 3,
              postsQaCount: 2,
              leadQuality: { good: 30, notQuotable: 20, missedCalls: 10, noData: 0 },
            },
          ],
        },
        otherLeads: {
          count: 40,
          description: "Referrals: 40",
          leadQuality: zeroQuality,
        },
      },
    },
  ],
};

// Reimport parse result the operator will DECLINE: 110 = 65 GBP + 45 Other.
// None of these values may ever reach a section PUT in this test.
const reimportParsed = {
  reportMonth: "2026-06",
  clientName: "Hide Other Firm",
  marketing: {
    totalLeads: 110,
    gbpLocations: [
      {
        name: "Lehi",
        uniqueLeads: 65,
        reviewsGenerated: 5,
        reviewsRespondedTo: 3,
        postsQaCount: 2,
        leadQuality: { good: 35, notQuotable: 20, missedCalls: 10, noData: 0 },
      },
    ],
    otherLeads: { total: 45, socialMedia: 45, directCalls: 0, referrals: 0 },
  },
};

// Captured PUT /api/reports/report-2800/sections/<key> bodies, in order.
const sectionSaves: Array<{ sectionKey: string; body: any }> = [];
// Captured POST /api/reports/report-2800/reimport request bodies.
const reimportCalls: Array<any> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "POST",
      path: "/api/reports/report-2800/reimport",
      respond: ({ init }: any) => {
        reimportCalls.push(init?.body ?? null);
        return {
          status: 200,
          json: { reportId: "report-2800", parsed: reimportParsed },
        };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-2800\/sections\/([^/?]+)$/,
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
      test: (url: string) => /^\/api\/reports\/report-2800$/.test(url),
      json: reportFixture,
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
    { path: "/api/clients", json: [hideOtherClient] },
    { path: "/api/notifications", json: [] },
  ],
  defaultJson: {},
});

const React = (await import("react")).default ?? (await import("react"));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router, Route } = await import("wouter");
const ReportForm = (await import("../../client/src/pages/ReportForm")).default;

// React missing-key warning guard (Task #2822/#2829) — installed BEFORE the
// first render so any un-keyed list in the rendered report UI fails loudly.
const { installReactKeyWarningGuard } = await import(
  "../helpers/reactKeyWarningGuard.mjs"
);
const keyWarningGuard = installReactKeyWarningGuard();

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

// Real-time wait that outlasts the 1500 ms autosave debounce, so a dirty
// marketing payload would have FIRED its autosave PUT by the time it returns.
async function waitPastAutosaveDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1700));
  });
  await flush(4);
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

// The pendingImportData-driven testids that must vanish on dismissal.
const IMPORT_TESTIDS = [
  "import-section-marketing",
  "import-field-marketing.gbpLocations",
  "import-field-marketing.otherLeads",
  "checkbox-marketing.gbpLocations",
  "checkbox-marketing.otherLeads",
];

function assertImportUiGone(context: string): void {
  assert(!$("dialog-import-review"), `dialog-import-review must be closed ${context}`);
  for (const tid of IMPORT_TESTIDS) {
    assert(!$(tid), `${tid} must be gone from the DOM ${context}`);
  }
}

// Assert a flushed marketing PUT body carries ONLY the pre-reimport values.
function assertOriginalMarketing(saved: any, context: string): void {
  assert(
    saved.totalLeads === 100,
    `${context}: the persisted marketing.totalLeads must be the ORIGINAL 100 ` +
      `(60 GBP + 40 Other) — a cancelled reimport half-applied the parse ` +
      `(got ${JSON.stringify(saved.totalLeads)})`,
  );
  assert(
    saved.otherLeads?.count === 40,
    `${context}: the persisted marketing.otherLeads.count must be the ORIGINAL ` +
      `40 (never the declined 45), got ${JSON.stringify(saved.otherLeads?.count)}`,
  );
  const locations = saved.gbp?.locations ?? [];
  assert(
    locations.length === 1 &&
      locations[0].id === "loc-lehi" &&
      locations[0].uniqueLeads === 60,
    `${context}: the persisted gbp.locations must still be the single ORIGINAL ` +
      `Lehi row with 60 leads (id loc-lehi), got ${JSON.stringify(locations)}`,
  );
}

// No section PUT anywhere in the run may carry a reimported value.
function assertNoReimportedValueLeaked(saves: Array<{ sectionKey: string; body: any }>): void {
  for (const s of saves) {
    const d = s.body?.data ?? {};
    assert(
      d.totalLeads !== 110 && d.totalLeads !== 65,
      `a ${s.sectionKey} PUT carried the DECLINED reimport totalLeads ` +
        `${JSON.stringify(d.totalLeads)} — cancel leaked parsed data into a save`,
    );
    assert(
      d.otherLeads?.count !== 45,
      `a ${s.sectionKey} PUT carried the DECLINED reimport otherLeads.count 45 ` +
        `— cancel leaked parsed data into a save`,
    );
    for (const loc of d.gbp?.locations ?? []) {
      assert(
        loc.uniqueLeads !== 65,
        `a ${s.sectionKey} PUT carried the DECLINED reimport Lehi uniqueLeads 65 ` +
          `— cancel leaked parsed data into a save`,
      );
    }
  }
}

async function openReimportDialog(expectedCalls: number): Promise<void> {
  const reimportButton = $("button-reimport-from-source");
  assert(
    reimportButton,
    "button-reimport-from-source must render (report fixture has hasStoredPdfUrl: true)",
  );
  await clickEl(reimportButton!);
  await flush(6);
  assert(
    reimportCalls.length === expectedCalls,
    `clicking Re-parse from Source must POST /api/reports/report-2800/reimport ` +
      `(expected ${expectedCalls} total calls, got ${reimportCalls.length})`,
  );
  assert($("dialog-import-review"), "the import-review consent dialog must open after the parse");
  for (const tid of ["checkbox-marketing.gbpLocations", "checkbox-marketing.otherLeads"]) {
    const cb = $(tid);
    assert(cb, `${tid} must render in the consent dialog`);
    assert(
      cb!.getAttribute("data-state") === "checked",
      `${tid} must be PRE-checked (the field differs from the saved value), ` +
        `got data-state="${cb!.getAttribute("data-state")}"`,
    );
  }
}

// ===========================================================================
// Mount the real ReportForm for the existing report.
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
      React.createElement(
        Router as any,
        null,
        React.createElement(Route as any, { path: "/reports/:id", component: ReportForm }),
      ),
    ),
  );
});
await flush();

// Drain any load-time autosaves so the post-cancel "no autosave queued"
// assertion below is attributable to the cancel, not to initial hydration.
await waitPastAutosaveDebounce();
assertNoReimportedValueLeaked(sectionSaves);
sectionSaves.length = 0;

// ===========================================================================
// Round 1 — dismiss via the explicit Cancel button (button-cancel-import).
// ===========================================================================
await openReimportDialog(1);

const cancelButton = $("button-cancel-import");
assert(cancelButton, "button-cancel-import must render in the consent dialog footer");
await clickEl(cancelButton!);

assertImportUiGone("after clicking Cancel");

// Cancel must not have queued an autosave: outwait the debounce and require
// ZERO section PUTs of any kind.
await waitPastAutosaveDebounce();
assert(
  sectionSaves.length === 0,
  `cancelling the reimport review must queue NO autosave — but ` +
    `${sectionSaves.length} section PUT(s) fired after Cancel: ` +
    JSON.stringify(sectionSaves.map((s) => s.sectionKey)),
);

// A subsequent Save must persist the ORIGINAL values (or nothing at all —
// flushAllAutosaves only saves dirty sections, and nothing is dirty).
const saveButton = $("button-save-status");
assert(saveButton, "button-save-status (Save) must render");
await clickEl(saveButton!);
await flush(6);

let marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
if (marketingSaves.length > 0) {
  assertOriginalMarketing(
    marketingSaves[marketingSaves.length - 1].body?.data ?? {},
    "Save after Cancel",
  );
}
assertNoReimportedValueLeaked(sectionSaves);
sectionSaves.length = 0;

// ===========================================================================
// Round 2 — dismiss via the DialogContent X close (onOpenChange(false) path,
// which is also what Escape / outside-click route through in production).
// ===========================================================================
await openReimportDialog(2);

const dialogEl = $("dialog-import-review")!;
const xClose = Array.from(dialogEl.querySelectorAll("button")).find((b) =>
  Array.from(b.querySelectorAll("span")).some((s) => s.textContent === "Close"),
) as HTMLElement | undefined;
assert(xClose, "the DialogContent X close button (sr-only 'Close') must render");
await clickEl(xClose!);

assertImportUiGone("after closing the dialog via the X");

await waitPastAutosaveDebounce();
assert(
  sectionSaves.length === 0,
  `closing the reimport review via the X must queue NO autosave — but ` +
    `${sectionSaves.length} section PUT(s) fired after close: ` +
    JSON.stringify(sectionSaves.map((s) => s.sectionKey)),
);

await clickEl($("button-save-status")!);
await flush(6);

marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
if (marketingSaves.length > 0) {
  assertOriginalMarketing(
    marketingSaves[marketingSaves.length - 1].body?.data ?? {},
    "Save after X close",
  );
}
assertNoReimportedValueLeaked(sectionSaves);

// ===========================================================================
// Sanity guard — the fixture still detects a real change: reopening a third
// time re-offers the SAME pre-checked overwrites, proving the two dismissals
// above discarded a genuinely applicable parse (not a no-op diff).
// ===========================================================================
await openReimportDialog(3);
await clickEl($("button-cancel-import")!);
assertImportUiGone("after the final Cancel");

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-reimport-cancel-leaves-report-unchanged.test.tsx",
);

console.log(
  "report-reimport-cancel-leaves-report-unchanged.test.tsx: PASS — Cancel and " +
    "the X close both discard pendingImportData completely: dialog testids " +
    "gone, zero autosaves queued past the debounce, and Save persists only " +
    "the ORIGINAL marketing values (100 / 40 / Lehi 60), never the declined " +
    "reimport (110 / 45 / 65)",
);
process.exit(0);
