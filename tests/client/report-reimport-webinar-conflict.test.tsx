/* test-registration
{
  "name": "Webinar edit conflict surfaces INLINE in the reimport review dialog (Task #2852)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2852: the flagged webinar edit conflict must surface INLINE in the reimport review dialog — Webinars row pre-UNCHECKED + conflict badge when the server flags reconciliation.webinarLeadQualityDiffers, unchecked Apply keeps the operator's hand-corrected breakdown, explicit check still overwrites. The Task #2842 toast alone is dismissible, so this rendered gate is the only guard against a pre-checked default silently reverting operator corrections. Same deterministic jsdom render profile — no DB, fully stubbed fetch.",
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
 * Task #2852 — The webinar edit conflict must surface INSIDE the reimport
 * review dialog, not just as a dismissible toast.
 *
 * Task #2842 made the reimport route flag
 * `reconciliation.webinarLeadQualityDiffers` when the parsed PDF's webinar
 * Lead Quality breakdown differs from the saved (possibly hand-corrected)
 * one, and the editor showed a toast. But a toast can be missed/dismissed,
 * and the Webinars row was still PRE-CHECKED (its value differs), so one
 * absent-minded Apply overwrote the operator's corrections.
 *
 * This test mounts the REAL ReportForm and drives the real reimport flow in
 * jsdom against a stubbed reimport response carrying the flag:
 *
 *   1. The review dialog's Webinars row must start UNCHECKED (keeping the
 *      operator's breakdown is the default) even though the parsed value
 *      differs — while a differing non-webinar field (gbpLocations 60→65)
 *      stays pre-checked, proving the uncheck is conflict-targeted, not a
 *      broken default-check pass.
 *   2. The row must carry the inline conflict badge + hint
 *      (badge-webinar-conflict / text-webinar-conflict-hint).
 *   3. Apply with Webinars unchecked → the flushed marketing section PUT
 *      keeps the operator's breakdown (5G/2NQ/1M) while still applying the
 *      checked GBP change (65 leads).
 *   4. Reimport again, explicitly CHECK Webinars, apply → the PUT now
 *      carries the parsed breakdown (8G/0NQ/0M) — checked still overwrites.
 *
 * Heavy leaf deps + the Radix Dialog portal are stubbed by
 * report-reimport-hide-other-consent-setup.mjs (registered via --import).
 */

import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/reports/report-2852" },
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
  id: "user-2852",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

const client = {
  id: "client-2852",
  firmName: "Webinar Conflict Firm",
  contactName: "Test Contact",
  products: ["gbp", "webinar"],
  hideOtherLeads: false,
  terminology: null,
};

const zeroQuality = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

// The operator's manually-corrected webinar breakdown that must survive an
// apply with Webinars unchecked.
const EDITED_WEBINAR_LQ = { good: 5, notQuotable: 2, missedCalls: 1, noData: 0 };
// The PDF's (differing) parsed breakdown that applies only on explicit check.
const PARSED_WEBINAR_LQ = { good: 8, notQuotable: 0, missedCalls: 0, noData: 0 };

const reportFixture = {
  id: "report-2852",
  clientId: "client-2852",
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
        totalLeads: 68,
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
        webinar: {
          registrants: 50,
          attendees: 30,
          hotTransfers: 8,
          leadQuality: EDITED_WEBINAR_LQ,
        },
        otherLeads: { count: 0, description: "", leadQuality: zeroQuality },
      },
    },
  ],
};

// The reimported PDF parse: gbpLocations changed (60 → 65, a normal
// pre-checked overwrite) and the webinar breakdown DIFFERS from the operator's
// edits — the server flags it via reconciliation.webinarLeadQualityDiffers.
const reimportParsed = {
  reportMonth: "2026-06",
  clientName: "Webinar Conflict Firm",
  marketing: {
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
    webinar: {
      registrants: 50,
      attendees: 30,
      hotTransfers: 8,
      leadQuality: PARSED_WEBINAR_LQ,
    },
  },
};

const sectionSaves: Array<{ sectionKey: string; body: any }> = [];
const reimportCalls: Array<any> = [];

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      method: "POST",
      path: "/api/reports/report-2852/reimport",
      respond: ({ init }: any) => {
        reimportCalls.push(init?.body ?? null);
        return {
          status: 200,
          json: {
            reportId: "report-2852",
            parsed: reimportParsed,
            // Task #2842 server flag — the subject of this test.
            reconciliation: { webinarLeadQualityDiffers: true },
          },
        };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/reports\/report-2852\/sections\/([^/?]+)$/,
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
      test: (url: string) => /^\/api\/reports\/report-2852$/.test(url),
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
    { path: "/api/clients", json: [client] },
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

// ===========================================================================
// Step 1 — trigger the reimport; the review dialog opens with the conflict
// surfaced INLINE: Webinars unchecked + badge, gbpLocations still pre-checked.
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
  `clicking Re-parse from Source must POST the reimport exactly once, got ${reimportCalls.length}`,
);
assert($("dialog-import-review"), "the import-review dialog must open after the reimport parse");

const webinarCheckbox = $("checkbox-marketing.webinar");
assert(webinarCheckbox, "checkbox-marketing.webinar must render in the review dialog");
assert(
  webinarCheckbox!.getAttribute("data-state") === "unchecked",
  `the Webinars row must start UNCHECKED when the server flags ` +
    `reconciliation.webinarLeadQualityDiffers — a pre-checked default is the ` +
    `"one absent-minded Apply overwrites the operator's corrections" failure ` +
    `mode; got data-state="${webinarCheckbox!.getAttribute("data-state")}"`,
);

// Control: a differing NON-webinar field stays pre-checked, proving the
// uncheck above is conflict-targeted rather than a broken default-check pass.
const gbpCheckbox = $("checkbox-marketing.gbpLocations");
assert(gbpCheckbox, "checkbox-marketing.gbpLocations must render in the review dialog");
assert(
  gbpCheckbox!.getAttribute("data-state") === "checked",
  `marketing.gbpLocations (60 → 65) must remain PRE-checked; ` +
    `got data-state="${gbpCheckbox!.getAttribute("data-state")}"`,
);

assert(
  $("badge-webinar-conflict"),
  "the Webinars row must carry the inline badge-webinar-conflict when the server flags the conflict",
);
assert(
  $("text-webinar-conflict-hint"),
  "the Webinars row must render the inline text-webinar-conflict-hint explanation",
);

// ===========================================================================
// Step 2 — Apply with Webinars UNCHECKED, then Save: the flushed marketing
// PUT keeps the operator's breakdown while applying the checked GBP change.
// ===========================================================================
await clickEl($("button-apply-import")!);
assert(!$("dialog-import-review"), "the review dialog must close after Apply Selected Fields");

sectionSaves.length = 0;
const saveButton = $("button-save-status");
assert(saveButton, "button-save-status (Save) must render");
await clickEl(saveButton!);
await flush(6);

let marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
assert(
  marketingSaves.length > 0,
  `Save must flush a PUT sections/marketing (captured: ${JSON.stringify(sectionSaves.map((s) => s.sectionKey))})`,
);
let savedMarketing = marketingSaves[marketingSaves.length - 1].body?.data ?? {};
let savedWebinarLq =
  (savedMarketing.webinar || savedMarketing.webinars)?.leadQuality ?? null;
assert(
  savedWebinarLq &&
    savedWebinarLq.good === EDITED_WEBINAR_LQ.good &&
    savedWebinarLq.notQuotable === EDITED_WEBINAR_LQ.notQuotable &&
    savedWebinarLq.missedCalls === EDITED_WEBINAR_LQ.missedCalls,
  `applying with Webinars UNCHECKED must persist the operator's edited ` +
    `breakdown ${JSON.stringify(EDITED_WEBINAR_LQ)}, got ${JSON.stringify(savedWebinarLq)}`,
);
const savedLocations = savedMarketing.gbp?.locations ?? [];
assert(
  savedLocations.length === 1 && savedLocations[0].uniqueLeads === 65,
  `the checked gbpLocations change must still apply (65 leads), got ${JSON.stringify(savedLocations)}`,
);

// ===========================================================================
// Step 3 — reimport again, explicitly CHECK Webinars, apply + Save: checked
// still overwrites with the parsed breakdown (current behavior preserved).
// ===========================================================================
await clickEl($("button-reimport-from-source")!);
await flush(6);
assert($("dialog-import-review"), "the review dialog must open on the second reimport");

const webinarCheckbox2 = $("checkbox-marketing.webinar");
assert(webinarCheckbox2, "checkbox-marketing.webinar must render on the second reimport");
assert(
  webinarCheckbox2!.getAttribute("data-state") === "unchecked",
  "the Webinars row must start unchecked again on the second conflicted reimport",
);
await clickEl(webinarCheckbox2!);
assert(
  $("checkbox-marketing.webinar")!.getAttribute("data-state") === "checked",
  "explicitly clicking the Webinars checkbox must check it (opt-in overwrite)",
);

await clickEl($("button-apply-import")!);
sectionSaves.length = 0;
await clickEl($("button-save-status")!);
await flush(6);

marketingSaves = sectionSaves.filter((s) => s.sectionKey === "marketing");
assert(marketingSaves.length > 0, "the second Save must flush a PUT sections/marketing");
savedMarketing = marketingSaves[marketingSaves.length - 1].body?.data ?? {};
savedWebinarLq = (savedMarketing.webinar || savedMarketing.webinars)?.leadQuality ?? null;
assert(
  savedWebinarLq &&
    savedWebinarLq.good === PARSED_WEBINAR_LQ.good &&
    savedWebinarLq.notQuotable === PARSED_WEBINAR_LQ.notQuotable &&
    savedWebinarLq.missedCalls === PARSED_WEBINAR_LQ.missedCalls,
  `applying with Webinars explicitly CHECKED must persist the parsed ` +
    `breakdown ${JSON.stringify(PARSED_WEBINAR_LQ)}, got ${JSON.stringify(savedWebinarLq)}`,
);

await act(async () => {
  root.unmount();
});

console.log(
  "report-reimport-webinar-conflict.test.tsx: PASS — the flagged webinar " +
    "conflict surfaces inline in the review dialog (unchecked row + badge + " +
    "hint), unchecked Apply keeps the operator's breakdown, and an explicit " +
    "check still applies the parsed one",
);
process.exit(0);
