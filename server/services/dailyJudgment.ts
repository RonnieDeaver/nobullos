// @db-pool-intent: worker
//
// Task #1723 (Phase 2.4): daily-judgment generation is a heavy
// background writer (multi-table upserts + AI knowledge extraction).
// `db` aliases `workerDb` directly so the few raw SQL paths in this
// module never reach the API pool, and `generateDailyJudgment()` is
// wrapped in `runWithWorkerDb` so the `storage.*` calls it makes
// (which go through `getDb()` and inherit the AsyncLocalStorage
// context) also hit the worker pool — even when the function is
// invoked from an API route handler.
//
// Task #3697: generation is data-availability-aware. Every run first
// assembles a per-client data inventory (comms windows, latest report,
// command panel, agent knowledge, open asks, RIS engagement results),
// then picks a tier: "full" (comms exist), "operational" (no comms but
// other data), or skip (truly nothing — `JudgmentSkippedError`). The
// inventory is written into `dataSourcesSummary` as the judgment's
// basis, drives an explicit availability manifest in the prompt, and
// feeds an inputs fingerprint used to carry an unchanged judgment
// forward without a fresh AI call. The Task #98 hallucination guard is
// preserved: when the analyzed comms window is empty, no agent-memory
// facts are extracted and sentiment scores are forced to null.
import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { createHash } from "node:crypto";
import { QUALITY_MODEL } from "../aiModels";
import { workerDb as db, runWithWorkerDb, withDbAttribution } from "../db";
import { getClientMetricTracking, type MetricTrackingState } from "./judgmentMetricTracking";
import { storage } from "../storage";
import {
  rawCommunicationRecords,
  communicationClientLinks,
  reports,
  reportSections,
  clientDailyJudgments,
  type Client,
  type ClientDailyJudgment,
  type ClientConcernIntel,
  type RawCommunicationRecord,
  type ClientOpenAsk,
  type InsertClientDailyJudgment,
  isActiveAskStatus,
} from "@shared/schema";
import {
  recordExtractedAsk,
  evaluateAndApplyAskClosure,
  runOpenAskMaintenance,
} from "./openAskPipeline";
import { eq, and, gte, lte, desc, or, inArray, isNull, ne, sql } from "drizzle-orm";
import { countableCommunicationConditions } from "../storage/communicationStorage";
import {
  enteredMetricOrNull,
  displayedSupportingMetric,
  sectionHasEntryTracking,
  hasLeadVolumeEvidence,
  readMonthLeadsReviews,
} from "@shared/reportMetrics";
import { getClientContext, formatContextForPrompt } from "./contextRetrieval";
import { extractAndPersistFromAgentOutput } from "./agentKnowledgeService";
import { listRisChecks, getRisResultsForClient } from "../storage/risStorage";
import { currentPeriod } from "./ris/risService";
import {
  beginClientRiskShiftRun,
  recordJudgmentForRiskShift,
  dispatchClientRiskShiftAlerts,
} from "./clientRiskShiftAlert";
import {
  TIER_GATE_VERSION,
  validateEvidenceCitations,
  isBaselineSilenceExceeded,
  assessDeliveryStabilityWithFallback,
  applyJudgmentTierGate,
  buildEvidenceRecencyFingerprint,
  buildTierGateAudit,
  reconcileJudgmentNarrative,
  stripModelRatingClaims,
  type TierGateAudit,
  type EvidenceCorpus,
  type EvidenceFragment,
  type EvidenceProvenance,
  type ValidatedEvidenceItem,
} from "./judgmentTierGate";
import {
  buildCommunicationEvidenceFragments,
  INTERNAL_AI_INTERPRETATION_LABEL,
} from "./judgmentEvidenceProvenance";
import { getMeasuredMonthlyLeadsSeries } from "../storage/liveDataStorage";

const openai = createDefaultOpenAiClient();

const MODEL_VERSION = QUALITY_MODEL;

// Bumped whenever the prompt/inventory semantics change so the first run
// after a deploy regenerates instead of carrying an old-revision judgment
// forward. Exported (Task #4048) because the "Re-judge stale client
// judgments" prod action uses it to find latest judgments generated under an
// older revision (each inventory stamps the revision as `promptRevision`).
// 4761.1 — evidence-gated deterministic tiers: the model now classifies
// churn evidence (fixed vocabulary + verbatim citations validated against
// the actual inputs) and server code owns the stored tier via
// judgmentTierGate; pre-calibration trajectory months are excluded from the
// prompt and standing issues decay instead of re-escalating. The bump makes
// every pre-gate judgment a target for the existing re-judge prod action.
// 4766.1 — measured monthly-leads fallback for delivery stability: the
// measured live-data series is a new generation input (fingerprinted), the
// tier gate can now ground stability from post-close measured snapshots
// when entered reports can't, and the audit names the evidence source.
// 4846.1 — client-level metric-tracking classification (never-entered vs
// lapsed intake/sales families) is a new generation input: the prompt now
// renders "not tracked for this client" for structurally unmeasured
// metrics, decontaminates recycled zero-metric narratives, and labels
// AI-inferred memory provenance. The bump re-targets every client for the
// re-judge prod action so poisoned zero narratives regenerate clean.
// 5121.1 — atomic evidence provenance + server-owned category eligibility:
// transport direction and subjects no longer imply client authorship;
// forwarded/automated/third-party/generated/internal text is distinguishable,
// and repeated asks/delivery decline/Critical semantics are enforced in code.
// 5122.1 — coherent server-owned health, relationship, and risk contract:
// threshold facts, root audit lineage, and rejudge selection now require the
// repaired gate version rather than a model-owned severity proposal.
// 5228.1 — model-authored narrative fields are reconciled with the final
// server-owned status and relationship after the gate runs, and AI-derived or
// unknown-provenance communication signals are explicitly internal
// interpretations, never direct client evidence. The revision bump prevents
// contradictory or pre-disclosure prose from carrying forward unchanged.
export const FINGERPRINT_REVISION = "5228.1";

interface JudgmentAIResponse {
  overallStatus: "Healthy" | "Watch" | "At Risk" | "Critical";
  relationshipStatus: "Strong" | "Stable" | "Strained" | "At Risk";
  confidenceLevel: "High" | "Medium" | "Low";
  summary: string;
  sentimentSummary: string;
  whatChanged: string[];
  concerns: string[];
  /**
   * Task #4761 — evidence classification: every churn-relevant concern
   * carries a fixed-vocabulary category plus a VERBATIM citation from the
   * provided inputs. Server-side validation (judgmentTierGate) rejects
   * citations that don't appear in the inputs; the deterministic tier gate
   * derives the stored status from the validated set. Typed loosely — this
   * is parsed model JSON and validation owns the shape.
   */
  churnEvidence?: Array<{ category?: string; quote?: string; source?: string; date?: string }>;
  unresolvedAsks: string[];
  wins: string[];
  recommendedActions: Array<{ action: string; why: string }>;
  scores: {
    relationshipHealth: number | null;
    sentiment: number | null;
    complaint: number | null;
    trust: number | null;
    responsivenessRisk: number | null;
    executionRisk: number | null;
    leadVolumeConcern: number | null;
    unresolvedTaskRisk: number | null;
    overallRisk: number | null;
  };
  openAskUpdates: Array<{
    // Task #4765 — asks are referenced by stable ID (rendered in the
    // open-asks prompt section); askText is display-only.
    askId?: string;
    askText: string;
    likelyResolved: boolean;
    resolvedEvidence?: string;
    stillReferenced: boolean;
  }>;
  newAsks: Array<{
    askText: string;
    askCategory: string;
    requestedBy?: string;
    confidence: number;
  }>;
}

// ---------------------------------------------------------------------------
// Task #3697 — data inventory types + pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type JudgmentTier = "full" | "operational";

export interface RisEngagementResult {
  key: string;
  label: string;
  status: string;
  period: string;
  notes: string | null;
}

export interface JudgmentSourceSignals {
  comms: {
    count24h: number;
    count7d: number;
    count30d: number;
    /** Most recent matched communication EVER (not window-bound), ISO string. */
    lastCommAt: string | null;
  };
  report: { reportId: string; month: string; updatedAt: string | null } | null;
  commandPanel: { lastUpdatedAt: string | null; lastReviewedAt: string | null } | null;
  knowledge: { totalFacts: number; latestFactSeenAt: string | null };
  openAsks: { activeCount: number; latestUpdatedAt: string | null };
  ris: { resultCount: number; latest: RisEngagementResult[] };
  /**
   * Task #4292 — lifetime relationship aggregate (all-time, non-orphaned
   * grain — same predicate as `lastCommAt`, NOT the windowed countable
   * dedupe; both sides of every cadence comparison use this one grain).
   * null when the client has never had a matched communication. Raw counts
   * only: time-derived ratios (weekly averages) are computed at prompt time
   * so the fingerprint doesn't drift with the calendar.
   */
  lifetime: {
    firstCommAt: string | null;
    totalComms: number;
    inboundComms: number;
    outboundComms: number;
    comms90d: number;
    longestGapDays: number | null;
  } | null;
  /**
   * Compressed long-run judgment trajectory: COMPLETED months only (the
   * in-progress month is deliberately excluded — including it would let
   * yesterday's judgment write invalidate today's fingerprint, killing
   * carry-forward daily). Newest first, ≤12 months.
   */
  trajectory: Array<{ month: string; endStatus: string | null; avgRisk: number | null; days: number }>;
  /**
   * Task #4761 — number of completed months dropped from `trajectory`
   * because they contain pre-tier-gate judgments (no tierGateVersion stamp
   * in data_sources_summary). Those months' Critical-heavy end statuses were
   * produced by miscalibrated prompts; feeding them back anchored every new
   * judgment red. Rendered as an explicit unreliable-era note instead.
   */
  trajectoryExcludedMonths?: number;
  /** Compact multi-month report-metric history (canonical extraction), newest first, ≤6. */
  reportHistory: Array<{ month: string; leads: number | null; reviews: number | null }>;
  /**
   * Task #4766 — MEASURED monthly lead totals (live_data_snapshots,
   * `perf_total_leads`, ok status, latest post-close snapshot per completed
   * period, newest first, ≤8). Feeds ONLY the deterministic tier gate's
   * delivery-stability fallback — never the model's evidence corpus.
   * Empty when live data is absent; optional so pre-4766 inventories parse.
   */
  measuredLeads?: Array<{ month: string; leads: number; fetchedAt: string }>;
  /** Operator concern intel filed in the last 90 days (Task #4292). */
  intel: { count90d: number; latestAt: string | null };
  /**
   * Task #4846 — client-level intake/sales metric-tracking classification
   * over the client's ENTIRE report history (judgmentMetricTracking).
   * never_entered = structurally not tracked (prompt renders "not tracked
   * for this client", never zero); entered_before = an absent value today is
   * a month-scoped entry lapse. Optional so pre-4846 stored inventories
   * parse; null when classification was skipped.
   */
  metricTracking?: {
    consults: "never_entered" | "entered_before";
    cases: "never_entered" | "entered_before";
  } | null;
}

/**
 * The judgment's persisted basis — stored in `client_daily_judgments.
 * data_sources_summary` and surfaced through the dashboard summaries API and
 * the client-profile judgment stream. `basedOn` / `missing` are
 * human-readable so the UI renders them verbatim.
 */
export interface JudgmentDataInventory {
  version: 2;
  tier: JudgmentTier;
  generatedAt: string;
  inputsFingerprint: string;
  /**
   * FINGERPRINT_REVISION active when this inventory was assembled (Task
   * #4048). Absent on rows generated before the field existed. Ops tooling
   * (the re-judge prod action) treats a latest judgment whose promptRevision
   * differs from the current constant as stale. Carried-forward rows copy
   * the FRESH inventory, which is correct: carry-forward requires a
   * fingerprint match, and the fingerprint embeds the revision, so a carried
   * row's source generation always ran at the same revision.
   */
  promptRevision?: string;
  /**
   * Task #4761 — deterministic tier gate. `tierGateVersion` stamps every
   * inventory assembled since the gate shipped (carried-forward copies
   * inherit it — correct for the same reason promptRevision above is) and
   * doubles as the trajectory calibration marker: only months whose
   * judgments ALL carry the stamp feed the trajectory prompt section.
   * `tierGate` is the per-generation audit (model's proposed status,
   * validated/rejected evidence, applied rule) — attached only where the
   * gate actually ran; carried-forward rows point at their source row's
   * audit via carriedForward.
   */
  tierGateVersion?: number;
  tierGate?: TierGateAudit;
  basedOn: string[];
  missing: string[];
  silenceDays: number | null;
  /**
   * Task #4292 — Mon–Fri (UTC) days with no matched communication, counted
   * strictly after the last-comm date up to and including the judgment
   * date. A Friday→Monday gap is 1; a weekend-only gap is 0. Optional so
   * pre-4292 inventories still parse.
   */
  businessDaySilence?: number | null;
  sources: JudgmentSourceSignals;
  carriedForward?: {
    fromDate: string;
    fromJudgmentId: string;
    rootDate: string;
    rootJudgmentId: string;
    /** Bounded root audit so carried rows remain independently explainable. */
    rootTierGate: TierGateAudit | null;
  } | null;
}

export interface JudgmentRatingFacts {
  silenceExceeded: boolean;
  deliveryStability: "stable" | "declining" | "unknown";
  deliveryStabilitySource: "entered_reports" | "measured_live_data" | "none";
  /** Independent accepted facts plus their current decay tier. */
  evidenceRecencyFingerprint: string[];
}

/** Thrown when a client has NO usable data source at all (true "No data"). */
export class JudgmentSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgmentSkippedError";
  }
}

export function decideJudgmentTier(sources: JudgmentSourceSignals): JudgmentTier | null {
  if (sources.comms.count30d > 0) return "full";
  const hasOperationalData =
    sources.report !== null ||
    sources.commandPanel !== null ||
    sources.knowledge.totalFacts > 0 ||
    sources.openAsks.activeCount > 0 ||
    sources.ris.resultCount > 0;
  return hasOperationalData ? "operational" : null;
}

/**
 * Sub-scores must be honest: anything the AI could not ground comes back as
 * null (or garbage) and is persisted as null — never coerced to a mid-range
 * number.
 */
export function sanitizeScoreValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Change-detection hash over every generation input. When it matches the
 * previous judgment's stored fingerprint (and the run isn't forced), the
 * prior judgment carries forward without an AI call. The silence bucket
 * widens weekly so a prolonged-quiet client still gets a genuinely fresh
 * judgment about once a week as its staleness grows.
 */
export function computeInputsFingerprint(
  sources: JudgmentSourceSignals,
  silenceDays: number | null,
  ratingFacts?: JudgmentRatingFacts,
): string {
  const payload = {
    rev: FINGERPRINT_REVISION,
    comms: sources.comms,
    report: sources.report,
    panel: sources.commandPanel,
    knowledge: sources.knowledge,
    asks: sources.openAsks,
    ris: sources.ris.latest.map(r => `${r.key}:${r.status}:${r.period}`).sort(),
    silenceBucket: silenceDays === null ? "never" : String(Math.floor(silenceDays / 7)),
    // Task #4292 — lifetime context + operator intel are generation inputs,
    // so they break carry-forward when they change. All four are raw stored
    // facts (no time-derived ratios): lifetime/trajectory/reportHistory only
    // move when underlying data moves (trajectory excludes the in-progress
    // month), and intel moves exactly when an operator files a note.
    lifetime: sources.lifetime,
    trajectory: sources.trajectory,
    // Task #4761 — the excluded-as-pre-calibration month count is itself a
    // generation input: when a month flips from excluded to included (or
    // ages out of the window) the prompt changes, so carry-forward breaks.
    trajectoryExcluded: sources.trajectoryExcludedMonths ?? 0,
    reportHistory: sources.reportHistory,
    // Task #4766 — the measured series is a generation input (it moves the
    // gate's stability verdict), so a new post-close snapshot breaks
    // carry-forward exactly when it could change the outcome.
    measuredLeads: sources.measuredLeads ?? [],
    intel: sources.intel,
    // Task #4846 — the metric-tracking classification changes how the
    // prompt frames absent intake/sales values (not-tracked vs lapsed), so
    // a family flipping to entered_before must break carry-forward.
    metricTracking: sources.metricTracking ?? null,
    // Calendar movement must break carry-forward precisely when it changes a
    // decision threshold, not only on the former coarse weekly silence bucket.
    ratingFacts: ratingFacts ?? null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Pure threshold facts that are allowed to invalidate carry-forward. */
export function deriveJudgmentRatingFacts(
  sources: JudgmentSourceSignals,
  silenceDays: number | null,
  businessDaySilence: number | null,
  judgmentDate: string,
): JudgmentRatingFacts {
  const delivery = assessDeliveryStabilityWithFallback(
    sources.reportHistory,
    sources.measuredLeads ?? [],
    judgmentDate,
  );
  return {
    silenceExceeded: isBaselineSilenceExceeded({
      silenceDays,
      businessDaySilence,
      longestGapDays: sources.lifetime?.longestGapDays ?? null,
    }),
    deliveryStability: delivery.stability,
    deliveryStabilitySource: delivery.source,
    evidenceRecencyFingerprint: [],
  };
}

const INTERNAL_INTERPRETATION_DISCLOSURE =
  "Internal interpretation note: AI-derived or unknown-provenance signals are not direct client evidence and cannot independently justify At Risk or Critical.";

export function discloseInternalInterpretationInNarrative(
  narrative: string,
  evidence: readonly ValidatedEvidenceItem[],
): string {
  const hasInternalInterpretation = evidence.some(item =>
    item.valid &&
    (item.provenance === "ai_generated" || item.provenance === "unknown"),
  );
  if (!hasInternalInterpretation) return narrative;
  const trimmed = narrative.trim();
  if (trimmed.startsWith(INTERNAL_INTERPRETATION_DISCLOSURE)) {
    return narrative;
  }
  return `${INTERNAL_INTERPRETATION_DISCLOSURE}\n\n${trimmed}`;
}

/**
 * Task #4292 — business-day silence: Mon–Fri (UTC) days counted strictly
 * after the last matched communication's UTC date, up to and including the
 * judgment date. Weekend-only gaps are 0 (quiet since Friday, judged over
 * the weekend); Friday→Monday is 1. Pure so tests pin the weekend rules.
 */
export function computeBusinessDaySilence(
  lastCommAt: string | Date | null,
  endAt: Date,
): number | null {
  if (!lastCommAt) return null;
  const last = lastCommAt instanceof Date ? lastCommAt : new Date(lastCommAt);
  if (Number.isNaN(last.getTime())) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const startDay = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  const endDay = Date.UTC(endAt.getUTCFullYear(), endAt.getUTCMonth(), endAt.getUTCDate());
  let count = 0;
  for (let t = startDay + dayMs; t <= endDay; t += dayMs) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function formatReportMonthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const idx = parseInt(m[2], 10) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${m[1]}` : month;
}

function plural(n: number, singular: string, pluralWord?: string): string {
  return `${n} ${n === 1 ? singular : (pluralWord ?? `${singular}s`)}`;
}

export function buildJudgmentBasis(
  sources: JudgmentSourceSignals,
  silenceDays: number | null,
): { basedOn: string[]; missing: string[] } {
  const basedOn: string[] = [];
  const missing: string[] = [];

  if (sources.comms.count30d > 0) {
    basedOn.push(`${plural(sources.comms.count30d, "comm")} (30d)`);
  } else {
    missing.push(
      silenceDays === null
        ? "no comms ever matched"
        : `no comms in 30d (silent ${silenceDays}d)`,
    );
  }

  if (sources.report) {
    basedOn.push(`${formatReportMonthLabel(sources.report.month)} report`);
  } else {
    missing.push("no monthly report");
  }

  if (sources.commandPanel) {
    basedOn.push("command panel");
  } else {
    missing.push("no command panel");
  }

  if (sources.knowledge.totalFacts > 0) {
    basedOn.push(`agent memory (${plural(sources.knowledge.totalFacts, "fact")})`);
  } else {
    missing.push("no agent memory");
  }

  // Absence of open asks is not "missing data" — it just means nothing is
  // pending — so asks only ever appear on the basedOn side.
  if (sources.openAsks.activeCount > 0) {
    basedOn.push(plural(sources.openAsks.activeCount, "open ask"));
  }

  if (sources.ris.resultCount > 0) {
    basedOn.push(`${plural(sources.ris.resultCount, "RIS engagement check")}`);
  } else {
    missing.push("no RIS engagement checks");
  }

  // Task #4292 — lifetime basis. Tenure + all-time volume tell the reader
  // the judgment saw more than the 30d detail window.
  if (sources.lifetime && sources.lifetime.firstCommAt) {
    basedOn.push(
      `lifetime history (${plural(sources.lifetime.totalComms, "comm")} since ${sources.lifetime.firstCommAt.split("T")[0]})`,
    );
  }
  if (sources.trajectory.length > 0) {
    basedOn.push(`${plural(sources.trajectory.length, "month")} judgment trajectory`);
  }
  if (sources.reportHistory.length > 1) {
    basedOn.push(`${sources.reportHistory.length}-month report history`);
  }
  // Absence of operator intel is normal, never "missing data".
  if (sources.intel.count90d > 0) {
    basedOn.push(`operator intel (${plural(sources.intel.count90d, "note")}, 90d)`);
  }

  return { basedOn, missing };
}

/**
 * The explicit available/missing manifest injected into the user prompt so
 * the model reasons only from sources that exist. Pure so tests can pin the
 * wording rules (missing ≠ evidence, silence = staleness, null scores).
 */
export function buildDataAvailabilityManifest(inventory: JudgmentDataInventory): string {
  const { sources, silenceDays, tier } = inventory;
  const businessDaySilence = inventory.businessDaySilence ?? null;
  const lines: string[] = [];

  lines.push(`=== DATA AVAILABILITY MANIFEST ===`);
  lines.push(`Available data sources for this judgment:`);
  if (sources.comms.count30d > 0) {
    const last = sources.comms.lastCommAt ? sources.comms.lastCommAt.split("T")[0] : "unknown";
    lines.push(
      `- Communications: ${sources.comms.count30d} matched in last 30 days` +
        ` (${sources.comms.count7d} in last 7 days, ${sources.comms.count24h} in last 24 hours); most recent ${last}`,
    );
  }
  if (sources.report) {
    lines.push(`- Latest monthly report: ${formatReportMonthLabel(sources.report.month)}`);
  }
  if (sources.commandPanel) {
    lines.push(`- Command panel (strategic context): present`);
  }
  if (sources.knowledge.totalFacts > 0) {
    lines.push(`- Agent knowledge base: ${plural(sources.knowledge.totalFacts, "stored fact")}`);
  }
  if (sources.openAsks.activeCount > 0) {
    lines.push(`- Open asks: ${sources.openAsks.activeCount} active`);
  }
  if (sources.ris.resultCount > 0) {
    lines.push(`- RIS engagement checks: ${plural(sources.ris.resultCount, "recent result")}`);
  }
  if (sources.lifetime && sources.lifetime.firstCommAt) {
    lines.push(
      `- Lifetime history: ${plural(sources.lifetime.totalComms, "communication")} since ${sources.lifetime.firstCommAt.split("T")[0]} (see LIFETIME RELATIONSHIP CONTEXT)`,
    );
  }
  if (sources.intel.count90d > 0) {
    lines.push(
      `- Operator intel: ${plural(sources.intel.count90d, "human-filed note")} in the last 90 days (see OPERATOR INTEL — it is authoritative)`,
    );
  }

  if (inventory.missing.length > 0) {
    lines.push(`Missing data sources (treat as UNKNOWN — never as evidence of a problem):`);
    for (const m of inventory.missing) {
      lines.push(`- ${m}`);
    }
  }

  if (silenceDays !== null && sources.comms.count30d === 0) {
    const businessNote = businessDaySilence !== null
      ? ` (${plural(businessDaySilence, "business day")} — weekends are not silence)`
      : "";
    lines.push(
      `Silence: no matched communications for ${silenceDays} calendar days${businessNote}. Judge staleness against THIS client's own cadence baseline in the lifetime context — a gap well beyond their historical norm is a disengagement risk worth flagging; a gap within their normal rhythm is not a finding. Never invent sentiment or motive from silence.`,
    );
  } else if (sources.comms.count30d > 0 && silenceDays !== null && businessDaySilence !== null) {
    lines.push(
      `Recency: last matched communication ${plural(silenceDays, "calendar day")} ago (${plural(businessDaySilence, "business day")}). Gaps of 0–3 business days are normal cadence — never a silence concern. Weekends and holidays are not avoidance.`,
    );
  } else if (sources.comms.lastCommAt === null) {
    lines.push(
      `This client has never had matched communications in the system. Judge from operational data only.`,
    );
  }

  lines.push(`Rules for using this manifest:`);
  lines.push(`- Reason ONLY from the available sources listed above. Never invent findings from missing sources.`);
  lines.push(`- Missing data is never itself evidence of a problem.`);
  lines.push(`- Output null for any score you cannot ground in the available data — never a made-up mid-range number.`);
  lines.push(`- Set confidenceLevel by basis completeness: High needs a meaningful recent comms window; Medium = partial data; Low = thin or operational-only basis.`);

  if (tier === "operational") {
    lines.push(
      `THIS IS AN OPERATIONAL-BASIS JUDGMENT: no communications are available. Judge account health from the operational data above (report metrics, strategic context, agent memory, open asks, RIS engagement). Do NOT fabricate relationship or sentiment findings; sentiment-related scores must be null unless grounded; confidenceLevel must be Low or Medium.`,
    );
  }

  return lines.join("\n");
}

export async function getClientRecentCommsCount(clientId: string, days = 30): Promise<number> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  return storage.countClientCommunicationsInRange(clientId, since);
}

/**
 * Task #4048 — light judgeability probe for the "Re-judge stale client
 * judgments" prod action. Answers "would generateDailyJudgmentDetailed
 * throw JudgmentSkippedError for this client?" using the SAME source
 * signals as the real tier decision (decideJudgmentTier), but without
 * retrieving communication rows, prior judgments, or prompt context — only
 * the fields the tier decision reads are populated. A client with judgment
 * HISTORY but no remaining usable sources can never be re-judged, so the
 * action must exclude it from its pending count or the count would never
 * converge to zero.
 */
export async function assessClientJudgeableTier(
  clientId: string,
  endAt: Date = new Date(),
): Promise<JudgmentTier | null> {
  const since30d = new Date(endAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [count30d, reportRows, commandPanel, knowledgeContext, allAsks, risEngagement] = await Promise.all([
    storage.countClientCommunicationsInRange(clientId, since30d, endAt),
    db.select({ id: reports.id }).from(reports).where(eq(reports.clientId, clientId)).limit(1),
    storage.getCommandPanel(clientId),
    getClientContext(clientId, "daily_judgment"),
    storage.getClientOpenAsks(clientId),
    getRisEngagementSnapshot(clientId),
  ]);
  const activeAskCount = allAsks.filter(a => isActiveAskStatus(a.status)).length;
  const sources: JudgmentSourceSignals = {
    comms: { count24h: 0, count7d: 0, count30d, lastCommAt: null },
    report: reportRows.length > 0 ? { reportId: reportRows[0].id, month: "", updatedAt: null } : null,
    commandPanel: panelHasContent(commandPanel) ? { lastUpdatedAt: null, lastReviewedAt: null } : null,
    knowledge: { totalFacts: knowledgeContext.totalFactCount, latestFactSeenAt: null },
    openAsks: { activeCount: activeAskCount, latestUpdatedAt: null },
    ris: { resultCount: risEngagement.length, latest: risEngagement },
    // Task #4292 fields the tier decision never reads — placeholders only.
    lifetime: null,
    trajectory: [],
    reportHistory: [],
    intel: { count90d: 0, latestAt: null },
  };
  return decideJudgmentTier(sources);
}

export interface GenerateDailyJudgmentResult {
  judgment: ClientDailyJudgment;
  outcome: "generated" | "carried_forward";
  tier: JudgmentTier;
}

export interface GenerateDailyJudgmentOptions {
  targetDate?: string;
  /** Skip the carry-forward shortcut and always run a fresh AI judgment. */
  force?: boolean;
}

export async function generateDailyJudgment(clientId: string, targetDate?: string): Promise<ClientDailyJudgment> {
  // Back-compat wrapper: manual/one-off callers always get a fresh judgment.
  const result = await generateDailyJudgmentDetailed(clientId, { targetDate, force: true });
  return result.judgment;
}

export async function generateDailyJudgmentDetailed(
  clientId: string,
  opts: GenerateDailyJudgmentOptions = {},
): Promise<GenerateDailyJudgmentResult> {
  // Task #1723 Phase 2.4: pin every storage call inside the
  // generation flow to the worker pool, even when this function is
  // invoked from an API route handler. `runWithWorkerDb` installs the
  // AsyncLocalStorage context that `getDb()` reads in
  // `server/storage/*` modules.
  return runWithWorkerDb(() =>
    withDbAttribution("worker:daily-judgment-generate", () =>
      generateDailyJudgmentInWorkerDb(clientId, opts),
    ),
  );
}

// ---------------------------------------------------------------------------
// Test seams (Task #3697): this module builds its own OpenAI client and
// statically imports the fact extractor, so hermetic tests swap both through
// narrow setters instead of ESM patching (named exports are read-only).
// ---------------------------------------------------------------------------

type JudgmentChatCreate = (params: {
  model: string;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
}) => Promise<{ choices: Array<{ message?: { content?: string | null } | null }> }>;

const defaultChatCreate: JudgmentChatCreate = (params) =>
  openai.chat.completions.create(params as any) as any;
let chatCreateImpl: JudgmentChatCreate = defaultChatCreate;

export function __test_setJudgmentChatCreate(fn: JudgmentChatCreate | null): void {
  chatCreateImpl = fn ?? defaultChatCreate;
}

type JudgmentFactExtractor = typeof extractAndPersistFromAgentOutput;
let extractFactsImpl: JudgmentFactExtractor = extractAndPersistFromAgentOutput;

export function __test_setJudgmentFactExtractor(fn: JudgmentFactExtractor | null): void {
  extractFactsImpl = fn ?? extractAndPersistFromAgentOutput;
}

// ---------------------------------------------------------------------------
// Inventory assembly (worker-pool context)
// ---------------------------------------------------------------------------

/** Command panel counts as a data source only when it carries real content. */
function panelHasContent(panel: any): boolean {
  if (!panel) return false;
  const fields = [
    panel.quarterPrimaryObjective,
    panel.currentBottleneck,
    panel.budgetPosture,
    panel.currentRiskFlags,
    panel.currentOpportunities,
    panel.clientPreferences,
    panel.internalHandlingNotes,
    panel.activeCampaignFocus,
    panel.keyActiveInitiatives,
  ];
  return fields.some(v => typeof v === "string" && v.trim().length > 0);
}

function previousPeriod(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Latest engagement-layer RIS result per check (current period preferred,
 * then previous, then launch). RIS being unreachable degrades to "missing"
 * in the manifest — loudly logged, never fabricated.
 */
async function getRisEngagementSnapshot(clientId: string): Promise<RisEngagementResult[]> {
  try {
    const checks = await listRisChecks({ layer: "engagement", activeOnly: true });
    if (checks.length === 0) return [];
    const period = currentPeriod();
    const prevPeriod = previousPeriod(period);
    const results = await getRisResultsForClient(clientId, [period, prevPeriod]);
    if (results.length === 0) return [];

    const rank = (p: string) => (p === period ? 3 : p === prevPeriod ? 2 : 1);
    const byCheck = new Map<string, (typeof results)[number]>();
    for (const r of results) {
      const prev = byCheck.get(r.checkId);
      if (!prev || rank(r.period) > rank(prev.period)) byCheck.set(r.checkId, r);
    }

    const snapshot: RisEngagementResult[] = [];
    for (const check of checks) {
      const r = byCheck.get(check.id);
      if (!r) continue;
      snapshot.push({
        key: check.key,
        label: check.label,
        status: r.status,
        period: r.period,
        notes: r.notes ?? null,
      });
    }
    return snapshot.slice(0, 20);
  } catch (err: any) {
    console.error(`[DailyJudgment] RIS engagement snapshot failed for client ${clientId}:`, err.message);
    return [];
  }
}

interface JudgmentGenerationInputs {
  client: Client;
  sources: JudgmentSourceSignals;
  silenceDays: number | null;
  businessDaySilence: number | null;
  tier: JudgmentTier | null;
  ratingFacts: JudgmentRatingFacts;
  recentComms: CommWithPerClientSummary[];
  priorJudgments: ClientDailyJudgment[];
  activeAsks: ClientOpenAsk[];
  latestReportData: any;
  commandPanel: any;
  knowledgeContextStr: string;
  risEngagement: RisEngagementResult[];
  /** Task #4292 — operator concern intel rows (last 90d, newest first). */
  recentIntel: ClientConcernIntel[];
}

async function buildJudgmentInputs(
  client: Client,
  dateStr: string,
  endAt: Date,
): Promise<JudgmentGenerationInputs> {
  const clientId = client.id;
  const startAt7d = new Date(endAt.getTime() - 7 * 24 * 60 * 60 * 1000);
  const since24h = new Date(endAt.getTime() - 24 * 60 * 60 * 1000);
  const since30d = new Date(endAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  const since90d = new Date(endAt.getTime() - 90 * 24 * 60 * 60 * 1000);
  // Lifetime aggregates use the SAME non-orphaned predicate as lastCommRow
  // (not the windowed countable dedupe): both sides of every cadence
  // comparison share one grain, and the aggregate is a single range scan on
  // raw_comm_client_timestamp_idx.
  const nonOrphaned = and(
    eq(rawCommunicationRecords.clientId, clientId),
    or(
      isNull(rawCommunicationRecords.matchStatus),
      ne(rawCommunicationRecords.matchStatus, "orphaned"),
    ),
    lte(rawCommunicationRecords.timestamp, endAt),
  );

  const [
    recentComms,
    priorJudgments,
    allAsks,
    latestReportData,
    commandPanel,
    knowledgeContext,
    count24h,
    count7d,
    count30d,
    lastCommRow,
    risEngagement,
    lifetimeAggRow,
    longestGapRow,
    trajectoryRows,
    reportHistoryRows,
    measuredLeadsRows,
    recentIntel,
    metricTracking,
  ] = await Promise.all([
    // The analyzed window is the SAME 30-day window the tier decision and the
    // manifest's headline count use. Anything counted must be retrievable and
    // vice versa (same range bounds, same non-orphaned predicate), otherwise a
    // client whose only comm is 8-30 days old would be tiered "full" while the
    // model sees no communications at all.
    getRecentCommunications(clientId, since30d, endAt),
    storage.getClientDailyJudgments(clientId, 7),
    storage.getClientOpenAsks(clientId),
    getLatestReportMetrics(clientId),
    storage.getCommandPanel(clientId),
    getClientContext(clientId, "daily_judgment"),
    storage.countClientCommunicationsInRange(clientId, since24h, endAt),
    storage.countClientCommunicationsInRange(clientId, startAt7d, endAt),
    storage.countClientCommunicationsInRange(clientId, since30d, endAt),
    db
      .select({ last: sql<string | null>`MAX(${rawCommunicationRecords.timestamp})` })
      .from(rawCommunicationRecords)
      .where(
        and(
          eq(rawCommunicationRecords.clientId, clientId),
          or(
            isNull(rawCommunicationRecords.matchStatus),
            ne(rawCommunicationRecords.matchStatus, "orphaned"),
          ),
        ),
      ),
    getRisEngagementSnapshot(clientId),
    // Task #4292 — lifetime aggregate: one index-backed range scan.
    db
      .select({
        first: sql<string | null>`MIN(${rawCommunicationRecords.timestamp})`,
        total: sql<number>`count(*)::int`,
        inbound: sql<number>`count(*) FILTER (WHERE ${rawCommunicationRecords.direction} = 'inbound')::int`,
        outbound: sql<number>`count(*) FILTER (WHERE ${rawCommunicationRecords.direction} = 'outbound')::int`,
        recent90: sql<number>`count(*) FILTER (WHERE ${rawCommunicationRecords.timestamp} >= ${since90d})::int`,
      })
      .from(rawCommunicationRecords)
      .where(nonOrphaned),
    // Longest historical gap between consecutive matched comms (days).
    db.execute(sql`
      SELECT FLOOR(EXTRACT(EPOCH FROM MAX(gap)) / 86400)::int AS gap_days
      FROM (
        SELECT ${rawCommunicationRecords.timestamp} - LAG(${rawCommunicationRecords.timestamp}) OVER (ORDER BY ${rawCommunicationRecords.timestamp}) AS gap
        FROM ${rawCommunicationRecords}
        WHERE ${nonOrphaned}
      ) gaps
      WHERE gap IS NOT NULL
    `),
    // Monthly judgment trajectory — COMPLETED months only (the in-progress
    // month would let yesterday's write break today's carry-forward).
    // Task #4761 — `calibrated` marks months whose judgments were ALL
    // generated with the deterministic tier gate (tierGateVersion stamped in
    // their inventory). Pre-gate months are excluded from the prompt: their
    // statuses came from miscalibrated prompts and anchored the board red.
    db.execute(sql`
      SELECT substring(${clientDailyJudgments.judgmentDate}, 1, 7) AS month,
             count(*)::int AS days,
             ROUND(AVG(${clientDailyJudgments.riskScore})::numeric, 1) AS avg_risk,
             (array_agg(${clientDailyJudgments.status} ORDER BY ${clientDailyJudgments.judgmentDate} DESC))[1] AS end_status,
             bool_and(${clientDailyJudgments.dataSourcesSummary}->>'tierGateVersion' IS NOT NULL) AS calibrated
      FROM ${clientDailyJudgments}
      WHERE ${clientDailyJudgments.clientId} = ${clientId}
        AND substring(${clientDailyJudgments.judgmentDate}, 1, 7) < ${dateStr.substring(0, 7)}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    `),
    // Compact multi-month report-metric history (canonical extraction below).
    db.execute(sql`
      SELECT r.report_month AS month, rs.data AS marketing
      FROM ${reports} r
      JOIN ${reportSections} rs ON rs.report_id = r.id AND rs.section_key = 'marketing'
      WHERE r.client_id = ${clientId}
      ORDER BY r.report_month DESC
      LIMIT 6
    `),
    // Task #4766 — measured monthly-leads series (latest post-close
    // snapshot per completed period, ok-status perf_total_leads only).
    // Degrades to an empty series when live data is absent; feeds ONLY the
    // deterministic tier gate, never the model's evidence corpus.
    getMeasuredMonthlyLeadsSeries(clientId, dateStr),
    storage.listRecentConcernIntel(clientId, since90d),
    // Task #4846 — classify each intake/sales metric family as never-entered
    // vs entered-before over the client's ENTIRE report history, so the
    // prompt can say "not tracked for this client" instead of implying zero.
    getClientMetricTracking(clientId),
  ]);

  const activeAsks = allAsks.filter(a => isActiveAskStatus(a.status));
  const knowledgeContextStr = formatContextForPrompt(knowledgeContext);

  const lastCommRaw = lastCommRow[0]?.last ?? null;
  const lastCommAt = lastCommRaw ? new Date(lastCommRaw).toISOString() : null;
  const silenceDays = lastCommAt
    ? Math.max(0, Math.floor((endAt.getTime() - new Date(lastCommAt).getTime()) / (24 * 60 * 60 * 1000)))
    : null;
  const businessDaySilence = computeBusinessDaySilence(lastCommAt, endAt);

  // Task #4292 — lifetime aggregate assembly. db.execute returns a raw
  // QueryResult (.rows), the drizzle select returns an array.
  const lifetimeAgg = lifetimeAggRow[0];
  const longestGapDays = (() => {
    const raw = (longestGapRow as any).rows?.[0]?.gap_days;
    const n = raw === null || raw === undefined ? null : Number(raw);
    return n !== null && Number.isFinite(n) ? n : null;
  })();
  const lifetime =
    lifetimeAgg && lifetimeAgg.total > 0
      ? {
          firstCommAt: lifetimeAgg.first ? new Date(lifetimeAgg.first).toISOString() : null,
          totalComms: lifetimeAgg.total,
          inboundComms: lifetimeAgg.inbound,
          outboundComms: lifetimeAgg.outbound,
          comms90d: lifetimeAgg.recent90,
          longestGapDays,
        }
      : null;

  const trajectoryAll = (((trajectoryRows as any).rows ?? []) as any[]).map(r => ({
    month: String(r.month),
    endStatus: r.end_status ? String(r.end_status) : null,
    avgRisk: r.avg_risk === null || r.avg_risk === undefined ? null : Number(r.avg_risk),
    days: Number(r.days) || 0,
    // Driver-dependent boolean serialization (true vs "t").
    calibrated: r.calibrated === true || r.calibrated === "t" || r.calibrated === "true",
  }));
  // Task #4761 — de-anchor: only calibrated-era months feed the prompt.
  const trajectory = trajectoryAll
    .filter(r => r.calibrated)
    .map(({ calibrated: _calibrated, ...rest }) => rest);
  const trajectoryExcludedMonths = trajectoryAll.length - trajectory.length;

  const reportHistory = (((reportHistoryRows as any).rows ?? []) as any[])
    .map(r => readMonthLeadsReviews(r.month, r.marketing))
    .filter((v): v is NonNullable<ReturnType<typeof readMonthLeadsReviews>> => v !== null);

  const intel = {
    count90d: recentIntel.length,
    latestAt: recentIntel[0]?.createdAt?.toISOString() ?? null,
  };

  let latestAskUpdatedAt: string | null = null;
  for (const ask of activeAsks) {
    const ts = (ask.updatedAt ?? ask.createdAt)?.toISOString() ?? null;
    if (ts && (!latestAskUpdatedAt || ts > latestAskUpdatedAt)) latestAskUpdatedAt = ts;
  }

  const panelPresent = panelHasContent(commandPanel);

  const sources: JudgmentSourceSignals = {
    comms: { count24h, count7d, count30d, lastCommAt },
    report: latestReportData
      ? {
          reportId: latestReportData.reportId,
          month: latestReportData.reportMonth,
          updatedAt: latestReportData.updatedAt,
        }
      : null,
    commandPanel: panelPresent
      ? {
          lastUpdatedAt: commandPanel?.lastUpdatedAt?.toISOString() ?? null,
          lastReviewedAt: commandPanel?.lastReviewedAt?.toISOString() ?? null,
        }
      : null,
    knowledge: {
      totalFacts: knowledgeContext.totalFactCount,
      latestFactSeenAt: knowledgeContext.latestFactSeenAt,
    },
    openAsks: { activeCount: activeAsks.length, latestUpdatedAt: latestAskUpdatedAt },
    ris: { resultCount: risEngagement.length, latest: risEngagement },
    lifetime,
    trajectory,
    trajectoryExcludedMonths,
    reportHistory,
    measuredLeads: measuredLeadsRows,
    intel,
    // Task #4846 — monthsInspected is deliberately dropped: it moves when a
    // new report month appears (already fingerprinted via reportHistory) and
    // would add churn without changing the never-vs-lapsed framing.
    metricTracking: { consults: metricTracking.consults, cases: metricTracking.cases },
  };

  return {
    client,
    sources,
    silenceDays,
    businessDaySilence,
    tier: decideJudgmentTier(sources),
    ratingFacts: deriveJudgmentRatingFacts(
      sources,
      silenceDays,
      businessDaySilence,
      dateStr,
    ),
    recentComms,
    priorJudgments,
    activeAsks,
    latestReportData,
    commandPanel: panelPresent ? commandPanel : null,
    knowledgeContextStr,
    risEngagement,
    recentIntel,
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function generateDailyJudgmentInWorkerDb(
  clientId: string,
  opts: GenerateDailyJudgmentOptions,
): Promise<GenerateDailyJudgmentResult> {
  const dateStr = opts.targetDate || new Date().toISOString().split("T")[0];
  const endAt = new Date(dateStr + "T23:59:59.999Z");
  const startAt24h = new Date(endAt.getTime() - 24 * 60 * 60 * 1000);
  const windowStartAt = new Date(endAt.getTime() - 30 * 24 * 60 * 60 * 1000);

  const client = await storage.getClient(clientId);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const inputs = await buildJudgmentInputs(client, dateStr, endAt);
  const {
    sources,
    silenceDays,
    businessDaySilence,
    tier,
    ratingFacts,
    recentComms,
    priorJudgments,
    activeAsks,
  } = inputs;

  if (!tier) {
    throw new JudgmentSkippedError(
      `No usable data sources for ${client.firmName}: no matched communications, no reports, no command panel, no agent memory, no open asks, and no RIS engagement checks.`,
    );
  }

  const latest = priorJudgments.find(j => j.judgmentDate <= dateStr);
  const latestInventory = (latest?.dataSourcesSummary ?? {}) as Partial<JudgmentDataInventory>;
  const latestGateAudit =
    latestInventory.carriedForward?.rootTierGate ??
    latestInventory.tierGate ??
    null;
  const carryForwardRatingFacts: JudgmentRatingFacts = {
    ...ratingFacts,
    evidenceRecencyFingerprint: buildEvidenceRecencyFingerprint(
      latestGateAudit?.evidence?.items ?? [],
      dateStr,
    ),
  };
  const fingerprint = computeInputsFingerprint(
    sources,
    silenceDays,
    carryForwardRatingFacts,
  );

  const { basedOn, missing } = buildJudgmentBasis(sources, silenceDays);
  const inventory: JudgmentDataInventory = {
    version: 2,
    tier,
    generatedAt: new Date().toISOString(),
    inputsFingerprint: fingerprint,
    promptRevision: FINGERPRINT_REVISION,
    tierGateVersion: TIER_GATE_VERSION,
    basedOn,
    missing,
    silenceDays,
    businessDaySilence,
    sources,
    carriedForward: null,
  };

  // Carry-forward: nothing changed since the most recent judgment → keep its
  // assessment, refresh the "as of" date, and skip the AI call entirely.
  if (!opts.force) {
    const latestFingerprint = (latest?.dataSourcesSummary as any)?.inputsFingerprint;
    if (latest && latestFingerprint === fingerprint) {
      if (latest.judgmentDate === dateStr) {
        return { judgment: latest, outcome: "carried_forward", tier };
      }
      const judgment = await carryJudgmentForward(latest, dateStr, inventory);
      console.log(
        `[DailyJudgment] Carried forward ${client.firmName} (${dateStr}) from ${latest.judgmentDate}: inputs unchanged`,
      );
      return { judgment, outcome: "carried_forward", tier };
    }
  }

  const prompt = buildJudgmentPrompt(
    client,
    recentComms.filter(c => new Date(c.timestamp) >= startAt24h),
    recentComms,
    priorJudgments,
    activeAsks,
    inputs.latestReportData,
    inputs.commandPanel,
    dateStr,
    inputs.knowledgeContextStr,
    inventory,
    inputs.risEngagement,
    inputs.recentIntel,
  );

  const response = await chatCreateImpl({
    model: MODEL_VERSION,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: getSystemPrompt() },
      { role: "user", content: prompt },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) throw new Error("Empty AI response for daily judgment");

  let aiResult: JudgmentAIResponse;
  try {
    aiResult = JSON.parse(rawContent);
  } catch (e) {
    console.error("[DailyJudgment] Failed to parse AI response:", rawContent.substring(0, 500));
    throw new Error("Failed to parse AI judgment response");
  }

  const validStatuses = ["Healthy", "Watch", "At Risk", "Critical"];
  const validRelStatuses = ["Strong", "Stable", "Strained", "At Risk"];
  const validConfidence = ["High", "Medium", "Low"];

  if (!validStatuses.includes(aiResult.overallStatus)) aiResult.overallStatus = "Watch";
  if (!validRelStatuses.includes(aiResult.relationshipStatus)) aiResult.relationshipStatus = "Stable";
  if (!validConfidence.includes(aiResult.confidenceLevel)) aiResult.confidenceLevel = "Medium";
  // An operational basis can never be a High-confidence judgment.
  if (tier === "operational" && aiResult.confidenceLevel === "High") aiResult.confidenceLevel = "Medium";

  const rawScores = (aiResult.scores ?? {}) as Record<string, unknown>;
  const scores = {
    relationshipHealth: sanitizeScoreValue(rawScores.relationshipHealth),
    sentiment: sanitizeScoreValue(rawScores.sentiment),
    complaint: sanitizeScoreValue(rawScores.complaint),
    trust: sanitizeScoreValue(rawScores.trust),
    responsivenessRisk: sanitizeScoreValue(rawScores.responsivenessRisk),
    executionRisk: sanitizeScoreValue(rawScores.executionRisk),
    leadVolumeConcern: sanitizeScoreValue(rawScores.leadVolumeConcern),
    unresolvedTaskRisk: sanitizeScoreValue(rawScores.unresolvedTaskRisk),
    overallRisk: sanitizeScoreValue(rawScores.overallRisk),
  };
  // Task #98 guard, hard-enforced: sentiment is comms-derived, so with no
  // analyzed communications a sentiment number would be fabricated by
  // definition — null it regardless of what the model returned.
  if (recentComms.length === 0) {
    scores.sentiment = null;
  }

  // Deterministic tier gate. Validate the model's churn-
  // evidence citations against the exact sections it saw, derive the STORED
  // tier from what survives, and preserve the model's proposal + the
  // applied rule in the persisted audit (inventory.tierGate).
  const evidenceCorpus = buildEvidenceCorpus({
    client: inputs.client,
    last24hComms: recentComms.filter(c => new Date(c.timestamp) >= startAt24h),
    windowComms: recentComms,
    openAsks: activeAsks,
    reportData: inputs.latestReportData,
    commandPanel: inputs.commandPanel,
    risEngagement: inputs.risEngagement,
    recentIntel: inputs.recentIntel,
    reportHistory: sources.reportHistory,
    dateStr,
    hasKnowledgeContext: !!inputs.knowledgeContextStr,
    metricTracking: sources.metricTracking,
  });
  const deliveryAssessed = assessDeliveryStabilityWithFallback(
    sources.reportHistory,
    sources.measuredLeads ?? [],
    dateStr,
  );
  const evidenceValidation = validateEvidenceCitations(aiResult.churnEvidence, evidenceCorpus, {
    judgmentDate: dateStr,
    deliveryStability: deliveryAssessed.stability,
    deliveryStabilitySource: deliveryAssessed.source,
  });
  const gateInput = {
    judgmentDate: dateStr,
    proposedStatus: aiResult.overallStatus as "Healthy" | "Watch" | "At Risk" | "Critical",
    proposedOverallRisk: scores.overallRisk,
    proposedRelationshipStatus: aiResult.relationshipStatus,
    evidence: evidenceValidation.items,
    tier,
    silenceExceeded: isBaselineSilenceExceeded({
      silenceDays,
      businessDaySilence,
      longestGapDays: sources.lifetime?.longestGapDays ?? null,
    }),
    // Task #4766 — entered reports stay primary; measured post-close
    // live-data leads ground stability only when entered data can't, and
    // the audit names which source the verdict came from.
    deliveryStability: deliveryAssessed.stability,
    deliveryStabilitySource: deliveryAssessed.source,
  };
  const gate = applyJudgmentTierGate(gateInput);
  inventory.tierGate = buildTierGateAudit(gateInput, gate, evidenceValidation);
  const reconcileSupportingText = (value: string): string =>
    stripModelRatingClaims(value);
  // The model proposal remains intact in inventory.tierGate for traceability,
  // while the persisted summary starts with the server-owned verdict and all
  // supporting fields drop model-authored rating claims.
  aiResult.summary = reconcileJudgmentNarrative(
    aiResult.summary,
    gate.finalStatus,
    gate.finalRelationshipStatus,
    gate.finalOverallRisk,
  );
  aiResult.sentimentSummary = reconcileSupportingText(aiResult.sentimentSummary);
  aiResult.whatChanged = (aiResult.whatChanged || []).map(reconcileSupportingText).filter(Boolean);
  aiResult.concerns = (aiResult.concerns || []).map(reconcileSupportingText).filter(Boolean);
  aiResult.unresolvedAsks = (aiResult.unresolvedAsks || []).map(reconcileSupportingText).filter(Boolean);
  aiResult.wins = (aiResult.wins || []).map(reconcileSupportingText).filter(Boolean);
  aiResult.recommendedActions = (aiResult.recommendedActions || [])
    .map(action => ({
      ...action,
      action: reconcileSupportingText(action.action),
      why: reconcileSupportingText(action.why),
    }))
    .filter(action => action.action || action.why);
  inventory.inputsFingerprint = computeInputsFingerprint(sources, silenceDays, {
    ...ratingFacts,
    evidenceRecencyFingerprint: buildEvidenceRecencyFingerprint(
      evidenceValidation.items,
      dateStr,
    ),
  });

  const judgment = await storage.upsertClientDailyJudgment({
    clientId,
    judgmentDate: dateStr,
    status: gate.finalStatus,
    overallStatus: gate.finalStatus,
    // Keep the legacy display columns in lockstep — the dashboard summaries
    // SQL and older stream rows still read them.
    relationshipHealth: gate.finalRelationshipStatus,
    confidence: aiResult.confidenceLevel,
    relationshipStatus: gate.finalRelationshipStatus,
    confidenceLevel: aiResult.confidenceLevel,
    summaryText: discloseInternalInterpretationInNarrative(
      aiResult.summary || "No summary generated.",
      evidenceValidation.items,
    ),
    sentimentSummary: aiResult.sentimentSummary || null,
    changeSummary: (aiResult.whatChanged || []).join("\n• ") || null,
    concernsJson: aiResult.concerns || [],
    unresolvedAsksJson: aiResult.unresolvedAsks || [],
    winsJson: aiResult.wins || [],
    actionsJson: (aiResult.recommendedActions || []).slice(0, 3),
    relationshipHealthScore: scores.relationshipHealth,
    sentimentScore: scores.sentiment,
    complaintScore: scores.complaint,
    // Stored risk is deterministic from accepted independent drivers; the
    // model's raw number remains proposal-only in the tierGate audit.
    riskScore: gate.finalOverallRisk,
    communicationsAnalyzed: recentComms.length,
    dataSourcesSummary: inventory,
    generatedFromStartAt: windowStartAt,
    generatedFromEndAt: endAt,
    modelVersion: MODEL_VERSION,
  });

  await storage.upsertClientRelationshipSignal({
    clientId,
    signalDate: dateStr,
    judgmentId: judgment.id,
    relationshipHealthScore: scores.relationshipHealth,
    sentimentScore: scores.sentiment,
    complaintScore: scores.complaint,
    trustScore: scores.trust,
    responsivenessRiskScore: scores.responsivenessRisk,
    executionRiskScore: scores.executionRisk,
    leadVolumeConcernScore: scores.leadVolumeConcern,
    unresolvedTaskScore: scores.unresolvedTaskRisk,
  });

  await updateOpenAsksFromJudgment(clientId, aiResult, activeAsks);

  // Task #98 hallucination guard: agent-memory facts are only extracted when
  // real communications were analyzed. An operational/no-comms judgment must
  // never seed the knowledge base with AI-inferred "facts".
  if (recentComms.length > 0) {
    try {
      const factsStored = await extractFactsImpl(clientId, "daily_judgment", judgment.id, {
        concerns: aiResult.concerns,
        wins: aiResult.wins,
        sentimentSummary: aiResult.sentimentSummary,
        unresolvedAsks: aiResult.unresolvedAsks,
      });
      if (factsStored > 0) {
        console.log(`[DailyJudgment] Stored ${factsStored} knowledge facts for ${client.firmName}`);
      }
    } catch (err: any) {
      console.error(`[DailyJudgment] Knowledge extraction failed for ${client.firmName}:`, err.message);
    }
  } else {
    console.log(
      `[DailyJudgment] Skipped knowledge extraction for ${client.firmName}: no communications in the analyzed window`,
    );
  }

  const gateNote = gate.overridden
    ? ` (model proposed ${gateInput.proposedStatus}; server derived ${gate.finalStatus}: ${gate.capReasons.join(", ")})`
    : "";
  console.log(
    `[DailyJudgment] Generated judgment for ${client.firmName} (${dateStr}): ${gate.finalStatus}${gateNote} [${tier} basis]`,
  );
  return { judgment, outcome: "generated", tier };
}

/**
 * Copy the prior judgment's assessment onto `dateStr` (status carries
 * forward, "as of" advances) and mirror its relationship-signal row, marking
 * the basis as carried so the UI can say so.
 */
async function carryJudgmentForward(
  prior: ClientDailyJudgment,
  dateStr: string,
  inventory: JudgmentDataInventory,
): Promise<ClientDailyJudgment> {
  const priorInventory = (prior.dataSourcesSummary ?? {}) as Partial<JudgmentDataInventory>;
  const priorLineage = priorInventory.carriedForward ?? null;
  const rootTierGate = priorLineage?.rootTierGate ?? priorInventory.tierGate ?? null;
  const carriedInventory: JudgmentDataInventory = {
    ...inventory,
    carriedForward: {
      fromDate: prior.judgmentDate,
      fromJudgmentId: prior.id,
      rootDate: priorLineage?.rootDate ?? prior.judgmentDate,
      rootJudgmentId: priorLineage?.rootJudgmentId ?? prior.id,
      rootTierGate,
    },
  };

  const judgment = await storage.upsertClientDailyJudgment({
    clientId: prior.clientId,
    judgmentDate: dateStr,
    status: (prior.status as InsertClientDailyJudgment["status"]) || "Watch",
    overallStatus: prior.overallStatus ?? prior.status,
    relationshipHealth: (prior.relationshipHealth ?? prior.relationshipStatus ?? undefined) as InsertClientDailyJudgment["relationshipHealth"],
    confidence: (prior.confidence ?? prior.confidenceLevel ?? undefined) as InsertClientDailyJudgment["confidence"],
    relationshipStatus: prior.relationshipStatus,
    confidenceLevel: prior.confidenceLevel,
    summaryText: prior.summaryText,
    sentimentSummary: prior.sentimentSummary,
    changeSummary: prior.changeSummary,
    concernsJson: (prior.concernsJson as string[] | null) ?? [],
    unresolvedAsksJson: (prior.unresolvedAsksJson as string[] | null) ?? [],
    winsJson: (prior.winsJson as string[] | null) ?? [],
    actionsJson: (prior.actionsJson as unknown[] | null) ?? [],
    relationshipHealthScore: prior.relationshipHealthScore,
    sentimentScore: prior.sentimentScore,
    complaintScore: prior.complaintScore,
    riskScore: prior.riskScore,
    communicationsAnalyzed: prior.communicationsAnalyzed ?? 0,
    dataSourcesSummary: carriedInventory,
    generatedFromStartAt: prior.generatedFromStartAt,
    generatedFromEndAt: prior.generatedFromEndAt,
    modelVersion: prior.modelVersion,
  });

  const priorSignals = await storage.listClientRelationshipSignals(prior.clientId, {
    dateFrom: new Date(prior.judgmentDate),
    dateTo: new Date(prior.judgmentDate),
  });
  const priorSignal = priorSignals.find(s => s.signalDate === prior.judgmentDate);
  if (priorSignal) {
    await storage.upsertClientRelationshipSignal({
      clientId: prior.clientId,
      signalDate: dateStr,
      judgmentId: judgment.id,
      relationshipHealthScore: priorSignal.relationshipHealthScore,
      sentimentScore: priorSignal.sentimentScore,
      complaintScore: priorSignal.complaintScore,
      trustScore: priorSignal.trustScore,
      responsivenessRiskScore: priorSignal.responsivenessRiskScore,
      executionRiskScore: priorSignal.executionRiskScore,
      leadVolumeConcernScore: priorSignal.leadVolumeConcernScore,
      unresolvedTaskScore: priorSignal.unresolvedTaskScore,
    });
  }

  return judgment;
}

// Task #4765 — asks are referenced by stable ID: the prompt renders each
// ask's id (buildOpenAsksSection) and the model returns `askId` in
// openAskUpdates; the old 30-char lowercase-prefix substring matching is
// retired for both updates and new-ask dedup. A likelyResolved flag is
// validated inline against full communication history (hindsight
// evaluator) — a validated answer transitions straight to `resolved` with
// cited evidence; an unvalidated one parks at `likely_resolved`, which the
// deterministic maintenance backstop auto-confirms after
// LIKELY_RESOLVED_CONFIRM_DAYS so it can never strand. New asks route
// through the shared creation path (cross-type semantic dedup, burst-safe).
export async function updateOpenAsksFromJudgment(
  clientId: string,
  aiResult: JudgmentAIResponse,
  existingAsks: ClientOpenAsk[],
) {
  if (aiResult.openAskUpdates && Array.isArray(aiResult.openAskUpdates)) {
    for (const update of aiResult.openAskUpdates) {
      const matchingAsk = update.askId
        ? existingAsks.find(a => a.id === update.askId)
        : undefined;
      if (!matchingAsk) {
        if (update.askId) {
          console.warn(`[DailyJudgment] openAskUpdates cited unknown askId ${update.askId} for client ${clientId} — skipped`);
        }
        continue;
      }

      if (update.likelyResolved) {
        await storage.updateClientOpenAsk(matchingAsk.id, {
          status: "likely_resolved",
          likelyResolved: true,
          likelyResolvedAt: new Date(),
        });
        // Validate against FULL history — resolved-with-evidence or stays
        // parked at likely_resolved (backstop confirms later). Errors never
        // fabricate or block: the row simply stays likely_resolved.
        try {
          const parked = await storage.getClientOpenAsk?.(matchingAsk.id);
          await evaluateAndApplyAskClosure(parked ?? { ...matchingAsk, status: "likely_resolved" });
        } catch (err: any) {
          console.error(`[DailyJudgment] hindsight validation failed for ask ${matchingAsk.id}:`, err?.message ?? err);
        }
      } else if (update.stillReferenced) {
        await storage.updateClientOpenAsk(matchingAsk.id, {
          concernScore: (matchingAsk.concernScore || 1) + 1,
          lastReferencedAt: new Date(),
        });
      }
    }
  }

  if (aiResult.newAsks && Array.isArray(aiResult.newAsks)) {
    for (const newAsk of aiResult.newAsks) {
      if (!newAsk.askText || newAsk.askText.trim().length === 0) continue;
      try {
        await recordExtractedAsk(clientId, {
          summary: newAsk.askText,
          askText: newAsk.askText,
          type: "client_ask",
          askCategory: newAsk.askCategory || null,
          requestedBy: newAsk.requestedBy || null,
          confidence: newAsk.confidence ?? 0.7,
        });
      } catch (err: any) {
        console.error(`[DailyJudgment] failed to record new ask "${newAsk.askText.slice(0, 60)}":`, err?.message ?? err);
      }
    }
  }

  // Deterministic backstop (no AI): auto-confirm stranded likely_resolved
  // rows + decay never-re-referenced actives — rides this worker instead of
  // a new always-on scheduler.
  try {
    await runOpenAskMaintenance(clientId);
  } catch (err: any) {
    console.error(`[DailyJudgment] open-ask maintenance failed for client ${clientId}:`, err?.message ?? err);
  }
}

export type CommWithPerClientSummary = RawCommunicationRecord & {
  perClientSummary?: string | null;
  isMultiClient?: boolean;
};

async function getRecentCommunications(
  clientId: string,
  since: Date,
  until: Date,
): Promise<CommWithPerClientSummary[]> {
  // Task #4048: the WHERE clause is the SAME shared predicate the window
  // counts use (countableCommunicationConditions — matched/non-orphaned rows,
  // one row per real communication with email-thread rollups deduped against
  // their materialized per-message siblings), and there is deliberately NO
  // row cap: every counted communication is retrieved, and the prompt
  // represents all of them (full detail → compact → one-line digest), so
  // `communicationsAnalyzed` == the basis line's 30-day count by
  // construction. The old silent `.limit(50)` produced self-contradicting
  // evidence ("50 comms analyzed" next to "152 comms (30d)").
  const comms = await db.select()
    .from(rawCommunicationRecords)
    .where(and(...countableCommunicationConditions(clientId, since, until)))
    .orderBy(desc(rawCommunicationRecords.timestamp));

  if (comms.length === 0) return comms;

  const commIds = comms.map(c => c.id);

  const allLinks = await db.select({
    id: communicationClientLinks.id,
    rawCommunicationRecordId: communicationClientLinks.rawCommunicationRecordId,
    clientId: communicationClientLinks.clientId,
    perClientSummary: communicationClientLinks.perClientSummary,
  })
    .from(communicationClientLinks)
    .where(
      inArray(communicationClientLinks.rawCommunicationRecordId, commIds),
    );

  const linksByCommId = new Map<string, typeof allLinks>();
  for (const link of allLinks) {
    const existing = linksByCommId.get(link.rawCommunicationRecordId) || [];
    existing.push(link);
    linksByCommId.set(link.rawCommunicationRecordId, existing);
  }

  const client = await storage.getClient(clientId);
  const clientName = client?.firmName || "";

  for (const comm of comms) {
    const links = linksByCommId.get(comm.id) || [];
    if (links.length <= 1) continue;

    const thisClientLink = links.find(l => l.clientId === clientId);
    if (!thisClientLink || thisClientLink.perClientSummary) continue;

    const generatedSummary = generateLazyPerClientSummary(
      comm, clientName, links.length,
    );
    if (generatedSummary) {
      await db.update(communicationClientLinks)
        .set({ perClientSummary: generatedSummary })
        .where(eq(communicationClientLinks.id, thisClientLink.id));
      thisClientLink.perClientSummary = generatedSummary;
    }
  }

  return comms.map(c => {
    const links = linksByCommId.get(c.id) || [];
    const isMultiClient = links.length > 1;
    const thisClientLink = links.find(l => l.clientId === clientId);
    return {
      ...c,
      perClientSummary: thisClientLink?.perClientSummary || null,
      isMultiClient,
    };
  });
}

function generateLazyPerClientSummary(
  comm: RawCommunicationRecord,
  clientName: string,
  totalClients: number,
): string | null {
  try {
    const clientNameLower = clientName.toLowerCase();

    if (comm.contentText) {
      const lines = comm.contentText.split("\n");
      const mentionLines = lines.filter(l => l.toLowerCase().includes(clientNameLower)).slice(0, 5);
      if (mentionLines.length > 0) {
        return `[${clientName} mentions] ${mentionLines.map(l => l.trim().substring(0, 150)).join(" | ")}`;
      }
    }

    return null;
  } catch (err: any) {
    console.error(`[DailyJudgment] Lazy per-client summary failed for comm ${comm.id}:`, err.message);
    return null;
  }
}

async function getLatestReportMetrics(clientId: string): Promise<any> {
  const [latestReport] = await db.select()
    .from(reports)
    .where(eq(reports.clientId, clientId))
    .orderBy(desc(reports.reportMonth))
    .limit(1);

  if (!latestReport) return null;

  const sections = await db.select()
    .from(reportSections)
    .where(eq(reportSections.reportId, latestReport.id));

  return {
    reportId: latestReport.id,
    reportMonth: latestReport.reportMonth,
    updatedAt: latestReport.updatedAt?.toISOString() ?? null,
    sections: sections.reduce((acc: any, s) => {
      acc[s.sectionKey] = s.data;
      return acc;
    }, {}),
  };
}

export function getSystemPrompt(): string {
  return `You are an internal account advisor for a legal marketing agency. You produce daily account judgments — not summaries, not reports — but direct, well-calibrated judgment calls about each client account.

Your job is to help Account Managers understand what's actually happening with each account: what the client is feeling, what risks are building, what asks are being dropped, and what should be done next.

Your tone should be:
- Direct and concise
- Measured and evidence-grounded — state what the evidence supports, plainly, and no more
- Calm and professional — like a smart operator making a judgment call
- Not robotic, not fluffy, not generic, not dramatic

Evidence and attribution rules (hard rules):
- Quote or reference the specific evidence behind every negative finding (who said what, when).
- NEVER attribute motive or intent the client did not state. Words like "intentional avoidance", "ghosting", "stonewalling", or claims about what the client is secretly thinking are banned unless the client literally said it. If a client is quiet, say they are quiet — not why.
- Distinguish observation ("no reply to the 3 pricing emails since Tuesday") from interpretation ("likely frustrated") and label interpretation as such.

STATUS TIER DEFINITIONS (apply these exactly — do not invent stricter ones):
- "Healthy": normal operation. Communication within the client's own normal cadence, no unaddressed client-expressed dissatisfaction, no material negative signals. Minor operational noise and routine back-and-forth are Healthy.
- "Watch": early or ambiguous signals worth monitoring — a mild sentiment dip, a growing pile of small asks, metric softness, or a gap modestly beyond the client's own baseline. Watch is the correct home for uncertainty; it means "keep an eye on it", not "act now".
- "At Risk": clear, evidence-backed problems — the client has EXPRESSED dissatisfaction, repeated asks are going unanswered, sentiment is durably negative, or communication has broken far below the client's own established baseline for that relationship.
- "Critical": RARE and reserved. Requires explicit churn or cancellation signals (client mentions leaving, canceling, ending the contract, legal/billing escalation, moving to another vendor) OR a severe unaddressed failure paired with client-expressed dissatisfaction. A healthy portfolio has few or zero Critical accounts. Critical must NEVER be produced by silence alone, missing data, weekend gaps, or accumulated small concerns.
Across a normal portfolio, most accounts should land Healthy or Watch. If your judgment for a routine account lands At Risk or Critical, re-check the evidence bar before finalizing.

RATING PROPOSALS ARE ADVISORY:
- Your overallStatus, relationshipStatus, and overallRisk are retained for traceability, but deterministic server policy owns the STORED overall status, relationship read, decision reasons, and 0-100 risk. The server adds those values to the stored summary; write supporting evidence only and do not state an overall status, relationship label, or qualitative risk level in narrative fields.
- The server calculates overallRisk from accepted independent evidence/cadence/delivery drivers in disjoint bands: Healthy 0-24, Watch 25-49, At Risk 50-74, Critical 75-100. Do not inflate your proposal to compensate.
- Strained or At Risk relationship proposals require attributable client-authored relationship signals. Silence, missing data, or delivery metrics alone cannot establish client sentiment.
- Anchor supporting scores honestly: reserve extreme values for extreme, evidence-grounded situations.

SILENCE CALIBRATION (hard rules):
- Business-day silence (provided in the manifest) is the authoritative silence measure. Weekends and holidays are NOT silence and NEVER avoidance.
- 0-3 business days without contact is normal cadence for virtually every client — never a silence concern on its own.
- Judge longer gaps against THIS client's own baseline in the LIFETIME RELATIONSHIP CONTEXT section (their normal weekly cadence, their longest historical gap). A monthly-cadence client quiet for two weeks is normal; a daily-cadence client quiet for two weeks is a real signal.
- Silence beyond the client's own norm is a staleness/disengagement risk worth flagging as such — never evidence of sentiment, motive, or an unspoken decision.

Your reasoning priorities:
1. Prioritize useful, calibrated judgment over generic summary
2. Detect tension even when stated indirectly — repeated follow-ups, "just checking again", impatience signals — and quote the evidence when you flag it
3. Look for repeated asks and possible dropped balls — this is critical
4. Notice when the client seems disappointed, impatient, skeptical, or relieved
5. Distinguish between actual account failure and perception/communication failure
6. Flag things as likely unresolved when evidence suggests it, and say why
7. Keep recommendations practical and limited (max 3)
8. Avoid fluff and repetition
9. Reason ONLY from the data sources listed as available in the DATA AVAILABILITY MANIFEST. Missing data is never evidence of a problem.
10. Use the LIFETIME RELATIONSHIP CONTEXT to judge against the client's own history: their tenure, their normal cadence, their long-run status trajectory. A standing issue that has not changed is a standing issue — not a new escalation.

"whatChanged" honesty:
- whatChanged lists only genuinely NEW material developments from the last 24-72 hours.
- If nothing materially changed, say exactly that in one line (e.g. "No material change — standing concerns unchanged"). Do NOT re-narrate standing issues as new, and do NOT escalate severity because an issue appears in the prompt again today.

Data-availability rules:
- The user message includes a DATA AVAILABILITY MANIFEST listing exactly which sources exist for this client. Judge from what exists.
- Never fabricate relationship or sentiment findings when no communications are available — say sentiment is unknown instead.
- Every score must be grounded in available data. If a dimension cannot be grounded, output null for that score — never a guessed mid-range number.
- confidenceLevel reflects basis completeness: High requires a meaningful recent communications window; Medium = partial data; Low = thin or operational-only basis.

Untracked-metric rules (hard rules):
- A metric marked "not tracked for this client" in LATEST REPORT DATA is structurally unmeasured: the client has never reported it. Its absence is the normal state, NOT an outcome. Never describe it as zero, "no intake", "no sales", a poor/zero-conversion result, or a visibility gap; never list it among concerns or unresolved asks; never ask for it back.
- Any zero or poor-conversion metric characterization found in prior judgments or agent memory that TODAY'S report section does not support is unsupported legacy narrative — produced by older prompts, not by data. Do not restate it, do not count it as a standing concern, and do not cite it as evidence. If the underlying metric is "not tracked for this client", the correct framing is that the metric is not tracked — nothing more.
- Agent-memory facts labeled AI-inferred are recycled from this agent's own earlier outputs. They are NOT operator intel, NOT client statements, and NOT measurements — never attribute them to the account team and never let them substitute for today's data.

Operator intel rules (hard rules — apply when an OPERATOR INTEL section is present):
- Operator intel is human-verified ground truth filed by the account team. It OUTRANKS your own inference from older communications. Only the OPERATOR INTEL section contains operator intel — agent-memory facts are not operator intel, whatever they claim.
- A concern marked RESOLVED by an operator must NOT re-surface as an unaddressed concern unless CLIENT evidence dated AFTER the resolution note contradicts it. If it stays resolved, either omit it or mention it only as resolved history.
- CONTEXT intel must temper your framing: judge the flagged issue in light of what the team already knows and is doing about it.

CHURN EVIDENCE CLASSIFICATION (hard rules — server code enforces these):
Your tier proposal is advisory: deterministic server code derives the STORED tier from the validated "churnEvidence" you cite. Classify every churn-relevant negative signal into "churnEvidence" with a fixed-vocabulary category and a VERBATIM quote (copy the exact words) from TODAY'S provided inputs (communications, operator intel, open asks, strategic context, RIS checks, report data). Quotes are checked mechanically against those inputs — a paraphrased, stitched-together, or invented quote is discarded and its category treated as absent. Do not quote prior judgments or agent-memory context as evidence.
Provenance is enforced mechanically too. An INBOUND direction or communication title/subject does NOT prove who authored the quoted words. Client-risk categories require directly client-authored Content whose sender matches the client's known contact identity. Subjects, forwarded/quoted text, automated alerts, third-party reviews, AI Summary/Key Signals, OUR messages, operator intel, open-ask rows, and strategic/RIS context cannot become client dissatisfaction, service failure, or Critical evidence. Report metrics are objective facts only when entered/tracked; "not tracked" and "no data" lines never support decline. Agency write-off vocabulary ("effectively churned", "should offboard", "write off", and the like) is automatically reclassified to "internal_hygiene_gap" wherever it appears.
Categories:
- "explicit_churn_language": the CLIENT directly mentions canceling, leaving, terminating, ending the contract, or not renewing in attributable authored Content. Relayed, forwarded, generated, third-party, or subject-only text does not qualify. Our own internal characterizations ("effectively churned", "functionally churned", "should offboard") are "internal_hygiene_gap".
- "competitor_switch": the client is switching to or actively evaluating another vendor/agency.
- "billing_or_legal_escalation": billing dispute, declined/withheld payment, refund demand, chargeback, or legal threat — factual events in the inputs, not hypothetical future exposure.
- "corroborated_loss_signal": a concrete near-term loss signal in direct client language (access revoked, assets requested for transfer, engagement formally wound down). Corroboration is enforced: cite at least TWO independent, differently-worded client communication fragments; two snippets from one message are not independent.
- "expressed_dissatisfaction": the client states unhappiness, frustration, or skepticism in their own words.
- "repeated_unresolved_ask": the client RECENTLY and explicitly re-referenced an ask that remains unanswered ("again", "following up", "still waiting", etc.) — cite that recent client communication, never a one-off question or backlog row.
- "service_failure": the client directly describes a concrete delivery failure on our side; internal performance commentary is not client evidence.
- "delivery_metric_decline": entered/tracked report metrics materially down vs this client's own recent history — cite metric lines. Server-computed history must independently confirm the decline.
- "internal_hygiene_gap": OUR missing process/documentation/decisions — undocumented plans/owners/metrics, unfilled report fields, un-triaged backlog, internal offboard debates. Never a client signal.
- "other_negative": a negative signal that fits no category above.
Authoritative outcomes the server enforces: internal_hygiene_gap / other_negative alone → "Watch". Current expressed_dissatisfaction / repeated_unresolved_ask / service_failure / delivery_metric_decline, silence beyond the client's own baseline, or declining delivery → "At Risk". "Critical" requires a current validated explicit_churn_language, competitor_switch, billing_or_legal_escalation, or corroborated_loss_signal citation. No validated negative evidence + full basis + stable delivery + cadence within the client's own baseline → "Healthy"; incomplete or genuinely uncertain evidence → "Watch". Propose your status honestly under these definitions.
Standing-issue decay (hard rule): a standing issue with NO new negative client signal since it was last raised must DECAY — the server lowers accepted evidence by one tier after 14 days without a newer signal. Never re-escalate or hold peak risk on an unchanged issue; treat it as standing context.
Missing internal data (unfilled report fields, absent documentation) is an internal gap — "internal_hygiene_gap" at most — NEVER evidence of client churn or delivery decline.
- Any "AI Summary" or "Key Signals" text is INTERNAL AI INTERPRETATION, not direct client evidence. Describe it that way in the narrative. It can support Watch-level context only and cannot independently justify At Risk, Critical, Strained, or relationship At Risk.

Lookback windows:
- Primary judgment: last 24 hours
- Sentiment trend context: the analyzed communications window (up to 30 days; weight recent messages most)
- Ask memory and unresolved item tracking: 14-30 days
- Relationship baseline: the client's full lifetime (see LIFETIME RELATIONSHIP CONTEXT)

You must respond in valid JSON with this exact structure:
{
  "overallStatus": "Healthy" | "Watch" | "At Risk" | "Critical",
  "relationshipStatus": "Strong" | "Stable" | "Strained" | "At Risk",
  "confidenceLevel": "High" | "Medium" | "Low",
  "summary": "150-300 words of supporting evidence and interpretation. Do not state an overall status, relationship label, or qualitative risk level; the server adds its authoritative verdict.",
  "sentimentSummary": "Concise read on client sentiment from recent communications. Include overall sentiment trend, emotional tone, whether sentiment is improving/stable/declining, and whether negativity targets performance, responsiveness, trust, execution, confusion, or another issue. If no communications are available, state that sentiment is unknown.",
  "whatChanged": ["Only genuinely new material developments from the last 24-72 hours; if nothing materially changed, a single line saying so"],
  "concerns": ["Concrete, evidence-grounded concerns — not generic observations, not re-escalated standing issues, not operator-resolved items"],
  "churnEvidence": [
    {
      "category": "explicit_churn_language|competitor_switch|billing_or_legal_escalation|corroborated_loss_signal|expressed_dissatisfaction|repeated_unresolved_ask|service_failure|delivery_metric_decline|internal_hygiene_gap|other_negative",
      "quote": "VERBATIM text copied character-for-character from today's inputs",
      "source": "which section the quote appears in (communications, operator intel, open asks, report data, ...)",
      "date": "date shown alongside the quoted text, if any"
    }
  ],
  "unresolvedAsks": ["Specific unresolved asks or likely dropped balls. Use language like 'likely unresolved', 'appears still open', 'client referencing as though not completed'"],
  "wins": ["Positive observations, recovered trust, meaningful wins, strategic insights"],
  "recommendedActions": [{"action": "Specific action", "why": "Why this matters now"}],
  "scores": {
    "relationshipHealth": 0-100 or null,
    "sentiment": -100 to 100 or null,
    "complaint": 0-100 or null,
    "trust": 0-100 or null,
    "responsivenessRisk": 0-100 or null,
    "executionRisk": 0-100 or null,
    "leadVolumeConcern": 0-100 or null,
    "unresolvedTaskRisk": 0-100 or null,
    "overallRisk": 0-100 or null
  },
  "openAskUpdates": [
    {
      "askId": "the exact id from the ask's [id:...] marker in the CURRENTLY OPEN ASKS section — required; updates without a valid askId are ignored",
      "askText": "Brief description of the ask (display only)",
      "likelyResolved": false,
      "resolvedEvidence": "Evidence if resolved",
      "stillReferenced": true
    }
  ],
  "newAsks": [
    {
      "askText": "New ask or request detected in recent communications",
      "askCategory": "lead_volume|reporting|responsiveness|execution|billing|creative|strategy|other",
      "requestedBy": "Who made the ask if identifiable",
      "confidence": 0.0-1.0
    }
  ]
}
Every score value may be null when the available data cannot ground it.`;
}

/**
 * Task #4292 — the lifetime-context prompt section, pure for tests. Weekly
 * averages are derived HERE (not stored in sources) so the fingerprint never
 * drifts with the calendar denominator.
 */
export function buildLifetimeContextSection(
  sources: JudgmentSourceSignals,
  dateStr: string,
): string[] {
  const { lifetime, trajectory, reportHistory } = sources;
  const trajectoryExcluded = sources.trajectoryExcludedMonths ?? 0;
  if (!lifetime && trajectory.length === 0 && trajectoryExcluded === 0 && reportHistory.length === 0) {
    return [];
  }

  const parts: string[] = [];
  parts.push(`=== LIFETIME RELATIONSHIP CONTEXT ===`);
  parts.push(`Judge this client against THEIR OWN history below — not against a generic ideal.`);

  if (lifetime && lifetime.firstCommAt) {
    const endMs = new Date(dateStr + "T23:59:59.999Z").getTime();
    const tenureDays = Math.max(1, Math.floor((endMs - new Date(lifetime.firstCommAt).getTime()) / (24 * 60 * 60 * 1000)));
    const tenureMonths = Math.floor(tenureDays / 30.44);
    const weeklyLifetime = Math.round((lifetime.totalComms / (tenureDays / 7)) * 10) / 10;
    const weekly90d = Math.round((lifetime.comms90d / (90 / 7)) * 10) / 10;
    parts.push(
      `Tenure: first matched communication ${lifetime.firstCommAt.split("T")[0]} (~${tenureMonths} months ago).`,
    );
    parts.push(
      `All-time communications: ${lifetime.totalComms} (${lifetime.inboundComms} inbound / ${lifetime.outboundComms} outbound).`,
    );
    parts.push(
      `Cadence baseline: ~${weeklyLifetime}/week lifetime average vs ~${weekly90d}/week over the last 90 days.` +
        (lifetime.longestGapDays !== null
          ? ` Longest historical gap between communications: ${plural(lifetime.longestGapDays, "day")} — gaps within that history are part of this client's normal rhythm.`
          : ""),
    );
  }

  if (trajectory.length > 0) {
    parts.push(`Long-run judgment trajectory (completed months, newest first — status at month end, avg risk score):`);
    for (const t of trajectory) {
      const risk = t.avgRisk !== null ? `avg risk ${t.avgRisk}` : "avg risk n/a";
      parts.push(`- ${t.month}: ${t.endStatus ?? "n/a"} (${risk}, ${plural(t.days, "judgment")})`);
    }
  }
  // Task #4761 — pre-calibration months are dropped from the trajectory;
  // say so explicitly instead of letting the model read a short (or empty)
  // history as a young relationship.
  if (trajectoryExcluded > 0) {
    parts.push(
      `NOTE: ${plural(trajectoryExcluded, "earlier completed month")} of judgment history ${
        trajectoryExcluded === 1 ? "is" : "are"
      } EXCLUDED as unreliable-era: those judgments came from a miscalibrated judge that systematically overstated severity. Do NOT anchor today's tier or risk on that era's statuses or scores.`,
    );
  }
  if (trajectory.length > 0 || trajectoryExcluded > 0) {
    parts.push(
      `A concern that has persisted across months at a stable status is a STANDING issue — acknowledge it as standing, do not re-escalate it as new. A standing issue with NO new negative client signal since it was last raised must DECAY: its weight shrinks as it ages unchanged — it must never hold risk at peak on its own.`,
    );
  }

  parts.push(...buildReportHistoryLines(reportHistory));

  parts.push("");
  return parts;
}

/**
 * Task #4761 — report-metric history lines, extracted pure so the evidence
 * corpus contains exactly what the model saw ("delivery_metric_decline"
 * citations quote these lines).
 */
export function buildReportHistoryLines(
  reportHistory: JudgmentSourceSignals["reportHistory"],
): string[] {
  if (reportHistory.length === 0) return [];
  const parts: string[] = [];
  parts.push(`Report-metric history (monthly leads / reviews; "n/a" = no data entered):`);
  for (const rh of reportHistory) {
    parts.push(`- ${rh.month}: leads ${rh.leads ?? "n/a"}, reviews ${rh.reviews ?? "n/a"}`);
  }
  return parts;
}

/**
 * Task #4292 — the operator-intel prompt section, pure for tests. Empty
 * when no intel exists (absence of intel is normal, not a data gap).
 */
export function buildOperatorIntelSection(recentIntel: ClientConcernIntel[]): string[] {
  if (recentIntel.length === 0) return [];
  const parts: string[] = [];
  parts.push(`=== OPERATOR INTEL (human-verified, last 90 days) ===`);
  parts.push(
    `The account team filed these responses to previously flagged concerns. This is ground truth from humans and OUTRANKS your own inference from older communications:`,
  );
  for (const entry of recentIntel) {
    const when = entry.createdAt ? entry.createdAt.toISOString().split("T")[0] : "unknown date";
    const label = entry.intelType === "resolved" ? "RESOLVED" : "CONTEXT";
    parts.push(`- [${label} ${when}] Concern: "${entry.concernText}" — Operator note: ${entry.note}`);
  }
  parts.push(`Hard rules:`);
  parts.push(
    `- A concern marked RESOLVED above must NOT appear in your "concerns" as unaddressed unless CLIENT evidence dated after the resolution contradicts it. Absent such evidence, omit it or reference it only as resolved history.`,
  );
  parts.push(
    `- CONTEXT notes must temper your framing: factor in what the team already knows and is already doing before flagging the same issue as neglected.`,
  );
  parts.push("");
  return parts;
}

/**
 * Task #4761 — prompt sections shared verbatim with the evidence corpus
 * (buildEvidenceCorpus): a churn-evidence citation may only quote text the
 * model actually saw, so the prompt and the corpus render these sections
 * through the same pure builders.
 */
export function buildStrategicContextSection(commandPanel: any): string[] {
  if (!commandPanel) return [];
  const parts: string[] = [];
  parts.push(`=== STRATEGIC CONTEXT (Command Panel) ===`);
  if (commandPanel.quarterPrimaryObjective) parts.push(`Current Quarter Objective: ${commandPanel.quarterPrimaryObjective}`);
  if (commandPanel.currentBottleneck) parts.push(`Current Bottleneck: ${commandPanel.currentBottleneck}`);
  if (commandPanel.budgetPosture) parts.push(`Budget Posture: ${commandPanel.budgetPosture}`);
  if (commandPanel.currentRiskFlags) parts.push(`Known Risk Flags: ${commandPanel.currentRiskFlags}`);
  if (commandPanel.currentOpportunities) parts.push(`Current Opportunities: ${commandPanel.currentOpportunities}`);
  if (commandPanel.clientPreferences) parts.push(`Client Preferences: ${commandPanel.clientPreferences}`);
  if (commandPanel.internalHandlingNotes) parts.push(`Internal Handling Notes: ${commandPanel.internalHandlingNotes}`);
  parts.push("");
  return parts;
}

export function buildRisEngagementSection(risEngagement: RisEngagementResult[]): string[] {
  if (risEngagement.length === 0) return [];
  const parts: string[] = [];
  parts.push(`=== RIS ENGAGEMENT CHECKS (latest internal engagement-tracking results) ===`);
  for (const r of risEngagement) {
    parts.push(`- [${r.status}] ${r.label} (${r.period})${r.notes ? ` — ${r.notes.substring(0, 200)}` : ""}`);
  }
  parts.push(`Treat these as relationship signals: repeated "fail"/"blocked" engagement checks (missed strategy calls, poor communication cadence, unused reports) indicate disengagement risk; "pass" indicates active engagement.`);
  parts.push("");
  return parts;
}

/**
 * Task #4761 — open asks render with honest staleness. Production grooming
 * of this table is effectively one-way (asks accumulate in meeting-burst
 * extractions; closure almost never fires — portfolio-wide, zero rows have
 * ever reached "resolved"), so an old row is NOT evidence the client has
 * been waiting: it is unconfirmed backlog. Internal promises are our own
 * commitments and are labeled as such.
 */
export const STALE_ASK_THRESHOLD_DAYS = 60;

export function buildOpenAsksSection(openAsks: ClientOpenAsk[], dateStr: string): string[] {
  if (openAsks.length === 0) return [];
  const endMs = new Date(dateStr + "T23:59:59.999Z").getTime();
  const parts: string[] = [];
  parts.push(`=== CURRENTLY OPEN ASKS (${openAsks.length} items) ===`);
  for (const ask of openAsks) {
    const lastRef = ask.lastReferencedAt ? new Date(ask.lastReferencedAt) : null;
    const ageDays =
      lastRef && !Number.isNaN(lastRef.getTime())
        ? Math.max(0, Math.floor((endMs - lastRef.getTime()) / (24 * 60 * 60 * 1000)))
        : null;
    const markers = [ask.status];
    if (ask.askType === "internal_promise") markers.push("internal promise");
    if (ageDays !== null && ageDays >= STALE_ASK_THRESHOLD_DAYS) markers.push("STALE");
    // Task #4765 — stable ID rendered so openAskUpdates can reference asks
    // by `askId` instead of the retired 30-char text-prefix matching.
    parts.push(`- [id:${ask.id}] [${markers.join(" | ")}] ${ask.askText} (concern score: ${ask.concernScore || 1}, category: ${ask.askCategory || "unknown"})`);
    if (lastRef && ageDays !== null) {
      parts.push(`  Last referenced: ${lastRef.toISOString().split("T")[0]} (${plural(ageDays, "day")} ago)`);
    }
  }
  parts.push(`Ask-evidence rules (hard rules):`);
  parts.push(
    `- STALE items (no reference in ${STALE_ASK_THRESHOLD_DAYS}+ days) are unconfirmed backlog — the tracker rarely closes items, so many were already handled or abandoned. Treat them as backlog context, never as fresh evidence of neglect, and never count their age as "the client has been waiting".`,
  );
  parts.push(`- "internal promise" items are commitments WE made — agency to-do material, never client churn signals.`);
  parts.push(`- "Repeated unresolved ask" evidence requires the CLIENT re-referencing the ask in recent communications; the existence of rows above is not that evidence.`);
  parts.push("");
  return parts;
}

function buildJudgmentPrompt(
  client: Client,
  last24hComms: CommWithPerClientSummary[],
  windowComms: CommWithPerClientSummary[],
  priorJudgments: ClientDailyJudgment[],
  openAsks: ClientOpenAsk[],
  reportData: any,
  commandPanel: any,
  dateStr: string,
  knowledgeContext: string | undefined,
  inventory: JudgmentDataInventory,
  risEngagement: RisEngagementResult[],
  recentIntel: ClientConcernIntel[] = [],
): string {
  const parts: string[] = [];

  parts.push(`=== DAILY JUDGMENT REQUEST ===`);
  parts.push(`Client: ${client.firmName}`);
  parts.push(`Date: ${dateStr}`);
  parts.push(`Client Code: ${client.clientCode || "N/A"}`);
  parts.push(`Products: ${(commandPanel?.productTypes || client.products || []).join(", ") || "N/A"}`);
  parts.push(`Practice Areas: ${(client.practiceAreas || []).join(", ") || "N/A"}`);
  if (client.contactName) parts.push(`Primary Contact: ${client.contactName}`);
  parts.push("");

  parts.push(buildDataAvailabilityManifest(inventory));
  parts.push("");

  parts.push(...buildLifetimeContextSection(inventory.sources, dateStr));
  parts.push(...buildOperatorIntelSection(recentIntel));

  parts.push(...buildStrategicContextSection(commandPanel));

  if (knowledgeContext) {
    parts.push(knowledgeContext);
  }

  parts.push(...buildRisEngagementSection(risEngagement));

  parts.push(...buildJudgmentCommSections(last24hComms, windowComms, !!knowledgeContext));

  if (priorJudgments.length > 0) {
    parts.push(`=== PRIOR DAILY JUDGMENTS (last ${priorJudgments.length} days) ===`);
    parts.push(
      `NOTE: prior judgments may carry metric claims produced under older prompts. Where the LATEST REPORT DATA section below marks a metric "no data" or "not tracked for this client", treat any prior claim about that metric (e.g. "0 leads", "zero consults", "poor conversion") as unsupported legacy narrative — do not restate it, do not count it as a standing concern, and do not keep asking for visibility into it. This applies equally to such claims appearing in the agent-memory section above.`,
    );
    for (const pj of priorJudgments) {
      // Task #4761 — flag pre-calibration-era judgments inline so their
      // severity language can't quietly anchor today's proposal.
      const pjRevision = (pj.dataSourcesSummary as any)?.promptRevision;
      const eraNote =
        pjRevision === FINGERPRINT_REVISION ? "" : " [pre-calibration era — severity unreliable, do not anchor on it]";
      parts.push(`--- ${pj.judgmentDate}${eraNote} ---`);
      parts.push(`Status: ${pj.overallStatus} | Relationship: ${pj.relationshipStatus} | Confidence: ${pj.confidenceLevel}`);
      parts.push(`Summary: ${(pj.summaryText || "").substring(0, 300)}`);
      if (pj.concernsJson && Array.isArray(pj.concernsJson) && (pj.concernsJson as string[]).length > 0) {
        parts.push(`Concerns: ${(pj.concernsJson as string[]).join("; ")}`);
      }
      if (pj.unresolvedAsksJson && Array.isArray(pj.unresolvedAsksJson) && (pj.unresolvedAsksJson as string[]).length > 0) {
        parts.push(`Unresolved: ${(pj.unresolvedAsksJson as string[]).join("; ")}`);
      }
      parts.push("");
    }
  }

  parts.push(...buildOpenAsksSection(openAsks, dateStr));

  parts.push(...buildLatestReportSection(reportData, inventory.sources.metricTracking));

  parts.push(`Generate a daily account judgment for ${client.firmName} for ${dateStr}.`);
  parts.push(`Remember: judgment, not summary. Be direct, measured, and evidence-grounded — apply the STATUS TIER DEFINITIONS and SILENCE CALIBRATION exactly, and judge this client against their own lifetime baseline.`);
  parts.push(`IMPORTANT: Only generate asks, concerns, and observations that are specifically relevant to ${client.firmName}. Do NOT include asks or issues that belong to other clients, even if they appear in multi-client meeting summaries. If a communication mentions other firms, ignore those references entirely.`);

  return parts.join("\n");
}

/**
 * Directly client-authored communication content from the model-visible
 * full-detail band. Transport direction and subject are never enough:
 * Front senders must match the client's exact contact or trusted domain,
 * Twilio rows must carry the existing phone-lookup match, and forwarded,
 * quoted, automated, third-party, internal, generated, and unknown text is
 * excluded. Compact/digest bands carry no raw Content line, so they cannot
 * produce client-authored fragments.
 */
export function extractClientAuthoredCommContent(
  last24hComms: CommWithPerClientSummary[],
  windowComms: CommWithPerClientSummary[],
  hasKnowledgeContext: boolean,
  client: Pick<Client, "contactEmail" | "emailDomains" | "contactPhone"> = {
    contactEmail: null,
    emailDomains: [],
    contactPhone: null,
  },
): string[] {
  const maxRecentComms = hasKnowledgeContext ? 10 : 20;
  void windowComms;
  return last24hComms
    .slice(0, maxRecentComms)
    .flatMap(comm =>
      buildCommunicationEvidenceFragments(comm, client, {
        includeContent: true,
        includeGenerated: false,
        digestTitle: false,
      }),
    )
    .filter(fragment => fragment.provenance === "client_authored" && fragment.field === "content")
    .map(fragment => fragment.text);
}

/**
 * Task #4761 — the evidence corpus a churn-evidence citation must quote
 * from, rendered by the SAME pure builders the prompt uses, so the corpus
 * is exactly what the model saw. Deliberately EXCLUDED: prior judgments,
 * agent-memory knowledge context, and the lifetime/trajectory narrative —
 * quoting an earlier AI output would launder a hallucination into
 * "evidence".
 *
 * Every model-visible field is represented as one atomic typed fragment.
 * This preserves actual author/provenance rather than collapsing the prompt
 * into "client" and "internal" blobs. The audit persists only fragment
 * metadata and the bounded model quote, never these full fragment bodies.
 */
export function buildEvidenceCorpus(args: {
  client: Pick<Client, "contactEmail" | "emailDomains" | "contactPhone">;
  last24hComms: CommWithPerClientSummary[];
  windowComms: CommWithPerClientSummary[];
  openAsks: ClientOpenAsk[];
  reportData: any;
  commandPanel: any;
  risEngagement: RisEngagementResult[];
  recentIntel: ClientConcernIntel[];
  reportHistory: JudgmentSourceSignals["reportHistory"];
  dateStr: string;
  hasKnowledgeContext: boolean;
  /** Task #4846 — must match the prompt's tracking so citations of the section still validate. */
  metricTracking?: JudgmentSourceSignals["metricTracking"];
}): EvidenceCorpus {
  const fragments: EvidenceFragment[] = [];
  const maxRecentComms = args.hasKnowledgeContext ? 10 : 20;
  const maxOlderComms = args.hasKnowledgeContext ? 8 : 15;
  const addComm = (
    comm: CommWithPerClientSummary,
    options: { includeContent: boolean; includeGenerated: boolean; digestTitle: boolean },
  ) => fragments.push(...buildCommunicationEvidenceFragments(comm, args.client, options));

  for (const comm of args.last24hComms.slice(0, maxRecentComms)) {
    addComm(comm, { includeContent: true, includeGenerated: true, digestTitle: false });
  }
  for (const comm of args.last24hComms.slice(maxRecentComms)) {
    addComm(comm, { includeContent: false, includeGenerated: false, digestTitle: true });
  }
  const olderComms = args.windowComms.filter(
    comm => !args.last24hComms.some(recent => recent.id === comm.id),
  );
  for (const comm of olderComms.slice(0, maxOlderComms)) {
    addComm(comm, { includeContent: false, includeGenerated: true, digestTitle: false });
  }
  for (const comm of olderComms.slice(maxOlderComms)) {
    addComm(comm, { includeContent: false, includeGenerated: false, digestTitle: true });
  }

  const addLines = (
    sourceType: string,
    provenance: EvidenceProvenance,
    lines: string[],
    options: {
      sourceIds?: Array<string | null | undefined>;
      metricState?: (line: string) => "tracked" | "untracked" | "unknown";
    } = {},
  ) => {
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      fragments.push({
        id: `${sourceType}:${options.sourceIds?.[index] ?? index}`,
        text: line,
        provenance,
        sourceType,
        sourceId: options.sourceIds?.[index] ?? null,
        field: "rendered_line",
        occurredAt: null,
        metricState: options.metricState?.(line),
      });
    }
  };

  const operatorLines = buildOperatorIntelSection(args.recentIntel);
  addLines("operator_intel", "operator_intel", operatorLines, {
    sourceIds: operatorLines.map((line, index) => {
      if (!line.startsWith("- [")) return null;
      const priorEntries = operatorLines.slice(0, index).filter(candidate => candidate.startsWith("- [")).length;
      return args.recentIntel[priorEntries]?.id ?? null;
    }),
  });
  const openAskLines = buildOpenAsksSection(args.openAsks, args.dateStr);
  addLines("open_ask", "open_ask", openAskLines, {
    sourceIds: openAskLines.map(line => /\[id:([^\]]+)\]/.exec(line)?.[1] ?? null),
  });
  addLines("strategic_context", "internal_context", buildStrategicContextSection(args.commandPanel));
  addLines("ris", "internal_operational", buildRisEngagementSection(args.risEngagement));

  const metricState = (line: string): "tracked" | "untracked" | "unknown" => {
    const normalized = line.toLowerCase();
    if (normalized.includes("not tracked for this client") || normalized.includes("not measured")) return "untracked";
    if (normalized.includes("no data") || normalized.includes("n/a")) return "unknown";
    return "tracked";
  };
  const latestReportLines = buildLatestReportSection(args.reportData, args.metricTracking);
  for (const [index, line] of latestReportLines.entries()) {
    if (!line.trim()) continue;
    const isMetricLine = /^(Intake|Sales|Lead volume \(marketing\)|Review Generation|Google Ads):/.test(line);
    fragments.push({
      id: `report_data:${args.reportData?.reportId ?? "unknown"}:${index}`,
      text: line,
      provenance: isMetricLine ? "objective_report_metric" : "internal_context",
      sourceType: "report_data",
      sourceId: args.reportData?.reportId ?? null,
      field: isMetricLine ? "metric_line" : "rendered_line",
      occurredAt: args.reportData?.updatedAt
        ? new Date(args.reportData.updatedAt).toISOString()
        : null,
      metricState: isMetricLine ? metricState(line) : undefined,
    });
  }
  const historyLines = buildReportHistoryLines(args.reportHistory);
  for (const [index, line] of historyLines.entries()) {
    if (!line.trim()) continue;
    const isMetricLine = line.startsWith("- ");
    fragments.push({
      id: `report_history:${index}`,
      text: line,
      provenance: isMetricLine ? "objective_report_metric" : "internal_context",
      sourceType: "report_history",
      sourceId: isMetricLine ? line.slice(2, 9) : null,
      field: isMetricLine ? "metric_line" : "rendered_line",
      occurredAt: null,
      metricState: isMetricLine ? metricState(line) : undefined,
    });
  }

  return { fragments };
}

/**
 * Task #4048 — the prompt's communication sections, extracted pure for
 * tests. EVERY communication in the analyzed window is represented: the
 * newest get full detail, the next tier compact detail, and the remainder a
 * one-line digest each — never a "…and N additional (summarized elsewhere)"
 * line that claims coverage the prompt does not contain. This is what makes
 * the persisted `communicationsAnalyzed` (the full retrieved window) an
 * honest number.
 */
export function buildJudgmentCommSections(
  last24hComms: CommWithPerClientSummary[],
  windowComms: CommWithPerClientSummary[],
  hasKnowledgeContext: boolean,
): string[] {
  const parts: string[] = [];
  const maxRecentComms = hasKnowledgeContext ? 10 : 20;
  const maxOlderComms = hasKnowledgeContext ? 8 : 15;

  parts.push(`=== LAST 24 HOURS COMMUNICATIONS (${last24hComms.length} records) ===`);
  if (last24hComms.length === 0) {
    parts.push("No communications in the last 24 hours.");
  } else {
    for (const comm of last24hComms.slice(0, maxRecentComms)) {
      parts.push(formatCommunication(comm));
    }
    const rest24h = last24hComms.slice(maxRecentComms);
    if (rest24h.length > 0) {
      parts.push(`Remaining ${rest24h.length} last-24h communication(s), one line each:`);
      for (const comm of rest24h) parts.push(formatCommunicationDigest(comm));
    }
  }
  parts.push("");

  const olderComms = windowComms.filter(c => !last24hComms.some(h => h.id === c.id));
  if (olderComms.length > 0) {
    parts.push(`=== EARLIER IN THE ANALYZED WINDOW — LAST 30 DAYS (${olderComms.length} additional records) ===`);
    for (const comm of olderComms.slice(0, maxOlderComms)) {
      parts.push(formatCommunication(comm, true));
    }
    const restOlder = olderComms.slice(maxOlderComms);
    if (restOlder.length > 0) {
      parts.push(`Remaining ${restOlder.length} earlier communication(s) in the window, one line each:`);
      for (const comm of restOlder) parts.push(formatCommunicationDigest(comm));
    }
    parts.push("");
  }

  if (windowComms.length > 0) {
    parts.push(
      `All ${windowComms.length} communication(s) in the analyzed 30-day window are represented above (full detail, compact, or one-line digest) — nothing was omitted.`,
    );
    parts.push("");
  }

  return parts;
}

/** One-line digest for window comms beyond the full/compact budgets. */
export function formatCommunicationDigest(comm: CommWithPerClientSummary): string {
  const date = new Date(comm.timestamp).toISOString().split("T")[0];
  const src = `${comm.sourceType}${comm.sourceSubtype ? `/${comm.sourceSubtype}` : ""}`;
  const dir = comm.direction ? ` ${comm.direction}` : "";
  const title = (comm.title || "(untitled)").substring(0, 90);
  const flags = comm.isMultiClient ? " [multi-client]" : "";
  return `- [${src}]${dir} ${date} — ${title}${flags}`;
}

/**
 * Task #4048 — the LATEST REPORT DATA prompt block, rebuilt on the shared
 * metric-presence helpers (shared/reportMetrics.ts, Task #3688) so metrics
 * that were never entered or are explicitly No-Data-flagged reach the model
 * as explicit "no data — not evidence" lines instead of fabricated zeros.
 * The old block coerced absent values with `|| 0` ("Intake: 0 leads, 0
 * consults"), rendered NaN% for absent rates, and multiplied stored 0-100
 * percents by 100 again. Mirrors PublicReport's presence gates exactly:
 * consult metrics gate on the totalConsults flag, case metrics on the
 * totalCases flag, no-show rate is observational (entered 0 is real,
 * legacy blank-coerced 0 is not), and lead volume requires lead-volume
 * evidence in the marketing section. Exported pure for tests.
 */
export function buildLatestReportSection(
  reportData: any,
  metricTracking?: { consults: MetricTrackingState; cases: MetricTrackingState } | null,
): string[] {
  if (!reportData) return [];
  const parts: string[] = [];
  const intake = reportData.sections?.intake;
  const sales = reportData.sections?.sales;
  const marketing = reportData.sections?.marketing;

  const NO_DATA = "no data (not entered for this month — treat as unknown, NOT as zero)";
  // Task #4846 — a family the client has NEVER entered in any report month
  // is structurally untracked: rendering it as a month-scoped lapse invited
  // the model to treat every month as a fresh "still no visibility" concern.
  const NOT_TRACKED =
    "not tracked for this client (never entered in any report month) — structurally unavailable: treat as NOT MEASURED, never as zero, never a concern, never an unresolved question";
  const neverTracked = (family: "consults" | "cases"): boolean =>
    metricTracking?.[family] === "never_entered";
  const missing = (family: "consults" | "cases"): string =>
    neverTracked(family) ? NOT_TRACKED : NO_DATA;
  const pct = (v: number) => `${v.toFixed(1)}%`;
  const toNum = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : (v as number);
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };

  parts.push(`=== LATEST REPORT DATA (${reportData.reportMonth}) ===`);
  parts.push(
    `Data-presence rules: "no data" below means the metric was not entered (or was explicitly marked No Data) for this month — treat it as UNKNOWN, never as zero and never as evidence of a problem. "Not tracked for this client" means the metric has NEVER been entered in any report month — it is structurally unmeasured for this client, so its absence is normal, carries no signal, and must not appear as a concern, a conversion problem, or a visibility gap. This section is the current ground truth for report metrics and SUPERSEDES any metric claims in prior judgments or agent memory above; do not repeat a prior metric claim (e.g. "0 leads", "0% conversion", "zero consults") that this section does not support.`,
  );
  if (neverTracked("consults") || neverTracked("cases")) {
    const families = [
      neverTracked("consults") ? "consult/intake metrics" : null,
      neverTracked("cases") ? "case/sales metrics" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    parts.push(
      `Metric-tracking status (hard rule): ${families} are NOT TRACKED for this client — never entered in any report month. Do not describe them as zero, declining, a conversion failure, or a visibility gap, and do not raise their absence as a concern or unresolved question.`,
    );
  }

  if (intake) {
    const flags = (intake.noDataFlags ?? {}) as Record<string, boolean | undefined>;
    const consults = enteredMetricOrNull(intake.totalConsults, flags.totalConsults);
    const rate = enteredMetricOrNull(intake.leadToConsultRate, flags.totalConsults);
    parts.push(
      `Intake: consults booked: ${consults ?? missing("consults")}; lead->consult conversion: ${rate !== null ? pct(rate) : missing("consults")}`,
    );
  } else if (neverTracked("consults")) {
    parts.push(`Intake: ${NOT_TRACKED}`);
  }
  if (sales) {
    const flags = (sales.noDataFlags ?? {}) as Record<string, boolean | undefined>;
    const consults = enteredMetricOrNull(sales.totalConsults, flags.totalConsults);
    const cases = enteredMetricOrNull(sales.totalCases, flags.totalCases);
    const closeRate = enteredMetricOrNull(sales.consultToCaseRate, flags.totalCases);
    // Observational metric: an ENTERED 0 is a real measurement, but legacy
    // sections (no noDataFlags key) coerced blanks to 0 on save. Same
    // clamping as the report page's supporting-metric card. Stays NO_DATA
    // (never NOT_TRACKED): it is advisory, not a family-defining metric.
    const noShow = displayedSupportingMetric(sales.noShowRate, flags.noShowRate, sectionHasEntryTracking(sales), { clampAsPercent: true });
    parts.push(
      `Sales: consults held: ${consults ?? missing("consults")}; cases signed: ${cases ?? missing("cases")}; consult->case close rate: ${closeRate !== null ? pct(closeRate) : missing("cases")}; no-show rate: ${noShow !== null ? pct(noShow) : NO_DATA}`,
    );
  } else if (neverTracked("cases")) {
    parts.push(`Sales: ${NOT_TRACKED}`);
  }
  if (marketing) {
    // Same rule as the leaderboard's Leads metric (server/routes/churn.ts
    // readMonthMetrics): a total is only claimable when the month has ANY
    // entered lead-volume evidence; otherwise it is no-data, never 0.
    const totalLeads = hasLeadVolumeEvidence(marketing) ? Number(marketing.totalLeads) || 0 : null;
    parts.push(`Lead volume (marketing): ${totalLeads !== null ? `${totalLeads} total leads` : NO_DATA}`);

    const gbpLocations: any[] | null = Array.isArray(marketing.gbp?.locations)
      ? marketing.gbp.locations
      : Array.isArray(marketing.gbpLocations)
        ? marketing.gbpLocations
        : null;
    if (gbpLocations && gbpLocations.length > 0) {
      const bucketVals = (lq: any): unknown[] =>
        lq && typeof lq === "object" ? [lq.good, lq.notQuotable, lq.missedCalls, lq.noData] : [];
      const hasGbpEvidence = gbpLocations.some(loc =>
        [loc?.uniqueLeads, ...bucketVals(loc?.leadQuality)].some(v => (toNum(v) ?? 0) > 0),
      );
      if (hasGbpEvidence) {
        const gbpLeads = gbpLocations.reduce((sum, l) => sum + (toNum(l?.uniqueLeads) ?? 0), 0);
        parts.push(`GBP: ${gbpLeads} leads across ${gbpLocations.length} location(s)`);
      } else {
        parts.push(`GBP: no lead data recorded for ${gbpLocations.length} location(s) this month (treat as unknown, NOT as zero)`);
      }
    }

    if (marketing.googleAds && marketing.googleAdsEnabled) {
      const ga = marketing.googleAds;
      const leads = toNum(ga.uniqueLeads);
      const spend = toNum(ga.adSpend);
      const cpl = toNum(ga.costPerLead);
      const allZero = (leads ?? 0) === 0 && (spend ?? 0) === 0 && (cpl ?? 0) === 0;
      if (allZero) {
        parts.push(`Google Ads: enabled, but no metrics entered this month (treat as unknown, NOT as zero)`);
      } else {
        parts.push(
          `Google Ads: ${leads !== null ? `${leads} leads` : "leads: no data"}, ${spend !== null ? `$${spend} spend` : "spend: no data"}, ${cpl !== null ? `$${cpl} CPL` : "CPL: no data"}`,
        );
      }
    }
  }
  parts.push("");
  return parts;
}

function formatCommunication(comm: CommWithPerClientSummary, compact = false): string {
  const parts: string[] = [];
  const date = new Date(comm.timestamp).toISOString().split("T");
  const dateStr = `${date[0]} ${date[1]?.substring(0, 5) || ""}`;

  parts.push(`[${comm.sourceType}${comm.sourceSubtype ? `/${comm.sourceSubtype}` : ""}] ${dateStr} — ${comm.title}`);

  if (comm.direction) parts.push(`  Direction: ${comm.direction}`);

  if (comm.participantsJson) {
    const participants = Array.isArray(comm.participantsJson) ? comm.participantsJson : [];
    if (participants.length > 0) {
      parts.push(`  Participants: ${participants.map((p: any) => p.name || p.email || String(p)).join(", ")}`);
    }
  }

  if (comm.perClientSummary) {
    parts.push(`  ${INTERNAL_AI_INTERPRETATION_LABEL} — AI Summary: ${comm.perClientSummary}`);
  } else if (comm.isMultiClient) {
    parts.push(`  ${INTERNAL_AI_INTERPRETATION_LABEL} — AI Summary: [Multi-client meeting — per-client details unavailable. Only reference this communication for scheduling/attendance context.]`);
  } else if (comm.aiSummary) {
    parts.push(`  ${INTERNAL_AI_INTERPRETATION_LABEL} — AI Summary: ${comm.aiSummary}`);
  }

  if (comm.aiSignals && Array.isArray(comm.aiSignals)) {
    const signals = (comm.aiSignals as any[]).filter(s => s.relevance === "high" || s.relevance === "medium");
    if (signals.length > 0) {
      parts.push(`  ${INTERNAL_AI_INTERPRETATION_LABEL} — Key Signals: ${signals.map(s => `${s.type}: ${s.description}`).join("; ")}`);
    }
  }

  if (!compact && comm.contentPreview) {
    const preview = comm.contentPreview.substring(0, 500);
    parts.push(`  Content: ${preview}`);
  }

  return parts.join("\n");
}

export interface DailyJudgmentCronOptions {
  /** Restrict the sweep to specific client ids (used by tests/targeted runs). */
  onlyClientIds?: string[];
  /** Pause between real AI generations; carried-forward clients never sleep. */
  interJudgmentSleepMs?: number;
}

export async function runDailyJudgmentCron(
  opts: DailyJudgmentCronOptions = {},
): Promise<{ processed: number; carriedForward: number; errors: number; skipped: number }> {
  console.log("[DailyJudgment] Starting daily judgment generation...");
  let activeClients = await storage.getActiveClients();
  if (opts.onlyClientIds) {
    const only = new Set(opts.onlyClientIds);
    activeClients = activeClients.filter(c => only.has(c.id));
  }
  const dateStr = new Date().toISOString().split("T")[0];
  const sleepMs = opts.interJudgmentSleepMs ?? 2000;

  let processed = 0;
  let carriedForward = 0;
  let errors = 0;
  let skipped = 0;

  // Task #3693 — collect each freshly generated judgment so risk-shift
  // alerts can compare against the previous judgment and fan out ONCE at
  // the end of the run (bundling mass degradations instead of alerting per
  // client). Carried-forward judgments are unchanged by construction
  // (same inputs fingerprint), so they cannot produce a transition and are
  // not recorded; skipped clients persist nothing to compare.
  const riskShiftRun = beginClientRiskShiftRun();

  for (const client of activeClients) {
    try {
      const result = await generateDailyJudgmentDetailed(client.id, { targetDate: dateStr });
      if (result.outcome === "carried_forward") {
        carriedForward++;
        continue;
      }
      processed++;
      await recordJudgmentForRiskShift(riskShiftRun, client, result.judgment);

      if (processed + carriedForward + skipped + errors < activeClients.length) {
        await new Promise(resolve => setTimeout(resolve, sleepMs));
      }
    } catch (err: any) {
      if (err instanceof JudgmentSkippedError) {
        skipped++;
        console.log(`[DailyJudgment] Skipped ${client.firmName} (${client.id}): no usable data sources`);
        continue;
      }
      errors++;
      console.error(`[DailyJudgment] Failed for ${client.firmName} (${client.id}):`, err.message);
    }
  }

  const riskShiftSummary = await dispatchClientRiskShiftAlerts(riskShiftRun);
  console.log(
    `[DailyJudgment] Risk-shift alerts: evaluated=${riskShiftSummary.evaluated} degraded=${riskShiftSummary.degraded} ` +
    `recovered=${riskShiftSummary.recovered} alertsSent=${riskShiftSummary.alertsSent} bundled=${riskShiftSummary.bundled}` +
    (riskShiftSummary.skipped ? ` skipped=${riskShiftSummary.skipped}` : ""),
  );

  console.log(
    `[DailyJudgment] Complete. Generated: ${processed}, Carried forward: ${carriedForward}, Skipped (no usable data): ${skipped}, Errors: ${errors}, Total clients: ${activeClients.length}`,
  );
  return { processed, carriedForward, errors, skipped };
}
