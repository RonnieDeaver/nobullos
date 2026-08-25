/* test-registration
{
  "name": "Reimport keeps RAW totals for hide-Other clients WITHOUT the GBP product (Task #2799)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2799: same reimport consent/apply write path, but through the OTHER branch of calculatedTotalLeads — a hide-Other client WITHOUT the GBP product (hasGbpProduct === false skips the GBP-locations sum, so the raw total is non-GBP sources + Other). The #2790 gate above stays green on a regression confined to this branch, so it needs its own gate. Same deterministic jsdom render profile — no DB, fully stubbed fetch.",
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
 * Task #2799 — The report editor's PDF REIMPORT consent/apply flow must not
 * drop hidden Other leads for hide-Other clients WITHOUT the GBP product.
 *
 * Task #2790 proved the reimport consent/apply path persists RAW totals for a
 * hide-Other client WITH the GBP product (products: ["gbp"]). But ReportForm's
 * calculatedTotalLeads takes a DIFFERENT branch when the client has no GBP
 * product: the hasGbpProduct gate (ReportForm.tsx ~594) zeroes the
 * GBP-locations sum, so the persisted total is built purely from the non-GBP
 * sources (Google Ads / LSA / webinar) plus Other. A regression on THAT branch
 * (e.g. suppressing otherLeads.count from the sum, or persisting the
 * display-adjusted total) would silently destroy the raw total for hide-Other
 * clients whose lead sources are non-GBP — and the #2790 test would stay
 * green because its fixture has the GBP product.
 *
 * hideOtherLeads is a DISPLAY-TIME flag (Tasks #2758 / #2760 / #2766 / #2769 /
 * #2777): persisted marketing sections always carry the RAW totals, and every
 * report surface subtracts Other at render time.
 *
 * This test mounts the REAL ReportForm for a hide-Other client with NO "gbp"
 * in products and drives the real reimport flow end to end in jsdom:
 *
 *   1. Existing report: raw 60 = 20 Google Ads + 40 Other, ZERO GBP locations.
 *      Client fixture: hideOtherLeads: true, products: ["google_ads"].
 *   2. Click button-reimport-from-source → stubbed POST
 *      /api/reports/:id/reimport returns parsed RAW totals:
 *      70 = 25 Google Ads + 45 Other (no gbpLocations at all).
 *   3. The consent dialog must pre-check BOTH changed fields
 *      (marketing.googleAds 20→25 and marketing.otherLeads 40→45), and must
 *      NOT render a gbpLocations row (the parser returned none).
 *   4. Click button-apply-import, then the header Save (flushes the
 *      marketing autosave) and assert the PUT /sections/marketing body:
 *      data.totalLeads === 70 (never the Other-suppressed 25) and
 *      data.otherLeads.count === 45 (never 0 / stale 40).
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import) —
 * the same harness as the #2790 template.
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
  { pretendToBeVisual: true, url: "http://localhost/reports/report-2799" },
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
  id: "user-2799",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

// A hide-Other client WITHOUT the GBP product: calculatedTotalLeads skips the
// GBP-locations sum entirely (hasGbpProduct === false) and the raw total is
// non-GBP sources + Other. Persisted sections must still carry RAW totals.
const hideOtherNoGbpClient = {
  id: "client-2799",
  firmName: "No GBP Firm",
  contactName: "Test Contact",
  products: ["google_ads"],
  hideOtherLeads: true,
  terminology: null,
};

const zeroQuality = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

// Existing saved report: raw 60 = 20 Google Ads + 40 Other, NO GBP locations.
const reportFixture = {
  id: "report-2799",
  clientId: "client-2799",
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
        totalLeads: 60,
        posture: "stable",
        gbpLeadQuality: zeroQuality,
        googleAdsEnabled: true,
        googleAds: {
          uniqueLeads: 20,
          adSpend: 0,
          leadQuality: { good: 15, notQuotable: 5, missedCalls: 0, noData: 0 },
        },
        gbp: { locations: [] },
        otherLeads: {
          count: 40,
          description: "Referrals: 40",
          leadQuality: zeroQuality,
        },
      },
    },
  ],
};

// New PDF (reimport parse result): RAW 70 = 25 Google Ads + 45 Other. No
// gbpLocations key at all — the parser found none, matching a client whose
// lead sources are entirely non-GBP. The parsed marketing.totalLeads (70) is
// the raw PDF headline — reference-only in the dialog; the editor recomputes
// totalLeads from the applied sources through the hasGbpProduct===false branch.
const reimportParsed = {
  reportMonth: "2026-06",
  clientName: "No GBP Firm",
  marketing: {
    totalLeads: 70,
    googleAds: {
      uniqueLeads: 25,
      adSpend: 0,
      leadQuality: { good: 20, notQuotable: 5, missedCalls: 0, noData: 0 },
    },
    otherLeads: { total: 45, socialMedia: 45, directCalls: 0, referrals: 0 },
  },
};

// Captured PUT /api/reports/report-2799/sections/<key> bodies, in order.
const sectionSaves: Array<{ sectionKey: string; body: any }> = [];
// Captured POST /api/reports/report-2799/reimport request bodies.
const reimportCalls: Array<any> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "POST",
      path: "/api/reports/report-2799/reimport",
      respond: ({ init }: any) => {
        reimportCalls.push(init?.body ?? null);
        return {
          status: 200,
          json: { reportId: "report-2799", parsed: reimportParsed },
        };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-2799\/sections\/([^/?]+)$/,
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
      test: (url: string) => /^\/api\/reports\/report-2799$/.test(url),
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
    { path: "/api/clients", json: [hideOtherNoGbpClient] },
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
// Mount the real ReportForm for the existing hide-Other, no-GBP report.
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
  `clicking Re-parse from Source must POST /api/reports/report-2799/reimport ` +
    `exactly once, got ${reimportCalls.length} calls`,
);

// ===========================================================================
// Step 2 — the consent dialog opens with BOTH changed non-GBP fields
// pre-checked, and NO gbpLocations row (the parser returned none).
// ===========================================================================
const dialog = $("dialog-import-review");
assert(dialog, "the import-review consent dialog must open after the reimport parse");

assert(
  !$("checkbox-marketing.gbpLocations"),
  "checkbox-marketing.gbpLocations must NOT render — the parsed PDF for this " +
    "non-GBP client returned no gbpLocations, so the field belongs in the " +
    '"Not found in PDF" list, not the checkable rows',
);

const googleAdsCheckbox = $("checkbox-marketing.googleAds");
assert(googleAdsCheckbox, "checkbox-marketing.googleAds must render in the consent dialog");
assert(
  googleAdsCheckbox!.getAttribute("data-state") === "checked",
  `marketing.googleAds (20 → 25 leads) must be PRE-checked in the consent dialog, ` +
    `got data-state="${googleAdsCheckbox!.getAttribute("data-state")}"`,
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
// Step 4 — the persisted marketing section carries the RAW totals through the
// hasGbpProduct === false branch of calculatedTotalLeads.
// ===========================================================================
const marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
assert(
  marketingSaves.length > 0,
  `clicking Save must flush a PUT /api/reports/report-2799/sections/marketing ` +
    `(captured section saves: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
const savedMarketing = marketingSaves[marketingSaves.length - 1].body?.data ?? {};

assert(
  savedMarketing.totalLeads !== 25,
  `the persisted marketing.totalLeads must NEVER be the Other-suppressed 25 for a ` +
    `hide-Other client without the GBP product — hideOtherLeads is display-time ` +
    `only; the raw total was dropped from persistence on the no-GBP branch ` +
    `(got ${JSON.stringify(savedMarketing.totalLeads)})`,
);
assert(
  savedMarketing.totalLeads === 70,
  `the persisted marketing.totalLeads must be the RAW 70 (25 Google Ads + 45 ` +
    `Other) computed through the hasGbpProduct === false branch, ` +
    `got ${JSON.stringify(savedMarketing.totalLeads)}`,
);
assert(
  savedMarketing.otherLeads?.count === 45,
  `the persisted marketing.otherLeads.count must be the reimported 45 (never 0 ` +
    `or the stale 40), got ${JSON.stringify(savedMarketing.otherLeads?.count)}`,
);

// The applied Google Ads source carries the reimported 25 leads.
assert(
  savedMarketing.googleAds?.uniqueLeads === 25,
  `the persisted googleAds.uniqueLeads must be the reimported 25, ` +
    `got ${JSON.stringify(savedMarketing.googleAds?.uniqueLeads)}`,
);

// No GBP rows were minted for this GBP-less client.
const savedLocations = savedMarketing.gbp?.locations ?? [];
assert(
  savedLocations.length === 0,
  `the persisted gbp.locations must stay empty for a client without the GBP ` +
    `product and a parse with no gbpLocations, got ${JSON.stringify(savedLocations)}`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings(
  "report-reimport-hide-other-no-gbp.test.tsx",
);

console.log(
  "report-reimport-hide-other-no-gbp.test.tsx: PASS — for a hide-Other client " +
    "WITHOUT the GBP product, the reimport consent dialog pre-checks " +
    "googleAds + otherLeads (no gbpLocations row), and the applied save " +
    "persists RAW totalLeads 70 with otherLeads.count 45 (never the " +
    "Other-suppressed 25) through the hasGbpProduct === false branch",
);
process.exit(0);
