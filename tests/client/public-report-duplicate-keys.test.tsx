/* test-registration
{
  "name": "Public report deck — duplicate React keys trip the render-health guard (Task #4702)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4692 fixed two duplicate-key sources on the client-facing Marketing slide (GBP location cards keyed by a name that repeats on multi-location firms after the share sanitizer strips `id`; heatmap cards keyed by a snapshotId repeating across locations) — found only by manual console inspection in the #4671 go-live parity audit. This suite renders the FULL public deck over a share payload reproducing exactly those shapes (two locations with the same name and no id, a heatmapSnapshotId shared across both) and fails on React's 'Encountered two children with the same key' dev warning via the shared reactKeyWarningGuard, plus a negative control proving the guard actually fires on the pre-#4692 keying. Since Task #4848 the map zone renders ONE card per location (distinct keywords as pills), so the render-health count asserts both per-location cards and both LOC_ONE pills are in the DOM. Without it, the next keyed-list regression on a client deck ships silently again.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4702 — automatic duplicate-React-key detection for client report decks.
 *
 * Scenarios:
 *   (R) Regression-shape render: the full PublicReport deck mounts over a
 *       share payload carrying the exact #4692 shapes —
 *         - TWO GBP locations named "Main Office" with NO `id` (the public
 *           share sanitizer strips ids, so pre-#4692 the card key was the
 *           repeating name);
 *         - a heatmapSnapshotId ("hs-shared") present on BOTH locations (the
 *           pre-#4692 heatmap-card key), alongside a per-location id.
 *       The shared reactKeyWarningGuard (extended in this task to also trap
 *       "Encountered two children with the same key") must capture ZERO
 *       warnings, and both same-name cards / both per-location heatmap cards
 *       (Task #4848: one card per LOCATION — LOC_ONE's two distinct keywords
 *       render as two pills on its card) must actually be in the DOM
 *       (duplicate keys make React DROP children — counting them is the
 *       render-health half of the check).
 *   (C) Negative control: a minimal list keyed the pre-#4692 way (key =
 *       loc.name / key = snapshotId) over the same fixture data MUST make the
 *       guard capture the duplicate-key warning — proving the check catches
 *       the regression rather than vacuously passing.
 *
 * Harness is the same jsdom + review-velocity loader kit the other rendered
 * report suites use (recharts passthrough shim, InteractiveHeatmap stubbed).
 */

import { register } from "node:module";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

register("./review-velocity-render-loader.mjs", import.meta.url);

// Deck-wide guard: installed before ANY React evaluation/render, asserted at
// the very end — scenario (R) must produce zero key warnings.
const deckGuard = installReactKeyWarningGuard();

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/share/test-token" },
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
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(dom.window.HTMLElement.prototype as any).scrollIntoView =
  (dom.window.HTMLElement.prototype as any).scrollIntoView || function () {};
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
class IntersectionObserverStub {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
(globalThis as any).IntersectionObserver = IntersectionObserverStub;
(dom.window as any).IntersectionObserver = IntersectionObserverStub;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true;
(dom.window as any).confirm = () => true;
(globalThis as any).scrollTo = () => {};
(dom.window as any).scrollTo = () => {};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Fixture — the #4692 regression shapes, post-sanitizer:
//   - two locations with IDENTICAL names and NO id;
//   - "hs-shared" appears in BOTH locations' heatmapSnapshotIds.
// ---------------------------------------------------------------------------
const DUP_NAME = "Main Office";

const LOC_ONE = {
  // no `id` — the public share sanitizer strips it
  name: DUP_NAME,
  uniqueLeads: 100,
  reviewsGenerated: 12,
  reviewsRespondedTo: 10,
  postsQaCount: 6,
  leadQuality: { good: 70, notQuotable: 20, missedCalls: 10, noData: 0 },
  heatmapSnapshotIds: ["hs-shared", "hs-one"],
  localDominance: {
    keywordSnapshots: [
      { snapshotId: "hs-shared", keywordName: "personal injury lawyer", avgRank: 2.4, rankChange: 1.2 },
      { snapshotId: "hs-one", keywordName: "car accident lawyer", avgRank: 3.1, rankChange: 0 },
    ],
  },
};

const LOC_TWO = {
  name: DUP_NAME,
  uniqueLeads: 30,
  reviewsGenerated: 3,
  reviewsRespondedTo: 2,
  postsQaCount: 1,
  leadQuality: { good: 15, notQuotable: 10, missedCalls: 5, noData: 0 },
  // Same snapshotId as LOC_ONE — sanitized share payloads can repeat it
  // across locations (the second #4692 duplicate-key source).
  heatmapSnapshotIds: ["hs-shared"],
  localDominance: {
    keywordSnapshots: [
      { snapshotId: "hs-shared", keywordName: "personal injury lawyer", avgRank: 4.0, rankChange: -0.5 },
    ],
  },
};

const shareFixture = {
  report: {
    id: "r-dupkeys",
    clientId: "c1",
    reportMonth: "2026-04",
    status: "final",
    title: "April 2026 Report",
    hideLeadQuality: false,
  },
  client: {
    id: "c1",
    firmName: "Duplicate Keys Law Firm",
    contactName: "Test Contact",
    consultType: "standard",
    products: ["gbp", "google_ads"],
    terminology: null,
    hideOtherLeads: false,
  },
  slideVerdicts: { marketing: "GBP is carrying growth across both offices." },
  sections: [
    {
      sectionKey: "marketing",
      data: {
        posture: "scaling",
        gbp: { locations: [LOC_ONE, LOC_TWO] },
        googleAds: {
          uniqueLeads: 40,
          adSpend: 2000,
          costPerLead: 50,
          leadQuality: { good: 20, notQuotable: 15, missedCalls: 5, noData: 0 },
        },
        otherLeads: { count: 0, description: "" },
      },
    },
    { sectionKey: "intake", data: { totalLeads: 170, totalConsults: 20, leadToConsultRate: 11.8 } },
    { sectionKey: "sales", data: {} },
  ],
  trendData: [
    { month: "2026-03", marketing: { totalLeads: 150, leadsBySource: { gbp: 110, googleAds: 40 } } },
    { month: "2026-04", marketing: { totalLeads: 170, leadsBySource: { gbp: 130, googleAds: 40 } } },
  ],
  dataAccess: [],
};

const React = (await import("react")).default;
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

// ---------------------------------------------------------------------------
// Scenario (R): full-deck render over the regression-shape payload
// ---------------------------------------------------------------------------
{
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      { path: "/api/share", json: shareFixture },
      { path: "/api/phase-settings", json: [] },
      { path: "/api/public/heatmaps", json: {} },
      { path: "/api/auth/user", json: null, status: 401 },
    ],
    defaultJson: {},
  }) as any;

  const PublicReport = (await import("@/pages/PublicReport")).default;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });

  const container = dom.window.document.getElementById("root")!;
  let root: any;
  await act(async () => {
    root = ReactDOMClient.createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(PublicReport as any),
      ),
    );
  });
  await flush(0);
  await flush(0);
  await flush(0);

  const doc = dom.window.document;
  const slide = doc.querySelector("#marketing");
  assert(slide, "(R) marketing slide (#marketing) must render");

  // Render-health half: duplicate keys make React DROP children, so count them.
  const locationCards = slide!.querySelectorAll('[data-testid="card-gbp-location-main-office"]');
  assert(
    locationCards.length === 2,
    `(R) BOTH same-name location cards must be in the DOM (duplicate keys would collapse them), got ${locationCards.length}`,
  );
  // Task #4848 — one card per LOCATION: LOC_ONE's two distinct keywords
  // (hs-shared + hs-one) group into pills on ONE card; LOC_TWO renders its
  // own card even though its snapshotId repeats LOC_ONE's (the cross-location
  // duplicate-id shape the #4692 keying regressed on).
  const heatmapCards = slide!.querySelectorAll('[data-testid^="card-heatmap-"]');
  assert(
    heatmapCards.length === 2,
    `(R) both per-location heatmap cards (hs-shared+hs-one grouped, hs-shared again) must render, got ${heatmapCards.length}`,
  );
  const locOnePills = slide!.querySelectorAll('[data-testid^="pill-heatmap-0-"]');
  assert(
    locOnePills.length === 2,
    `(R) LOC_ONE's two distinct keywords render as two pills (dropped pills = keyed-list regression), got ${locOnePills.length}`,
  );

  await act(async () => { root.unmount(); });

  // Warning half: the extended guard captured neither the missing-key nor
  // the duplicate-key warning during the full-deck render.
  assert(
    deckGuard.getKeyWarnings().length === 0,
    `(R) full-deck render over the #4692 shapes must emit zero key warnings, got:\n` +
      deckGuard.getKeyWarnings().join("\n"),
  );

  console.log("scenario R (regression-shape full-deck render) PASSED");
}

// ---------------------------------------------------------------------------
// Scenario (C): negative control — the PRE-#4692 keying must trip the guard.
// This proves the check would have caught the shipped regression (and will
// catch the next one) instead of vacuously passing.
// ---------------------------------------------------------------------------
{
  // Isolated capture scoped to the control render: installReactKeyWarningGuard
  // CHAINS to the previous console.error, so a second guard instance would
  // forward the deliberate duplicate warning into the deck guard's capture and
  // fail the final assert. Swap console.error out entirely for this block.
  const controlCaptured: string[] = [];
  const deckHookedError = console.error;
  console.error = (...args: unknown[]) => {
    controlCaptured.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };

  const locations = [LOC_ONE, LOC_TWO];
  const heatmapEntries = locations.flatMap((loc) =>
    loc.heatmapSnapshotIds.map((id) => ({ locName: loc.name, snapshotId: id })),
  );

  // Exactly the pre-#4692 key choices: location cards keyed by the (repeating)
  // name, heatmap cards keyed by the (repeating) snapshotId.
  function OldKeyedLists() {
    return React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        null,
        locations.map((loc) =>
          React.createElement("div", { key: loc.name }, loc.name),
        ),
      ),
      React.createElement(
        "div",
        null,
        heatmapEntries.map((entry) =>
          React.createElement("div", { key: entry.snapshotId }, entry.locName),
        ),
      ),
    );
  }

  const controlHost = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(controlHost);
  let controlRoot: any;
  await act(async () => {
    controlRoot = ReactDOMClient.createRoot(controlHost);
    controlRoot.render(React.createElement(OldKeyedLists));
  });
  await act(async () => { controlRoot.unmount(); });
  controlHost.remove();

  console.error = deckHookedError;
  const captured = controlCaptured.filter((w) =>
    /Each child in a list should have a unique "key" prop|Encountered two children with the same key/i.test(w),
  );
  assert(
    captured.length > 0,
    "(C) the pre-#4692 keying (key=name / key=snapshotId over repeating values) MUST trip the guard — it captured nothing",
  );
  assert(
    captured.some((w) => /Encountered two children with the same key/i.test(w)),
    `(C) captured warnings must include React's duplicate-key warning, got:\n${captured.join("\n")}`,
  );

  console.log("scenario C (negative control trips the guard) PASSED");
}

deckGuard.assertNoKeyWarnings("public-report-duplicate-keys.test.tsx");
console.log("public-report-duplicate-keys: PASSED");
