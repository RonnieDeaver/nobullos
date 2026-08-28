// Task #4761 — deterministic, evidence-gated judgment tiers.
//
// The daily-judgment model CLASSIFIES churn evidence (fixed vocabulary +
// verbatim citations); THIS module owns the stored tier. Task #4292 shipped
// the calibrated rubric as prompt text only, and the board stayed ~74%
// Critical: prompt guidance cannot bind a model output. The gate makes the
// rubric mechanical:
//
//   - Critical requires at least one VALIDATED Critical-qualifying evidence
//     item (explicit churn/cancel/termination language, competitor switch,
//     billing/legal escalation, or a strongly corroborated loss signal).
//   - At-Risk-qualifying evidence, baseline-relative silence, or declining
//     delivery metrics cap the tier at "At Risk".
//   - Internal hygiene/process gaps (agency to-do items) cap at "Watch" —
//     they are never client churn evidence.
//   - No validated negative evidence + stable delivery + cadence within the
//     client's own baseline on a full-tier basis lands "Healthy", so the
//     board differentiates instead of showing one red wall.
//
// Citations are validated against an evidence corpus assembled from the
// same prompt sections the model actually saw (client comms, operator
// intel, open asks, command panel, RIS results, report metrics — NEVER
// prior judgments or agent-memory context, which would let an old
// hallucination launder itself into "evidence"). A paraphrased or invented
// quote is rejected and its category treated as absent.
//
// PROVENANCE IS ENFORCED, not just existence: the corpus is split into a
// client-communications scope and an internal-context scope, and the
// category the gate ACTS on is derived deterministically:
//   - Agency write-off vocabulary ("effectively churned", "should
//     offboard", …) is forcibly internal_hygiene_gap wherever it appears —
//     our own characterizations are never client churn evidence.
//   - A Critical-qualifying category quoted only from internal context
//     (operator intel, open asks, command panel, report data) is downgraded
//     to expressed_dissatisfaction: it keeps At-Risk monitoring weight, but
//     only client-originated communication evidence can unlock Critical.
//   - corroborated_loss_signal must actually be corroborated: at least two
//     DISTINCT validated client-communication citations, or each lone
//     signal is downgraded to expressed_dissatisfaction.
// Every downgrade is recorded on the item (reclassifiedFrom/reclassReason)
// so the audit shows the model's claim and the rule that corrected it.
//
// Pure leaf module: no DB or service imports — unit-testable with pinned
// fixtures from real prod basis rows.

import { createHash } from "node:crypto";
import {
  accountHealthContract,
  isAccountHealthStatus,
  isRelationshipRead,
  relationshipReadContract,
  type AccountHealthStatus,
  type AccountRatingDriver,
  type AccountRatingPresentation,
  type RatingDriverFreshness,
  type RatingDriverProvenance,
  type RatingDriverSeverity,
} from "@shared/clientRating";

export type JudgmentGateStatus = AccountHealthStatus;
export type DeliveryStability = "stable" | "declining" | "unknown";

/**
 * Stamped into every fresh inventory (`tierGateVersion`). Its PRESENCE on a
 * judgment row marks the row as generated under the deterministic gate era —
 * the trajectory query uses that to exclude pre-calibration months without
 * maintaining a list of calibrated prompt revisions.
 *
 * v2: provenance-scoped citations (client-communication vs internal
 * context), forced reclassification of agency write-off language and
 * internal-sourced Critical claims, and a two-distinct-citations
 * corroboration floor for corroborated_loss_signal.
 *
 * v3 (Task #4766): delivery stability may fall back to MEASURED monthly
 * lead totals (live_data_snapshots, post-close only) when entered reports
 * cannot ground a verdict, and the audit names the evidence source
 * (`deliveryStabilitySource`) so measured data is never mistaken for
 * entered data.
 *
 * v4: citations resolve to atomic, typed provenance fragments rather than
 * broad client/internal text buckets. Category eligibility is server-owned:
 * client-risk language must be directly client-authored, repeated asks must
 * be recent and explicitly repeated, delivery decline must agree with
 * measured server facts, and Critical categories must contain qualifying
 * language (with independent corroboration for loss signals).
 *
 * v5: status, relationship read, and risk are all derived from accepted
 * evidence and deterministic delivery/cadence facts. Model status, relationship,
 * and overall-risk values remain proposal-only audit fields.
 *
 * v6: accepted evidence is deduplicated by the persisted independence
 * contract before rating and explanation assembly. Distinct atomic fragment
 * identities remain independent; legacy items without fragment metadata fall
 * back to their normalized quote fingerprint.
 *
 * v7: current, clearly positive operator intel is persisted as authoritative
 * supporting evidence and can temper a contradicted silence-only escalation.
 * It never overrides current client-risk evidence or objective delivery decline.
 */
export const TIER_GATE_VERSION = 7;

/** Evidence that permits a Critical tier when validated. */
export const CRITICAL_EVIDENCE_CATEGORIES = [
  "explicit_churn_language",
  "competitor_switch",
  "billing_or_legal_escalation",
  "corroborated_loss_signal",
] as const;

/** Evidence that permits an At Risk tier (but never Critical) when validated. */
export const AT_RISK_EVIDENCE_CATEGORIES = [
  "expressed_dissatisfaction",
  "repeated_unresolved_ask",
  "service_failure",
  "delivery_metric_decline",
] as const;

/** Negative-but-soft evidence: worth monitoring, ceiling stays Watch. */
export const WATCH_EVIDENCE_CATEGORIES = [
  "internal_hygiene_gap",
  "other_negative",
] as const;

export type JudgmentEvidenceCategory =
  | (typeof CRITICAL_EVIDENCE_CATEGORIES)[number]
  | (typeof AT_RISK_EVIDENCE_CATEGORIES)[number]
  | (typeof WATCH_EVIDENCE_CATEGORIES)[number];

const CRITICAL_SET: ReadonlySet<string> = new Set(CRITICAL_EVIDENCE_CATEGORIES);
const AT_RISK_SET: ReadonlySet<string> = new Set(AT_RISK_EVIDENCE_CATEGORIES);
const ALL_CATEGORIES: ReadonlySet<string> = new Set([
  ...CRITICAL_EVIDENCE_CATEGORIES,
  ...AT_RISK_EVIDENCE_CATEGORIES,
  ...WATCH_EVIDENCE_CATEGORIES,
]);

export function isKnownEvidenceCategory(value: string): value is JudgmentEvidenceCategory {
  return ALL_CATEGORIES.has(value);
}

/**
 * Non-overlapping risk-score bands per tier. Stored risk is server-calculated
 * from accepted, independent drivers; the model's raw number is audit-only.
 */
export const TIER_RISK_BANDS: Record<JudgmentGateStatus, readonly [number, number]> =
  Object.fromEntries(
    Object.entries(accountHealthContract).map(([status, contract]) => [
      status,
      contract.riskRange,
    ]),
  ) as Record<JudgmentGateStatus, readonly [number, number]>;

export function clampRiskToTier(risk: number | null, status: JudgmentGateStatus): number | null {
  if (risk === null) return null; // ungrounded stays ungrounded — never invent a number
  const [lo, hi] = TIER_RISK_BANDS[status];
  return Math.min(hi, Math.max(lo, Math.round(risk)));
}

// ---------------------------------------------------------------------------
// Citation validation
// ---------------------------------------------------------------------------

/** Hard cap on evidence items considered per judgment (storage + prompt bound). */
export const MAX_EVIDENCE_ITEMS = 20;
/** Audit stores a fingerprint and shape, never the quoted communication text. */
const REDACTED_QUOTE_LABEL = "[citation redacted]";

// Minimum substance for a citation to count. Critical-qualifying categories
// need a longer verbatim run — a two-word fragment like "cancel it" matching
// some unrelated sentence must not unlock the Critical ceiling.
export const MIN_QUOTE_CHARS = 12;
export const MIN_QUOTE_WORDS = 2;
export const MIN_CRITICAL_QUOTE_CHARS = 15;
export const MIN_CRITICAL_QUOTE_WORDS = 3;

/**
 * Normalization applied to BOTH the corpus and each quote before the
 * substring check: models routinely swap curly quotes/dashes for ASCII and
 * collapse whitespace when copying "verbatim" text; those transforms must
 * not reject an otherwise-genuine citation.
 */
export function normalizeForCitationMatch(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type EvidenceRejectReason =
  | "invalid_category"
  | "missing_quote"
  | "quote_too_short"
  | "not_found_in_inputs"
  | "untracked_metric";

/** Which corpus scope the validated quote was actually found in. */
export type EvidenceSourceScope = "client_communication" | "internal_context";

export type EvidenceReclassReason =
  | "agency_writeoff_language"
  | "critical_requires_direct_client_language"
  | "client_risk_requires_direct_client_language"
  | "category_semantics_not_met"
  | "repeated_ask_not_recent"
  | "repeated_ask_not_repeated"
  | "delivery_decline_requires_objective_metrics"
  | "delivery_decline_not_measured"
  | "uncorroborated_independent_signals";

export type EvidenceProvenance =
  | "client_authored"
  | "client_forwarded"
  | "automated"
  | "third_party"
  | "internal_staff"
  | "ai_generated"
  | "operator_intel"
  | "open_ask"
  | "objective_report_metric"
  | "internal_operational"
  | "internal_context"
  | "communication_subject"
  | "unknown";

export type EvidenceMetricState = "tracked" | "untracked" | "unknown";

/**
 * One model-visible field or authored segment. The text is used only during
 * validation; the persisted audit stores the bounded quote plus the metadata
 * below, never the full fragment body.
 */
export interface EvidenceFragment {
  id: string;
  text: string;
  provenance: EvidenceProvenance;
  sourceType: string;
  sourceId?: string | null;
  field: string;
  occurredAt?: string | null;
  authorAttribution?: string | null;
  metricState?: EvidenceMetricState;
  /**
   * Identity of the underlying authored fact/message. This may intentionally
   * be shared by a Front thread preview and its materialized message row so
   * duplicate storage representations never count as independent evidence.
   */
  independenceKey?: string | null;
}

/**
 * Atomic model-visible fragments with explicit provenance. A citation must
 * match within ONE fragment, never across joined fields/records. This keeps
 * transport direction, actual author, forwarded/automated text, generated
 * summaries, operator notes, asks, and objective metrics distinguishable.
 */
export interface EvidenceCorpus {
  fragments: EvidenceFragment[];
}

export interface EvidenceEligibilityContext {
  judgmentDate: string;
  deliveryStability: DeliveryStability;
  deliveryStabilitySource: DeliveryStabilitySource;
}

/**
 * Agency write-off vocabulary (normalized): OUR internal characterizations
 * of an account, observed verbatim in prod Command Panel notes and ask
 * rows. A quote carrying any of these is agency judgment, not client
 * evidence — forcibly internal_hygiene_gap no matter where it appears or
 * how the model categorized it. Compared against
 * normalizeForCitationMatch(quote), so entries are lowercase ASCII.
 */
export const AGENCY_WRITEOFF_PHRASES: readonly string[] = [
  "effectively churned",
  "functionally churned",
  "essentially churned",
  "basically churned",
  "de facto churned",
  "treat as churned",
  "treated as churned",
  "considered churned",
  "consider them churned",
  "should offboard",
  "should be offboarded",
  "offboard them",
  "offboard this client",
  "write off",
  "write-off",
  "written off",
  "write them off",
];

export function containsAgencyWriteoffLanguage(normalizedQuote: string): boolean {
  return AGENCY_WRITEOFF_PHRASES.some(p => normalizedQuote.includes(p));
}

export interface ValidatedEvidenceItem {
  /** The model's claimed category (preserved verbatim for audit). */
  category: string;
  /** Explicit alias for audit consumers; `category` remains backwards-compatible. */
  originalCategory: string;
  /**
   * The category the gate ACTS on — equals `category` unless a
   * deterministic reclassification rule fired (see reclassReason).
   */
  effectiveCategory: string;
  /** Compatibility field: raw communication text is intentionally redacted. */
  quote: string;
  /** One-way audit correlation for the normalized model citation. */
  quoteFingerprint: string | null;
  quoteLength: number;
  quoteWordCount: number;
  source: string | null;
  date: string | null;
  valid: boolean;
  rejectReason?: EvidenceRejectReason;
  /** Scope the quote matched in (valid items only). */
  sourceScope?: EvidenceSourceScope;
  /** Precise provenance of the atomic fragment that matched. */
  provenance?: EvidenceProvenance;
  /** Bounded metadata only — the complete fragment body is never persisted. */
  matchedFragment?: {
    id: string;
    sourceType: string;
    sourceId: string | null;
    field: string;
    occurredAt: string | null;
    authorAttribution: string | null;
    metricState: EvidenceMetricState | null;
    independenceKey: string | null;
  };
  /** Set when effectiveCategory differs from the model's claim. */
  reclassifiedFrom?: string;
  reclassReason?: EvidenceReclassReason;
}

export interface EvidenceValidationResult {
  items: ValidatedEvidenceItem[];
  validCount: number;
  rejectedCount: number;
  /** Count of valid items whose category was deterministically downgraded. */
  reclassifiedCount: number;
}

type EvidenceIdentityInput = {
  quoteFingerprint?: string | null;
  matchedFragment?: {
    id?: string | null;
    independenceKey?: string | null;
  } | null;
};

/**
 * Canonical identity for one accepted fact. An explicit independence key
 * unifies duplicate storage representations; otherwise the atomic fragment
 * keeps genuinely distinct sources separate. The quote fingerprint is the
 * compatibility fallback for legacy accepted items without fragment metadata.
 */
export function acceptedEvidenceIdentity(item: EvidenceIdentityInput): string {
  return item.matchedFragment?.independenceKey ??
    item.matchedFragment?.id ??
    item.quoteFingerprint ??
    "unattributed";
}

const ACCEPTED_SEVERITY_RANK: Record<RatingDriver["severity"], number> = {
  watch: 0,
  at_risk: 1,
  critical: 2,
};

/**
 * Keep one strongest accepted item per canonical fact while retaining every
 * rejected item for audit. Stable first-wins ordering avoids explanation churn
 * when duplicate model citations have equal effective severity.
 */
export function deduplicateAcceptedEvidence(
  items: readonly ValidatedEvidenceItem[],
  judgmentDate: string,
): ValidatedEvidenceItem[] {
  const deduplicated: ValidatedEvidenceItem[] = [];
  const acceptedIndexByIdentity = new Map<string, number>();
  for (const item of items) {
    if (!item.valid) {
      deduplicated.push(item);
      continue;
    }
    const identity = acceptedEvidenceIdentity(item);
    if (identity === "unattributed") {
      deduplicated.push(item);
      continue;
    }
    const existingIndex = acceptedIndexByIdentity.get(identity);
    if (existingIndex === undefined) {
      acceptedIndexByIdentity.set(identity, deduplicated.length);
      deduplicated.push(item);
      continue;
    }
    const existing = deduplicated[existingIndex];
    if (
      ACCEPTED_SEVERITY_RANK[acceptedEvidenceSeverity(item, judgmentDate)] >
      ACCEPTED_SEVERITY_RANK[acceptedEvidenceSeverity(existing, judgmentDate)]
    ) {
      deduplicated[existingIndex] = item;
    }
  }
  return deduplicated;
}

/**
 * Validate the model's raw `churnEvidence` array against the provenance-
 * scoped evidence corpus. Defensive on shape (the input is parsed model
 * JSON): non-arrays yield zero items, malformed entries are recorded as
 * rejected — never thrown. A rejected item is treated by the gate as
 * absent evidence.
 *
 * The model does NOT own the category that reaches the gate:
 *  1. A quote carrying agency write-off vocabulary is forcibly
 *     internal_hygiene_gap (Watch ceiling) regardless of claimed category
 *     or scope.
 *  2. A Critical-qualifying category whose quote matches only internal
 *     context is downgraded to expressed_dissatisfaction (At Risk
 *     ceiling): agency-authored text can flag risk but never unlock
 *     Critical.
 *  3. corroborated_loss_signal requires >= 2 DISTINCT surviving client-
 *     communication citations; lone signals downgrade to
 *     expressed_dissatisfaction.
 */
export function validateEvidenceCitations(
  raw: unknown,
  corpus: EvidenceCorpus,
  context: EvidenceEligibilityContext = {
    judgmentDate: "1970-01-01",
    deliveryStability: "unknown",
    deliveryStabilitySource: "none",
  },
): EvidenceValidationResult {
  const items: ValidatedEvidenceItem[] = [];
  const normalizedQuoteByItem = new Map<ValidatedEvidenceItem, string>();
  const fragments = corpus.fragments
    .map(fragment => ({ fragment, normalized: normalizeForCitationMatch(fragment.text) }))
    .filter(entry => entry.normalized.length > 0);
  if (Array.isArray(raw)) {
    for (const entry of raw.slice(0, MAX_EVIDENCE_ITEMS)) {
      const e = (entry ?? {}) as Record<string, unknown>;
      const category = typeof e.category === "string" ? e.category.trim() : "";
      const quoteRaw = typeof e.quote === "string" ? e.quote : "";
      const normalizedQuote = normalizeForCitationMatch(quoteRaw);
      const item: ValidatedEvidenceItem = {
        category,
        originalCategory: category,
        effectiveCategory: category,
        quote: REDACTED_QUOTE_LABEL,
        quoteFingerprint: normalizedQuote
          ? createHash("sha256").update(normalizedQuote).digest("hex").slice(0, 20)
          : null,
        quoteLength: quoteRaw.length,
        quoteWordCount: normalizedQuote ? normalizedQuote.split(" ").length : 0,
        source: typeof e.source === "string" ? e.source.slice(0, 120) : null,
        date: typeof e.date === "string" ? e.date.slice(0, 40) : null,
        valid: false,
      };
      items.push(item);
      normalizedQuoteByItem.set(item, normalizedQuote);
      if (!isKnownEvidenceCategory(category)) {
        item.rejectReason = "invalid_category";
        continue;
      }
      const norm = normalizedQuote;
      if (norm.length === 0) {
        item.rejectReason = "missing_quote";
        continue;
      }
      const critical = CRITICAL_SET.has(category);
      const minChars = critical ? MIN_CRITICAL_QUOTE_CHARS : MIN_QUOTE_CHARS;
      const minWords = critical ? MIN_CRITICAL_QUOTE_WORDS : MIN_QUOTE_WORDS;
      if (norm.length < minChars || norm.split(" ").length < minWords) {
        item.rejectReason = "quote_too_short";
        continue;
      }
      const candidates = fragments.filter(entry => entry.normalized.includes(norm));
      if (candidates.length === 0) {
        item.rejectReason = "not_found_in_inputs";
        continue;
      }
      const matched = selectBestFragment(candidates.map(entry => entry.fragment));
      item.provenance = matched.provenance;
      item.sourceScope =
        matched.provenance === "client_authored" ? "client_communication" : "internal_context";
      item.matchedFragment = {
        id: matched.id,
        sourceType: matched.sourceType,
        sourceId: matched.sourceId ?? null,
        field: matched.field,
        occurredAt: matched.occurredAt ?? null,
        authorAttribution: matched.authorAttribution ?? null,
        metricState: matched.metricState ?? null,
        independenceKey: matched.independenceKey ?? null,
      };
      if (matched.metricState === "untracked") {
        item.rejectReason = "untracked_metric";
        continue;
      }
      item.valid = true;

      // Deterministic category corrections — the gate acts on
      // effectiveCategory, never the model's claim alone.
      if (containsAgencyWriteoffLanguage(norm) && category !== "internal_hygiene_gap") {
        item.effectiveCategory = "internal_hygiene_gap";
        item.reclassifiedFrom = category;
        item.reclassReason = "agency_writeoff_language";
      } else {
        applyCategoryEligibility(item, matched, norm, context, critical);
      }
    }
  }

  // Corroboration floor: corroborated_loss_signal only counts as Critical-
  // qualifying when at least two DISTINCT quotes from DISTINCT communication
  // fragments survive the per-item rules. Two snippets from one message are
  // not independent corroboration.
  const lossSignals = items.filter(
    i => i.valid && i.effectiveCategory === "corroborated_loss_signal",
  );
  const independentSignals = new Set(
    lossSignals.map(i =>
      `${i.matchedFragment?.independenceKey ?? i.matchedFragment?.id ?? "unknown"}\u0000${normalizedQuoteByItem.get(i) ?? ""}`,
    ),
  );
  const distinctFragments = new Set(
    lossSignals.map(i =>
      i.matchedFragment?.independenceKey ?? i.matchedFragment?.id ?? "unknown",
    ),
  );
  if (lossSignals.length > 0 && (independentSignals.size < 2 || distinctFragments.size < 2)) {
    for (const item of lossSignals) {
      item.effectiveCategory = "expressed_dissatisfaction";
      item.reclassifiedFrom = item.reclassifiedFrom ?? item.category;
      item.reclassReason = "uncorroborated_independent_signals";
    }
  }

  const deduplicatedItems = deduplicateAcceptedEvidence(items, context.judgmentDate);
  const validCount = deduplicatedItems.filter(i => i.valid).length;
  const reclassifiedCount = deduplicatedItems.filter(
    i => i.valid && i.reclassifiedFrom !== undefined,
  ).length;
  return {
    items: deduplicatedItems,
    validCount,
    rejectedCount: deduplicatedItems.length - validCount,
    reclassifiedCount,
  };
}

const FRAGMENT_PROVENANCE_RANK: Record<EvidenceProvenance, number> = {
  client_authored: 100,
  objective_report_metric: 90,
  operator_intel: 60,
  open_ask: 55,
  internal_operational: 50,
  internal_staff: 45,
  client_forwarded: 40,
  third_party: 35,
  automated: 30,
  ai_generated: 25,
  internal_context: 20,
  communication_subject: 10,
  unknown: 0,
};

function selectBestFragment(fragments: EvidenceFragment[]): EvidenceFragment {
  return fragments.reduce((best, candidate) =>
    FRAGMENT_PROVENANCE_RANK[candidate.provenance] > FRAGMENT_PROVENANCE_RANK[best.provenance]
      ? candidate
      : best,
  );
}

const CATEGORY_SEMANTICS: Partial<Record<JudgmentEvidenceCategory, RegExp>> = {
  explicit_churn_language:
    /\b((?:(?:want|plan|intend|need|decid(?:e|ed)|going|would like) to|will|please|kindly) (?:cancel|terminate|end) (?:our|the|this|your)? ?(?:contract|agreement|engagement|services?|retainer|account|relationship|agency relationship|vendor relationship)|(?:we(?:'re| are)|i(?:'m| am)) (?:cancelling|terminating|ending) (?:our|the|this|your)? ?(?:contract|agreement|engagement|services?|retainer|account|relationship|agency relationship|vendor relationship)|(?:(?:want|plan|intend|need|decid(?:e|ed)|going|would like) to|will) leave (?:the|your) agency|(?:we(?:'re| are)|i(?:'m| am)) leaving (?:the|your) agency|(?:not renew|won't renew|will not renew) (?:our|the|this|your)? ?(?:contract|agreement|engagement|services?|retainer)|(?:won't|will not|do not|don't) renew with (?:you|your agency))\b/i,
  competitor_switch:
    /\b((?:(?:want|plan|intend|need|decid(?:e|ed)|going|would like) to|will) (?:switch|move) to (?:another|a new|new|a different|different) (?:agency|vendor|provider)|(?:we(?:'re| are)|i(?:'m| am)) (?:switching|moving) to (?:another|a new|new|a different|different) (?:agency|vendor|provider)|(?:(?:want|plan|intend|need|decid(?:e|ed)|going|would like) to|will) (?:replace|evaluate|hire|choose) (?:another|a new|new|a different|different) (?:agency|vendor|provider)|(?:we(?:'re| are)|i(?:'m| am)) (?:replacing|evaluating|hiring|choosing) (?:another|a new|new|a different|different) (?:agency|vendor|provider))\b/i,
  billing_or_legal_escalation:
    /\b((?:(?:want|need|plan|intend|decid(?:e|ed)|going|would like) to|will|please|kindly) (?:request|demand) (?:a )?refund|(?:we(?:'re| are)|i(?:'m| am)) (?:requesting|demanding) (?:a )?refund|(?:(?:plan|intend|decid(?:e|ed)|going|would like) to|will) (?:file|initiate|pursue) (?:a )?chargeback|(?:we(?:'re| are)|i(?:'m| am)) (?:filing|initiating|pursuing) (?:a )?chargeback|(?:we(?:'re| are)|i(?:'m| am)) disputing (?:the )?(?:invoice|charge|bill)|withhold(?:ing)? payment|won't pay|will not pay|declin(?:e|ed|ing) (?:payment|to pay)|(?:(?:plan|intend|decid(?:e|ed)|going|would like) to|will) (?:pursue|take) legal action|(?:we(?:'re| are)|i(?:'m| am)) (?:pursuing|taking) legal action|this is (?:a )?breach of contract|our (?:attorney|lawyer) (?:will|is going to) (?:review|contact|respond|write|call))\b/i,
  corroborated_loss_signal:
    /\b((?:revoke|remove).{0,35}(?:(?:your|your agency's|the incumbent agency's) (?:access|credentials)|(?:access|credentials).{0,25}from (?:you|your agency|the incumbent agency))|(?:transfer|hand over|handover).{0,50}(?:access|assets|files|creative|credentials).{0,60}(?:to|for) (?:(?:our|the|a) )?(?:new|next|replacement) (?:agency|vendor|provider)|(?:access|assets|files|creative|credentials).{0,50}(?:transfer|hand over|handover).{0,60}(?:to|for) (?:(?:our|the|a) )?(?:new|next|replacement) (?:agency|vendor|provider)|package.{0,40}(?:assets|files|creative|credentials).{0,40}(?:for transfer to|for handover to|for) (?:(?:our|the|a) )?(?:new|next|replacement) (?:agency|vendor|provider)|(?:assets|files|creative|credentials).{0,40}packag(?:e|ed|ing).{0,40}(?:for transfer to|for handover to|for) (?:(?:our|the|a) )?(?:new|next|replacement) (?:agency|vendor|provider)|wind(?:ing)? down (?:the )?(?:account|engagement|relationship)|wound down (?:the )?(?:account|engagement|relationship))\b/i,
  expressed_dissatisfaction:
    /\b(frustrat(?:ed|ing|ion)?|unhappy|dissatisf(?:ied|action)?|disappoint(?:ed|ing|ment)?|skeptic(?:al|ism)?|unacceptable|upset|angry|not happy|losing confidence)\b/i,
  service_failure:
    /\b(still|again|promised|overdue|never|not|no)\b.{0,100}\b(receiv(?:e|ed)|deliver(?:ed|y)?|report|launch(?:ed)?|campaign|response|reply|complet(?:e|ed)|fix(?:ed)?|live)\b/i,
};

const CRITICAL_NEGATION_PREFIX =
  String.raw`(?:do not|don't|does not|doesn't|did not|didn't|will not|won't|would not|wouldn't|cannot|can't|is not|isn't|are not|aren't|was not|wasn't|were not|weren't|not going to|never|no (?:plan|plans|intention) to|decided (?:against|not to)|avoid(?:ing)?)`;

const CRITICAL_NEGATION: Partial<Record<JudgmentEvidenceCategory, RegExp>> = {
  explicit_churn_language: new RegExp(
    String.raw`\b${CRITICAL_NEGATION_PREFIX}\b.{0,40}\b(?:cancel(?:led|ling)?|terminat(?:e|ing)|end(?:ing)?|leav(?:e|ing))\b`,
    "i",
  ),
  competitor_switch: new RegExp(
    String.raw`\b${CRITICAL_NEGATION_PREFIX}\b.{0,45}\b(?:switch(?:ing)?|mov(?:e|ing)|replac(?:e|ing)|evaluat(?:e|ing)|hir(?:e|ing)|choos(?:e|ing)|court(?:ed|ing))\b`,
    "i",
  ),
  billing_or_legal_escalation: new RegExp(
    String.raw`\b${CRITICAL_NEGATION_PREFIX}\b.{0,50}\b(?:request(?:ed|ing)?|demand(?:ed|ing)?|pursu(?:e|ed|ing)|tak(?:e|ing)|threaten(?:ed|ing)?|fil(?:e|ed|ing)|disput(?:e|ed|ing)|withhold(?:ing)?)\b.{0,30}\b(?:refund|chargeback|legal action|lawsuit|invoice|charge|bill|payment)\b`,
    "i",
  ),
  corroborated_loss_signal: new RegExp(
    String.raw`\b${CRITICAL_NEGATION_PREFIX}\b.{0,50}\b(?:revok(?:e|ed|ing)|remov(?:e|ed|ing)|transferr?(?:ed|ing)?|hand over|handover|packag(?:e|ed|ing)|wind(?:ing)? down)\b`,
    "i",
  ),
};

const REPEATED_ASK_LANGUAGE =
  /\b(again|following up|follow up|checking (?:in )?again|second request|third request|still waiting|reminder|re-?sending|asked (?:before|last|twice)|once again)\b/i;
const REPEATED_ASK_MAX_AGE_DAYS = 14;

function processGapProvenance(provenance: EvidenceProvenance): boolean {
  return provenance === "operator_intel" ||
    provenance === "open_ask" ||
    provenance === "internal_context";
}

function reclassify(
  item: ValidatedEvidenceItem,
  effectiveCategory: JudgmentEvidenceCategory,
  reason: EvidenceReclassReason,
): void {
  item.effectiveCategory = effectiveCategory;
  item.reclassifiedFrom = item.reclassifiedFrom ?? item.category;
  item.reclassReason = reason;
}

function fragmentAgeDays(fragment: EvidenceFragment, judgmentDate: string): number | null {
  if (!fragment.occurredAt || !/^\d{4}-\d{2}-\d{2}/.test(judgmentDate)) return null;
  const occurred = new Date(fragment.occurredAt).getTime();
  const judged = new Date(`${judgmentDate.slice(0, 10)}T23:59:59.999Z`).getTime();
  if (!Number.isFinite(occurred) || !Number.isFinite(judged)) return null;
  return Math.max(0, Math.floor((judged - occurred) / 86_400_000));
}

function citationContext(fragmentText: string, normalizedQuote: string): string {
  const normalizedFragment = normalizeForCitationMatch(fragmentText);
  const index = normalizedFragment.indexOf(normalizedQuote);
  if (index < 0) return normalizedQuote;
  return normalizedFragment.slice(
    Math.max(0, index - 60),
    Math.min(normalizedFragment.length, index + normalizedQuote.length + 60),
  );
}

function applyCategoryEligibility(
  item: ValidatedEvidenceItem,
  fragment: EvidenceFragment,
  normalizedQuote: string,
  context: EvidenceEligibilityContext,
  critical: boolean,
): void {
  const category = item.category as JudgmentEvidenceCategory;
  const directClient = fragment.provenance === "client_authored";
  const softFallback: JudgmentEvidenceCategory =
    processGapProvenance(fragment.provenance) ? "internal_hygiene_gap" : "other_negative";

  if (critical && !directClient) {
    reclassify(item, softFallback, "critical_requires_direct_client_language");
    return;
  }

  if (
    (category === "expressed_dissatisfaction" ||
      category === "repeated_unresolved_ask" ||
      category === "service_failure") &&
    !directClient
  ) {
    reclassify(item, softFallback, "client_risk_requires_direct_client_language");
    return;
  }

  if (category === "delivery_metric_decline") {
    if (fragment.provenance !== "objective_report_metric" || fragment.metricState !== "tracked") {
      reclassify(item, softFallback, "delivery_decline_requires_objective_metrics");
      return;
    }
    if (context.deliveryStability !== "declining" || context.deliveryStabilitySource === "none") {
      reclassify(item, "other_negative", "delivery_decline_not_measured");
    }
    return;
  }

  if (category === "repeated_unresolved_ask") {
    const age = fragmentAgeDays(fragment, context.judgmentDate);
    if (age === null || age > REPEATED_ASK_MAX_AGE_DAYS) {
      reclassify(item, "other_negative", "repeated_ask_not_recent");
      return;
    }
    if (!REPEATED_ASK_LANGUAGE.test(normalizedQuote)) {
      reclassify(item, "other_negative", "repeated_ask_not_repeated");
    }
    return;
  }

  const semanticRule = CATEGORY_SEMANTICS[category];
  const negationRule = CRITICAL_NEGATION[category];
  const localContext = citationContext(fragment.text, normalizedQuote);
  const semanticText = category === "explicit_churn_language"
    ? localContext
    : normalizedQuote;
  if (
    semanticRule &&
    (!semanticRule.test(semanticText) || (negationRule?.test(localContext) ?? false))
  ) {
    reclassify(item, "other_negative", "category_semantics_not_met");
  }
}

// ---------------------------------------------------------------------------
// Deterministic context signals (computed server-side, never model-claimed)
// ---------------------------------------------------------------------------

/**
 * Fallback silence threshold (calendar days) when the client has no usable
 * historical baseline: the owner-approved acceptable standard is one client
 * communication per week.
 */
export const FALLBACK_SILENCE_THRESHOLD_DAYS = 7;
export const ACCEPTABLE_ROLLING_30D_COMMUNICATIONS = 4;

/**
 * Baseline-relative silence: the weekly standard is the minimum acceptable
 * cadence, and a client's observed average gap can make that threshold more
 * permissive for a genuinely slower relationship. The rolling 30-day count
 * remains an explicit input so the decision cannot silently drift away from
 * the headline communication volume. A longest-gap value is retained only as
 * a compatibility fallback for pre-average inventories.
 */
export function isBaselineSilenceExceeded(args: {
  silenceDays: number | null;
  businessDaySilence: number | null;
  longestGapDays: number | null;
  averageGapDays?: number | null;
  rolling30dCount?: number;
}): boolean {
  const {
    silenceDays,
    businessDaySilence,
    longestGapDays,
    averageGapDays,
    rolling30dCount = 0,
  } = args;
  if (silenceDays === null) return false;
  if (businessDaySilence !== null && businessDaySilence <= 3) return false;
  // Four or more communications in a rolling 30-day window meets the
  // once-per-week standard. Do not call that account silent; the rolling
  // window itself will stop protecting it as older communications age out.
  const weeklyStandardDays = 7;
  const observedAverage =
    averageGapDays !== null && averageGapDays !== undefined && Number.isFinite(averageGapDays) && averageGapDays > 0
      ? averageGapDays
      : longestGapDays !== null && longestGapDays > 0
        ? longestGapDays
        : null;
  const acceptableGapDays = Math.max(weeklyStandardDays, observedAverage ?? 0);
  if (rolling30dCount >= ACCEPTABLE_ROLLING_30D_COMMUNICATIONS) return false;
  if (observedAverage !== null) return silenceDays > acceptableGapDays;
  return silenceDays > FALLBACK_SILENCE_THRESHOLD_DAYS;
}

/**
 * Delivery stability from entered report metrics (leads), judged latest
 * completed month vs the average of up to five prior non-null months.
 * "unknown" whenever the data cannot honestly support a verdict: fewer than
 * two non-null completed months, or the newest entered month is more than
 * two months behind the judgment date (stale reports prove nothing about
 * current delivery). The judgment month itself is excluded — an in-progress
 * month's partial total would read as a false collapse.
 */
export function assessDeliveryStability(
  reportHistory: Array<{ month: string; leads: number | null; reviews: number | null }>,
  dateStr: string,
): DeliveryStability {
  return assessLeadsSeries(
    reportHistory.map(r => ({ month: r.month, leads: r.leads })),
    dateStr,
  );
}

/**
 * Shared series assessor — the SAME rules regardless of where the monthly
 * lead totals came from (entered reports or measured live-data snapshots):
 * ≥2 non-null completed months, latest ≤2 months behind the judgment date,
 * judgment month excluded, latest vs prior-average <0.6 = declining,
 * all-zero history grounds nothing.
 */
function assessLeadsSeries(
  series: Array<{ month: string; leads: number | null }>,
  dateStr: string,
): DeliveryStability {
  const judgmentMonth = dateStr.substring(0, 7);
  const completed = series
    .filter(r => /^\d{4}-\d{2}$/.test(r.month) && r.month < judgmentMonth && r.leads !== null)
    .sort((a, b) => (a.month < b.month ? 1 : -1)); // newest first
  if (completed.length < 2) return "unknown";
  const latest = completed[0];
  if (monthsBetween(latest.month, judgmentMonth) > 2) return "unknown";
  const prior = completed.slice(1, 6);
  const avg = prior.reduce((s, r) => s + (r.leads as number), 0) / prior.length;
  const current = latest.leads as number;
  if (avg <= 0) return current > 0 ? "stable" : "unknown"; // all-zero history grounds nothing
  return current < avg * 0.6 ? "declining" : "stable";
}

// ---------------------------------------------------------------------------
// Task #4766 — measured-fallback delivery stability
// ---------------------------------------------------------------------------

/** Where the delivery-stability verdict's evidence came from. */
export type DeliveryStabilitySource =
  | "entered_reports"
  | "measured_live_data"
  | "none";

/**
 * One measured monthly lead total from a live-data snapshot. `fetchedAt`
 * is the snapshot's fetch timestamp (ISO) — only snapshots fetched AFTER
 * the month closed count as that month's final total, so a partial
 * mid-month pull can never read as a collapse.
 */
export interface MeasuredMonthlyLeads {
  /** Calendar month YYYY-MM the total covers. */
  month: string;
  /** Measured lead total (ok-status metric value). */
  leads: number;
  /** ISO timestamp the snapshot was fetched. */
  fetchedAt: string;
}

/** True when `fetchedAt` falls after the last instant of `month` (UTC). */
export function isPostCloseSnapshot(month: string, fetchedAt: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const [y, m] = month.split("-").map(Number);
  const closeMs = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  const fetchedMs = new Date(fetchedAt).getTime();
  return Number.isFinite(fetchedMs) && fetchedMs >= closeMs;
}

/**
 * Delivery stability with the Task #4766 measured fallback. Entered reports
 * stay PRIMARY: whenever they can ground a verdict on their own, that
 * verdict wins and the source is `entered_reports`. Only when entered data
 * reads "unknown" does the measured monthly-leads series get a turn, under
 * the exact same rules (via `assessLeadsSeries`) plus the post-close
 * requirement enforced here. When neither series grounds anything, the
 * verdict stays "unknown" with source `none` — which still blocks the
 * Healthy force (no semantics weakened).
 */
export function assessDeliveryStabilityWithFallback(
  reportHistory: Array<{ month: string; leads: number | null; reviews: number | null }>,
  measured: MeasuredMonthlyLeads[],
  dateStr: string,
): { stability: DeliveryStability; source: DeliveryStabilitySource } {
  const entered = assessDeliveryStability(reportHistory, dateStr);
  if (entered !== "unknown") return { stability: entered, source: "entered_reports" };

  const postClose = measured
    .filter(m => isPostCloseSnapshot(m.month, m.fetchedAt))
    .map(m => ({ month: m.month, leads: m.leads }));
  const measuredVerdict = assessLeadsSeries(postClose, dateStr);
  if (measuredVerdict !== "unknown") {
    return { stability: measuredVerdict, source: "measured_live_data" };
  }
  return { stability: "unknown", source: "none" };
}

function monthsBetween(earlier: string, later: string): number {
  const [ey, em] = earlier.split("-").map(Number);
  const [ly, lm] = later.split("-").map(Number);
  return (ly - ey) * 12 + (lm - em);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface TierGateInput {
  /** Rating as-of date; owns standing-evidence decay. */
  judgmentDate: string;
  /** Model's proposed overallStatus (after enum fallback). */
  proposedStatus: JudgmentGateStatus;
  /** Model's sanitized overallRisk (null = ungrounded). */
  proposedOverallRisk: number | null;
  /** Model's relationship proposal is retained for traceability only. */
  proposedRelationshipStatus?: JudgmentRelationshipStatus;
  /** Output of validateEvidenceCitations — invalid items count as absent. */
  evidence: ValidatedEvidenceItem[];
  tier: "full" | "operational";
  silenceExceeded: boolean;
  deliveryStability: DeliveryStability;
  /** Task #4766 — where the stability verdict's evidence came from. */
  deliveryStabilitySource: DeliveryStabilitySource;
  /**
   * Current, clearly positive human-filed client context. Text is classified
   * before this boundary and never persisted here; the gate independently
   * enforces freshness from the source timestamp.
   */
  positiveClientContext?: PositiveClientContextSignal[];
}

export type JudgmentRelationshipStatus = "Strong" | "Stable" | "Strained" | "At Risk";

export interface PositiveClientContextSignal {
  /** Stable source identity; never contains operator-entered text. */
  id: string;
  sourceType: "operator_intel";
  occurredAt: string;
  /**
   * The intel explicitly records recent direct contact (for example, a call
   * or meeting), so it can contradict a missing/misclassified silence fact.
   * General positive sentiment alone never suppresses a genuine cadence gap.
   */
  confirmsRecentClientContact?: boolean;
}

export interface RatingDriver {
  /** Stable, deduplicated identifier; never contains the underlying quote. */
  id: string;
  severity: "watch" | "at_risk" | "critical";
  reason: string;
}

const JUDGMENT_STATUS_LABELS = "Healthy|Watch|At Risk|Critical";
export interface TierGateDecision {
  finalStatus: JudgmentGateStatus;
  finalRelationshipStatus: JudgmentRelationshipStatus;
  cap: JudgmentGateStatus;
  /** Machine-readable reasons the authoritative decision landed where it did. */
  capReasons: string[];
  /** Accepted independent drivers used to calculate the stored risk. */
  riskDrivers: RatingDriver[];
  /** finalStatus differs from the model's proposal. */
  overridden: boolean;
  healthyForced: boolean;
  finalOverallRisk: number;
  riskClamped: boolean;
  /** Current positive operator signals accepted as authoritative support. */
  positiveClientContext: PositiveClientContextSignal[];
  /** True only when positive context contradicted an otherwise silence-only escalation. */
  silenceTemperedByPositiveContext: boolean;
}

export const POSITIVE_CLIENT_CONTEXT_MAX_AGE_DAYS = 14;

function currentPositiveClientContext(input: TierGateInput): PositiveClientContextSignal[] {
  const judged = new Date(`${input.judgmentDate.slice(0, 10)}T23:59:59.999Z`).getTime();
  if (!Number.isFinite(judged)) return [];
  const seen = new Set<string>();
  return (input.positiveClientContext ?? []).filter(signal => {
    if (
      !signal ||
      signal.sourceType !== "operator_intel" ||
      typeof signal.id !== "string" ||
      !signal.id ||
      seen.has(signal.id)
    ) return false;
    const occurred = new Date(signal.occurredAt).getTime();
    if (!Number.isFinite(occurred)) return false;
    const ageDays = Math.floor((judged - occurred) / 86_400_000);
    if (ageDays < 0 || ageDays > POSITIVE_CLIENT_CONTEXT_MAX_AGE_DAYS) return false;
    seen.add(signal.id);
    return true;
  });
}

/**
 * Deterministic, evidence-derived rating decision. Model values are never
 * decision inputs: accepted Critical evidence requires Critical, accepted
 * client-risk evidence or an objective delivery/cadence breakdown requires
 * At Risk, and only a complete, stable, in-cadence basis can be Healthy.
 */
export function applyJudgmentTierGate(input: TierGateInput): TierGateDecision {
  const valid = deduplicateAcceptedEvidence(input.evidence, input.judgmentDate)
    .filter(e => e.valid);
  const acceptedSeverities = valid.map(item =>
    acceptedEvidenceSeverity(item, input.judgmentDate),
  );
  const hasCriticalEvidence = acceptedSeverities.includes("critical");
  const hasAtRiskEvidence = acceptedSeverities.includes("at_risk");
  const positiveClientContext = currentPositiveClientContext(input);
  const hasCurrentPositiveClientContext = positiveClientContext.length > 0;
  const silenceTemperedByPositiveContext =
    positiveClientContext.some(signal => signal.confirmsRecentClientContact === true) &&
    input.silenceExceeded &&
    !hasCriticalEvidence &&
    !hasAtRiskEvidence &&
    input.deliveryStability !== "declining";
  const effectiveSilenceExceeded =
    input.silenceExceeded && !silenceTemperedByPositiveContext;
  const criticalClaimsReclassified = valid.some(
    e => e.reclassifiedFrom !== undefined && CRITICAL_SET.has(e.reclassifiedFrom),
  );
  const riskDrivers = buildRiskDrivers(valid, input);
  const capReasons = [...new Set(riskDrivers.map(driver => driver.reason))];
  const addReason = (reason: string) => {
    if (!capReasons.includes(reason)) capReasons.push(reason);
  };
  let finalStatus: JudgmentGateStatus;
  if (hasCriticalEvidence) {
    finalStatus = "Critical";
  } else if (hasAtRiskEvidence || effectiveSilenceExceeded || input.deliveryStability === "declining") {
    finalStatus = "At Risk";
  } else if (
    valid.length === 0 &&
    input.tier === "full" &&
    input.deliveryStability === "stable" &&
    !effectiveSilenceExceeded
  ) {
    finalStatus = "Healthy";
  } else {
    finalStatus = "Watch";
  }
  if (criticalClaimsReclassified) addReason("critical_claims_reclassified");
  if (hasCurrentPositiveClientContext) addReason("positive_client_context_validated");
  if (silenceTemperedByPositiveContext) {
    addReason("positive_client_context_tempered_silence");
  }
  if (valid.length === 0 && finalStatus === "Watch") {
    addReason("no_validated_negative_evidence");
    addReason("genuinely_uncertain_or_incomplete_basis");
  }
  if (valid.some(e => WATCH_EVIDENCE_CATEGORIES.includes(e.effectiveCategory as any))) {
    addReason("watch_level_evidence_validated");
  }
  if (
    valid.length > 0 &&
    valid.every(e => e.effectiveCategory === "internal_hygiene_gap")
  ) {
    addReason("hygiene_only_evidence");
  }
  if (finalStatus === "Healthy") addReason("stable_delivery_in_baseline_no_negative_evidence");

  const finalRelationshipStatus = deriveRelationshipStatus(valid, input, finalStatus);
  const finalOverallRisk = calculateRiskFromDrivers(finalStatus, riskDrivers);
  const healthyForced = finalStatus === "Healthy" && input.proposedStatus !== "Healthy";
  return {
    finalStatus,
    finalRelationshipStatus,
    cap: finalStatus,
    capReasons,
    overridden: finalStatus !== input.proposedStatus,
    healthyForced,
    finalOverallRisk,
    riskDrivers,
    riskClamped: finalOverallRisk !== input.proposedOverallRisk,
    positiveClientContext,
    silenceTemperedByPositiveContext,
  };
}

export const STANDING_EVIDENCE_DECAY_DAYS = 14;

function evidenceDriverId(item: ValidatedEvidenceItem): string {
  return acceptedEvidenceIdentity(item);
}

function evidenceAgeDays(item: ValidatedEvidenceItem, judgmentDate: string): number | null {
  const occurredAt = item.matchedFragment?.occurredAt;
  if (!occurredAt || !/^\d{4}-\d{2}-\d{2}/.test(judgmentDate)) return null;
  const occurred = new Date(occurredAt).getTime();
  const judged = new Date(`${judgmentDate.slice(0, 10)}T23:59:59.999Z`).getTime();
  if (!Number.isFinite(occurred) || !Number.isFinite(judged)) return null;
  return Math.max(0, Math.floor((judged - occurred) / 86_400_000));
}

/**
 * Current accepted severity for one validated item. Standing evidence loses
 * one tier after two weeks without a newer accepted signal.
 */
export function acceptedEvidenceSeverity(
  item: ValidatedEvidenceItem,
  judgmentDate: string,
): RatingDriver["severity"] {
  if (item.provenance === "ai_generated" || item.provenance === "unknown") {
    return "watch";
  }
  const age = evidenceAgeDays(item, judgmentDate);
  if (CRITICAL_SET.has(item.effectiveCategory)) {
    return age !== null && age > STANDING_EVIDENCE_DECAY_DAYS ? "at_risk" : "critical";
  }
  if (AT_RISK_SET.has(item.effectiveCategory)) {
    return age !== null && age > STANDING_EVIDENCE_DECAY_DAYS ? "watch" : "at_risk";
  }
  return "watch";
}

export function buildEvidenceRecencyFingerprint(
  evidence: readonly ValidatedEvidenceItem[],
  judgmentDate: string,
): string[] {
  const rank = { watch: 0, at_risk: 1, critical: 2 } as const;
  const facts = new Map<string, RatingDriver["severity"]>();
  for (const item of evidence) {
    if (!item.valid) continue;
    const id = evidenceDriverId(item);
    const severity = acceptedEvidenceSeverity(item, judgmentDate);
    const existing = facts.get(id);
    if (!existing || rank[severity] > rank[existing]) facts.set(id, severity);
  }
  return [...facts.entries()]
    .map(([id, severity]) => `${id}:${severity}`)
    .sort();
}

function buildRiskDrivers(
  valid: ValidatedEvidenceItem[],
  input: TierGateInput,
): RatingDriver[] {
  const drivers = new Map<string, RatingDriver>();
  const add = (driver: RatingDriver) => {
    const existing = drivers.get(driver.id);
    const rank = { watch: 0, at_risk: 1, critical: 2 } as const;
    if (!existing || rank[driver.severity] > rank[existing.severity]) {
      drivers.set(driver.id, driver);
    }
  };
  for (const item of valid) {
    const severity = acceptedEvidenceSeverity(item, input.judgmentDate);
    const originalSeverity = CRITICAL_SET.has(item.effectiveCategory)
      ? "critical"
      : AT_RISK_SET.has(item.effectiveCategory)
        ? "at_risk"
        : "watch";
    const reason =
      originalSeverity === "critical" && severity === "at_risk"
        ? "standing_critical_evidence_decayed"
        : originalSeverity === "at_risk" && severity === "watch"
          ? "standing_at_risk_evidence_decayed"
          : severity === "critical"
            ? "critical_evidence_validated"
            : severity === "at_risk"
              ? "at_risk_evidence_validated"
              : "watch_level_evidence_validated";
    add({
      id: `evidence:${evidenceDriverId(item)}`,
      severity,
      reason,
    });
  }
  if (input.silenceExceeded) {
    const positiveContextTempersSilence =
      currentPositiveClientContext(input).some(signal => signal.confirmsRecentClientContact === true) &&
      input.deliveryStability !== "declining" &&
      !valid.some(item => acceptedEvidenceSeverity(item, input.judgmentDate) !== "watch");
    if (!positiveContextTempersSilence) {
      add({ id: "context:baseline_silence", severity: "at_risk", reason: "baseline_silence_exceeded" });
    }
  }
  if (input.deliveryStability === "declining") {
    add({ id: "context:delivery_declining", severity: "at_risk", reason: "delivery_metrics_declining" });
  }
  if (input.tier === "operational" || input.deliveryStability === "unknown") {
    add({ id: "context:data_uncertainty", severity: "watch", reason: "genuinely_uncertain_or_incomplete_basis" });
  }
  return [...drivers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Deterministic 0–100 risk. The tier selects a disjoint band and the count of
 * accepted independent drivers moves the score upward inside that band. This
 * intentionally has no model-score input.
 */
export function calculateRiskFromDrivers(
  status: JudgmentGateStatus,
  drivers: readonly RatingDriver[],
): number {
  const [lo, hi] = TIER_RISK_BANDS[status];
  if (status === "Healthy") return lo;
  const severity = status === "Critical" ? "critical" : status === "At Risk" ? "at_risk" : "watch";
  const relevantCount = drivers.filter(driver => driver.severity === severity).length;
  const supportingCount = drivers.length - relevantCount;
  const step = status === "Critical" ? 5 : status === "At Risk" ? 6 : 4;
  return Math.min(hi, lo + Math.max(0, relevantCount - 1) * step + Math.min(3, supportingCount));
}

function deriveRelationshipStatus(
  valid: ValidatedEvidenceItem[],
  input: TierGateInput,
  overall: JudgmentGateStatus,
): JudgmentRelationshipStatus {
  const directClientRisk = valid.some(
    item =>
      item.provenance === "client_authored" &&
      acceptedEvidenceSeverity(item, input.judgmentDate) !== "watch",
  );
  const directCriticalRisk = valid.some(
    item =>
      item.provenance === "client_authored" &&
      acceptedEvidenceSeverity(item, input.judgmentDate) === "critical",
  );
  // A relationship "At Risk" requires a direct client Critical signal. A
  // strained relationship requires an actual current client signal. Cadence
  // or delivery deterioration alone cannot invent relationship sentiment.
  if (directCriticalRisk) return "At Risk";
  if (directClientRisk) return "Strained";
  if (
    overall === "Healthy" &&
    input.tier === "full" &&
    input.deliveryStability === "stable" &&
    valid.length === 0
  ) {
    return "Strong";
  }
  return "Stable";
}

// ---------------------------------------------------------------------------
// Audit record (persisted in the judgment's data_sources_summary)
// ---------------------------------------------------------------------------

export interface TierGateAudit {
  version: number;
  judgmentDate: string;
  proposedStatus: JudgmentGateStatus;
  finalStatus: JudgmentGateStatus;
  proposedRelationshipStatus: JudgmentRelationshipStatus | null;
  finalRelationshipStatus: JudgmentRelationshipStatus;
  cap: JudgmentGateStatus;
  capReasons: string[];
  overridden: boolean;
  healthyForced: boolean;
  proposedOverallRisk: number | null;
  finalOverallRisk: number;
  riskDrivers: RatingDriver[];
  silenceExceeded: boolean;
  deliveryStability: DeliveryStability;
  /** Task #4766 — measured data is never mistaken for entered data. */
  deliveryStabilitySource: DeliveryStabilitySource;
  positiveClientContext: PositiveClientContextSignal[];
  silenceTemperedByPositiveContext: boolean;
  evidence: {
    validCount: number;
    rejectedCount: number;
    reclassifiedCount: number;
    items: ValidatedEvidenceItem[];
  };
}

export function buildTierGateAudit(
  input: TierGateInput,
  decision: TierGateDecision,
  validation: EvidenceValidationResult,
): TierGateAudit {
  return {
    version: TIER_GATE_VERSION,
    judgmentDate: input.judgmentDate,
    proposedStatus: input.proposedStatus,
    finalStatus: decision.finalStatus,
    proposedRelationshipStatus: input.proposedRelationshipStatus ?? null,
    finalRelationshipStatus: decision.finalRelationshipStatus,
    cap: decision.cap,
    capReasons: decision.capReasons,
    overridden: decision.overridden,
    healthyForced: decision.healthyForced,
    proposedOverallRisk: input.proposedOverallRisk,
    finalOverallRisk: decision.finalOverallRisk,
    riskDrivers: decision.riskDrivers,
    silenceExceeded: input.silenceExceeded,
    deliveryStability: input.deliveryStability,
    deliveryStabilitySource: input.deliveryStabilitySource,
    positiveClientContext: decision.positiveClientContext,
    silenceTemperedByPositiveContext: decision.silenceTemperedByPositiveContext,
    evidence: {
      validCount: validation.validCount,
      rejectedCount: validation.rejectedCount,
      reclassifiedCount: validation.reclassifiedCount,
      items: validation.items,
    },
  };
}

const PRESENTATION_DRIVER_LIMIT = 3;
const PRESENTATION_REASON_LIMIT = 5;

const EVIDENCE_LABELS: Record<string, string> = {
  explicit_churn_language: "Explicit churn or cancellation language",
  competitor_switch: "Competitor switch",
  billing_or_legal_escalation: "Billing or legal escalation",
  corroborated_loss_signal: "Corroborated loss signals",
  expressed_dissatisfaction: "Expressed client dissatisfaction",
  repeated_unresolved_ask: "Repeated unresolved client ask",
  service_failure: "Service failure",
  delivery_metric_decline: "Objective delivery decline",
  internal_hygiene_gap: "Internal follow-through gap",
  other_negative: "Other accepted warning",
};

const REASON_LABELS: Record<string, string> = {
  critical_evidence_validated: "Qualifying first-party loss evidence was validated",
  at_risk_evidence_validated: "Client-risk evidence was validated",
  watch_level_evidence_validated: "A watch-level warning was validated",
  standing_critical_evidence_decayed: "Older critical evidence has decayed to At Risk",
  standing_at_risk_evidence_decayed: "Older At-Risk evidence has decayed to Watch",
  baseline_silence_exceeded: "Communication silence exceeded this account's baseline",
  delivery_metrics_declining: "Objective delivery metrics are declining",
  genuinely_uncertain_or_incomplete_basis: "The evidence basis is incomplete",
  no_validated_negative_evidence: "No negative evidence was accepted",
  hygiene_only_evidence: "Only internal follow-through evidence was accepted",
  stable_delivery_in_baseline_no_negative_evidence:
    "Delivery is stable, cadence is within baseline, and no negative evidence was accepted",
  critical_claims_reclassified: "Unsupported critical claims were downgraded",
  positive_client_context_validated: "Current positive client context was accepted",
  positive_client_context_tempered_silence:
    "Current positive client context tempered an otherwise contradictory silence-only signal",
};

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function driverProvenance(value: unknown): RatingDriverProvenance {
  if (value === "client_authored" || value === "client_forwarded") return "client-authored";
  if (value === "objective_report_metric") return "objective";
  if (
    value === "internal_staff" ||
    value === "operator_intel" ||
    value === "open_ask" ||
    value === "internal_operational" ||
    value === "internal_context" ||
    value === "ai_generated" ||
    value === "unknown"
  ) return "internal";
  return "other";
}

function driverSourceLabel(
  provenance: RatingDriverProvenance,
  evidenceProvenance: unknown,
  sourceType: unknown,
): string {
  if (provenance === "client-authored") return "Client communication";
  if (provenance === "objective") return "Objective account metric";
  if (evidenceProvenance === "ai_generated") {
    return "Internal AI interpretation — not direct client evidence";
  }
  if (evidenceProvenance === "unknown") {
    return "Internal interpretation with unknown provenance — not direct client evidence";
  }
  if (provenance === "internal") return "Internal account context";
  return typeof sourceType === "string" && sourceType.trim()
    ? "Other accepted source"
    : "Accepted account evidence";
}

function presentationSeverity(value: unknown): RatingDriverSeverity {
  if (value === "critical") return "critical";
  if (value === "at_risk") return "at-risk";
  if (value === "watch") return "watch";
  return "supporting";
}

function driverFreshness(
  occurredAt: string | null,
  judgmentDate: string,
): { ageDays: number | null; freshness: RatingDriverFreshness } {
  if (!occurredAt) return { ageDays: null, freshness: "unknown" };
  const occurred = new Date(occurredAt).getTime();
  const judged = new Date(`${judgmentDate.slice(0, 10)}T23:59:59.999Z`).getTime();
  if (!Number.isFinite(occurred) || !Number.isFinite(judged)) {
    return { ageDays: null, freshness: "unknown" };
  }
  const ageDays = Math.max(0, Math.floor((judged - occurred) / 86_400_000));
  return {
    ageDays,
    freshness: ageDays > STANDING_EVIDENCE_DECAY_DAYS ? "standing" : "current",
  };
}

function presentationDriverId(rawIdentity: string): string {
  return `driver-${createHash("sha256").update(rawIdentity).digest("hex").slice(0, 12)}`;
}

function contextDriver(driver: Record<string, any>, judgmentDate: string): AccountRatingDriver {
  const details: Record<string, {
    label: string;
    provenance: RatingDriverProvenance;
    sourceLabel: string;
  }> = {
    "context:baseline_silence": {
      label: "Communication silence exceeded the account baseline",
      provenance: "objective",
      sourceLabel: "Account communication cadence",
    },
    "context:delivery_declining": {
      label: "Objective delivery metrics declined",
      provenance: "objective",
      sourceLabel: "Account delivery metrics",
    },
    "context:data_uncertainty": {
      label: "The available evidence basis is incomplete",
      provenance: "objective",
      sourceLabel: "Account data coverage",
    },
  };
  const detail = details[String(driver.id)] ?? {
    label: REASON_LABELS[String(driver.reason)] ?? "Accepted account signal",
    provenance: "other" as const,
    sourceLabel: "Accepted account evidence",
  };
  return {
    id: presentationDriverId(String(driver.id)),
    label: detail.label,
    severity: presentationSeverity(driver.severity),
    provenance: detail.provenance,
    sourceLabel: detail.sourceLabel,
    occurredAt: judgmentDate,
    ageDays: 0,
    freshness: "current",
  };
}

/**
 * Build the bounded, quote-free rating explanation returned to operator
 * surfaces. Detailed evidence remains in dataSourcesSummary only on routes
 * that already return it; this projection never exposes quote fragments,
 * source IDs, or author attribution.
 */
export function toAccountRatingPresentation(input: {
  status: unknown;
  relationship: unknown;
  riskScore: unknown;
  judgmentDate: unknown;
  dataSourcesSummary: unknown;
}): AccountRatingPresentation | null {
  const inventory = asRecord(input.dataSourcesSummary);
  if (!inventory || !isAccountHealthStatus(input.status)) return null;
  const carried = asRecord(inventory.carriedForward);
  const audit = asRecord(carried?.rootTierGate ?? inventory.tierGate);
  if (
    !audit ||
    typeof audit.version !== "number" ||
    !isAccountHealthStatus(audit.finalStatus) ||
    !isRelationshipRead(audit.finalRelationshipStatus) ||
    typeof audit.judgmentDate !== "string"
  ) return null;

  const relationship = isRelationshipRead(input.relationship)
    ? input.relationship
    : audit.finalRelationshipStatus;
  const riskScore = typeof input.riskScore === "number" && Number.isFinite(input.riskScore)
    ? input.riskScore
    : null;
  const judgmentDate = typeof input.judgmentDate === "string"
    ? input.judgmentDate
    : audit.judgmentDate;
  const evidence = asRecord(audit.evidence);
  const items = Array.isArray(evidence?.items)
    ? evidence!.items.map(asRecord).filter((item): item is Record<string, any> => item !== null)
    : [];
  const acceptedById = new Map<string, Record<string, any>>();
  for (const item of items) {
    if (item.valid !== true) continue;
    const identity = acceptedEvidenceIdentity(item);
    if (!acceptedById.has(identity)) acceptedById.set(identity, item);
  }

  const rawDrivers = Array.isArray(audit.riskDrivers)
    ? audit.riskDrivers.map(asRecord).filter((driver): driver is Record<string, any> => driver !== null)
    : [];
  const rank: Record<RatingDriverSeverity, number> = {
    critical: 0,
    "at-risk": 1,
    watch: 2,
    supporting: 3,
  };
  const primaryDrivers = rawDrivers.map((driver): AccountRatingDriver => {
    const id = String(driver.id ?? "");
    if (!id.startsWith("evidence:")) return contextDriver(driver, judgmentDate);
    const item = acceptedById.get(id.slice("evidence:".length));
    if (!item) return contextDriver(driver, judgmentDate);
    const fragment = asRecord(item.matchedFragment);
    const occurredAt =
      typeof fragment?.occurredAt === "string"
        ? fragment.occurredAt
        : typeof item.date === "string"
          ? item.date
          : null;
    const freshness = driverFreshness(occurredAt, audit.judgmentDate);
    const provenance = driverProvenance(item.provenance);
    return {
      id: presentationDriverId(id),
      label: EVIDENCE_LABELS[String(item.effectiveCategory)] ?? "Accepted account evidence",
      severity: presentationSeverity(driver.severity),
      provenance,
      sourceLabel: driverSourceLabel(provenance, item.provenance, fragment?.sourceType),
      occurredAt,
      ageDays: freshness.ageDays,
      freshness: freshness.freshness,
    };
  }).sort((a, b) =>
    rank[a.severity] - rank[b.severity] ||
    (a.ageDays ?? Number.MAX_SAFE_INTEGER) - (b.ageDays ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id),
  ).slice(0, PRESENTATION_DRIVER_LIMIT);

  const reasonLabels = (Array.isArray(audit.capReasons) ? audit.capReasons : [])
    .filter((reason): reason is string => typeof reason === "string")
    .map(reason => REASON_LABELS[reason] ?? reason.replace(/_/g, " "))
    .filter((reason, index, all) => all.indexOf(reason) === index)
    .slice(0, PRESENTATION_REASON_LIMIT);

  if (primaryDrivers.length === 0 && reasonLabels.length > 0) {
    primaryDrivers.push({
      id: `reason:${String((audit.capReasons as unknown[])?.[0] ?? "account_basis")}`,
      label: reasonLabels[0],
      severity: input.status === "Healthy" ? "supporting" : presentationSeverity(
        input.status === "Critical" ? "critical" : input.status === "At Risk" ? "at_risk" : "watch",
      ),
      provenance: "objective",
      sourceLabel: "Deterministic rating policy",
      occurredAt: judgmentDate,
      ageDays: 0,
      freshness: "current",
    });
  }

  const lineage = carried &&
    typeof carried.fromDate === "string" &&
    typeof carried.fromJudgmentId === "string" &&
    typeof carried.rootDate === "string" &&
    typeof carried.rootJudgmentId === "string"
      ? {
          fromDate: carried.fromDate,
          fromJudgmentId: carried.fromJudgmentId,
          rootDate: carried.rootDate,
          rootJudgmentId: carried.rootJudgmentId,
        }
      : null;
  const statusContract = accountHealthContract[input.status];
  return {
    status: input.status,
    statusDefinition: statusContract.definition,
    relationship,
    relationshipDefinition: relationshipReadContract[relationship].definition,
    riskScore,
    riskRange: statusContract.riskRange,
    policyVersion: audit.version,
    promptRevision: typeof inventory.promptRevision === "string" ? inventory.promptRevision : null,
    basisTier: inventory.tier === "full" || inventory.tier === "operational"
      ? inventory.tier
      : null,
    judgmentDate,
    generatedAt: typeof inventory.generatedAt === "string" ? inventory.generatedAt : null,
    generation: lineage ? "carried-forward" : "generated",
    primaryDrivers,
    reasonLabels,
    evidenceCounts: {
      accepted: acceptedById.size,
      rejected: typeof evidence?.rejectedCount === "number" ? evidence.rejectedCount : 0,
      reclassified: typeof evidence?.reclassifiedCount === "number" ? evidence.reclassifiedCount : 0,
    },
    lineage,
  };
}

/**
 * Build the persisted summary around a structured server-owned verdict. The
 * model's remaining prose is supporting context only; rating-claim sentences
 * are removed first. `finalOverallRisk` is the gate's existing output, not a
 * separately calculated score.
 */
export function reconcileJudgmentNarrative(
  narrative: string | null | undefined,
  finalStatus: JudgmentGateStatus,
  finalRelationshipStatus: JudgmentRelationshipStatus,
  finalOverallRisk: number,
  authoritativeContext?: string,
): string {
  const verdict =
    `Server verdict: ${finalStatus} / ${finalOverallRisk}. ` +
    `Relationship: ${finalRelationshipStatus}.`;
  const supportingContext = stripModelRatingClaims(narrative);
  const sections = [verdict];
  const trimmedAuthoritativeContext = authoritativeContext?.trim();
  if (trimmedAuthoritativeContext) {
    sections.push(`Authoritative context: ${trimmedAuthoritativeContext}`);
  }
  if (supportingContext) sections.push(`Supporting context: ${supportingContext}`);
  return sections.join("\n\n");
}

const JUDGMENT_RELATIONSHIP_LABELS = "Strong|Stable|Strained|At Risk";

const JUDGMENT_RISK_LEVELS =
  "minimal|low|limited|moderate|medium|elevated|high|severe|critical";

/**
 * Model prose may supply evidence and interpretation, but never the stored
 * rating. Remove complete sentences that make their own status, relationship,
 * or qualitative-risk claim so unconstrained wording cannot compete with the
 * server verdict.
 */
export function stripModelRatingClaims(narrative: string | null | undefined): string {
  if (typeof narrative !== "string") return "";
  const trimmed = narrative.trim();
  if (!trimmed) return "";

  return trimmed
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(sentence => sentence.trim() && !isModelRatingClaim(sentence))
    .join(" ")
    .trim();
}

function isModelRatingClaim(sentence: string): boolean {
  const statusClaim = new RegExp(
    `(?:\\b(?:status|overall\\s+health|account|rating|tier)\\b[^.!?\\n]{0,60}` +
      `\\b(?:${JUDGMENT_STATUS_LABELS})\\b)` +
      `|(?:\\b(?:${JUDGMENT_STATUS_LABELS})\\b[^.!?\\n]{0,60}` +
      `\\b(?:status|overall\\s+health|account|rating|tier)\\b)`,
    "i",
  );
  const relationshipClaim = new RegExp(
    `(?:\\brelationship\\b[^.!?\\n]{0,60}\\b(?:${JUDGMENT_RELATIONSHIP_LABELS})\\b)` +
      `|(?:\\b(?:${JUDGMENT_RELATIONSHIP_LABELS})\\b[^.!?\\n]{0,60}` +
      `\\brelationship\\b)`,
    "i",
  );
  const riskClaim = new RegExp(
    `(?:\\brisk\\b[^.!?\\n]{0,60}\\b(?:${JUDGMENT_RISK_LEVELS})\\b)` +
      `|(?:\\b(?:${JUDGMENT_RISK_LEVELS})\\b[^.!?\\n]{0,60}\\brisk\\b)`,
    "i",
  );
  return statusClaim.test(sentence) || relationshipClaim.test(sentence) || riskClaim.test(sentence);
}
