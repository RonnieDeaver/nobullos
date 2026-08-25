/* test-registration
{
  "name": "Churn leaderboard tab — briefing rows render reasons inline and expand in place (jsdom, no navigation required)",
  "regression": true,
  "smoke": true,
  "smokeReason": "The Leaderboard tab's whole point after the briefing redesign is that a director reads WHY each client is at risk without leaving the page: concerns + what-changed inline, full narrative/actions expanding in place, expand-all, explicit zero-comms/carried-forward treatment, real report metrics, and the no-data bucket. Mounts the REAL ChurnLeaderboardTab in jsdom against a stubbed leaderboard payload and fails loudly if any of that regresses to a click-through or a blank render. DB-free, network-free, ~2s.",
  "extraNodeArgs": [
    "--import",
    "./tests/churn-leaderboard-tab-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Churn Command Center — Leaderboard briefing view UI contract.
 *
 * Mounts the REAL ChurnLeaderboardTab (client/src/components/churn/
 * ChurnLeaderboardTab.tsx) in jsdom with a stubbed
 * GET /api/churn/leaderboard payload and pins the redesign's promises:
 *
 *   1. Reasons inline, zero clicks — the concerns list and the "what
 *      changed" line are in the DOM right after mount, and no expanded
 *      section exists yet (they are NOT hidden behind the expansion).
 *   2. In-place expansion — clicking the row header reveals the full
 *      narrative sections, recommended actions (with rationale), wins,
 *      unresolved-ask count and the labeled signal grid, while
 *      location.pathname stays put (no navigation needed to read WHY).
 *      Clicking again collapses. Expand-all opens every scored row.
 *   3. Evidence treatment — comms-analyzed count + confidence + inbound
 *      recency + real lead/review numbers render for a fully-evidenced row;
 *      a zero-fresh-comms carried-forward row shows the explicit amber
 *      "0 new comms" chip and the carried-forward badge, and a client
 *      without reports shows the "no monthly-report metrics" fallback
 *      instead of fabricated numbers.
 *   4. No-data bucket — never-judged clients render in the separate bucket.
 *   5. Client page stays reachable as a SECONDARY action — the explicit
 *      open-client button navigates (pathname changes), proving the row
 *      click and the navigation affordance are decoupled.
 *
 * DB-free / network-free. Harness per memory notes
 * mount-large-client-component-jsdom + radix-portal-jsdom-tests:
 * jsdom globals installed BEFORE the dynamic client imports, heavy-client
 * loader (setup: tests/churn-leaderboard-tab-setup.mjs) stubs CSS and shims
 * Radix Select, fetch stubbed via tests/helpers/createFetchStub.mjs, and the
 * QueryClient gets the app-shaped default queryFn (queryKey.join("/") →
 * fetch) so the component's bare useQuery({ queryKey }) works as in prod.
 */
import { strict as assert } from "node:assert";

import { JSDOM } from "jsdom";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs helper without type declarations
import { createFetchStub } from "./helpers/createFetchStub.mjs";

// ── jsdom bootstrap (must precede the dynamic client imports) ──
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/churn" },
);
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).navigator = dom.window.navigator;
(globalThis as any).location = dom.window.location;
(globalThis as any).history = dom.window.history;
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
(globalThis as any).addEventListener = dom.window.addEventListener.bind(dom.window);
(globalThis as any).removeEventListener = dom.window.removeEventListener.bind(dom.window);
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).MouseEvent = dom.window.MouseEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).CustomEvent = dom.window.CustomEvent;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
if (!(globalThis as any).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

// ── Fixture payload (shape mirrors server/routes/churn.ts response) ──

const CL_A = "cl-a"; // fully-evidenced Critical row
const CL_B = "cl-b"; // zero-fresh-comms carried-forward row, no reports
const CL_C = "cl-c"; // never judged → no-data bucket
const CL_D = "cl-d"; // Task #4048: analyzed == count30d → merged full-window chip

const CONCERNS = [
  "Three emails unanswered for over a week",
  "Lead volume dropped sharply month-over-month",
  "Client asked about contract terms twice",
];
const CHANGE_SUMMARY = "Risk rose after two more emails went unanswered since yesterday.";
const NARRATIVE =
  "**Summary**\nThe firm is drifting after two escalations.\n\n**Concerns**\nEmails are going unanswered.";

// Task #5123 — authoritative rating fixtures
const RATING_CL_A = {
  status: "Critical",
  statusDefinition: "Qualifying first-party evidence indicates an immediate loss risk.",
  relationship: "Strained",
  relationshipDefinition: "Current client-authored evidence indicates relationship pressure.",
  riskScore: 82,
  riskRange: [75, 100],
  policyVersion: 5,
  promptRevision: "5123.1",
  basisTier: "full",
  judgmentDate: "2026-08-01",
  generatedAt: "2026-08-01T06:00:00.000Z",
  generation: "generated",
  primaryDrivers: [
    {
      id: "d1",
      label: "Three client emails unanswered for 9+ days",
      severity: "critical",
      provenance: "client-authored",
      sourceLabel: "Front email thread",
      occurredAt: "2026-07-23T00:00:00.000Z",
      ageDays: 9,
      freshness: "current",
    },
    {
      id: "d2",
      label: "Lead volume drop of 40% month-over-month",
      severity: "at-risk",
      provenance: "objective",
      sourceLabel: "Monthly report",
      occurredAt: "2026-07-01T00:00:00.000Z",
      ageDays: 31,
      freshness: "standing",
    },
  ],
  reasonLabels: ["Unanswered emails", "Lead volume drop"],
  evidenceCounts: { accepted: 3, rejected: 0, reclassified: 1 },
  lineage: null,
};

const RATING_CL_B = {
  status: "Watch",
  statusDefinition: "The account has a softer warning or an incomplete basis that needs attention.",
  relationship: null,
  relationshipDefinition: null,
  riskScore: 30,
  riskRange: [25, 49],
  policyVersion: 5,
  promptRevision: "5123.1",
  basisTier: null,
  judgmentDate: "2026-08-01",
  generatedAt: null,
  generation: "carried-forward",
  primaryDrivers: [],
  reasonLabels: [],
  evidenceCounts: { accepted: 0, rejected: 0, reclassified: 0 },
  lineage: {
    fromDate: "2026-07-28",
    fromJudgmentId: "jdg-prev",
    rootDate: "2026-07-28",
    rootJudgmentId: "jdg-prev",
  },
};

const PAYLOAD = {
  generatedAt: "2026-08-06T12:00:00.000Z",
  clients: [
    {
      clientId: CL_A,
      firmName: "Meridian Law Group",
      clientCode: "NB-0101",
      ownerId: "u-1",
      ownerName: "Dana Owner",
      ownerAvatar: null,
      judgment: {
        status: "Critical",
        riskScore: 82.5,
        headline: "Escalating complaints - three unanswered emails",
        judgmentDate: "2026-08-01",
        summaryText: "Latest full summary.",
        narrativeSummary: NARRATIVE,
        changeSummary: CHANGE_SUMMARY,
        sentimentSummary: "Tone is frustrated but still professional.",
        concernsJson: CONCERNS,
        keyRisks: null,
        actionsJson: [
          { action: "Call the client today", why: "Unanswered emails signal escalation risk" },
          { action: "Send the July lead report", why: null },
        ],
        winsJson: ["Reviews up in July"],
        keyOpportunities: null,
        unresolvedAskCount: 2,
        communicationsAnalyzed: 14,
        dataSourcesSummary: {
          tier: "full",
          basedOn: ["front_emails", "call_transcripts", "monthly_reports"],
          missing: [],
          carriedForward: null,
        },
        confidence: "Medium",
        confidenceLevel: "High",
        generatedFromStartAt: "2026-07-25T00:00:00.000Z",
        generatedFromEndAt: "2026-08-01T00:00:00.000Z",
        statusSince: "2026-07-30",
        rating: RATING_CL_A,
      },
      signals: {
        signalDate: "2026-08-01",
        sentimentScore: -40,
        complaintScore: 77.5,
        trustScore: 22,
        responsivenessRiskScore: 66,
        executionRiskScore: 55,
        leadVolumeConcernScore: 44,
        unresolvedTaskScore: 33,
        relationshipHealthScore: 25,
      },
      engagement: {
        snapshotDate: "2026-08-01",
        daysSinceLastInbound: 9,
        daysSinceLastCallMeeting: 21,
        inbound30d: 4,
        outbound30d: 11,
      },
      reportMetrics: {
        latestMonth: "2026-07",
        leads: 12,
        reviews: 5,
        prevMonth: "2026-06",
        leadsPrev: 20,
        reviewsPrev: 4,
        leadsAvg90: 25,
        reviewsAvg90: 5,
        leadsMonthsInAvg: 2,
        reviewsMonthsInAvg: 2,
      },
      riskDelta7d: 22,
      riskDelta30d: 42,
    },
    {
      // Task #4048 — post-honest-inputs row: analyzed == sources.comms.count30d,
      // so the evidence strip must merge into ONE "(full 30d window)" chip and
      // drop the now-redundant "62 comms (30d)" basis badge.
      clientId: CL_D,
      firmName: "Beacon Injury Law",
      clientCode: "NB-0104",
      ownerId: "u-1",
      ownerName: "Dana Owner",
      ownerAvatar: null,
      judgment: {
        status: "Watch",
        riskScore: 45,
        headline: "Steady month with full comm coverage.",
        judgmentDate: "2026-08-06",
        summaryText: "Full-window judgment.",
        narrativeSummary: null,
        changeSummary: "Nothing material changed.",
        sentimentSummary: null,
        concernsJson: null,
        keyRisks: null,
        actionsJson: null,
        winsJson: null,
        keyOpportunities: null,
        unresolvedAskCount: 0,
        communicationsAnalyzed: 62,
        dataSourcesSummary: {
          tier: "full",
          basedOn: ["62 comms (30d)", "monthly_reports"],
          missing: [],
          carriedForward: null,
          sources: { comms: { count24h: 1, count7d: 9, count30d: 62, lastCommAt: "2026-08-06T09:00:00.000Z" } },
        },
        confidence: "Medium",
        confidenceLevel: "High",
        generatedFromStartAt: "2026-07-07T00:00:00.000Z",
        generatedFromEndAt: "2026-08-06T00:00:00.000Z",
        statusSince: "2026-08-01",
      },
      signals: null,
      engagement: {
        snapshotDate: "2026-08-06",
        daysSinceLastInbound: 1,
        daysSinceLastCallMeeting: 10,
        inbound30d: 20,
        outbound30d: 25,
      },
      reportMetrics: null,
      riskDelta7d: 0,
      riskDelta30d: null,
    },
    {
      clientId: CL_B,
      firmName: "Harbor Legal",
      clientCode: "NB-0102",
      ownerId: "u-1",
      ownerName: "Dana Owner",
      ownerAvatar: null,
      judgment: {
        status: "Watch",
        riskScore: 30,
        headline: "Quiet month; nothing new from the client.",
        judgmentDate: "2026-08-01",
        summaryText: "Carried forward from the last scored day.",
        narrativeSummary: null,
        changeSummary: null,
        sentimentSummary: null,
        concernsJson: null,
        keyRisks: null,
        actionsJson: null,
        winsJson: null,
        keyOpportunities: null,
        unresolvedAskCount: 0,
        communicationsAnalyzed: 0,
        dataSourcesSummary: {
          tier: "carried_forward",
          basedOn: [],
          missing: ["front_emails"],
          carriedForward: { fromDate: "2026-07-28" },
        },
        confidence: "Medium",
        confidenceLevel: "Low",
        generatedFromStartAt: null,
        generatedFromEndAt: null,
        statusSince: "2026-07-15",
        rating: RATING_CL_B,
      },
      signals: null,
      engagement: {
        snapshotDate: "2026-08-01",
        daysSinceLastInbound: 30,
        daysSinceLastCallMeeting: null,
        inbound30d: 0,
        outbound30d: 2,
      },
      reportMetrics: null,
      riskDelta7d: null,
      riskDelta30d: null,
    },
    {
      clientId: CL_C,
      firmName: "Quiet Harbor Firm",
      clientCode: null,
      ownerId: null,
      ownerName: null,
      ownerAvatar: null,
      judgment: null,
      signals: null,
      engagement: null,
      reportMetrics: null,
      riskDelta7d: null,
      riskDelta30d: null,
    },
  ],
};

// Task #4812 — mid-drain re-score progress (GET /api/churn/rejudge-progress):
// running=true must surface the blue progress banner with the fresh/total
// fraction, and must suppress the amber stale-calibration banner.
const RESCORE_PROGRESS = {
  running: true,
  runningSource: "cross-instance",
  currentRevision: "4766.1",
  totalJudged: 57,
  fresh: 15,
  stale: 42,
  lastFreshGeneratedAt: "2026-08-14T21:07:20.000Z",
};

globalThis.fetch = createFetchStub({
  Headers: dom.window.Headers,
  routes: [
    { path: "/api/churn/leaderboard", json: PAYLOAD },
    { path: "/api/churn/rejudge-progress", json: RESCORE_PROGRESS },
  ],
  defaultJson: {},
}) as any;

// ── Harness ──

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

const $t = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tText = (id: string): string => $t(id)?.textContent ?? "";

async function run(): Promise<void> {
  console.log("Churn leaderboard tab — briefing view render/expand contract");

  const React = (await import("react")).default as any;
  const { createRoot } = (await import("react-dom/client")) as any;
  const { act } = (await import("react")) as any;
  const { QueryClient, QueryClientProvider } = (await import("@tanstack/react-query")) as any;
  const { ChurnLeaderboardTab } = (await import("@/components/churn/ChurnLeaderboardTab")) as any;

  // App-shaped default queryFn (client/src/lib/queryClient.ts joins the
  // queryKey with "/" and fetches), so the component's bare
  // useQuery({ queryKey: ["/api/churn/leaderboard"] }) resolves through the
  // stub exactly like in prod.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async ({ queryKey }: any) => {
          const res = await (globalThis.fetch as any)(queryKey.join("/"));
          if (!res.ok) throw new Error(`fetch ${queryKey.join("/")} → ${res.status}`);
          return res.json();
        },
      },
    },
  });

  const flush = async (times = 10) => {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush(3);
  };

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(ChurnLeaderboardTab),
        ),
      );
    });
    await flush();

    // ── 0. Task #4812 — re-score progress banner (mid-drain) ──
    await check("re-score banner renders mid-drain with the fresh/total fraction", () => {
      assert.ok($t("banner-rejudge-running"), "running banner present");
      const bannerText = tText("banner-rejudge-running");
      assert.ok(
        bannerText.includes("15 of 57"),
        `banner shows the re-scored fraction (got: ${bannerText.slice(0, 120)})`,
      );
      assert.equal(
        $t("banner-rejudge-stale"),
        null,
        "amber stale banner suppressed while a run is in progress",
      );
    });

    // ── 1. Reasons inline with ZERO clicks ──
    await check("rows render with reasons inline before any interaction", () => {
      assert.ok($t(`row-churn-${CL_A}`), "scored row A renders");
      assert.equal(tText(`text-firm-${CL_A}`), "Meridian Law Group", "firm name");
      const concerns = tText(`list-concerns-${CL_A}`);
      for (const c of CONCERNS) {
        assert.ok(concerns.includes(c), `concern visible inline: ${c}`);
      }
      assert.ok(
        tText(`text-what-changed-${CL_A}`).includes(CHANGE_SUMMARY),
        "what-changed line visible inline",
      );
      assert.equal($t(`section-expanded-${CL_A}`), null, "expanded section NOT open yet");
      assert.equal($t(`section-expanded-${CL_B}`), null, "row B not expanded either");
      assert.equal(dom.window.location.pathname, "/churn", "no navigation happened on mount");
    });

    await check("rank/risk/trend/status metadata renders", () => {
      assert.ok(tText(`text-risk-${CL_A}`).includes("83"), "rounded risk score shown");
      assert.ok(tText(`delta7-${CL_A}`).includes("22"), "7d delta shown");
      assert.ok(tText(`delta30-${CL_A}`).includes("42"), "30d delta shown");
      assert.ok(tText(`text-status-since-${CL_A}`).length > 0, "status-since streak label shown");
    });

    // ── 2. Evidence treatment ──
    await check("evidence strip: comms count, confidence, recency, real report numbers", () => {
      assert.ok(tText(`text-evidence-comms-${CL_A}`).includes("14"), "comms-analyzed count");
      assert.ok(tText(`badge-confidence-${CL_A}`).toLowerCase().includes("high"), "confidence badge");
      assert.ok(tText(`text-inbound-recency-${CL_A}`).includes("9"), "days since last inbound");
      assert.ok(tText(`text-inbound-30d-${CL_A}`).includes("4"), "inbound 30d count");
      assert.ok(tText(`metric-leads-${CL_A}`).includes("12"), "REAL lead count, not a 0-100 code");
      assert.ok(tText(`metric-reviews-${CL_A}`).includes("5"), "REAL review count");
      assert.equal($t(`text-zero-comms-${CL_A}`), null, "no zero-comms chip on an evidenced row");
    });

    await check("zero-fresh-comms carried-forward row says so explicitly", () => {
      assert.ok($t(`text-zero-comms-${CL_B}`), "explicit 0-new-comms chip");
      assert.ok($t(`badge-carried-forward-${CL_B}`), "carried-forward badge");
      assert.ok($t(`metric-none-${CL_B}`), "no fabricated report metrics for a report-less client");
      assert.ok(
        tText(`text-reason-fallback-${CL_B}`).includes("Quiet month"),
        "headline fallback reason when no structured concerns",
      );
    });

    // Task #4048 — when analyzed == the 30-day window count, the strip must
    // read coherently: ONE "(full 30d window)" chip, and the redundant
    // "N comms (30d)" basis badge is dropped (kept only when they differ).
    await check("agreeing analyzed/window figures merge into one coherent chip", () => {
      const commsText = tText(`text-evidence-comms-${CL_D}`);
      assert.ok(commsText.includes("62"), "analyzed count shown");
      assert.ok(commsText.includes("full 30d window"), "merged full-window label present");
      // The exact "62 comms (30d)" basis badge must NOT also render for CL_D.
      const row = $t(`row-churn-${CL_D}`) ?? document.body;
      assert.ok(!row.textContent?.includes("62 comms (30d)"), "redundant basis badge dropped when figures agree");
      // A legitimately non-redundant basis badge still shows.
      assert.ok(row.textContent?.includes("monthly_reports"), "other basis badges still render");
    });

    // ── Task #5123: Authoritative explanation from rating.primaryDrivers ──
    await check("authoritative explanation renders with drivers, provenance, freshness", () => {
      const explanation = $t(`authoritative-explanation-${CL_A}`);
      assert.ok(explanation, "authoritative explanation block present for CL_A");
      const expText = explanation!.textContent ?? "";
      // Primary drivers
      assert.ok(
        expText.includes("Three client emails unanswered for 9+ days"),
        "first driver label shown",
      );
      assert.ok(
        expText.includes("Lead volume drop of 40% month-over-month"),
        "second driver label shown",
      );
      // Provenance and source
      assert.ok(expText.includes("Client-authored"), "client-authored provenance shown");
      assert.ok(expText.includes("Front email thread"), "source label shown");
      // Freshness / age
      assert.ok(expText.includes("9d ago"), "age days shown for current driver");
      assert.ok(expText.includes("standing"), "standing freshness shown for older driver");
      // Policy version + revision
      const policyText = tText(`rating-policy-${CL_A}`);
      assert.ok(policyText.includes("Policy v5"), "policy version shown");
      assert.ok(policyText.includes("5123.1"), "prompt revision shown");
    });

    await check("generated lineage shows generated label for fresh judgment", () => {
      const lineageText = tText(`rating-lineage-${CL_A}`);
      assert.ok(
        lineageText.includes("Generated") || lineageText.includes("2026-08-01"),
        `generated lineage label shown (got: ${lineageText})`,
      );
      assert.ok(
        !lineageText.includes("Carried forward"),
        "generated row does NOT show carried-forward",
      );
    });

    await check("carried-forward lineage shown for CL_B with fromDate", () => {
      const lineageText = tText(`rating-lineage-${CL_B}`);
      assert.ok(
        lineageText.includes("Carried forward") && lineageText.includes("2026-07-28"),
        `carried-forward lineage with date shown (got: ${lineageText})`,
      );
    });

    await check("relationship shown separately from overall status for CL_A", () => {
      const relText = tText(`rating-relationship-${CL_A}`);
      assert.ok(relText.includes("Relationship"), "relationship label present");
      assert.ok(relText.includes("Strained"), "relationship value shown");
      // Relationship NOT rendered for CL_B (null)
      assert.equal(
        $t(`rating-relationship-${CL_B}`),
        null,
        "no relationship chip when rating.relationship is null",
      );
    });

    await check("authoritative explanation is more prominent than concerns (rendered above)", () => {
      // The authoritative explanation element appears before the concerns list in the DOM
      const row = $t(`row-churn-${CL_A}`)!;
      const allChildren = Array.from(row.querySelectorAll("[data-testid]"));
      const authIdx = allChildren.findIndex(
        (el) => el.getAttribute("data-testid") === `authoritative-explanation-${CL_A}`,
      );
      const concernsIdx = allChildren.findIndex(
        (el) => el.getAttribute("data-testid") === `list-concerns-${CL_A}`,
      );
      assert.ok(authIdx !== -1, "authoritative explanation element present");
      assert.ok(concernsIdx !== -1, "concerns list element present");
      assert.ok(authIdx < concernsIdx, "authoritative explanation renders before concerns");
    });

    await check("advisory AI indicators label shown (not old status-colored label)", async () => {
      // Expand CL_A to see the signals grid
      await click($t(`button-expand-${CL_A}`)!);
      const signalsGrid = $t(`grid-signals-${CL_A}`);
      assert.ok(signalsGrid, "signals grid present after expansion");
      const gridText = signalsGrid!.textContent ?? "";
      assert.ok(
        gridText.includes("Advisory AI indicators"),
        `signals grid uses advisory label (got: ${gridText.slice(0, 120)})`,
      );
      assert.ok(
        gridText.includes("not authoritative status"),
        "advisory disclaimer present in signals section",
      );
      // Collapse again
      await click($t(`button-expand-${CL_A}`)!);
    });

    await check("risk number tone derives from stored status (Critical → critical class)", () => {
      // CL_A is Critical — risk number must have critical tone class (text-status-critical)
      const riskEl = $t(`text-risk-${CL_A}`) as HTMLElement | null;
      assert.ok(riskEl, "risk element present");
      // The element should have the critical class, not watch/neutral
      const cls = riskEl!.className;
      assert.ok(
        cls.includes("status-critical"),
        `Critical status → critical-toned risk number (got class: ${cls})`,
      );
    });

    await check("Watch status risk number uses warn/neutral tone (not critical)", () => {
      const riskEl = $t(`text-risk-${CL_B}`) as HTMLElement | null;
      assert.ok(riskEl, "risk element present for CL_B");
      const cls = riskEl!.className;
      assert.ok(
        !cls.includes("status-critical"),
        `Watch status → no critical-toned risk number (got class: ${cls})`,
      );
    });

    // ── 3. In-place expansion ──
    await check("clicking the row header expands the full story IN PLACE", async () => {
      await click($t(`button-expand-${CL_A}`)!);
      const expanded = $t(`section-expanded-${CL_A}`);
      assert.ok(expanded, "expanded section appears");
      const body = expanded!.textContent ?? "";
      assert.ok(body.includes("The firm is drifting after two escalations."), "narrative section content");
      assert.ok(tText(`list-actions-${CL_A}`).includes("Call the client today"), "recommended action");
      assert.ok(
        tText(`list-actions-${CL_A}`).includes("Unanswered emails signal escalation risk"),
        "action rationale (why)",
      );
      assert.ok(tText(`list-wins-${CL_A}`).includes("Reviews up in July"), "wins list");
      assert.ok(tText(`text-unresolved-asks-${CL_A}`).includes("2"), "unresolved asks count");
      assert.ok($t(`grid-signals-${CL_A}`), "labeled signal grid present");
      assert.equal(dom.window.location.pathname, "/churn", "expansion did NOT navigate");
    });

    await check("clicking again collapses the row", async () => {
      await click($t(`button-expand-${CL_A}`)!);
      assert.equal($t(`section-expanded-${CL_A}`), null, "expanded section removed");
    });

    await check("expand-all opens every scored row; toggling closes them", async () => {
      await click($t("button-expand-all")!);
      assert.ok($t(`section-expanded-${CL_A}`), "row A expanded via expand-all");
      assert.ok($t(`section-expanded-${CL_B}`), "row B expanded via expand-all");
      // Raw-narrative fallback for a row without **Section** markers.
      assert.ok(
        tText(`text-narrative-${CL_B}`).includes("Carried forward from the last scored day."),
        "row B falls back to raw summary text in the expansion",
      );
      await click($t("button-expand-all")!);
      assert.equal($t(`section-expanded-${CL_A}`), null, "collapse-all closed row A");
      assert.equal($t(`section-expanded-${CL_B}`), null, "collapse-all closed row B");
    });

    // ── 4. No-data bucket ──
    await check("never-judged client renders in the no-data bucket", () => {
      assert.ok($t("bucket-no-data"), "bucket renders");
      assert.ok($t(`row-churn-nodata-${CL_C}`), "no-data row present");
      assert.ok(tText(`row-churn-nodata-${CL_C}`).includes("Quiet"), "firm name in bucket");
    });

    // ── 5. Client page as a secondary action (LAST: it navigates) ──
    await check("open-client button navigates to the client page", async () => {
      await click($t(`button-open-client-${CL_A}`)!);
      assert.equal(dom.window.location.pathname, `/clients/${CL_A}`, "secondary action navigates");
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
  }

  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll churn-leaderboard-tab render checks passed");
}

// jsdom + react-query keep timer handles alive (QueryClient gcTime, jsdom's
// pretendToBeVisual loop), so like the other DOM suites
// (tests/ads-os-pyramid-tool-render.test.ts, tests/client/
// judgment-basis-render.test.tsx) this exits explicitly instead of waiting
// for a natural drain that never comes.
run()
  .then(() => {
    console.log("\nPASS tests/churn-leaderboard-tab-render.test.ts");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL tests/churn-leaderboard-tab-render.test.ts");
    console.error(err?.message ?? err);
    process.exit(1);
  });
