/* test-registration
{
  "name": "Overall account health/Relationship rendering — Dashboard split labeled columns (Task #5123) + accountRating drivers/provenance/lineage + DailyJudgmentStream authoritative rating section, dimension labels, no unknown→Healthy fallback (Task #3704)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5123: Dashboard Overall account health column (renamed from Performance) + accountRating authoritative tooltip (drivers/provenance/freshness/lineage) + DailyJudgmentStream authoritative rating section + no Healthy fallback for unknown statuses. Deterministic stubbed-fetch jsdom render test; the render layer has no other gate.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/judgment-basis-render-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json",
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #5123 — render-layer coverage for the accountRating / rating UI
 * integration. Extends Task #3704 (Task #3697 health data-basis surfaces).
 * The service/API sides are covered by tests/daily-judgment-*.test.ts;
 * this test mounts the REAL rendering layer in jsdom so a refactor cannot
 * silently drop:
 *
 * A. Dashboard (`client/src/pages/Dashboard.tsx`) Overall account health /
 *    Relationship columns (Task #5123 renames "Performance" → "Overall account
 *    health" everywhere):
 *    - authoritative tooltip from `accountRating` (drivers with provenance /
 *      freshness / age, carried-forward lineage, policy/revision),
 *    - legacy `judgmentBasis` fallback for rows without `accountRating`,
 *    - "limited data" marker (`text-limited-basis-${id}`) for operational-tier,
 *    - never-judged client renders NO health badge / marker / tooltip,
 *    - labeled sortable headers ("Overall account health", "Relationship");
 *      the relationship read is in its OWN column and sorts worst-first;
 *      the legend popover is titled "Overall account health (AI judgment)";
 *      filter chip reads "No Account Health Data".
 *
 * B. DailyJudgmentStream (`client/src/components/DailyJudgmentStream.tsx`):
 *    - "Overall account health" / "Relationship" dimension labels on badges,
 *    - authoritative rating section (`section-rating-authoritative-${id}`)
 *      with primary drivers (provenance/freshness/age) and lineage visually
 *      primary; model narrative labeled advisory when rating is present,
 *    - unknown statuses render neutral (no Healthy fallback),
 *    - operational-basis badge, carried-forward badge with fromDate title,
 *    - collapsed "Based on:" line, expanded Data Basis section,
 *    - legacy rows (no rating, arbitrary dataSourcesSummary) fall back to
 *      "Sources: <keys>" footer and no authoritative section.
 *
 * Harness: stubbed-fetch jsdom pattern (see
 * .agents/memory/mount-large-client-component-jsdom.md and
 * tests/client/dashboard-transient-resilience.test.tsx). Radix primitives and
 * heavy leaves are shimmed via tests/client/judgment-basis-render-setup.mjs.
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createFetchStub } from "../helpers/createFetchStub.mjs";

const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
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
(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

// ---- Fixtures ---------------------------------------------------------------

const TEST_USER = {
  id: "user-1",
  email: "lead@example.com",
  firstName: "Lead",
  lastName: "User",
  role: "team_lead",
  profileImageUrl: null,
};

function summary(overrides: Record<string, unknown>) {
  return {
    id: "c-x",
    clientCode: null,
    firmName: "Firm",
    contactName: null,
    products: [] as string[],
    practiceAreas: [] as string[],
    clientStartDate: "2025-01-01",
    ownerId: "user-1",
    ownerName: "Lead User",
    ownerAvatar: null,
    lastCommDate: "2026-07-01T00:00:00.000Z",
    commCount30d: 3,
    commCountTotal: 30,
    touchpointCount30d: 1,
    touchpointCountTotal: 10,
    lastTouchpointDate: "2026-07-01T00:00:00.000Z",
    judgmentStatus: "Healthy",
    relationshipHealth: null,
    judgmentHeadline: null,
    judgmentDate: "2026-08-01T00:00:00.000Z",
    judgmentConfidence: "High",
    judgmentBasis: null as unknown,
    accountRating: null as unknown,
    lastReviewedAt: "2026-08-01T00:00:00.000Z",
    budgetPosture: null,
    ...overrides,
  };
}

// Full-tier, High confidence → tooltip, NO limited-data marker. Carries a
// relationship read (the motivating "Healthy + At Risk look contradictory"
// pairing lives on C_OP; this one is the happy pairing).
// Task #5123 — accountRating carries authoritative structured rating with
// primaryDrivers (provenance, freshness, age) and generation lineage.
const C_FULL = summary({
  id: "c-full",
  firmName: "Fulldata LLP",
  judgmentStatus: "Healthy",
  relationshipHealth: "Strong",
  judgmentConfidence: "High",
  judgmentBasis: {
    tier: "full",
    basedOn: ["Communications (14)", "Reports"],
    missing: [],
    carriedForward: null,
  },
  accountRating: {
    status: "Healthy",
    statusDefinition: "Delivery is stable, cadence is within baseline, and no accepted negative evidence is present.",
    relationship: "Strong",
    relationshipDefinition: "A complete, stable account basis has no accepted negative relationship evidence.",
    riskScore: 12,
    riskRange: [0, 24],
    policyVersion: 3,
    promptRevision: "3.2",
    basisTier: "full",
    judgmentDate: "2026-08-01",
    generatedAt: "2026-08-01T06:00:00.000Z",
    generation: "generated",
    primaryDrivers: [
      {
        id: "d-1",
        label: "14 communications reviewed",
        severity: "supporting",
        provenance: "objective",
        sourceLabel: "Communications",
        occurredAt: "2026-07-28T00:00:00.000Z",
        ageDays: 4,
        freshness: "current",
      },
    ],
    reasonLabels: ["Stable delivery", "Cadence within baseline"],
    evidenceCounts: { accepted: 2, rejected: 0, reclassified: 0 },
    lineage: null,
  },
});

// Operational-tier, Medium confidence → limited-data marker + Missing line.
// Relationship deliberately WORSE than the overall account health badge (the
// unlabeled pairing Task #4994 disambiguates; Task #5123 labels both explicitly).
const C_OP = summary({
  id: "c-op",
  firmName: "Opsonly PC",
  judgmentStatus: "Watch",
  relationshipHealth: "At Risk",
  judgmentConfidence: "Medium",
  judgmentBasis: {
    tier: "operational",
    basedOn: ["SEMrush rankings", "Google Ads spend"],
    missing: ["Communications"],
    carriedForward: null,
  },
  accountRating: {
    status: "Watch",
    statusDefinition: "The account has a softer warning or an incomplete basis that needs attention.",
    relationship: "At Risk",
    relationshipDefinition: "Direct client-authored evidence indicates a severe relationship concern.",
    riskScore: 38,
    riskRange: [25, 49],
    policyVersion: 3,
    promptRevision: "3.2",
    basisTier: "operational",
    judgmentDate: "2026-08-01",
    generatedAt: "2026-08-01T06:00:00.000Z",
    generation: "generated",
    primaryDrivers: [
      {
        id: "d-2",
        label: "SEMrush ranking decline",
        severity: "watch",
        provenance: "objective",
        sourceLabel: "SEMrush",
        occurredAt: "2026-07-30T00:00:00.000Z",
        ageDays: 2,
        freshness: "current",
      },
      {
        id: "d-3",
        label: "No communications in 30 days",
        severity: "at-risk",
        provenance: "objective",
        sourceLabel: "Communications",
        occurredAt: null,
        ageDays: null,
        freshness: "unknown",
      },
    ],
    reasonLabels: ["Operational data only", "No comms in window"],
    evidenceCounts: { accepted: 1, rejected: 0, reclassified: 0 },
    lineage: null,
  },
});

// Task #5000 — Strained relationship fixture: confirms the "Rel: Strained"
// chip renders and filters to this client when the read exists.
const C_STRAINED = summary({
  id: "c-strained",
  firmName: "Strained Corp",
  judgmentStatus: "Healthy",
  relationshipHealth: "Strained",
  judgmentConfidence: "High",
  judgmentBasis: {
    tier: "full",
    basedOn: ["Communications (8)"],
    missing: [],
    carriedForward: null,
  },
  accountRating: {
    status: "Healthy",
    statusDefinition: "Delivery is stable, cadence is within baseline, and no accepted negative evidence is present.",
    relationship: "Strained",
    relationshipDefinition: "Current client-authored evidence indicates relationship pressure.",
    riskScore: 20,
    riskRange: [0, 24],
    policyVersion: 3,
    promptRevision: "3.2",
    basisTier: "full",
    judgmentDate: "2026-08-01",
    generatedAt: "2026-08-01T06:00:00.000Z",
    generation: "generated",
    primaryDrivers: [
      {
        id: "d-4",
        label: "Client expressed frustration in email",
        severity: "watch",
        provenance: "client-authored",
        sourceLabel: "Front email",
        occurredAt: "2026-07-25T00:00:00.000Z",
        ageDays: 7,
        freshness: "current",
      },
    ],
    reasonLabels: ["Client frustration signal"],
    evidenceCounts: { accepted: 1, rejected: 0, reclassified: 0 },
    lineage: null,
  },
});

// Carried-forward → tooltip carries the carried-forward lineage line.
// Task #5123 — accountRating.generation = "carried-forward" + lineage present.
const C_CF = summary({
  id: "c-cf",
  firmName: "Carryfwd LLC",
  judgmentStatus: "Healthy",
  judgmentConfidence: "High",
  judgmentBasis: {
    tier: "full",
    basedOn: ["Communications (2)"],
    missing: [],
    carriedForward: { fromDate: "2026-07-28" },
  },
  accountRating: {
    status: "Healthy",
    statusDefinition: "Delivery is stable, cadence is within baseline, and no accepted negative evidence is present.",
    relationship: null,
    relationshipDefinition: null,
    riskScore: 8,
    riskRange: [0, 24],
    policyVersion: 3,
    promptRevision: "3.2",
    basisTier: "full",
    judgmentDate: "2026-08-01",
    generatedAt: null,
    generation: "carried-forward",
    primaryDrivers: [],
    reasonLabels: ["Inputs unchanged"],
    evidenceCounts: { accepted: 0, rejected: 0, reclassified: 0 },
    lineage: {
      fromDate: "2026-07-28",
      fromJudgmentId: "j-prev-1",
      rootDate: "2026-07-28",
      rootJudgmentId: "j-prev-1",
    },
  },
});

// Never judged → no badge, no marker, no tooltip; "—" placeholder cell.
const C_NONE = summary({
  id: "c-none",
  firmName: "Neverjudged Inc",
  judgmentStatus: null,
  judgmentConfidence: null,
  judgmentBasis: null,
  accountRating: null,
  judgmentDate: null,
});

function judgment(overrides: Record<string, unknown>) {
  return {
    id: "j-x",
    clientId: "client-1",
    judgmentDate: "2026-08-01",
    status: "Healthy",
    relationshipHealth: null,
    relationshipStatus: null,
    confidence: null,
    confidenceLevel: "High",
    overallSentiment: null,
    sentimentTrend: null,
    headline: "Headline",
    narrativeSummary: null,
    summaryText: null,
    keyRisks: null,
    keyOpportunities: null,
    concernsJson: null,
    winsJson: null,
    unresolvedAskCount: 0,
    communicationsAnalyzed: 0,
    dataSourcesSummary: null as unknown,
    actionsJson: null,
    rating: null as unknown,
    createdAt: "2026-08-01T06:00:00.000Z",
    ...overrides,
  };
}

// Operational-tier judgment with a missing inventory.
// Task #5123 — rating field carries authoritative AccountRatingPresentation.
const J_OP = judgment({
  id: "j-op",
  status: "Watch",
  confidenceLevel: "Medium",
  dataSourcesSummary: {
    tier: "operational",
    basedOn: ["SEMrush rankings", "Reports (1)"],
    missing: ["Communications"],
    carriedForward: null,
  },
  rating: {
    status: "Watch",
    statusDefinition: "The account has a softer warning or an incomplete basis that needs attention.",
    relationship: null,
    relationshipDefinition: null,
    riskScore: 33,
    riskRange: [25, 49],
    policyVersion: 3,
    promptRevision: "3.1",
    basisTier: "operational",
    judgmentDate: "2026-08-01",
    generatedAt: "2026-08-01T05:00:00.000Z",
    generation: "generated",
    primaryDrivers: [
      {
        id: "drv-op-1",
        label: "No communications available",
        severity: "at-risk",
        provenance: "objective",
        sourceLabel: "Communications",
        occurredAt: null,
        ageDays: null,
        freshness: "unknown",
      },
      {
        id: "drv-op-2",
        label: "SEMrush rankings declined 12%",
        severity: "watch",
        provenance: "objective",
        sourceLabel: "SEMrush",
        occurredAt: "2026-07-31T00:00:00.000Z",
        ageDays: 1,
        freshness: "current",
      },
    ],
    reasonLabels: ["Operational only", "SEMrush decline"],
    evidenceCounts: { accepted: 1, rejected: 0, reclassified: 0 },
    lineage: null,
  },
});

// Carried-forward judgment — generation = "carried-forward" + lineage.
const J_CF = judgment({
  id: "j-cf",
  judgmentDate: "2026-08-02",
  dataSourcesSummary: {
    tier: "full",
    basedOn: ["Communications (5)"],
    missing: [],
    carriedForward: { fromDate: "2026-08-01" },
  },
  rating: {
    status: "Healthy",
    statusDefinition: "Delivery is stable, cadence is within baseline, and no accepted negative evidence is present.",
    relationship: null,
    relationshipDefinition: null,
    riskScore: 10,
    riskRange: [0, 24],
    policyVersion: 3,
    promptRevision: "3.1",
    basisTier: "full",
    judgmentDate: "2026-08-02",
    generatedAt: null,
    generation: "carried-forward",
    primaryDrivers: [],
    reasonLabels: ["Inputs unchanged"],
    evidenceCounts: { accepted: 0, rejected: 0, reclassified: 0 },
    lineage: {
      fromDate: "2026-08-01",
      fromJudgmentId: "j-prev-2",
      rootDate: "2026-08-01",
      rootJudgmentId: "j-prev-2",
    },
  },
});

// Legacy pre-#3697 row: arbitrary source-count shape → "Sources:" fallback.
// No rating field (simulates an old row with no AccountRatingPresentation).
const J_LEGACY = judgment({
  id: "j-legacy",
  judgmentDate: "2026-07-30",
  narrativeSummary: "Plain legacy narrative.",
  dataSourcesSummary: { front: 12, slack: 3 },
  rating: null,
});

// ---- Fetch stub -------------------------------------------------------------

const fetchStub = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/auth/user", json: TEST_USER },
    { path: "/api/dashboard/client-summaries", json: [C_FULL, C_OP, C_STRAINED, C_CF, C_NONE] },
    { path: "/api/dashboard/wins", json: [] },
    { path: /\/api\/clients\/[^/]+\/judgments(\?|$)/, json: [J_OP, J_CF, J_LEGACY] },
    { path: /\/api\/clients\/[^/]+\/recent-comms-count$/, json: { count: 5, days: 30 } },
    { path: /\/api\/clients\/[^/]+\/open-asks$/, json: [] },
    { path: "/api/reports", json: [] },
    { path: "/api/notifications/unread-count", json: { count: 0 } },
    { path: "/api/monthly-review-stats", json: { reviewed: 0, needsReview: 0, total: 0 } },
    { path: "/api/integrations/unmatched-feed", json: { items: [], totalCount: 0, clients: [] } },
  ],
  defaultJson: {},
});
(globalThis as any).fetch = fetchStub;

// ---- Helpers ----------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function byTestId(id: string): Element | null {
  return dom.window.document.querySelector(`[data-testid="${id}"]`);
}

function bodyText(): string {
  return dom.window.document.body.textContent || "";
}

/** The Performance-cell tooltip is a native `title` on the wrapper around the badge. */
function healthTooltip(clientId: string): string | null {
  const badge = byTestId(`badge-health-${clientId}`);
  if (!badge) return null;
  const holder = badge.closest("[title]");
  return holder ? holder.getAttribute("title") : null;
}

// ---- Run --------------------------------------------------------------------

async function run() {
  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClient, QueryClientProvider } = (await import("@tanstack/react-query")) as any;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);

  function mount(element: any) {
    act(() => {
      root.render(
        React.createElement(QueryClientProvider, { client: queryClient }, element),
      );
    });
  }

  // ===========================================================================
  // Part A — Dashboard health column
  // ===========================================================================
  const Dashboard = (await import("@/pages/Dashboard")).default as any;
  mount(React.createElement(Dashboard));

  await waitFor(
    "dashboard client table renders all fixture firms",
    () =>
      bodyText().includes("Fulldata LLP") &&
      bodyText().includes("Opsonly PC") &&
      bodyText().includes("Strained Corp") &&
      bodyText().includes("Carryfwd LLC") &&
      bodyText().includes("Neverjudged Inc"),
  );

  // Full-tier / High: health badge with tooltip, NO limited-data marker.
  assert.ok(byTestId("badge-health-c-full"), "full-tier client must render a health badge");
  assert.equal(
    byTestId("text-limited-basis-c-full"),
    null,
    "full-tier/High client must NOT carry the 'limited data' marker",
  );
  const fullTip = healthTooltip("c-full");
  assert.ok(fullTip, "full-tier health badge must carry a title tooltip");
  assert.ok(
    fullTip!.includes("Based on: Communications (14) · Reports"),
    `full tooltip must list its basis, got: ${fullTip}`,
  );
  assert.ok(fullTip!.includes("Confidence: High"), `full tooltip must carry confidence, got: ${fullTip}`);
  assert.ok(!fullTip!.includes("Missing:"), "full tooltip must not have a Missing line");
  assert.ok(!fullTip!.includes("Carried forward"), "full tooltip must not claim carried-forward");

  // Operational / Medium: limited-data marker + Missing line in tooltip.
  const opMarker = byTestId("text-limited-basis-c-op");
  assert.ok(opMarker, "operational-tier client must show the 'limited data' marker");
  assert.ok(
    (opMarker!.textContent || "").includes("limited data"),
    `marker must read 'limited data', got: ${opMarker!.textContent}`,
  );
  const opTip = healthTooltip("c-op");
  assert.ok(opTip, "operational health badge must carry a title tooltip");
  assert.ok(
    opTip!.includes("Based on: SEMrush rankings · Google Ads spend"),
    `operational tooltip must list its basis, got: ${opTip}`,
  );
  assert.ok(
    opTip!.includes("Missing: Communications"),
    `operational tooltip must list what's missing, got: ${opTip}`,
  );
  assert.ok(opTip!.includes("Confidence: Medium"), `operational tooltip confidence, got: ${opTip}`);

  // Carried-forward: tooltip carries the carried-forward provenance line.
  const cfTip = healthTooltip("c-cf");
  assert.ok(cfTip, "carried-forward health badge must carry a title tooltip");
  assert.ok(
    cfTip!.includes("Carried forward from 2026-07-28 (inputs unchanged)"),
    `carried-forward tooltip line missing, got: ${cfTip}`,
  );
  assert.equal(
    byTestId("text-limited-basis-c-cf"),
    null,
    "carried-forward full-tier/High client must NOT be flagged limited",
  );

  // Never judged: no badge, no marker, no tooltip — the "—" placeholder cell.
  assert.equal(byTestId("badge-health-c-none"), null, "never-judged client must have NO health badge");
  assert.equal(
    byTestId("text-limited-basis-c-none"),
    null,
    "never-judged client must have NO limited-data marker",
  );
  // Task #4362 — the client table is an OsTable adopter; rows carry the
  // shared primitive's `os-table-row-<id>` testid.
  const noneRow = byTestId("os-table-row-c-none");
  assert.ok(noneRow, "never-judged client row must render");
  assert.ok(
    (noneRow!.textContent || "").includes("—"),
    "never-judged health cell must show the '—' placeholder",
  );
  // "No data" is the never-judged label (CSV export path); judged clients must
  // never read as no-data anywhere in the rendered dashboard.
  for (const id of ["c-full", "c-op", "c-strained", "c-cf"] as const) {
    const row = byTestId(`os-table-row-${id}`);
    assert.ok(row, `row for ${id} must render`);
    assert.ok(
      !(row!.textContent || "").includes("No data"),
      `judged client ${id} must not read 'No data'`,
    );
  }

  // ---------------------------------------------------------------------------
  // Task #5123 — split labeled Overall account health / Relationship columns.
  // ---------------------------------------------------------------------------

  // Labeled sortable headers with scale tooltips.
  const perfHeader = byTestId("os-table-sort-judgmentStatus");
  assert.ok(perfHeader, "Overall account health column sort header must render");
  assert.ok(
    (perfHeader!.textContent || "").includes("Overall account health"),
    `overall account health header must be labeled 'Overall account health', got: ${perfHeader!.textContent}`,
  );
  const perfHeaderTip = perfHeader!.querySelector("span[title]")?.getAttribute("title") || "";
  assert.ok(
    perfHeaderTip.includes("Deterministic account-health rating"),
    `Overall account health header tooltip must explain the policy scale, got: ${perfHeaderTip}`,
  );
  const relHeader = byTestId("os-table-sort-relationshipHealth");
  assert.ok(relHeader, "Relationship column sort header must render");
  assert.ok(
    (relHeader!.textContent || "").includes("Relationship"),
    `relationship header must be labeled 'Relationship', got: ${relHeader!.textContent}`,
  );
  const relHeaderTip = relHeader!.querySelector("span[title]")?.getAttribute("title") || "";
  assert.ok(
    relHeaderTip.includes("separate from"),
    `Relationship header tooltip must explain the scale, got: ${relHeaderTip}`,
  );

  // Relationship renders in its OWN column cell, outside the overall-account-
  // health cell's judgment-basis tooltip wrapper.
  const fullRel = byTestId("text-relationship-c-full");
  assert.ok(fullRel, "client with a relationship read must render the relationship text");
  assert.equal((fullRel!.textContent || "").trim(), "Strong");
  const fullBadge = byTestId("badge-health-c-full")!;
  assert.ok(
    fullBadge.closest("td") !== fullRel!.closest("td"),
    "Overall account health badge and Relationship text must live in separate columns",
  );
  const relTitleHolder = fullRel!.closest("[title]");
  assert.ok(
    !relTitleHolder || !(relTitleHolder.getAttribute("title") || "").includes("Based on:"),
    "relationship text must not sit inside the judgment-basis tooltip wrapper",
  );
  const opRel = byTestId("text-relationship-c-op");
  assert.ok(opRel, "worse-than-overall-health relationship read must render");
  assert.equal((opRel!.textContent || "").trim(), "At Risk");

  // No relationship read → em-dash placeholder, no relationship text node.
  assert.equal(
    byTestId("text-relationship-c-cf"),
    null,
    "client without a relationship read must render NO relationship text",
  );
  // Column order: firmName(0) · Overall account health(1) · Relationship(2) · Headline(3)…
  const cfCells = byTestId("os-table-row-c-cf")!.querySelectorAll("td");
  assert.ok(
    (cfCells[2]?.textContent || "").includes("—"),
    "no-relationship client must show an em-dash in the Relationship column",
  );
  const noneCells = byTestId("os-table-row-c-none")!.querySelectorAll("td");
  assert.ok(
    (noneCells[1]?.textContent || "").includes("—"),
    "never-judged client must show an em-dash in the Overall account health column",
  );
  assert.ok(
    (noneCells[2]?.textContent || "").includes("—"),
    "never-judged client must show an em-dash in the Relationship column",
  );

  // Task #5123 — accountRating tooltip carries authoritative provenance:
  // driver labels, provenance type, age, carried-forward lineage.
  const cfTipNew = healthTooltip("c-cf");
  assert.ok(cfTipNew, "carried-forward accountRating tooltip must render");
  assert.ok(
    cfTipNew!.includes("Carried forward from 2026-07-28"),
    `carried-forward tooltip must cite lineage fromDate, got: ${cfTipNew}`,
  );
  assert.ok(
    cfTipNew!.includes("Policy v3"),
    `carried-forward tooltip must cite policy version, got: ${cfTipNew}`,
  );
  const fullTipNew = healthTooltip("c-full");
  assert.ok(fullTipNew, "full-tier accountRating tooltip must render");
  assert.ok(
    fullTipNew!.includes("14 communications reviewed"),
    `full-tier tooltip must cite primary driver label, got: ${fullTipNew}`,
  );
  assert.ok(
    fullTipNew!.includes("objective"),
    `full-tier tooltip must cite driver provenance, got: ${fullTipNew}`,
  );
  assert.ok(
    fullTipNew!.includes("4d ago"),
    `full-tier tooltip must cite driver age, got: ${fullTipNew}`,
  );
  assert.ok(
    fullTipNew!.includes("current"),
    `full-tier tooltip must cite driver freshness, got: ${fullTipNew}`,
  );

  // ---------------------------------------------------------------------------
  // Task #5123 — relationship quick-filter chips + "No Account Health Data" label.
  // ---------------------------------------------------------------------------

  // "No Account Health Data" chip must be present (renamed from "No Performance Data").
  assert.ok(
    bodyText().includes("No Account Health Data"),
    "filter chips must include 'No Account Health Data' (renamed from 'No Performance Data')",
  );
  assert.ok(
    !bodyText().includes("No Performance Data"),
    "'No Performance Data' chip label must not appear anywhere — renamed to 'No Account Health Data'",
  );
  assert.ok(
    !bodyText().includes("No Health Data"),
    "old 'No Health Data' chip label must not appear anywhere in the page",
  );

  // "Rel: At Risk" chip renders (C_OP has relationshipHealth: "At Risk").
  const relAtRiskChip = byTestId("filter-rel_at_risk");
  assert.ok(relAtRiskChip, "'Rel: At Risk' relationship filter chip must render");

  // Clicking the chip narrows the table to C_OP only.
  await act(async () => {
    (relAtRiskChip as any).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await sleep(0);
  });
  await waitFor(
    "rel_at_risk filter: only C_OP row visible",
    () => {
      const rows = dom.window.document.querySelectorAll('[data-testid^="os-table-row-"]');
      return (
        rows.length === 1 &&
        !!dom.window.document.querySelector('[data-testid="os-table-row-c-op"]')
      );
    },
  );

  // Chip is marked active.
  assert.ok(
    (relAtRiskChip as any).getAttribute("aria-pressed") === "true",
    "'Rel: At Risk' chip must be aria-pressed=true when active",
  );

  // Reset to "All" before continuing.
  await act(async () => {
    const allChip = dom.window.document.querySelector(
      '[aria-label="Relationship filter"] [data-testid="filter-all"]',
    );
    assert.ok(allChip, "relationship All chip must render");
    (allChip as any).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await sleep(0);
  });
  await waitFor(
    "reset to all: all five rows visible again",
    () => dom.window.document.querySelectorAll('[data-testid^="os-table-row-"]').length === 5,
  );

  // Task #5000 — "Rel: Strained" chip renders (C_STRAINED has relationshipHealth: "Strained").
  const relStrainedChip = byTestId("filter-rel_strained");
  assert.ok(relStrainedChip, "'Rel: Strained' relationship filter chip must render");

  // Clicking the chip narrows the table to C_STRAINED only.
  await act(async () => {
    (relStrainedChip as any).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await sleep(0);
  });
  await waitFor(
    "rel_strained filter: only C_STRAINED row visible",
    () => {
      const rows = dom.window.document.querySelectorAll('[data-testid^="os-table-row-"]');
      return (
        rows.length === 1 &&
        !!dom.window.document.querySelector('[data-testid="os-table-row-c-strained"]')
      );
    },
  );

  // Chip is marked active.
  assert.ok(
    (relStrainedChip as any).getAttribute("aria-pressed") === "true",
    "'Rel: Strained' chip must be aria-pressed=true when active",
  );

  // Reset to "All" before continuing.
  await act(async () => {
    const allChip = dom.window.document.querySelector(
      '[aria-label="Relationship filter"] [data-testid="filter-all"]',
    );
    assert.ok(allChip, "relationship All chip must render");
    (allChip as any).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await sleep(0);
  });
  await waitFor(
    "reset to all after strained filter: all five rows visible again",
    () => dom.window.document.querySelectorAll('[data-testid^="os-table-row-"]').length === 5,
  );

  // Mobile card labels its relationship line; the overall account health badge stays.
  const mobileCard = byTestId("card-client-c-full");
  assert.ok(mobileCard, "mobile card must render");
  const mobileRel = mobileCard!.querySelector('[data-testid="text-relationship-c-full"]');
  assert.ok(mobileRel, "mobile card must render the relationship value");
  assert.ok(
    (mobileRel!.parentElement!.textContent || "").includes("Relationship:"),
    `mobile relationship line must be labeled, got: ${mobileRel!.parentElement!.textContent}`,
  );
  assert.ok(
    mobileCard!.querySelector('[data-testid="badge-health-c-full"]'),
    "mobile card must keep the overall account health badge",
  );

  // Legend popover (inline via the popover shim) uses the new terminology.
  assert.ok(
    bodyText().includes("Overall account health (policy rating)"),
    "legend must title the judgment section 'Overall account health (policy rating)'",
  );
  assert.ok(
    !bodyText().includes("Performance (AI judgment)"),
    "legend must not use the old 'Performance (AI judgment)' title",
  );
  assert.ok(
    !bodyText().includes("Health (AI judgment)"),
    "legend must not use the old 'Health (AI judgment)' title",
  );

  // Relationship column sorts worst-first (asc): At Risk → Strong → no read.
  await act(async () => {
    (relHeader as any).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await sleep(0);
  });
  const rowOrder = Array.from(
    dom.window.document.querySelectorAll('[data-testid^="os-table-row-"]'),
  ).map((el) => el.getAttribute("data-testid"));
  assert.deepEqual(
    rowOrder,
    ["os-table-row-c-op", "os-table-row-c-strained", "os-table-row-c-full", "os-table-row-c-cf", "os-table-row-c-none"],
    "relationship sort must rank worst-first with no-read clients last",
  );

  console.log("  ✓ Part A: Dashboard Overall account health/Relationship columns — tooltip content (driver provenance/freshness/lineage), limited-data marker, placeholders, labeled headers + scale tooltips, rel quick-filter chips, 'No Account Health Data' rename, mobile relationship label, legend retitle, worst-first sort");

  act(() => root.unmount());

  // ===========================================================================
  // Part B — DailyJudgmentStream
  // ===========================================================================
  const root2 = createRoot(container);
  const DailyJudgmentStream = (await import("@/components/DailyJudgmentStream")).default as any;
  act(() => {
    root2.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(DailyJudgmentStream, {
          clientId: "client-1",
          currentUser: TEST_USER,
        }),
      ),
    );
  });

  await waitFor(
    "judgment stream renders all fixture cards",
    () =>
      byTestId("card-judgment-j-op") !== null &&
      byTestId("card-judgment-j-cf") !== null &&
      byTestId("card-judgment-j-legacy") !== null,
  );

  // Task #5123 — both dimension labels must appear on the operational card.
  const opCard = byTestId("card-judgment-j-op")!;
  assert.ok(
    (opCard.textContent || "").includes("Overall account health"),
    "DailyJudgmentStream must label the status badge dimension 'Overall account health'",
  );

  // Operational badge — driven by rating.basisTier = "operational".
  const opBadge = byTestId("badge-operational-basis-j-op");
  assert.ok(opBadge, "operational judgment must carry the operational-basis badge");
  assert.ok(
    (opBadge!.textContent || "").includes("Operational data"),
    `badge must read 'Operational data', got: ${opBadge!.textContent}`,
  );
  assert.equal(byTestId("badge-operational-basis-j-cf"), null, "full-tier card must NOT carry operational badge");
  assert.equal(byTestId("badge-operational-basis-j-legacy"), null, "legacy card must NOT carry operational badge");

  // Carried-forward badge — driven by rating.generation = "carried-forward" + lineage.fromDate.
  const cfBadge = byTestId("badge-carried-forward-j-cf");
  assert.ok(cfBadge, "carried-forward judgment must carry the carried-forward badge");
  assert.ok(
    (cfBadge!.getAttribute("title") || "").includes("2026-08-01"),
    `carried-forward badge title must cite the fromDate, got: ${cfBadge!.getAttribute("title")}`,
  );
  assert.equal(byTestId("badge-carried-forward-j-op"), null, "operational card must NOT carry carried-forward badge");
  assert.equal(byTestId("badge-carried-forward-j-legacy"), null, "legacy card must NOT carry carried-forward badge");

  // Authoritative rating explanation: rendered visually primary for rows with rating.
  const opRatingSection = byTestId("section-rating-authoritative-j-op");
  assert.ok(opRatingSection, "operational card must render the authoritative rating explanation");
  assert.ok(
    (opRatingSection!.textContent || "").includes("Watch"),
    `authoritative section must name the status, got: ${opRatingSection!.textContent}`,
  );
  // Drivers with provenance and freshness.
  const opDriversSection = byTestId("section-rating-drivers-j-op");
  assert.ok(opDriversSection, "operational card must render the primary drivers section");
  const opDriversText = opDriversSection!.textContent || "";
  assert.ok(
    opDriversText.includes("No communications available"),
    `drivers must include 'No communications available', got: ${opDriversText}`,
  );
  assert.ok(
    opDriversText.includes("objective"),
    `drivers must show provenance 'objective', got: ${opDriversText}`,
  );
  assert.ok(
    opDriversText.includes("SEMrush rankings declined 12%"),
    `drivers must include SEMrush driver, got: ${opDriversText}`,
  );
  assert.ok(
    opDriversText.includes("1d ago"),
    `drivers must show age '1d ago', got: ${opDriversText}`,
  );
  assert.ok(
    opDriversText.includes("current"),
    `drivers must show freshness 'current', got: ${opDriversText}`,
  );

  // Carried-forward authoritative section shows lineage fromDate.
  const cfRatingSection = byTestId("section-rating-authoritative-j-cf");
  assert.ok(cfRatingSection, "carried-forward card must render the authoritative rating explanation");
  assert.ok(
    (cfRatingSection!.textContent || "").includes("Carried forward from 2026-08-01"),
    `carried-forward authoritative section must cite lineage fromDate, got: ${cfRatingSection!.textContent}`,
  );

  // Legacy card has no authoritative rating section (rating: null).
  assert.equal(
    byTestId("section-rating-authoritative-j-legacy"),
    null,
    "legacy card (no rating) must NOT render the authoritative rating section",
  );

  // Collapsed "Based on:" line for structured-basis judgments only.
  const opBasisLine = byTestId("text-judgment-basis-j-op");
  assert.ok(opBasisLine, "operational card must show the collapsed 'Based on:' line");
  assert.ok(
    (opBasisLine!.textContent || "").includes("Based on: SEMrush rankings · Reports (1)"),
    `'Based on:' line content wrong, got: ${opBasisLine!.textContent}`,
  );
  assert.ok(byTestId("text-judgment-basis-j-cf"), "carried-forward card must show the 'Based on:' line");
  assert.equal(
    byTestId("text-judgment-basis-j-legacy"),
    null,
    "legacy card (unparseable basis) must NOT show a 'Based on:' line",
  );

  // Expand all three cards.
  for (const id of ["j-op", "j-cf", "j-legacy"] as const) {
    const btn = byTestId(`button-expand-judgment-${id}`);
    assert.ok(btn, `expand button must render for ${id}`);
    await act(async () => {
      (btn as any).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await sleep(0);
    });
  }

  // Expanded operational card: Data Basis section with missing line + caveat.
  const opSection = byTestId("section-data-basis-j-op");
  assert.ok(opSection, "expanded operational card must show the Data Basis section");
  const opMissing = byTestId("text-judgment-missing-j-op");
  assert.ok(opMissing, "expanded operational card must show the missing line");
  assert.ok(
    (opMissing!.textContent || "").includes("Not available: Communications"),
    `missing line content wrong, got: ${opMissing!.textContent}`,
  );
  assert.ok(
    (opSection!.textContent || "").includes("judged from operational data"),
    "operational Data Basis section must carry the operational caveat",
  );

  // Expanded carried-forward card: carried-forward provenance in Data Basis.
  const cfSection = byTestId("section-data-basis-j-cf");
  assert.ok(cfSection, "expanded carried-forward card must show the Data Basis section");
  assert.ok(
    (cfSection!.textContent || "").includes("Carried forward from 2026-08-01"),
    `carried-forward Data Basis line missing, got: ${cfSection!.textContent}`,
  );
  assert.equal(
    byTestId("text-judgment-missing-j-cf"),
    null,
    "carried-forward card (nothing missing) must NOT show a missing line",
  );

  // Legacy row: "Sources:" fallback, never the structured section.
  assert.equal(
    byTestId("section-data-basis-j-legacy"),
    null,
    "legacy card must NOT render the structured Data Basis section",
  );
  const legacyCard = byTestId("card-judgment-j-legacy");
  assert.ok(
    (legacyCard!.textContent || "").includes("Sources: front, slack"),
    `legacy card must fall back to 'Sources: front, slack', got no match in: ${legacyCard!.textContent}`,
  );

  console.log("  ✓ Part B: DailyJudgmentStream — 'Overall account health' label, authoritative rating section (drivers/provenance/freshness/lineage), operational/carried-forward badges, basis lines, Data Basis section, legacy Sources fallback, no legacy Performance terminology");

  act(() => root2.unmount());
}

run()
  .then(() => {
    console.log("\nPASS tests/client/judgment-basis-render.test.tsx");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/client/judgment-basis-render.test.tsx");
    console.error(err);
    process.exit(1);
  });
