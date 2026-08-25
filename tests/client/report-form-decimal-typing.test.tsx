/* test-registration
{
  "name": "Report editor decimal TYPING — draft-state DecimalInput keeps '8.' while typing (Task #2768)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2768: manual decimal TYPING in the report editor. The parseInt→ safeNumber lint (gated below) cannot catch the controlled-input keystroke bug (safeNumber(\"8.\") === 8 re-renders the field as \"8\"), so the rendered keystroke test is the only guard for the reported bug class. Deterministic jsdom render of the real ReportForm — no DB, fully stubbed fetch.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/client/report-form-heavy-deps-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #2768 — Decimals can be TYPED into decimal-capable report-editor fields.
 *
 * Root cause guarded: a controlled `type="number"` input that parses on every
 * keystroke (`safeNumber(e.target.value)`) cannot hold the intermediate "8."
 * state — safeNumber("8.") === 8, so the re-render strips the dot before the
 * next digit lands. The prior parseInt→safeNumber fix (Task #2756) made PDF
 * import work but manual typing still failed.
 *
 * The fix is the shared `DecimalInput` component in ReportForm.tsx: it keeps a
 * string DRAFT of exactly what the user typed while focused, commits the
 * safeNumber-parsed value to form state on each change, and re-syncs the
 * display from the committed number on blur (normalizing "8." → "8").
 *
 * This test mounts the REAL ReportForm page (same harness as
 * report-editor-back-button.test.tsx), switches to the Intake tab, and drives
 * the Avg Time to Human Answer field through the exact keystroke sequence from
 * the bug report:
 *
 *   1. Type "8" → "8." → "8.5": the displayed value must keep the trailing
 *      decimal point at every step (never re-render "8." as "8").
 *   2. Blur after "8.5": display stays "8.5" — and because blur clears the
 *      draft, the post-blur display comes from COMMITTED form state, proving
 *      the committed value is 8.5 (not 8).
 *   3. Type "8." then blur: display normalizes to "8" (committed value 8).
 *   4. Non-numeric garbage ("8.5x") is rejected — display stays "8.5".
 *   5. Sales tab: Deal Touch Density accepts "0.62" the same way (the same
 *      DecimalInput is bound to every decimal-capable field).
 *
 * Heavy leaf components (ObjectUploader / InteractiveHeatmap / HeatmapPicker)
 * are stubbed by report-form-heavy-deps-setup.mjs (registered via --import).
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
  { pretendToBeVisual: true, url: "http://localhost/reports/report-2768" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLDivElement = dom.window.HTMLDivElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
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
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
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
  id: "user-2768",
  email: "editor@test.local",
  firstName: "Report",
  lastName: "Editor",
  role: "ceo",
};

(globalThis as any).fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: testUser },
    {
      // Editing an EXISTING report renders the tabbed editor directly (the
      // new-report flow gates behind a client/month picker first).
      test: (url: string) => /^\/api\/reports\/report-2768$/.test(url),
      json: {
        id: "report-2768",
        clientId: "client-2768",
        reportMonth: "2026-06",
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
    {
      // Marketing-tab ad-spend cards only render when the client has the
      // matching paid product (Task #2770 scenario 6).
      path: "/api/clients",
      json: [
        {
          id: "client-2768",
          name: "Decimal Test Client",
          products: ["google_ads", "lsa"],
          terminology: null,
        },
      ],
    },
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

// React overrides the input value setter on controlled inputs — use the
// native prototype setter, then dispatch a bubbling `input` event so React's
// onChange sees the new value.
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLInputElement.prototype,
  "value",
)!.set!;

async function typeValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeValueSetter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function blurInput(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    const FE = (dom.window as any).FocusEvent ?? dom.window.Event;
    input.dispatchEvent(new FE("focusout", { bubbles: true }));
    input.dispatchEvent(new FE("blur", { bubbles: false }));
  });
}

async function clickTab(testid: string): Promise<void> {
  const trigger = $(testid);
  assert(trigger, `${testid} trigger must render`);
  await act(async () => {
    // Radix tab triggers activate on mousedown (plus click for safety).
    trigger!.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    trigger!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await flush(4);
}

// ---------------------------------------------------------------------------
// Mount the real ReportForm at /reports/new?clientId=... (new-report flow).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Scenario 1-4: Avg Time to Human Answer (Intake tab).
// ---------------------------------------------------------------------------
await clickTab("tab-intake");

const avgInput = $("input-avg-time-to-answer") as HTMLInputElement | null;
assert(avgInput, "input-avg-time-to-answer must render on the Intake tab");

// 1. Keystroke sequence "8" → "8." → "8.5": the dot must never be stripped.
await typeValue(avgInput!, "8");
assert(
  avgInput!.value === "8",
  `after typing "8" the field must show "8" (got "${avgInput!.value}")`,
);
await typeValue(avgInput!, "8.");
assert(
  avgInput!.value === "8.",
  `after typing "8." the field must KEEP the decimal point (got "${avgInput!.value}") — this is the reported bug`,
);
await typeValue(avgInput!, "8.5");
assert(
  avgInput!.value === "8.5",
  `after typing "8.5" the field must show "8.5" (got "${avgInput!.value}")`,
);

// 4. Garbage is rejected: the draft keeps the last valid value.
await typeValue(avgInput!, "8.5x");
assert(
  avgInput!.value === "8.5",
  `non-numeric input must be rejected — field must stay "8.5" (got "${avgInput!.value}")`,
);

// 2. Blur after "8.5": draft clears, display now comes from COMMITTED form
// state — so "8.5" here proves the committed value is 8.5.
await blurInput(avgInput!);
assert(
  avgInput!.value === "8.5",
  `after blur the committed form state must render "8.5" (got "${avgInput!.value}") — the committed number must be 8.5, not 8`,
);

// 3. Trailing-dot normalization: "8." blurs to "8" (committed 8).
await typeValue(avgInput!, "8.");
assert(avgInput!.value === "8.", "trailing-dot draft shows while focused");
await blurInput(avgInput!);
assert(
  avgInput!.value === "8",
  `blur must normalize "8." to the committed "8" (got "${avgInput!.value}")`,
);

// ---------------------------------------------------------------------------
// Task #2771: pasting locale/currency-formatted values from spreadsheets.
// Paste lands as a single input event with the full pasted string.
// ---------------------------------------------------------------------------
await typeValue(avgInput!, "1,000.50");
assert(
  avgInput!.value === "1000.50",
  `pasting "1,000.50" must strip the comma and show "1000.50" (got "${avgInput!.value}")`,
);
await blurInput(avgInput!);
assert(
  avgInput!.value === "1000.5",
  `after blur the committed value must be 1000.5 (got "${avgInput!.value}")`,
);
await typeValue(avgInput!, "$1,000.50");
assert(
  avgInput!.value === "1000.50",
  `pasting "$1,000.50" must strip "$" and comma (got "${avgInput!.value}")`,
);
await blurInput(avgInput!);
assert(
  avgInput!.value === "1000.5",
  `after blur "$1,000.50" must commit 1000.5 (got "${avgInput!.value}")`,
);
// Truly non-numeric paste is still rejected (last committed value kept).
await typeValue(avgInput!, "N/A");
assert(
  avgInput!.value === "1000.5",
  `non-numeric paste must be rejected (got "${avgInput!.value}")`,
);

// ---------------------------------------------------------------------------
// Scenario 5: Deal Touch Density (Sales tab) uses the same DecimalInput.
// ---------------------------------------------------------------------------
await clickTab("tab-sales");

const densityInput = $("input-deal-touch-density") as HTMLInputElement | null;
assert(densityInput, "input-deal-touch-density must render on the Sales tab");

await typeValue(densityInput!, "0");
await typeValue(densityInput!, "0.");
assert(
  densityInput!.value === "0.",
  `Deal Touch Density must keep "0." while typing (got "${densityInput!.value}")`,
);
await typeValue(densityInput!, "0.62");
assert(
  densityInput!.value === "0.62",
  `Deal Touch Density must show "0.62" (got "${densityInput!.value}")`,
);
await blurInput(densityInput!);
assert(
  densityInput!.value === "0.62",
  `Deal Touch Density committed state must render "0.62" after blur (got "${densityInput!.value}")`,
);

// ---------------------------------------------------------------------------
// Scenario 6 (Task #2770): Google Ads Spend (Marketing tab) uses the same
// DecimalInput — lock a third usage site so a Marketing-tab refactor can't
// silently regress decimal typing there.
// ---------------------------------------------------------------------------
await clickTab("tab-marketing");

const adSpendInput = $("input-google-ads-spend") as HTMLInputElement | null;
assert(adSpendInput, "input-google-ads-spend must render on the Marketing tab");

await typeValue(adSpendInput!, "1");
await typeValue(adSpendInput!, "12");
await typeValue(adSpendInput!, "12.");
assert(
  adSpendInput!.value === "12.",
  `Google Ads Spend must keep "12." while typing (got "${adSpendInput!.value}")`,
);
await typeValue(adSpendInput!, "12.5");
assert(
  adSpendInput!.value === "12.5",
  `Google Ads Spend must show "12.5" (got "${adSpendInput!.value}")`,
);
await blurInput(adSpendInput!);
assert(
  adSpendInput!.value === "12.5",
  `Google Ads Spend committed state must render "12.5" after blur (got "${adSpendInput!.value}") — the committed number must be 12.5, not 12`,
);

// ---------------------------------------------------------------------------
// Scenario 7 (Task #2773): LSA Ad Spend (Marketing tab) is the LAST DecimalInput
// usage site — lock it with a rendered keystroke assertion so a refactor of the
// LSA card can't silently break decimal typing there. The fetch stub already
// seeds the client with the "lsa" product, and lsaEnabled defaults to true.
// ---------------------------------------------------------------------------
const lsaAdSpendInput = $("input-lsa-ad-spend") as HTMLInputElement | null;
assert(lsaAdSpendInput, "input-lsa-ad-spend must render on the Marketing tab");

await typeValue(lsaAdSpendInput!, "9");
await typeValue(lsaAdSpendInput!, "9.");
assert(
  lsaAdSpendInput!.value === "9.",
  `LSA Ad Spend must keep "9." while typing (got "${lsaAdSpendInput!.value}")`,
);
await typeValue(lsaAdSpendInput!, "9.9");
await typeValue(lsaAdSpendInput!, "9.99");
assert(
  lsaAdSpendInput!.value === "9.99",
  `LSA Ad Spend must show "9.99" (got "${lsaAdSpendInput!.value}")`,
);
await blurInput(lsaAdSpendInput!);
assert(
  lsaAdSpendInput!.value === "9.99",
  `LSA Ad Spend committed state must render "9.99" after blur (got "${lsaAdSpendInput!.value}") — the committed number must be 9.99, not 9`,
);

await act(async () => {
  root.unmount();
});

keyWarningGuard.assertNoKeyWarnings("report-form-decimal-typing.test.tsx");

console.log(
  "report-form-decimal-typing: PASS — typing 8 → 8. → 8.5 keeps the decimal point, " +
    "blur commits 8.5, trailing dot normalizes to 8, garbage rejected, Deal Touch Density accepts 0.62, " +
    "Google Ads Spend (Marketing tab) accepts 12.5, LSA Ad Spend accepts 9.99",
);
process.exit(0);
