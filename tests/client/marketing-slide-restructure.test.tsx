/* test-registration
{
  "name": "Marketing slide restructure — hierarchy, shared heatmap legend, honest standing line, rated-based quality %, no internal state (Tasks #4280, #4717, #4848, #4914)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4280 (audit §8.7-7 + §8.5): the Marketing slide was restructured from a ~2,890px wall into verdict → hero → KPI tags → ONE source chart → stacked bar + table → GBP thumbnail cards → prominent Paid Search per-channel card (Task #4913) → a Map Rankings grid with ONE shared legend → single-row webinar/review stats. This is the only rendered lock on that hierarchy: Task #4913 re-promoted the paid card the #4280 restructure had demoted to bottom-of-slide 11px chips (which buried spend/CPL below the tall map cards on already-shipped share links — the deck renders live code): the card must sit BETWEEN the GBP zone and Map Rankings with per-channel Google Ads / LSA leads, spend, and CPL at metric-large size plus Total Spend and Blended CPL chips, single-paid-product clients get a single full-width sub-card, and a zero-lead channel reads '–' CPL, never a fabricated $0. Additionally: the donut cluster must stay dead (zero PieCharts), exactly ONE shared heatmap legend from the canonical palette must render with a takeaway line per map, GBP locations must render as thumbnail cards (not full-bleed portraits), internal automation/ops copy must never appear on the slide, and the hero must stay Total Leads in BOTH quality modes (Task #4843 — the operator wants the total as the biggest number on the slide; Good Leads is demoted to the first KPI tag) with exactly one text-total-leads-ht in the DOM (other suites pin its totals). Task #4717 adds the rendered lock on the competitor standing line under the active map's takeaway: derived from averageRank ONLY (never the SoV-ordered rank field or any percentage), absent entirely when a snapshot lacks usable competitor rows, privacy-masked names passing through as-is. Task #4848 replaces one-card-per-snapshot-id with ONE card per LOCATION: distinct keywords become pills, same-keyword weekly SEMrush scans collapse to the LATEST scan (prod shipped ~60 reports whose stored ids repeat one keyword 4×), switching a pill swaps map + keyword label + takeaway + standing, a rank change that rounds to 0.0 reads as holding steady (never 'up 0.0 spots'), and masked duplicates collapse without leaking real keywords. Task #4914 rebases the quality math on RATED leads (owner decision superseding #1028): the KPI card carries a coverage sub-line, the stacked bar sums Good/NQ/Missed to 100% of RATED leads with 'No data' pulled into a muted coverage strip (excluded from % Good but never hidden), per-source % Good shows 'of N rated', and zero-rated months read '—'/'Not yet rated' instead of a fabricated %; scenarios (N)/(Z) pin the no-data-heavy month (55% of 88 rated, never the diluted 20%) and the zero-rated month so the diluted-denominator bug can't return. A drift here quietly regrows the wall (or the four-identical-maps wall), leaks operator state into client-facing reports, or resurrects the share-of-voice framing #4280 killed.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4280 — Marketing slide restructure RENDER contracts.
 *
 * Scenarios:
 *   (P) Populated (gbp + google_ads + lsa + webinar, quality shown):
 *       - server-stored verdict renders (first VerdictLine consumer);
 *       - hero card shows Total Leads (Task #4843 — the total is the biggest
 *         number on the slide; the hero is the ONLY text-total-leads-ht
 *         instance, gold) with no "of N total this month" sub-line;
 *       - all four KPI tags render (good leads / reviews / quality / blended
 *         CPL) — Good Leads is the first tag (green, with an "of N total"
 *         ratio sub-line), demoted from the hero it occupied before #4843;
 *       - exactly ONE Leads-by-Source trend LineChart, ZERO PieCharts and no
 *         donut-era testids (chart-lead-sources-public / chart-legend-public);
 *       - lead-source table renders with an Other row (toggle OFF);
 *       - GBP locations render as thumbnail cards: heatmap thumb <img> when
 *         the location has one, MapPin fallback (no <img>) when not;
 *       - map zone (Task #4848): exactly ONE shared legend carrying every
 *         canonical HEATMAP_RANK_LEGEND label, ONE card per LOCATION,
 *         side-by-side grid for >1 cards, and a one-line takeaway per card
 *         (avgRank wording; EQUAL avgRank across cards is deliberately fine
 *         — different keywords can perform alike). LOC_A stores THREE ids
 *         but only TWO distinct keywords (hs-1-old is an older weekly scan
 *         of hs-1's keyword, listed FIRST) → exactly two pills, the active
 *         map is hs-1 (latest by reportDate, not first-listed), and the
 *         collapsed duplicate never gets a pill. LOC_B has a single keyword
 *         → no pill row at all. Clicking a pill swaps the rendered snapshot
 *         + keyword label + takeaway + standing; hs-2's rankChange (0.04)
 *         rounds to 0.0 and must read "holding steady", never "up 0.0
 *         spots";
 *       - Task #4717 standing line: the hs-1 pill (competitor rows present)
 *         renders ONE standing line derived from averageRank alone —
 *         position/total/name order ignore the served SoV-ordered `rank`
 *         field, the null-averageRank row is dropped and never named, the
 *         subject position is gold-highlighted, and no "%" appears; the
 *         hs-2 pill and LOC_B's card (no competitor rows) render NO
 *         standing line at all (absent, never an empty band);
 *       - paid search renders as a prominent card BETWEEN the GBP zone and
 *         Map Rankings (Task #4913 restored its pre-#4280 position/weight):
 *         combined-leads header, Total Spend + Blended CPL chips, and
 *         per-channel Google Ads / LSA sub-cards carrying leads, spend, and
 *         CPL at metric-large size — the demoted single-row chip treatment
 *         (row-paid-google-ads / row-paid-lsa) must stay dead;
 *       - webinars render as a single-row card;
 *       - the slide's text contains no automation/ops vocabulary.
 *   (C) Single paid channel (google_ads only, lsa data present but INACTIVE):
 *       the paid card renders a single full-width Google Ads sub-card — no
 *       LSA sub-card even though a stale lsa data block sits in the payload
 *       (product flags gate the render, not data presence), no two-column
 *       grid, "Total" (not "Combined") leads label, channels sub-line names
 *       only Google Ads, and the blended chips still render.
 *   (S) Sparse (gbp only, no locations, no trend): the section has NO entered
 *       data, so per the deck-wide empty convention (Task #4285) the slide
 *       collapses to ONE explanatory band — no hero-over-zero, no verdict,
 *       no map zone, no GBP card grid, no paid/webinar cards.
 *   (H) hideLeadQuality: hero still shows Total Leads (text-total-leads-ht
 *       INSIDE the hero card, still exactly one instance), no Good-Leads
 *       element or tag anywhere, no quality KPI tag, and the source table
 *       hides its quality columns.
 *   Task #4982 — Other-leads disclosure sub-line on the hero card
 *       ('includes 25 "Other" leads — not attributed to our campaigns'):
 *       renders in BOTH quality modes ((P) and (H)) since it annotates the
 *       total itself, never adds a second text-total-leads-ht instance, and
 *       is absent on the (S) skeleton where there is nothing to disclose.
 *   (V) privacyApplied (Task #4717): masked payload ("Market A"/"Keyword A",
 *       competitor rows "Competitor A/B", subject "Confidential Client")
 *       renders the standing line with the server-masked names exactly as
 *       served and leaks no unmasked firm/keyword identifiers on the slide.
 *       Task #4848: masked duplicates of one keyword ("Keyword A" twice)
 *       collapse to ONE pill; distinct masked keywords keep their distinct
 *       pills, and switching stays leak-free.
 *   (N) No-data-heavy month (Task #4914 — Cambridge July 2026 shape: 48 good /
 *       40 NQ / 0 missed / 154 no data): quality % is RATED-based everywhere —
 *       KPI card 55% with an "88 of 242 leads rated" coverage sub-line,
 *       header tag 55% Good, stacked bar 55/45 summing to 100% of rated with
 *       NO No-data segment, coverage strip "Rated 88 of 242 (36%) · No data:
 *       154", per-source % Good on rated leads with "of 88 rated" context,
 *       Answer Rate 100 untouched — and the old diluted "20% Good" appears
 *       nowhere.
 *   (Z) Zero-rated month (every lead No data): KPI card renders "—" (never a
 *       0%/100% off an empty denominator) with a "not yet rated" sub-line,
 *       the header tag reads "Not yet rated", the bar is a dashed
 *       placeholder, the coverage strip still reports the honest "Rated 0 of
 *       20 (0%)", and the GBP row shows "—" with a "0 rated" sub-line.
 *
 * Exact Total-Leads arithmetic (463/1007 etc.) stays pinned by
 * tests/client/hide-other-leads-rendered.test.tsx; this suite locks the
 * STRUCTURE the restructure introduced.
 *
 * Heavy browser-only deps are shimmed by the existing
 * `review-velocity-render-loader.mjs` loader (recharts passthrough shim keeps
 * chart `data` queryable; InteractiveHeatmap is stubbed to a marker div
 * exposing its `snapshotId` prop — its hideLegend/height props are
 * typechecked, the shared legend asserted here lives in MarketingSlide
 * itself, and the marker is what lets pill→map switching be asserted).
 */

import { register } from "node:module";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";
import { installReactKeyWarningGuard } from "../helpers/reactKeyWarningGuard.mjs";

register("./review-velocity-render-loader.mjs", import.meta.url);

const keyWarningGuard = installReactKeyWarningGuard();

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

const VERDICT_TEXT = "GBP is carrying growth; paid search is buying the remainder.";

const LOC_A = {
  name: "Main Office",
  uniqueLeads: 100,
  reviewsGenerated: 12,
  reviewsRespondedTo: 10,
  postsQaCount: 6,
  leadQuality: { good: 70, notQuotable: 20, missedCalls: 10, noData: 0 },
  // Task #4848 — the pre-fix auto-pull stored EVERY weekly SEMrush scan, so
  // shipped reports carry same-keyword duplicates. hs-1-old is an OLDER scan
  // of hs-1's keyword and is deliberately listed FIRST: the card must pick
  // hs-1 by reportDate (latest wins), not by array position.
  heatmapSnapshotIds: ["hs-1-old", "hs-1", "hs-2"],
  // Must be an /objects/ path: the Task #4544 scan-image guard fails CLOSED
  // for any other URL shape, so a /fake/... fixture can never render the thumb.
  heatmapImageUrl: "/objects/uploads/thumb-main",
  localDominance: {
    keywordSnapshots: [
      {
        snapshotId: "hs-1",
        keywordName: "personal injury lawyer",
        avgRank: 2.4,
        rankChange: 1.2,
        reportDate: "2026-04-27",
        // Task #4717 — the served `rank` field is SoV-ordered and deliberately
        // CONTRADICTS averageRank order here: the standing line must follow
        // averageRank only (honest-metric rule), so expected position is #2
        // (1.8 < 2.4) and expected name order is Quiet Winner → Big Spender →
        // Fourth Firm. The null-averageRank row is dropped (not counted, not
        // named) → "of 4 firms".
        competitors: [
          { rank: 1, name: "Big Spender Law", shareOfVoice: 48, averageRank: 3.1, isSubjectBusiness: false },
          { rank: 2, name: "Restructure Law Firm", shareOfVoice: 22, averageRank: 2.4, isSubjectBusiness: true },
          { rank: 3, name: "Quiet Winner Legal", shareOfVoice: 9, averageRank: 1.8, isSubjectBusiness: false },
          { rank: 4, name: "Fourth Firm", shareOfVoice: 5, averageRank: 4.0, isSubjectBusiness: false },
          { rank: 5, name: "Unrankable Row", shareOfVoice: 3, averageRank: null, isSubjectBusiness: false },
        ],
      },
      // Task #4848 — older weekly scan of the SAME keyword. Its avgRank is
      // distinct on purpose: if grouping ever picked this snapshot, the
      // takeaway assert on "#2.4 … up 1.2" would fail loudly.
      { snapshotId: "hs-1-old", keywordName: "personal injury lawyer", avgRank: 3.9, rankChange: -0.3, reportDate: "2026-04-13" },
      // Same avgRank as hs-1 on purpose: equal averages across maps are an
      // expected outcome (same scan, different keyword), not a data bug.
      // No competitors key on purpose (legacy snapshot shape) — Task #4717:
      // this pill must render NO standing line. rankChange 0.04 rounds to
      // 0.0 — Task #4848: must read "holding steady", never "up 0.0 spots".
      { snapshotId: "hs-2", keywordName: "car accident lawyer", avgRank: 2.4, rankChange: 0.04, reportDate: "2026-04-15" },
    ],
  },
};

const LOC_B = {
  name: "Satellite",
  uniqueLeads: 30,
  reviewsGenerated: 3,
  reviewsRespondedTo: 2,
  postsQaCount: 1,
  leadQuality: { good: 15, notQuotable: 10, missedCalls: 5, noData: 0 },
  // Task #4848 — single-keyword location: exactly one card, NO pill row.
  // rankChange is exactly 0 → the plain-zero "holding steady" branch.
  // No competitors → no standing line on card 1. No heatmapImageUrl → the
  // GBP thumbnail card keeps its MapPin fallback assert.
  heatmapSnapshotIds: ["hs-3"],
  localDominance: {
    keywordSnapshots: [
      { snapshotId: "hs-3", keywordName: "family lawyer", avgRank: 2.4, rankChange: 0, reportDate: "2026-04-20" },
    ],
  },
};

function buildPopulatedFixture(overrides?: { hideLeadQuality?: boolean }) {
  return {
    report: {
      id: "r1",
      clientId: "c1",
      reportMonth: "2026-04",
      status: "final",
      title: "April 2026 Report",
      hideLeadQuality: overrides?.hideLeadQuality ?? false,
    },
    client: {
      id: "c1",
      firmName: "Restructure Law Firm",
      contactName: "Test Contact",
      consultType: "standard",
      products: ["gbp", "google_ads", "lsa", "webinar"],
      terminology: null,
      hideOtherLeads: false,
    },
    slideVerdicts: { marketing: VERDICT_TEXT },
    sections: [
      {
        sectionKey: "marketing",
        data: {
          posture: "scaling",
          gbp: { locations: [LOC_A, LOC_B] },
          googleAds: {
            uniqueLeads: 40,
            adSpend: 2000,
            costPerLead: 201.89,
            leadQuality: { good: 20, notQuotable: 15, missedCalls: 5, noData: 0 },
          },
          lsa: {
            uniqueLeads: 10,
            adSpend: 500,
            costPerLead: 201.49,
            leadQuality: { good: 6, notQuotable: 3, missedCalls: 1, noData: 0 },
          },
          // No webinar block: hasWebinar comes from products, and the
          // single-row webinar card must render its zero/fallback state.
          otherLeads: {
            count: 25,
            description: "",
            leadQuality: { good: 10, notQuotable: 10, missedCalls: 5, noData: 0 },
          },
        },
      },
      { sectionKey: "intake", data: { totalLeads: 205, totalConsults: 20, leadToConsultRate: 9.8 } },
      { sectionKey: "sales", data: {} },
    ],
    trendData: [
      { month: "2026-02", marketing: { totalLeads: 150, leadsBySource: { gbp: 90, googleAds: 30, lsa: 8 } } },
      { month: "2026-03", marketing: { totalLeads: 170, leadsBySource: { gbp: 110, googleAds: 35, lsa: 9 } } },
      { month: "2026-04", marketing: { totalLeads: 205, leadsBySource: { gbp: 130, googleAds: 40, lsa: 10 } } },
    ],
    dataAccess: [{ category: "consult_bookings", status: "available" }],
  };
}

function buildSparseFixture() {
  return {
    report: {
      id: "r2",
      clientId: "c1",
      reportMonth: "2026-04",
      status: "final",
      title: "Sparse Report",
      hideLeadQuality: false,
    },
    client: {
      id: "c1",
      firmName: "Sparse Law Firm",
      contactName: "Test Contact",
      consultType: "standard",
      products: ["gbp"],
      terminology: null,
      hideOtherLeads: false,
    },
    sections: [
      {
        sectionKey: "marketing",
        data: {
          posture: "baseline",
          gbp: { locations: [] },
          otherLeads: { count: 0, description: "" },
        },
      },
      { sectionKey: "intake", data: {} },
      { sectionKey: "sales", data: {} },
    ],
    trendData: [],
    dataAccess: [],
  };
}

/** Task #4717 — scenario (V): what the SERVER-masked payload looks like after
 * reportPrivacyMasking ran (locations "Market A"…, keywords "Keyword A"…,
 * competitor rows "Competitor A/B…", subject "Confidential Client"). The
 * client must render those names exactly as served — masking is never a
 * client-side job. Fresh objects throughout: LOC_A/LOC_B are shared consts
 * and must not be mutated. */
function buildPrivacyMaskedFixture(): any {
  const f: any = buildPopulatedFixture();
  f.report.privacyApplied = true;
  f.client.firmName = "Confidential Client";
  f.sections[0].data.gbp.locations = [
    {
      ...LOC_A,
      name: "Market A",
      localDominance: {
        keywordSnapshots: [
          {
            snapshotId: "hs-1",
            keywordName: "Keyword A",
            avgRank: 2.2,
            rankChange: 0,
            reportDate: "2026-04-27",
            competitors: [
              { rank: 1, name: "Competitor A", shareOfVoice: 30, averageRank: 1.5, isSubjectBusiness: false },
              { rank: 2, name: "Confidential Client", shareOfVoice: 25, averageRank: 2.2, isSubjectBusiness: true },
              { rank: 3, name: "Competitor B", shareOfVoice: 10, averageRank: 3.7, isSubjectBusiness: false },
            ],
          },
          // Task #4848 — masking maps one keyword to ONE masked label, so a
          // duplicate weekly scan arrives as a second "Keyword A" entry. It
          // must collapse into hs-1's pill (latest reportDate), never render
          // a third pill, and never surface its own avgRank.
          { snapshotId: "hs-1-old", keywordName: "Keyword A", avgRank: 3.5, rankChange: -0.2, reportDate: "2026-04-13" },
          // Masked legacy snapshot without competitor rows → no standing line.
          { snapshotId: "hs-2", keywordName: "Keyword B", avgRank: 2.4, rankChange: 0, reportDate: "2026-04-15" },
        ],
      },
    },
    {
      ...LOC_B,
      name: "Market B",
      localDominance: {
        keywordSnapshots: [
          { snapshotId: "hs-3", keywordName: "Keyword C", avgRank: 2.4, rankChange: 0, reportDate: "2026-04-20" },
        ],
      },
    },
  ];
  return f;
}

const React = (await import("react")).default;
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { HEATMAP_RANK_LEGEND } = await import("@shared/heatmapColors");
const { NO_DATA_LABEL } = await import(
  "../../client/src/pages/publicReport/EmptyState"
);
const { __resetScanProbeCacheForTest } = await import(
  "../../client/src/pages/publicReport/scanImageGuard"
);
const { PerformanceSection } = await import(
  "../../client/src/pages/adsOs/components/PerformanceSection"
);

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Dispatch a real bubbling click (React 18 listens at the root container). */
async function clickEl(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(0);
}

let activeRoot: any = null;

async function renderScenario(fixture: any): Promise<Document> {
  if (activeRoot) {
    await act(async () => { activeRoot.unmount(); });
    activeRoot = null;
  }
  dom.window.document.getElementById("root")!.innerHTML = "";

  // Task #4573 — settle the scan-image guard deterministically: clear its
  // module-level verdict cache between scenarios and answer the HEAD probe
  // for the fixture's /objects/ upload with a scan Content-Type (image/png),
  // so the GBP thumb <img> renders on every run instead of racing the probe.
  __resetScanProbeCacheForTest();

  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        path: "/objects/",
        respond: () => ({
          ok: true,
          status: 200,
          statusText: "",
          headers: new dom.window.Headers({ "Content-Type": "image/png" }),
          json: async () => ({}),
          text: async () => "",
        }),
      },
      { path: "/api/share", json: fixture },
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
  await act(async () => {
    activeRoot = ReactDOMClient.createRoot(container);
    activeRoot.render(
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

  return dom.window.document;
}

async function renderFractionalCplProfile(): Promise<Document> {
  if (activeRoot) {
    await act(async () => { activeRoot.unmount(); });
    activeRoot = null;
  }
  dom.window.document.getElementById("root")!.innerHTML = "";

  const current = {
    client: "Fractional CPL Client",
    currency_code: "USD",
    start: "2026-08-01",
    end: "2026-08-01",
    generated_at: "2026-08-02T00:00:00.000Z",
    accounts: [
      {
        product: "gads",
        customer_id: "g-fractional",
        name: "Fractional Google Ads",
        city: null,
        ads_status: "on",
        metrics_failed: false,
        points: [{ date: "2026-08-01", spend: 201.89, leads: 1 }],
      },
      {
        product: "gads",
        customer_id: "g-no-leads",
        name: "No-lead Google Ads",
        city: null,
        ads_status: "on",
        metrics_failed: false,
        points: [{ date: "2026-08-01", spend: 0, leads: 0 }],
      },
      {
        product: "lsa",
        customer_id: "l-fractional",
        name: "Fractional LSA",
        city: "Fractional City",
        ads_status: "on",
        metrics_failed: false,
        points: [{ date: "2026-08-01", spend: 201.49, leads: 1 }],
      },
    ],
  };
  const comparison = {
    ...current,
    start: "2026-07-02",
    end: "2026-07-31",
    accounts: [
      {
        ...current.accounts[0],
        points: [{ date: "2026-07-31", spend: 100.51, leads: 1 }],
      },
      {
        ...current.accounts[1],
        points: [{ date: "2026-07-31", spend: 1, leads: 0 }],
      },
      {
        ...current.accounts[2],
        points: [{ date: "2026-07-31", spend: 99.49, leads: 1 }],
      },
    ],
  };
  let performanceCalls = 0;
  globalThis.fetch = createFetchStub({
    Headers: dom.window.Headers,
    routes: [
      {
        path: "/api/ads-os/client/performance",
        json: () => performanceCalls++ === 0 ? current : comparison,
      },
    ],
    defaultJson: {},
  }) as any;

  const container = dom.window.document.getElementById("root")!;
  await act(async () => {
    activeRoot = ReactDOMClient.createRoot(container);
    activeRoot.render(
      React.createElement(PerformanceSection, { name: "Fractional CPL Client" }),
    );
  });
  await flush(0);
  await flush(0);
  return dom.window.document;
}

function marketingSlide(doc: Document): Element {
  const el = doc.querySelector("#marketing");
  assert(el, "marketing slide (#marketing) must render");
  return el!;
}

// ---------------------------------------------------------------------------
// Scenario (P): populated — full hierarchy
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildPopulatedFixture());
  const slide = marketingSlide(doc);

  // Verdict (first VerdictLine consumer)
  const verdict = slide.querySelector('[data-testid="text-verdict-marketing"]');
  assert(verdict, "(P) marketing verdict line renders");
  assert(
    verdict!.textContent!.includes(VERDICT_TEXT),
    `(P) verdict renders the server-stored sentence, got "${verdict!.textContent}"`,
  );

  // Hero + KPI tags — Task #4843: the hero is Total Leads in BOTH quality
  // modes (the biggest number on the slide is the total); Good Leads is the
  // first KPI tag (green) with an "of N total" ratio sub-line.
  const heroCard = slide.querySelector('[data-testid="card-marketing-hero"]');
  assert(heroCard, "(P) hero card renders");
  const heroTotal = heroCard!.querySelector('[data-testid="text-total-leads-ht"]');
  assert(heroTotal, "(P) hero shows Total Leads even when quality is shown (Task #4843)");
  assert(/^\d+$/.test(heroTotal!.textContent ?? ""), "(P) hero Total Leads is numeric");
  assert(
    (heroTotal!.className || "").includes("text-report-gold"),
    "(P) hero Total Leads keeps the gold hero styling",
  );
  assert(
    !(heroCard!.textContent ?? "").includes("total this month"),
    "(P) the 'of N total this month' hero sub-line is gone (the total IS the hero)",
  );
  const totalInstances = doc.querySelectorAll('[data-testid="text-total-leads-ht"]');
  assert(
    totalInstances.length === 1,
    `(P) exactly ONE text-total-leads-ht in the DOM (the hero), got ${totalInstances.length}`,
  );
  // Task #4982 — Other-leads disclosure: the populated fixture carries
  // otherLeads.count=25, so the hero card gets the muted "includes N" sub-line
  // (same annotation slot pattern as the webinar note) WITHOUT adding a second
  // text-total-leads-ht instance (pinned above).
  const otherNote = heroCard!.querySelector('[data-testid="text-total-leads-other-annotation"]');
  assert(otherNote, "(P) hero card carries the Other-leads disclosure sub-line (Task #4982)");
  assert(
    otherNote!.textContent === 'includes 25 "Other" leads — not attributed to our campaigns',
    `(P) hero disclosure states the actual Other count with the attribution tail, got "${otherNote!.textContent}"`,
  );
  const goodLeadsTag = slide.querySelector('[data-testid="kpi-good-leads"]');
  assert(goodLeadsTag, "(P) Good Leads renders as a KPI tag when quality is shown");
  assert(
    !heroCard!.contains(goodLeadsTag!),
    "(P) the Good Leads tag lives in the tag grid, not the hero card",
  );
  const goodLeads = goodLeadsTag!.querySelector('[data-testid="text-good-leads"]');
  assert(goodLeads, "(P) Good Leads tag carries the good-lead count");
  assert(/^\d+$/.test(goodLeads!.textContent ?? ""), "(P) Good Leads tag value is numeric");
  assert(
    (goodLeads!.className || "").includes("text-report-healthy-bright"),
    "(P) Good Leads tag keeps the green styling",
  );
  assert(
    /of \d+ total/.test(goodLeadsTag!.textContent ?? ""),
    "(P) Good Leads tag keeps the good/total ratio visible via its 'of N total' sub-line",
  );
  assert(
    doc.querySelectorAll('[data-testid="text-good-leads"]').length === 1,
    "(P) exactly one Good-Leads element (the KPI tag)",
  );
  assert(
    !slide.querySelector('[data-testid="kpi-total-leads"]'),
    "(P) the old kpi-total-leads tag is retired (the total moved into the hero)",
  );
  for (const tag of ["kpi-good-leads", "kpi-reviews-generated", "card-lead-quality", "kpi-blended-cpl"]) {
    assert(slide.querySelector(`[data-testid="${tag}"]`), `(P) KPI tag ${tag} renders`);
  }

  // ONE source chart; the donut cluster stays dead
  const lineCharts = Array.from(
    slide.querySelectorAll('[data-recharts="LineChart"][data-chart-data]'),
  ).filter((el) => {
    const rows = JSON.parse(el.getAttribute("data-chart-data")!);
    return Array.isArray(rows) && rows.length > 0 && rows.every((r: any) => "total" in r && "gbp" in r);
  });
  assert(
    lineCharts.length === 1,
    `(P) exactly one Leads-by-Source trend chart, got ${lineCharts.length}`,
  );
  assert(
    slide.querySelectorAll('[data-recharts="PieChart"]').length === 0,
    "(P) zero PieCharts — the donut cluster must not return",
  );
  assert(
    !slide.querySelector('[data-testid="chart-lead-sources-public"]') &&
      !slide.querySelector('[data-testid="chart-legend-public"]'),
    "(P) donut-era testids are gone",
  );

  // Stacked bar + table with Other row (toggle OFF)
  assert(slide.querySelector('[data-testid="card-lead-sources-quality"]'), "(P) stacked-bar card renders");
  assert(slide.querySelector('[data-testid="table-lead-sources"]'), "(P) lead-source table renders");
  assert(
    slide.querySelectorAll('[data-testid^="row-lead-source-"]').length >= 4,
    "(P) table renders a row per source (gbp + ads + lsa + other at minimum)",
  );
  assert(
    slide.querySelector('[data-testid="row-lead-source-other"]'),
    "(P) Other row renders while hideOtherLeads is OFF",
  );

  // Task #4914 — rated-based quality furniture on a FULLY-rated month: every
  // P-fixture bucket has noData 0, so the % is the same under both maths
  // (111 good of 180 rated = 62) and coverage reads full. GBP agg rated =
  // 85 + 30 + 15 = 130.
  const qualityCardP = slide.querySelector('[data-testid="card-lead-quality"]')!;
  const qualityPctP = qualityCardP.querySelector('[data-testid="text-lead-quality-percent"]');
  assert(
    qualityPctP?.textContent === "62%",
    `(P) KPI quality reads 62% (111 of 180 rated), got "${qualityPctP?.textContent}"`,
  );
  const coverageP = qualityCardP.querySelector('[data-testid="text-lead-quality-coverage"]');
  assert(
    coverageP?.textContent === "180 of 180 leads rated",
    `(P) KPI coverage sub-line reads "180 of 180 leads rated", got "${coverageP?.textContent}"`,
  );
  const sourcesCardP = slide.querySelector('[data-testid="card-lead-sources-quality"]')!;
  assert(
    (sourcesCardP.textContent ?? "").includes("62% Good"),
    "(P) sources header tag matches the rated-based headline (62% Good)",
  );
  assert(
    sourcesCardP.querySelector('[data-testid="bar-lead-quality-rated"]'),
    "(P) the rated stacked bar renders",
  );
  assert(
    !sourcesCardP.querySelector('[data-testid="bar-lead-quality-rated"] .bg-report-neutral'),
    "(P) no No-data segment inside the rated quality bar",
  );
  const stripP = sourcesCardP.querySelector('[data-testid="text-lead-quality-coverage-strip"]');
  assert(
    (stripP?.textContent ?? "").includes("Rated 180 of 180 (100%)"),
    `(P) coverage strip reads full coverage, got "${stripP?.textContent}"`,
  );
  assert(
    !(sourcesCardP.textContent ?? "").includes("No data"),
    "(P) zero No-data leads → no No-data furniture anywhere in the sources card",
  );
  const gbpRatedP = sourcesCardP.querySelector('[data-testid="text-rated-count-gbp"]');
  assert(
    gbpRatedP?.textContent === "of 130 rated",
    `(P) GBP row shows its rated denominator, got "${gbpRatedP?.textContent}"`,
  );

  // GBP thumbnail cards — 56px thumb or MapPin fallback, never full-bleed
  assert(slide.querySelector('[data-testid="grid-gbp-location-cards"]'), "(P) GBP card grid renders");
  const cardA = slide.querySelector('[data-testid="card-gbp-location-main-office"]');
  const cardB = slide.querySelector('[data-testid="card-gbp-location-satellite"]');
  assert(cardA && cardB, "(P) one thumbnail card per location");
  assert(cardA!.querySelector("img"), "(P) location with heatmapImageUrl renders the thumb <img>");
  assert(!cardB!.querySelector("img"), "(P) location without a thumb renders the MapPin fallback (no img)");

  // Map zone: ONE shared legend, one card per snapshot, takeaways
  assert(slide.querySelector('[data-testid="section-map-rankings"]'), "(P) map-rankings zone renders");
  const legends = doc.querySelectorAll('[data-testid="heatmap-shared-legend"]');
  assert(legends.length === 1, `(P) exactly ONE shared heatmap legend, got ${legends.length}`);
  const legendText = legends[0].textContent ?? "";
  for (const item of HEATMAP_RANK_LEGEND) {
    assert(
      legendText.includes(item.label),
      `(P) shared legend carries the canonical band label "${item.label}"`,
    );
  }
  // Task #4848 — one card per LOCATION (LOC_A's three ids collapse to one
  // card; a third card would mean per-snapshot cards came back).
  const map0 = slide.querySelector('[data-testid="card-heatmap-0"]');
  const map1 = slide.querySelector('[data-testid="card-heatmap-1"]');
  assert(map0 && map1, "(P) one map card per location");
  assert(
    slide.querySelectorAll('[data-testid^="card-heatmap-"]').length === 2,
    `(P) exactly TWO map cards — LOC_A's 3 snapshot ids group into one card, got ${slide.querySelectorAll('[data-testid^="card-heatmap-"]').length}`,
  );
  assert(
    (slide.querySelector('[data-testid="text-heatmap-keyword-0"]')?.textContent ?? "").includes("personal injury lawyer"),
    "(P) map card labels its active keyword from the payload snapshot",
  );
  const mapGrid = map0!.parentElement!;
  assert(
    (mapGrid.className || "").includes("lg:grid-cols-2"),
    "(P) two location cards render side-by-side (lg:grid-cols-2)",
  );

  // Task #4848 — pills: LOC_A has TWO distinct keywords (the hs-1-old
  // duplicate collapses into hs-1's pill); LOC_B has one keyword → no row.
  const pills0 = map0!.querySelectorAll('[data-testid^="pill-heatmap-0-"]');
  assert(
    map0!.querySelector('[data-testid="row-heatmap-pills-0"]') && pills0.length === 2,
    `(P) LOC_A card renders exactly TWO keyword pills (duplicate scan collapsed), got ${pills0.length}`,
  );
  assert(
    (pills0[0].textContent ?? "").includes("personal injury lawyer") &&
      (pills0[1].textContent ?? "").includes("car accident lawyer"),
    `(P) pills carry the distinct keyword labels in first-seen order, got "${pills0[0].textContent}" / "${pills0[1].textContent}"`,
  );
  assert(
    !map1!.querySelector('[data-testid="row-heatmap-pills-1"]'),
    "(P) single-keyword location renders NO pill row",
  );

  // Task #4848 — the active map is the LATEST scan of the active keyword:
  // hs-1-old is listed first in heatmapSnapshotIds but hs-1 wins by
  // reportDate. The stubbed InteractiveHeatmap exposes the id it was asked
  // to render.
  const stub0 = map0!.querySelector('[data-testid="stub-interactive-heatmap"]');
  assert(
    stub0?.getAttribute("data-snapshot-id") === "hs-1",
    `(P) active map renders the LATEST same-keyword scan (hs-1, not first-listed hs-1-old), got "${stub0?.getAttribute("data-snapshot-id")}"`,
  );

  const take0 = slide.querySelector('[data-testid="text-heatmap-takeaway-0"]');
  const take1 = slide.querySelector('[data-testid="text-heatmap-takeaway-1"]');
  assert(take0 && take1, "(P) one takeaway line per card");
  assert(
    take0!.textContent!.includes("Averaging #2.4") && take0!.textContent!.includes("up 1.2 spots"),
    `(P) takeaway 0 uses the LATEST scan's avgRank/rankChange wording (hs-1-old's #3.9 must not leak), got "${take0!.textContent}"`,
  );
  assert(
    take1!.textContent!.includes("Averaging #2.4") && take1!.textContent!.includes("holding steady"),
    `(P) takeaway 1 renders the equal-avgRank card as steady (not a bug), got "${take1!.textContent}"`,
  );

  // Task #4717 — standing line: averageRank-only, absent without data
  const standing0 = slide.querySelector('[data-testid="text-heatmap-standing-0"]');
  assert(standing0, "(P) map with competitor rows renders the standing line");
  const standingText = standing0!.textContent ?? "";
  assert(
    standingText.includes("You rank #2 of 4 firms detected in this market"),
    `(P) standing position/total derive from averageRank with the null-rank row dropped, got "${standingText}"`,
  );
  assert(
    standingText.includes("top competitors: Quiet Winner Legal, Big Spender Law, Fourth Firm"),
    `(P) competitor names ordered by averageRank — NOT the served SoV-ordered rank field, got "${standingText}"`,
  );
  assert(!standingText.includes("Unrankable Row"), "(P) null-averageRank rows are never named");
  assert(!standingText.includes("%"), "(P) the standing line carries no percentage — share-of-voice stays dead");
  const standingGold = standing0!.querySelector(".text-report-gold");
  assert(
    standingGold && /You rank #2/.test(standingGold.textContent ?? ""),
    "(P) subject position is highlighted in report gold",
  );
  assert(
    !slide.querySelector('[data-testid="text-heatmap-standing-1"]'),
    "(P) card whose snapshot has no competitor rows renders NO standing line (absent, never empty)",
  );

  // Task #4848 — pill switching swaps map + keyword label + takeaway +
  // standing to the selected keyword's snapshot.
  await clickEl(pills0[1]);
  const stubAfter = map0!.querySelector('[data-testid="stub-interactive-heatmap"]');
  assert(
    stubAfter?.getAttribute("data-snapshot-id") === "hs-2",
    `(P) clicking the second pill swaps the map to that keyword's snapshot, got "${stubAfter?.getAttribute("data-snapshot-id")}"`,
  );
  assert(
    (slide.querySelector('[data-testid="text-heatmap-keyword-0"]')?.textContent ?? "").includes("car accident lawyer"),
    "(P) the header keyword label follows the active pill",
  );
  const takeSwitched = slide.querySelector('[data-testid="text-heatmap-takeaway-0"]');
  assert(
    takeSwitched!.textContent!.includes("Averaging #2.4") &&
      takeSwitched!.textContent!.includes("holding steady"),
    `(P) switched takeaway renders hs-2's metrics, got "${takeSwitched!.textContent}"`,
  );
  assert(
    !takeSwitched!.textContent!.includes("0.0 spots"),
    `(P) a rank change that ROUNDS to 0.0 (0.04) reads as holding steady — "up 0.0 spots" must never ship, got "${takeSwitched!.textContent}"`,
  );
  assert(
    !slide.querySelector('[data-testid="text-heatmap-standing-0"]'),
    "(P) standing line disappears when the active pill's snapshot has no competitor rows",
  );
  await clickEl(pills0[0]);
  assert(
    map0!.querySelector('[data-testid="stub-interactive-heatmap"]')?.getAttribute("data-snapshot-id") === "hs-1",
    "(P) switching back re-renders the first keyword's latest snapshot",
  );
  assert(
    slide.querySelector('[data-testid="text-heatmap-standing-0"]'),
    "(P) standing line returns with the competitor-backed snapshot",
  );

  // Prominent Paid Search card — Task #4913 restored the pre-#4280 weight
  // and position: BETWEEN the GBP zone and Map Rankings, with per-channel
  // sub-cards at metric size. If the demoted single-row chip treatment ever
  // returns, spend/CPL sink below the tall map cards again on every
  // already-shipped share link (the deck renders live code).
  const paidCard = slide.querySelector('[data-testid="card-paid-media"]');
  assert(paidCard, "(P) paid search card renders");
  const gbpGrid = slide.querySelector('[data-testid="grid-gbp-location-cards"]');
  const mapSection = slide.querySelector('[data-testid="section-map-rankings"]');
  assert(gbpGrid && mapSection, "(P) GBP grid and Map Rankings section both render");
  const FOLLOWING = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
  assert(
    (gbpGrid!.compareDocumentPosition(paidCard!) & FOLLOWING) !== 0,
    "(P) paid card sits AFTER the GBP zone",
  );
  assert(
    (paidCard!.compareDocumentPosition(mapSection!) & FOLLOWING) !== 0,
    "(P) paid card sits BEFORE Map Rankings — the #4280 demotion below the maps must not return",
  );
  assert(
    !slide.querySelector('[data-testid="row-paid-google-ads"]') &&
      !slide.querySelector('[data-testid="row-paid-lsa"]'),
    "(P) the demoted single-row chip treatment stays dead",
  );
  // Per-channel sub-cards: leads, spend, CPL at metric-large size. Spend and
  // leads stay unchanged while fractional stored CPL values round to the
  // client-facing report's existing whole-dollar convention.
  const adsCard = paidCard!.querySelector('[data-testid="card-paid-google-ads"]');
  const lsaCard = paidCard!.querySelector('[data-testid="card-paid-lsa"]');
  assert(adsCard && lsaCard, "(P) both per-channel sub-cards render");
  assert(
    (adsCard!.parentElement!.className || "").includes("sm:grid-cols-2"),
    "(P) dual-channel sub-cards sit in a two-column grid at desktop",
  );
  for (const [tid, want] of [
    ["text-paid-google-ads-leads", "40"],
    ["text-paid-google-ads-spend", "$2K"],
    ["text-paid-google-ads-cpl", "$202"],
    ["text-paid-lsa-leads", "10"],
    ["text-paid-lsa-spend", "$0.5K"],
    ["text-paid-lsa-cpl", "$201"],
  ] as const) {
    const el = paidCard!.querySelector(`[data-testid="${tid}"]`);
    assert(el, `(P) ${tid} renders`);
    assert(
      el!.textContent === want,
      `(P) ${tid} reads "${want}", got "${el!.textContent}"`,
    );
    assert(
      (el!.className || "").includes("metric-large"),
      `(P) ${tid} renders at metric-large size — readable, not 11px fine print`,
    );
  }
  const spendChip = paidCard!.querySelector('[data-testid="chip-paid-total-spend"]');
  const cplChip = paidCard!.querySelector('[data-testid="chip-paid-blended-cpl"]');
  assert(
    (spendChip?.textContent ?? "").includes("Total Spend:") &&
      (spendChip?.textContent ?? "").includes("$2.5K"),
    `(P) Total Spend chip reads $2.5K, got "${spendChip?.textContent}"`,
  );
  assert(
    (cplChip?.textContent ?? "").includes("Blended CPL:") &&
      (cplChip?.textContent ?? "").includes("$50"),
    `(P) Blended CPL chip reads $50 ($2,500 / 50 leads), got "${cplChip?.textContent}"`,
  );
  assert(slide.querySelector('[data-testid="card-webinars"]'), "(P) webinar single-row card renders");
  assert(slide.querySelector('[data-testid="row-review-sources"]'), "(P) review-source chips render");

  // No internal automation/ops vocabulary anywhere on the slide
  const slideText = slide.textContent ?? "";
  assert(
    !/post[- ]?consult|case[- ]?closed|automation/i.test(slideText),
    "(P) the slide surfaces no internal automation/ops state",
  );
  // Task #4850 — nothing is missing on the populated fixture (leads, reviews,
  // and ad spend all recorded), so NO upsell callout renders at all: the
  // CaseIntake™ pitch only ever accompanies a real gap.
  assert(
    !slide.querySelector('[data-testid="upsell-marketing"]'),
    "(P) fully-populated slide renders no upsell callout",
  );
  assert(!/CaseIntake/.test(slideText), "(P) no stray CaseIntake™ pitch on a populated slide");
  // Task #4717 — the honest-metric rule holds slide-wide, not just in the
  // standing element: share-of-voice framing must never resurface.
  assert(
    !/share of voice|market share/i.test(slideText),
    "(P) share-of-voice framing appears nowhere on the slide",
  );

  console.log("scenario P (populated hierarchy) PASSED");
}

// ---------------------------------------------------------------------------
// Scenario (S): sparse — no locations, no trend, no verdict
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildSparseFixture());
  const slide = marketingSlide(doc);

  // Task #4693 deck-wide no-data upsell convention (supersedes the #4285
  // collapse): a marketing section with NOTHING entered renders its FULL
  // slide skeleton — hero as a muted "No data" slot (never a wall of
  // fabricated zeros), a quiet placeholder frame where the source chart
  // would draw, and ONE gold CaseIntake™ callout (upgrade-only variant —
  // marketing data is tracked, not hand-reported). The fixture's stored
  // 'baseline' posture badge stays suppressed over zero volume.
  assert(!slide.querySelector('[data-testid="empty-marketing"]'), "(S) the #4285 collapse band is retired");
  const callout = slide.querySelector('[data-testid="upsell-marketing"]');
  assert(callout, "(S) fully-empty section renders the single gold callout");
  assert(
    (callout!.textContent ?? "").includes("CaseIntake™ tracks this automatically"),
    "(S) callout carries the upgrade-only copy",
  );
  assert(
    (slide.textContent ?? "").match(/CaseIntake™/g)!.length === 1,
    "(S) the pitch appears exactly once on the slide",
  );
  const hero = slide.querySelector('[data-testid="card-marketing-hero"]');
  assert(hero, "(S) hero card still renders (full skeleton)");
  assert(
    hero!.querySelector('[data-testid="text-marketing-hero-missing"]'),
    "(S) hero shows the muted no-data slot, not a fabricated 0",
  );
  // Task #4843 — the skeleton hero is labeled Total Leads in every mode, and
  // the Good Leads KPI tag renders its own muted no-data slot.
  assert(
    (hero!.textContent ?? "").includes("Total Leads") &&
      !(hero!.textContent ?? "").includes("Good Leads"),
    `(S) skeleton hero label reads Total Leads, got "${hero!.textContent}"`,
  );
  assert(
    !hero!.querySelector('[data-testid="text-total-leads-other-annotation"]'),
    "(S) skeleton hero renders no Other-leads disclosure (Task #4982 — nothing to disclose on an empty month)",
  );
  const goodTagSkeleton = slide.querySelector('[data-testid="kpi-good-leads"]');
  assert(goodTagSkeleton, "(S) Good Leads KPI tag renders its skeleton");
  assert(
    (goodTagSkeleton!.textContent ?? "").includes(NO_DATA_LABEL) &&
      !goodTagSkeleton!.querySelector('[data-testid="text-good-leads"]'),
    "(S) Good Leads tag skeleton is the muted no-data slot, never a fabricated 0",
  );
  assert(slide.querySelector('[data-testid="chart-placeholder-marketing"]'), "(S) source-chart area renders the quiet placeholder frame");
  assert(!/Establishing Baseline|Ramp-Up|Scaling/.test(slide.textContent ?? ""), "(S) posture badge still suppressed over zero volume");
  assert(!slide.querySelector('[data-testid="text-verdict-marketing"]'), "(S) no verdict → no verdict line");
  assert(!slide.querySelector('[data-testid="section-map-rankings"]'), "(S) no heatmaps → no map zone");
  assert(!doc.querySelector('[data-testid="heatmap-shared-legend"]'), "(S) no maps → no shared legend");
  assert(!slide.querySelector('[data-testid="grid-gbp-location-cards"]'), "(S) no locations → no card grid");
  assert(!slide.querySelector('[data-testid="card-paid-media"]'), "(S) no paid products → no paid card");
  assert(!slide.querySelector('[data-testid="card-webinars"]'), "(S) no webinar product → no webinar card");
  assert(
    slide.querySelectorAll('[data-recharts="PieChart"]').length === 0,
    "(S) still zero PieCharts",
  );

  console.log("scenario S (sparse) PASSED");
}

// ---------------------------------------------------------------------------
// Scenario (H): hideLeadQuality — hero stays Total Leads, Good-Leads tag gone
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildPopulatedFixture({ hideLeadQuality: true }));
  const slide = marketingSlide(doc);

  const hero = slide.querySelector('[data-testid="card-marketing-hero"]');
  assert(hero, "(H) hero card renders");
  assert(
    hero!.querySelector('[data-testid="text-total-leads-ht"]'),
    "(H) hero carries text-total-leads-ht when quality is hidden",
  );
  assert(!slide.querySelector('[data-testid="text-good-leads"]'), "(H) no Good-Leads element anywhere");
  assert(
    !slide.querySelector('[data-testid="kpi-good-leads"]'),
    "(H) the Good-Leads KPI tag is suppressed when quality is hidden (Task #4843)",
  );
  const totalInstances = doc.querySelectorAll('[data-testid="text-total-leads-ht"]');
  assert(
    totalInstances.length === 1,
    `(H) still exactly ONE text-total-leads-ht (hero instance only), got ${totalInstances.length}`,
  );
  // Task #4982 — the Other-leads disclosure annotates the TOTAL, so it is
  // quality-mode independent: it renders in hideLeadQuality mode too.
  assert(
    hero!.querySelector('[data-testid="text-total-leads-other-annotation"]'),
    "(H) hero keeps the Other-leads disclosure sub-line when quality is hidden (Task #4982)",
  );
  assert(!slide.querySelector('[data-testid="card-lead-quality"]'), "(H) quality KPI tag suppressed");
  const table = slide.querySelector('[data-testid="table-lead-sources"]');
  assert(table, "(H) source table still renders");
  assert(
    !table!.textContent!.includes("% Good"),
    "(H) table hides its quality columns when hideLeadQuality is on",
  );

  console.log("scenario H (hideLeadQuality) PASSED");
}

// ---------------------------------------------------------------------------
// Scenario (V): privacyApplied — masked standing renders as-is, no leaks
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(buildPrivacyMaskedFixture());
  const slide = marketingSlide(doc);

  const standing = slide.querySelector('[data-testid="text-heatmap-standing-0"]');
  assert(standing, "(V) masked report still renders the standing line");
  const text = standing!.textContent ?? "";
  assert(
    text.includes("You rank #2 of 3 firms detected in this market"),
    `(V) masked standing keeps the averageRank-derived position, got "${text}"`,
  );
  assert(
    text.includes("top competitors: Competitor A, Competitor B"),
    `(V) server-masked competitor names render exactly as served, got "${text}"`,
  );
  assert(!text.includes("%"), "(V) no percentage under privacy mode either");
  assert(
    !slide.querySelector('[data-testid="text-heatmap-standing-1"]'),
    "(V) masked snapshot without competitor rows renders no standing line",
  );

  // Task #4848 — masked DUPLICATES collapse: two "Keyword A" scans arrive as
  // two entries, but the card renders exactly two pills (A + B) with the
  // latest "Keyword A" snapshot active. A third pill would double-expose one
  // keyword; rendering hs-1-old would surface the stale scan's metrics.
  const maskedCard0 = slide.querySelector('[data-testid="card-heatmap-0"]');
  const maskedPills = maskedCard0!.querySelectorAll('[data-testid^="pill-heatmap-0-"]');
  assert(
    maskedPills.length === 2,
    `(V) masked duplicate scans collapse to one pill per masked keyword, got ${maskedPills.length}`,
  );
  assert(
    (maskedPills[0].textContent ?? "").includes("Keyword A") &&
      (maskedPills[1].textContent ?? "").includes("Keyword B"),
    `(V) distinct masked keywords keep their distinct pill labels, got "${maskedPills[0].textContent}" / "${maskedPills[1].textContent}"`,
  );
  assert(
    maskedCard0!.querySelector('[data-testid="stub-interactive-heatmap"]')?.getAttribute("data-snapshot-id") === "hs-1",
    "(V) the latest masked scan renders (hs-1, not the hs-1-old duplicate)",
  );
  await clickEl(maskedPills[1]);
  assert(
    (slide.querySelector('[data-testid="text-heatmap-keyword-0"]')?.textContent ?? "").includes("Keyword B"),
    "(V) switching a masked pill swaps to the masked label — never a real keyword",
  );
  assert(
    !slide.querySelector('[data-testid="text-heatmap-standing-0"]'),
    "(V) masked pill without competitor rows drops the standing line after switch",
  );

  const slideText = slide.textContent ?? "";
  assert(
    !slideText.includes("Restructure Law Firm") &&
      !slideText.includes("personal injury lawyer") &&
      !slideText.includes("car accident lawyer") &&
      !slideText.includes("family lawyer"),
    "(V) no unmasked firm or keyword identifiers leak onto the slide",
  );

  console.log("scenario V (privacy-masked standing) PASSED");
}

// ---------------------------------------------------------------------------
// Scenario (C): single paid channel — google_ads active, lsa INACTIVE
// ---------------------------------------------------------------------------
{
  const fixture: any = buildPopulatedFixture();
  // Products drive the paid render, not data presence: drop lsa from the
  // product list but LEAVE its stale data block in the payload — the real
  // payload shape after a product is turned off mid-engagement.
  fixture.client.products = ["gbp", "google_ads", "webinar"];
  const doc = await renderScenario(fixture);
  const slide = marketingSlide(doc);

  const paidCard = slide.querySelector('[data-testid="card-paid-media"]');
  assert(paidCard, "(C) paid card renders for a single-channel client");
  const adsCard = paidCard!.querySelector('[data-testid="card-paid-google-ads"]');
  assert(adsCard, "(C) Google Ads sub-card renders");
  assert(
    !paidCard!.querySelector('[data-testid="card-paid-lsa"]'),
    "(C) NO LSA sub-card — the stale lsa data block must not render for an inactive product",
  );
  assert(
    !(adsCard!.parentElement!.className || "").includes("sm:grid-cols-2"),
    "(C) single-channel grid stays one full-width column",
  );
  const cardText = paidCard!.textContent ?? "";
  assert(
    cardText.includes("Total Leads") && !cardText.includes("Combined"),
    `(C) single-channel header labels Total (not Combined) leads, got "${cardText.slice(0, 120)}"`,
  );
  assert(
    cardText.includes("Google Ads") && !cardText.includes("Local Services Ads"),
    "(C) channels sub-line names only Google Ads",
  );
  assert(
    (paidCard!.querySelector('[data-testid="chip-paid-total-spend"]')?.textContent ?? "").includes("$2K"),
    "(C) Total Spend chip sums only the ACTIVE channel ($2K, not $2.5K)",
  );
  assert(
    (paidCard!.querySelector('[data-testid="chip-paid-blended-cpl"]')?.textContent ?? "").includes("$50"),
    "(C) Blended CPL chip renders ($50 = $2,000 / 40)",
  );

  console.log("scenario C (single paid channel) PASSED");
}

// ---------------------------------------------------------------------------
// Scenarios (N)/(Z) — Task #4914 rated-based quality %. GBP-only client, ONE
// location, no maps/paid noise: the quality furniture is the whole story.
// ---------------------------------------------------------------------------
function buildQualityCoverageFixture(
  id: string,
  leadQuality: { good: number; notQuotable: number; missedCalls: number; noData: number },
  uniqueLeads: number,
) {
  return {
    report: {
      id,
      clientId: "c1",
      reportMonth: "2026-07",
      status: "final",
      title: "July 2026 Report",
      hideLeadQuality: false,
    },
    client: {
      id: "c1",
      firmName: "Coverage Law Firm",
      contactName: "Test Contact",
      consultType: "standard",
      products: ["gbp"],
      terminology: null,
      hideOtherLeads: false,
    },
    sections: [
      {
        sectionKey: "marketing",
        data: {
          posture: "scaling",
          gbp: {
            locations: [
              {
                name: "Cambridge Office",
                uniqueLeads,
                reviewsGenerated: 2,
                reviewsRespondedTo: 1,
                postsQaCount: 0,
                leadQuality,
              },
            ],
          },
          otherLeads: { count: 0, description: "" },
        },
      },
      { sectionKey: "intake", data: {} },
      { sectionKey: "sales", data: {} },
    ],
    trendData: [],
    dataAccess: [],
  };
}

// ---------------------------------------------------------------------------
// Scenario (N): no-data-heavy month — Cambridge July 2026 shape
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildQualityCoverageFixture("r-n", { good: 48, notQuotable: 40, missedCalls: 0, noData: 154 }, 242),
  );
  const slide = marketingSlide(doc);

  const qualityCard = slide.querySelector('[data-testid="card-lead-quality"]');
  assert(qualityCard, "(N) quality KPI card renders");
  const pct = qualityCard!.querySelector('[data-testid="text-lead-quality-percent"]');
  assert(
    pct?.textContent === "55%",
    `(N) KPI quality is RATED-based: 48 of 88 rated = 55%, never 48/242 = 20%, got "${pct?.textContent}"`,
  );
  assert(
    (pct!.className || "").includes("text-report-gold"),
    "(N) 55% sits in the gold band (>=40, <60) — thresholds unchanged",
  );
  const coverage = qualityCard!.querySelector('[data-testid="text-lead-quality-coverage"]');
  assert(
    coverage?.textContent === "88 of 242 leads rated",
    `(N) KPI coverage sub-line makes the rated denominator explicit, got "${coverage?.textContent}"`,
  );
  const answerRate = qualityCard!.querySelector('[data-testid="text-answer-rate-percent"]');
  assert(
    (answerRate?.textContent ?? "").includes("100%"),
    `(N) Answer Rate stays on its own (unchanged) math — 88 answered of 88 = 100%, got "${answerRate?.textContent}"`,
  );

  const sourcesCard = slide.querySelector('[data-testid="card-lead-sources-quality"]');
  assert(sourcesCard, "(N) sources & quality card renders");
  const cardText = sourcesCard!.textContent ?? "";
  assert(cardText.includes("242 total leads"), `(N) total count stays visible, got "${cardText.slice(0, 120)}"`);
  assert(cardText.includes("55% Good"), "(N) header tag matches the rated-based headline");
  assert(!cardText.includes("20% Good"), "(N) the old diluted all-buckets % must appear nowhere");

  const bar = sourcesCard!.querySelector('[data-testid="bar-lead-quality-rated"]');
  assert(bar, "(N) rated stacked bar renders");
  const goodSeg = bar!.querySelector(".bg-report-healthy");
  const badSeg = bar!.querySelector(".bg-report-critical");
  assert(
    goodSeg?.textContent === "55%" && badSeg?.textContent === "45%",
    `(N) bar segments are shares of RATED leads and sum to 100 (55 + 45), got good "${goodSeg?.textContent}" / NQ "${badSeg?.textContent}"`,
  );
  assert(!bar!.querySelector(".bg-report-watch"), "(N) zero missed calls → no Missed segment");
  assert(
    !bar!.querySelector(".bg-report-neutral"),
    "(N) No data NEVER renders inside the quality bar — it lives in the coverage strip",
  );

  const strip = sourcesCard!.querySelector('[data-testid="text-lead-quality-coverage-strip"]');
  assert(strip, "(N) coverage strip renders");
  const stripText = strip!.textContent ?? "";
  assert(
    stripText.includes("Rated 88 of 242 (36%)"),
    `(N) strip reports rating coverage, got "${stripText}"`,
  );
  assert(
    stripText.includes("No data: 154") && stripText.includes("not in % Good"),
    `(N) No-data count stays visible with the exclusion spelled out, got "${stripText}"`,
  );
  assert(
    strip!.querySelector(".bg-report-neutral"),
    "(N) the muted No-data swatch moved to the strip (legend continuity)",
  );
  for (const label of ["Good (48)", "Not Quotable (40)", "Missed (0)"]) {
    assert(cardText.includes(label), `(N) legend keeps the rated-disposition count "${label}"`);
  }

  const gbpRated = sourcesCard!.querySelector('[data-testid="text-rated-count-gbp"]');
  assert(
    gbpRated?.textContent === "of 88 rated",
    `(N) per-source % Good carries its rated denominator, got "${gbpRated?.textContent}"`,
  );
  const gbpRow = sourcesCard!.querySelector('[data-testid="row-lead-source-gbp"]');
  assert(
    (gbpRow?.textContent ?? "").includes("55%"),
    `(N) GBP row % Good is rated-based (55%), got "${gbpRow?.textContent}"`,
  );

  console.log("scenario N (no-data-heavy rated-based quality) PASSED");
}

// ---------------------------------------------------------------------------
// Scenario (Z): zero-rated month — every lead is No data
// ---------------------------------------------------------------------------
{
  const doc = await renderScenario(
    buildQualityCoverageFixture("r-z", { good: 0, notQuotable: 0, missedCalls: 0, noData: 20 }, 20),
  );
  const slide = marketingSlide(doc);

  const qualityCard = slide.querySelector('[data-testid="card-lead-quality"]');
  assert(qualityCard, "(Z) quality KPI card still renders (data was entered — this is not the empty-section state)");
  assert(
    !qualityCard!.querySelector('[data-testid="text-lead-quality-percent"]'),
    "(Z) no percentage element — 0 rated must never fabricate a 0% or 100%",
  );
  const dash = qualityCard!.querySelector('[data-testid="text-lead-quality-unrated"]');
  assert(
    dash?.textContent === "—",
    `(Z) KPI card renders the em-dash placeholder, got "${dash?.textContent}"`,
  );
  const coverage = qualityCard!.querySelector('[data-testid="text-lead-quality-coverage"]');
  assert(
    coverage?.textContent === "not yet rated · 20 leads without data",
    `(Z) coverage sub-line explains the dash, got "${coverage?.textContent}"`,
  );
  assert(
    !qualityCard!.querySelector('[data-testid="text-answer-rate-percent"]'),
    "(Z) Answer Rate line absent — its denominator is empty too",
  );

  const sourcesCard = slide.querySelector('[data-testid="card-lead-sources-quality"]');
  assert(sourcesCard, "(Z) sources & quality card renders (20 leads exist, just unrated)");
  assert(
    sourcesCard!.querySelector('[data-testid="text-lead-sources-not-yet-rated"]'),
    "(Z) header shows the 'Not yet rated' tag instead of a %",
  );
  assert(
    !/\d+% Good/.test(sourcesCard!.textContent ?? ""),
    "(Z) no percentage-Good tag anywhere on the card",
  );
  assert(
    !sourcesCard!.querySelector('[data-testid="bar-lead-quality-rated"]'),
    "(Z) no rated bar when nothing is rated",
  );
  const placeholder = sourcesCard!.querySelector('[data-testid="bar-lead-quality-unrated"]');
  assert(placeholder, "(Z) dashed placeholder stands in for the bar");
  assert(
    (placeholder!.textContent ?? "").includes("No rated leads yet"),
    `(Z) placeholder copy names the gap, got "${placeholder!.textContent}"`,
  );
  const stripZ = sourcesCard!.querySelector('[data-testid="text-lead-quality-coverage-strip"]');
  assert(
    (stripZ?.textContent ?? "").includes("Rated 0 of 20 (0%)") &&
      (stripZ?.textContent ?? "").includes("No data: 20"),
    `(Z) strip reports the honest zero coverage with counts, got "${stripZ?.textContent}"`,
  );

  const gbpRow = sourcesCard!.querySelector('[data-testid="row-lead-source-gbp"]');
  assert(gbpRow, "(Z) GBP source row renders");
  assert(
    (gbpRow!.textContent ?? "").includes("—"),
    `(Z) zero-rated source shows an em-dash % cell, got "${gbpRow!.textContent}"`,
  );
  const gbpRatedZ = gbpRow!.querySelector('[data-testid="text-rated-count-gbp"]');
  assert(
    gbpRatedZ?.textContent === "0 rated",
    `(Z) zero-rated source still carries its rated-count context, got "${gbpRatedZ?.textContent}"`,
  );

  console.log("scenario Z (zero-rated month) PASSED");
}

// ---------------------------------------------------------------------------
// Scenario (D): divergent GBP shape — zero-rated ROLLUP with stale rated
// location buckets. `readGbpLeadQuality` is rollup-first and explicitly
// supports rollup/location divergence, so the canonical counts here are the
// rollup's (0 rated, 20 No data) while the per-location sums claim 15 rated.
// Every quality surface — KPI card, header tag, bar, coverage strip,
// per-source row — must follow the rollup and render the unrated state; in
// particular the KPI card's `qualityPercent ?? goodLeadPercent` fallback must
// NOT resurrect a percentage from the divergent location sums, which is why
// `goodLeadPercent`'s GBP terms read the same canonical rollup-first counts
// as the headline and the bar.
// ---------------------------------------------------------------------------
{
  const fixture = buildQualityCoverageFixture(
    "r-d",
    { good: 10, notQuotable: 5, missedCalls: 0, noData: 5 },
    20,
  );
  (fixture.sections[0].data as any).gbpLeadQuality = {
    good: 0,
    notQuotable: 0,
    missedCalls: 0,
    noData: 20,
  };
  const doc = await renderScenario(fixture);
  const slide = marketingSlide(doc);

  const qualityCard = slide.querySelector('[data-testid="card-lead-quality"]');
  assert(qualityCard, "(D) quality KPI card renders");
  assert(
    !qualityCard!.querySelector('[data-testid="text-lead-quality-percent"]'),
    "(D) no percentage element — the zero-rated rollup is canonical, so the divergent rated location buckets must not resurrect a % through the goodLeadPercent fallback",
  );
  const dashD = qualityCard!.querySelector('[data-testid="text-lead-quality-unrated"]');
  assert(
    dashD?.textContent === "—",
    `(D) KPI card renders the em-dash placeholder, got "${dashD?.textContent}"`,
  );
  const coverageD = qualityCard!.querySelector('[data-testid="text-lead-quality-coverage"]');
  assert(
    coverageD?.textContent === "not yet rated · 20 leads without data",
    `(D) coverage sub-line follows the rollup counts, got "${coverageD?.textContent}"`,
  );
  assert(
    !qualityCard!.querySelector('[data-testid="text-answer-rate-percent"]'),
    "(D) Answer Rate line absent — the rollup's answer denominator is empty too",
  );

  const sourcesCard = slide.querySelector('[data-testid="card-lead-sources-quality"]');
  assert(sourcesCard, "(D) sources & quality card renders");
  assert(
    sourcesCard!.querySelector('[data-testid="text-lead-sources-not-yet-rated"]'),
    "(D) header shows the 'Not yet rated' tag instead of a %",
  );
  assert(
    !/\d+% Good/.test(sourcesCard!.textContent ?? ""),
    "(D) no percentage-Good tag anywhere on the card",
  );
  assert(
    !sourcesCard!.querySelector('[data-testid="bar-lead-quality-rated"]'),
    "(D) no rated bar — the canonical rollup has zero rated leads",
  );
  assert(
    sourcesCard!.querySelector('[data-testid="bar-lead-quality-unrated"]'),
    "(D) dashed placeholder stands in for the bar",
  );
  const stripD = sourcesCard!.querySelector('[data-testid="text-lead-quality-coverage-strip"]');
  assert(
    (stripD?.textContent ?? "").includes("Rated 0 of 20 (0%)") &&
      (stripD?.textContent ?? "").includes("No data: 20"),
    `(D) strip reports the rollup's coverage with counts, got "${stripD?.textContent}"`,
  );

  const gbpRowD = sourcesCard!.querySelector('[data-testid="row-lead-source-gbp"]');
  assert(gbpRowD, "(D) GBP source row renders");
  assert(
    (gbpRowD!.textContent ?? "").includes("—"),
    `(D) GBP row shows an em-dash % cell, got "${gbpRowD!.textContent}"`,
  );
  const gbpRatedD = gbpRowD!.querySelector('[data-testid="text-rated-count-gbp"]');
  assert(
    gbpRatedD?.textContent === "0 rated",
    `(D) GBP row rated-count follows the rollup, got "${gbpRatedD?.textContent}"`,
  );

  console.log("scenario D (divergent zero-rated rollup) PASSED");
}

// ---------------------------------------------------------------------------
// Scenario (F): fractional CPL parity — Ads OS profile + Marketing report
// ---------------------------------------------------------------------------
{
  const doc = await renderFractionalCplProfile();
  const profile = doc.querySelector("#cp-performance");
  assert(profile, "(F) Ads OS client-profile Performance section renders");

  const compare = profile!.querySelector('[data-testid="select-perf-compare"]') as HTMLSelectElement;
  assert(compare, "(F) comparison control renders");
  await act(async () => {
    compare.value = "prev";
    compare.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await flush(0);
  await flush(0);

  await clickEl(profile!.querySelector('[data-testid="button-perf-channels-toggle"]')!);
  await clickEl(profile!.querySelector('[data-testid="button-perf-accounts-toggle"]')!);

  const hasCents = (value: string | null | undefined) => /\$[\d,]+\.\d{1,2}/.test(value ?? "");
  const directCells = (table: Element): Element[] =>
    Array.from(table.children).filter((el) => el.classList.contains("cell"));
  const cplCells = (table: Element): Element[] =>
    directCells(table).filter((_, index) => index % 3 === 2);

  // The blended headline derives $403.38 / 2 leads = $201.69 and therefore
  // reads $202. Its exact raw ratio still drives the comparison percentage;
  // only the displayed value, real-change amount and comparison value round.
  // The comparison is $201 / 2 leads = $100.50, which rounds to $101.
  const cplKpi = profile!.querySelector('[data-testid="perf-kpi-cpl"]');
  assert(cplKpi, "(F) blended CPL headline KPI renders");
  assert(
    (cplKpi!.querySelector(".v")?.textContent ?? "").includes("$202"),
    `(F) profile headline rounds fractional blended CPL to $202, got "${cplKpi!.querySelector(".v")?.textContent}"`,
  );
  assert(
    (cplKpi!.querySelector(".vs")?.textContent ?? "").includes("$101"),
    `(F) profile comparison value rounds to whole dollars, got "${cplKpi!.querySelector(".vs")?.textContent}"`,
  );
  assert(!hasCents(cplKpi!.textContent), "(F) headline value, delta and comparison carry no CPL cents");

  // Flat account/channel grids use three numeric cells per row: spend, leads,
  // CPL. The fractional account is the exact $201.89 → $202 report example;
  // the value below the boundary pins $201.49 → $201.
  const accountTable = profile!.querySelector('[data-testid="perf-account-table"]')!;
  const accountCplCells = cplCells(accountTable);
  assert(accountCplCells.length === 3, `(F) three account CPL cells render, got ${accountCplCells.length}`);
  assert(
    accountCplCells[0].textContent!.startsWith("$202"),
    `(F) $201.89 account CPL rounds to $202, got "${accountCplCells[0].textContent}"`,
  );
  assert(
    accountCplCells[1].textContent!.startsWith("—"),
    `(F) no-lead account CPL remains a dash, got "${accountCplCells[1].textContent}"`,
  );
  assert(
    accountCplCells[2].textContent!.startsWith("$201"),
    `(F) $201.49 account CPL rounds to $201, got "${accountCplCells[2].textContent}"`,
  );
  assert(
    accountCplCells.every((el) => !hasCents(el.textContent)),
    "(F) account CPL values, real-change chips and comparison values carry no cents",
  );

  const channelTable = profile!.querySelector('[data-testid="perf-channel-table"]')!;
  const channelCplCells = cplCells(channelTable);
  assert(channelCplCells.length === 2, `(F) two channel CPL cells render, got ${channelCplCells.length}`);
  assert(
    channelCplCells.every((el) => !hasCents(el.textContent)),
    "(F) channel CPL values, deltas and comparison values carry no cents",
  );

  const accountCardCpl = Array.from(
    profile!.querySelectorAll("#perf-accts .perf-totals > span:nth-child(3)"),
  );
  assert(accountCardCpl.length === 3, `(F) three expanded account-card CPL totals render, got ${accountCardCpl.length}`);
  assert(
    accountCardCpl.every((el) => !hasCents(el.textContent)),
    "(F) expanded account-card CPL values and deltas carry no cents",
  );
  assert(
    accountCardCpl.some((el) => (el.textContent ?? "").startsWith("—")),
    "(F) expanded no-lead account card keeps the CPL dash",
  );

  // Composition bars expose both a visible label and a hover title. The
  // no-lead account has no ratio and remains omitted from this comparison.
  const cplBars = Array.from(profile!.querySelectorAll(".perf-bar-row"));
  assert(cplBars.length === 2, `(F) only the two lead-bearing CPL composition bars render, got ${cplBars.length}`);
  assert(
    cplBars.map((el) => el.querySelector(".perf-bar-val")?.textContent).join("|") === "$201|$202",
    `(F) composition labels are nearest-dollar values in ascending raw-CPL order, got "${cplBars.map((el) => el.querySelector(".perf-bar-val")?.textContent).join("|")}"`,
  );
  assert(
    cplBars.every((el) => !hasCents(el.getAttribute("title"))),
    "(F) composition hover titles carry no hidden two-decimal CPL values",
  );

  // Every native chart <title> includes all three metrics. CPL stays whole
  // dollar for fractional buckets and a dash for the no-lead account.
  const nativeTitles = Array.from(profile!.querySelectorAll("svg title")).map((el) => el.textContent ?? "");
  const cplTooltipLines = nativeTitles.flatMap((title) =>
    title.split("\n").filter((line) => line.startsWith("CPL:")),
  );
  assert(
    cplTooltipLines.some((line) => line === "CPL: $202"),
    `(F) native chart tooltip rounds fractional CPL to $202, got "${cplTooltipLines.join(" | ")}"`,
  );
  assert(
    cplTooltipLines.some((line) => line === "CPL: —"),
    "(F) native chart tooltip preserves the no-lead CPL dash",
  );
  assert(
    cplTooltipLines.every((line) => !hasCents(line)),
    "(F) native chart tooltip CPL lines carry no cents",
  );

  // Non-CPL presentation remains untouched: account spend still keeps cents
  // and leads remain whole counts. This distinguishes display-only CPL
  // rounding from accidental source-value or metric-formatting changes.
  const numericAccountCells = directCells(accountTable);
  const spendCells = numericAccountCells.filter((_, index) => index % 3 === 0);
  const leadCells = numericAccountCells.filter((_, index) => index % 3 === 1);
  assert(
    spendCells[0].textContent!.startsWith("$201.89") &&
      spendCells[2].textContent!.startsWith("$201.49"),
    `(F) spend formatting remains two-decimal, got "${spendCells.map((el) => el.textContent).join(" | ")}"`,
  );
  assert(
    leadCells.map((el) => el.textContent?.charAt(0)).join("|") === "1|0|1",
    `(F) lead formatting remains unchanged, got "${leadCells.map((el) => el.textContent).join(" | ")}"`,
  );

  // Scenario P above renders the same report-side fractional contract:
  // $201.89 → $202 and $201.49 → $201, while preserving 40/$2K and 10/$0.5K.
  console.log("scenario F (fractional CPL profile/report parity) PASSED");
}

keyWarningGuard.assertNoKeyWarnings("marketing-slide-restructure.test.tsx");
console.log("marketing-slide-restructure: PASSED");
