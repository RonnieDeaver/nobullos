/**
 * types — shared pieces of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 419–496, 879–893, 1255–1259 @ d31d7c0c7, Task #4271).
 * Zero visual/behavioral change intended — do not edit alongside a move.
 */

import { type ClientTerminology, type ReportProductUpdates } from "@shared/schema";
import { type SlideVerdictMap } from "@shared/slideVerdicts";
import CeoPulseChartRenderer from "@/components/CeoPulseChartRenderer";

export type CeoPulseAnalysis = {
  headline?: string;
  keyTakeaways?: Array<string | { highlight: string; detail: string }>;
  strategicImplications?: Array<string | { highlight: string; detail: string }>;
  charts?: import("@/components/CeoPulseChartRenderer").CeoPulseChart[];
};

// Task #3688 — intake/sales trend fields are nullable: the server emits null
// for metric-months that weren't provided (absent, blank-saved-as-0 entered
// metrics, or No-Data-flagged) so the charts can skip them instead of
// plotting fake 0 points.
export type ReportTrendData = {
  month: string;
  intake: { totalConsults: number | null; leadToConsultRate: number | null; missedCallRate: number | null; avgTimeToAnswer: number | null; qualityScore: number | null; intakeExecutionScore?: number | null };
  sales: { totalCases: number | null; consultToCaseRate: number | null; avgCaseValue: number | null; noShowRate: number | null; avgFollowUps: number | null; pipelineMomentumScore?: number | null; qualityScore: number | null; effectiveSalesQuality?: number | null };
  marketing: {
    totalLeads: number;
    totalReviews: number;
    leadQuality: { good: number; notQuotable: number; missedCalls: number; noData: number };
    // Per-month campaign-lead breakdown (GBP + Google Ads + LSA + webinar
    // lead-equivalents) — the SAME per-source formula the server's lifetime
    // accumulation sums, which is what lets the Lifetime Value slide plot a
    // cumulative arc that reconciles exactly with `lifetimeValue.totalLeads`
    // (Task #4281). Optional: emitted by both the share and demo builders
    // today, but absent from older stored fixtures — consumers must gate.
    leadsBySource?: { gbp?: number; googleAds?: number; lsa?: number; webinar?: number; webinarHT?: number };
  };
};

export type SharedReportData = {
  report: {
    id: string;
    reportMonth: string;
    status: string;
    hideLeadQuality?: boolean;
    /** Task #4290 — server-computed EFFECTIVE privacy flag (DB privacy_mode
     * OR ?private=true). Every client-side privacy fallback keys off this. */
    privacyApplied?: boolean;
  };
  client: {
    firmName: string;
    contactName: string | null;
    products: string[] | null;
    practiceAreas?: string[];
    initialLeads?: number;
    initialReviews?: number;
    initialCases?: number;
    clientStartDate?: string | null;
    consultType?: string | null;
    terminology?: ClientTerminology | null;
    // Task #2596 — per-client monthly review target fallback (reviews/month).
    monthlyReviewTarget?: number | null;
    // Task #2667 — per-client toggle to suppress the "Other" lead bucket
    // everywhere on the report. Client-level (applies to all of this client's
    // reports). Default false → no change.
    hideOtherLeads?: boolean;
  };
  sections: Array<{
    sectionKey: string;
    data: any;
  }>;
  ceoPulse: {
    title: string | null;
    rawContent: string;
    aiAnalysis: CeoPulseAnalysis | null;
    fullLetterHtml?: string | null;
    shareToken?: string | null;
    includeGraphs?: boolean;
    // Task #4268 — "company_update" | "market_shift"; null for legacy
    // untagged briefs (no edition tag rendered on the slide).
    edition?: string | null;
  } | null;
  // Task #4216 — CEO Pulse "Product updates" block: current-quarter product
  // roadmap items (server-selected, live percentages computed at render
  // time). Null/absent when the report has no CEO Pulse or nothing
  // qualifies.
  productUpdates?: ReportProductUpdates | null;
  dataAccess: any[] | null;
  trendData: ReportTrendData[] | null;
  lifetimeValue?: {
    totalLeads: number;
    totalReviews: number;
    totalCases: number;
    estimatedCases?: number;
    hasHardData: boolean;
    // Task #4849 — per-month case-data provenance from the shared server
    // accumulator ("YYYY-MM", ascending; missingMonths is calendar-complete
    // over the accumulation span, so report-less months count). The payoff
    // card renders its "Incomplete data — missing <months>" annotation from
    // missingMonths. Optional: legacy/hand-built payloads simply render no
    // annotation.
    casesCoverage?: { providedMonths: string[]; missingMonths: string[] };
  };
  // Task #4210 — deterministic seasonal-trend payload embedded server-side
  // (buildReportResponse) so anonymous share-token viewers see REAL
  // per-practice-area data instead of the hardcoded fallback. aiAnalysis is
  // always null here (no OpenAI on unauthenticated views — explicit product
  // decision); the derived fallback analysis text renders instead.
  seasonalTrends?: TrendsResponse | null;
  // Task #4273 — per-slide verdict sentences (audit §8.1-1): server-stored
  // copy only (finalize-time AI draft or operator authoring), stripped from
  // `sections` and surfaced here. Slides render it via <VerdictLine>; null/
  // absent (incl. every pre-#4273 report) simply renders no verdict line.
  slideVerdicts?: SlideVerdictMap | null;
  // Task #4282 — Next 30 Days closing CTA: the account manager (client
  // owner), resolved server-side. Null when the client has no owner, on
  // privacy-mode views (identity stripped), and on every pre-#4282 payload —
  // the slide degrades to its generic closing line.
  accountManager?: { name: string; email: string | null } | null;
};

export type TrendDataPoint = { month: string; value: number; isCurrent: boolean; phase: string };
export type PracticeAreaTrend = { practiceArea: string; searchTerm: string; data: TrendDataPoint[] };
export type AnalysisEntry = {
  currentPosition: string[];
  demandShapeAhead: string[];
};
export type TrendsResponse = {
  practiceAreas: PracticeAreaTrend[];
  combined: PracticeAreaTrend | null;
  currentMonth: string;
  currentMonthIndex: number;
  aiAnalysis: Record<string, AnalysisEntry> | null;
  source: string;
};


export type PhaseSettingResponse = {
  phase: string;
  actions: string[];
  isCustom: boolean;
};
