/* test-registration
{
  "name": "Reimport consent/apply keeps RAW totals for hide-Other clients (Task #2790)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2790: the EDITOR's reimport consent/apply path (dialog → apply → section PUT) is the remaining hide-Other write path with no rendered guard — a regression there silently persists the Other-suppressed total and permanently destroys the raw 110 (65 GBP + 45 Other). Deterministic jsdom render of the real ReportForm — no DB, fully stubbed fetch — same gate profile as its #2758/#2768 peers above.",
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
 * Task #2790 — The report editor's PDF REIMPORT consent/apply flow must not
 * drop hidden Other leads for hide-Other clients.
 *
 * hideOtherLeads is a DISPLAY-TIME flag (Tasks #2758 / #2760 / #2766 / #2769 /
 * #2777): persisted marketing sections always carry the RAW totals (GBP +
 * Other), and every report surface subtracts Other at render time for
 * hide-Other clients. The route-level reimport invariant test
 * (tests/hide-other-leads-reimport-invariant.test.ts) proves the SERVER keeps
 * raw totals, but nothing proved the EDITOR's reimport consent dialog →
 * applyImportData → saveMarketing path can't leak the suppression into the
 * persisted payload (e.g. by dropping otherLeads from the apply, or by
 * computing totalLeads from GBP-only sources for a hide-Other client). If
 * that regressed, one reimport would permanently destroy the raw total: the
 * saved section would carry totalLeads=65 instead of 110 and there would be
 * no way to recover the hidden 45 Other leads.
 *
 * This test mounts the REAL ReportForm for a hide-Other client and drives the
 * real reimport flow end to end in jsdom:
 *
 *   1. Existing report: raw 100 = 60 GBP (one location, "Lehi") + 40 Other.
 *      Client fixture: hideOtherLeads: true, products: ["gbp"].
 *   2. Click button-reimport-from-source → stubbed POST
 *      /api/reports/:id/reimport returns parsed RAW totals:
 *      110 = 65 GBP + 45 Other.
 *   3. The consent dialog must pre-check BOTH changed fields
 *      (marketing.gbpLocations 60→65 and marketing.otherLeads 40→45) — an
 *      unchecked otherLeads default is exactly the "silently keep stale/drop
 *      Other" failure mode.
 *   4. Click button-apply-import, then the header Save (flushes the
 *      marketing autosave) and assert the PUT /sections/marketing body:
 *      data.totalLeads === 110 (never the Other-suppressed 65) and
 *      data.otherLeads.count === 45 (never 0 / stale 40).
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

// Task #2829 — fail loudly if ANY rendered list in the report editor logs
// React's missing-key warning (redraw/flicker risk, see Task #2813). Scoped
// to the key warning only; jsdom/recharts SVG casing noise is untouched.
const keyWarningGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/reports/report-2790" },
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
  id: "user-2790",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

// A hide-Other client: persisted sections must still carry RAW totals.
const hideOtherClient = {
  id: "client-2790",
  firmName: "Hide Other Firm",
  contactName: "Test Contact",
  products: ["gbp"],
  hideOtherLeads: true,
  terminology: null,
};

const zeroQuality = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

// Existing saved report: raw 100 = 60 GBP (Lehi) + 40 Other.
const reportFixture = {
  id: "report-2790",
  clientId: "client-2790",
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

// New PDF (reimport parse result): RAW 110 = 65 GBP + 45 Other. The parsed
// marketing.totalLeads (110) is the raw PDF headline — reference-only in the
// dialog; the editor recomputes totalLeads from the applied sources.
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

// Captured PUT /api/reports/report-2790/sections/<key> bodies, in order.
const sectionSaves: Array<{ sectionKey: string; body: any }> = [];
// Captured POST /api/reports/report-2790/reimport request bodies.
const reimportCalls: Array<any> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "POST",
      path: "/api/reports/report-2790/reimport",
      respond: ({ init }: any) => {
        reimportCalls.push(init?.body ?? null);
        return {
          status: 200,
          json: { reportId: "report-2790", parsed: reimportParsed },
        };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-2790\/sections\/([^/?]+)$/,
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
      test: (url: string) => /^\/api\/reports\/report-2790$/.test(url),
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
// Mount the real ReportForm for the existing hide-Other report.
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

// ===========================================================================
// Step 1 — trigger the reimport (fromStoredUrl path).
// ===========================================================================
const reimportButton = $("button-reimport-from-source");
assert(
  reimportButton,
  "button-reimport-from-source must render (report fixture has hasStoredPdfUrl: true)",
);
await clickEl(reimportButton!);
await flush(6);

assert(
  reimportCalls.length === 1,
  `clicking Re-parse from Source must POST /api/reports/report-2790/reimport ` +
    `exactly once, got ${reimportCalls.length} calls`,
);

// ===========================================================================
// Step 2 — the consent dialog opens with BOTH changed fields pre-checked.
// ===========================================================================
const dialog = $("dialog-import-review");
assert(dialog, "the import-review consent dialog must open after the reimport parse");

const gbpCheckbox = $("checkbox-marketing.gbpLocations");
assert(gbpCheckbox, "checkbox-marketing.gbpLocations must render in the consent dialog");
assert(
  gbpCheckbox!.getAttribute("data-state") === "checked",
  `marketing.gbpLocations (60 → 65) must be PRE-checked in the consent dialog, ` +
    `got data-state="${gbpCheckbox!.getAttribute("data-state")}"`,
);

const otherCheckbox = $("checkbox-marketing.otherLeads");
assert(otherCheckbox, "checkbox-marketing.otherLeads must render in the consent dialog");
assert(
  otherCheckbox!.getAttribute("data-state") === "checked",
  `marketing.otherLeads (40 → 45) must be PRE-checked in the consent dialog — ` +
    `an unchecked default here is the "silently drop the hidden Other leads" ` +
    `failure mode for hide-Other clients; got data-state="${otherCheckbox!.getAttribute("data-state")}"`,
);

// ===========================================================================
// Step 3 — apply the selected fields, then Save (flushes the autosaves).
// ===========================================================================
await clickEl($("button-apply-import")!);
assert(
  !$("dialog-import-review"),
  "the consent dialog must close after Apply Selected Fields",
);

sectionSaves.length = 0;
const saveButton = $("button-save-status");
assert(saveButton, "button-save-status (Save) must render");
await clickEl(saveButton!);
await flush(6);

// ===========================================================================
// Step 4 — the persisted marketing section carries the RAW totals.
// ===========================================================================
const marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
assert(
  marketingSaves.length > 0,
  `clicking Save must flush a PUT /api/reports/report-2790/sections/marketing ` +
    `(captured section saves: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedMarketing = marketingSaves[marketingSaves.length - 1].body?.data ?? {};

assert(
  savedMarketing.totalLeads !== 65,
  `the persisted marketing.totalLeads must NEVER be the Other-suppressed 65 for a ` +
    `hide-Other client — hideOtherLeads is display-time only; the raw total was ` +
    `dropped from persistence (got ${JSON.stringify(savedMarketing.totalLeads)})`,
);
assert(
  savedMarketing.totalLeads === 110,
  `the persisted marketing.totalLeads must be the RAW 110 (65 GBP + 45 Other), ` +
    `got ${JSON.stringify(savedMarketing.totalLeads)}`,
);
assert(
  savedMarketing.otherLeads?.count === 45,
  `the persisted marketing.otherLeads.count must be the reimported 45 (never 0 ` +
    `or the stale 40), got ${JSON.stringify(savedMarketing.otherLeads?.count)}`,
);

// The applied GBP location merged into the existing row (65 leads, same id).
const savedLocations = savedMarketing.gbp?.locations ?? [];
assert(
  savedLocations.length === 1 &&
    savedLocations[0].id === "loc-lehi" &&
    savedLocations[0].uniqueLeads === 65,
  `the persisted gbp.locations must be the single merged Lehi row with 65 leads ` +
    `(kept id loc-lehi), got ${JSON.stringify(savedLocations)}`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-reimport-hide-other-consent.test.tsx",
);

console.log(
  "report-reimport-hide-other-consent.test.tsx: PASS — reimport consent dialog " +
    "pre-checks gbpLocations + otherLeads, and the applied save persists RAW " +
    "totalLeads 110 with otherLeads.count 45 (never the Other-suppressed 65) " +
    "for a hideOtherLeads client",
);
process.exit(0);
