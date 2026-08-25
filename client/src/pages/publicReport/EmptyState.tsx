/**
 * Deck-wide empty-state primitives (Task #4693, superseding the Task #4285
 * collapse convention).
 *
 * ONE convention for "nothing was entered" across every client-data slide:
 * - `NO_DATA_LABEL` is the canonical wording — sentence-case "No data".
 *   The deck previously mixed a title-cased variant, bare "0", and bespoke
 *   phrasings; every rendered absence uses this constant (a source-scan
 *   test bans the title-cased form from the whole slide directory).
 * - A fully-empty section NO LONGER collapses to a band or drops its agenda
 *   row. It renders its FULL slide skeleton: real layout, muted "No data"
 *   metric slots, `ChartPlaceholderFrame` where charts/funnels would draw
 *   (never fabricated zero-value charts), and exactly ONE gold
 *   `SectionUpsellCallout` carrying the CaseIntake™ pitch. Do not "restore"
 *   the collapse — the always-visible gaps are a deliberate sales lever
 *   (owner-approved, 2026-08).
 * - A partially-filled section keeps its compact per-metric "No data" cards
 *   (Task #3688) and ALSO shows the single section callout; the pitch is
 *   never repeated on individual cards.
 * - Badge suppression survives (Task #4285): a status tag asserts a judgment
 *   the data can't back, so absent metrics render NO tag. Delta chips never
 *   claim change against absent baselines (Task #4226).
 *
 * Copy variants (owner-approved "direct ask" direction; Task #4845 layered
 * client-attribution on top: a gap in CLIENT-reportable data — consults,
 * cases, average case value — always reads as "waiting on your …", i.e. the
 * client hasn't shared it yet, never as NoBull failing to provide data.
 * NoBull-tracked gaps (marketing leads, search trends) keep neutral wording):
 * - consults/cases (manual entry allowed) → `buildManualUpsellMessage`
 * - average case value (client-supplied dollar figure, not a count) →
 *   `buildValueUpsellMessage` — same client-attributed month-scoped ask,
 *   without the "count" noun.
 * - everything else → `buildUpgradeUpsellMessage` (Lifetime Value's
 *   fully-empty skeleton uses this too — it isn't month-scoped, and this
 *   variant carries no month clause).
 * - Lifetime Value with data but soft/absent case numbers (Task #4714,
 *   owner-approved): `buildLifetimeEstimateUpsellMessage` when a "~N"
 *   benchmark estimate renders, `buildLifetimeNoCasesUpsellMessage` when
 *   cases were never reported — next to a slide that visibly HAS data, the
 *   generic "No data" line would read as false.
 * - Marketing with visible data but a missing sub-metric (Task #4850, same
 *   rule as #4714): month-scoped gap-naming variants
 *   `buildMarketingReviewsGapUpsellMessage` /
 *   `buildMarketingAdSpendGapUpsellMessage` /
 *   `buildMarketingReviewsAndAdSpendGapUpsellMessage` /
 *   `buildMarketingLeadsGapUpsellMessage`. The generic whole-section line
 *   stays ONLY on the fully-empty marketing section.
 * CaseIntake™ ALWAYS carries the ™.
 *
 * `EmptySlideBand` remains ONLY for the Next 30 Days slide (NoBull-authored
 * content, out of the upsell's scope).
 */

import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";

/** Canonical rendered wording for an absent metric or section. */
export const NO_DATA_LABEL = "No data";

/**
 * Upsell copy for data points the client may hand-report (# of consults /
 * # of cases). Month-scoped; `countLabel` is the client's own configured
 * terminology (lowercased t() label), e.g. "consults" or "consults and cases".
 * Use this variant for fully-empty months (no leads, no consults, no cases).
 */
export function buildManualUpsellMessage(monthLabel: string, countLabel: string): string {
  return `Still waiting on your ${countLabel} count for ${monthLabel} — send it over, or upgrade to CaseIntake™ and it's tracked automatically.`;
}

/**
 * Upsell copy for client-supplied VALUE data points (average case value —
 * a dollar figure, so the manual variant's "count" noun would be wrong).
 * Month-scoped and client-attributed like `buildManualUpsellMessage`;
 * `valueLabel` is the client's configured terminology, lowercased
 * (t("averageCaseValue").toLowerCase()).
 */
export function buildValueUpsellMessage(monthLabel: string, valueLabel: string): string {
  return `Still waiting on your ${valueLabel} for ${monthLabel} — send it over, or upgrade to CaseIntake™ and it's tracked automatically.`;
}

/**
 * Upsell copy for partial months where leads ARE present but consults/cases
 * are missing. Opening with "No data for <month>" would be dishonest next to
 * a visible leads hero, so this variant names only the missing metrics
 * (Task #4854, owner-approved). Same `countLabel` contract as
 * `buildManualUpsellMessage`.
 */
export function buildPartialManualUpsellMessage(monthLabel: string, countLabel: string): string {
  return `Missing ${countLabel} for ${monthLabel} — send us your ${countLabel} count, or upgrade to CaseIntake™ and it's tracked automatically.`;
}
/** Upsell copy for every other data point (and Lifetime Value's fully-empty skeleton — no month clause). */
export function buildUpgradeUpsellMessage(): string {
  return `${NO_DATA_LABEL} — CaseIntake™ tracks this automatically. Ask us about upgrading.`;
}

/**
 * Lifetime Value, estimate-only payoff (Task #4714): the cases card shows a
 * "~N" benchmark estimate (hasHardData=false but a meaningful estimate
 * renders), so "No data" would be wrong — the pitch names the estimates and
 * sells the upgrade to the client's own confirmed numbers instead.
 * `casesLabel` is the client's configured terminology, lowercased plural
 * (t("cases").toLowerCase()), e.g. "cases" or "matters".
 */
export function buildLifetimeEstimateUpsellMessage(casesLabel: string): string {
  return `These are industry estimates — CaseIntake™ replaces them with your real signed ${casesLabel}. Ask us about upgrading.`;
}
/**
 * The ONE gold-accented callout band a section renders when at least one of
 * its data points is missing. Slim, single line, no buttons — the CTA is
 * conversational copy only (the deck is a presentation, not an app).
 * Exactly one per section, in a consistent position under the divider.
 */
export function SectionUpsellCallout({
  message,
  variant,
  testId,
}: {
  message: string;
  /** Match the slide surface: 'light' on cream/beige, 'dark' on charcoal/burgundy. */
  variant: "light" | "dark";
  testId: string;
}) {
  const isDark = variant === "dark";
  // Print atomicity (Tasks #4715/#4747): the `data-testid` (upsell-* prefix)
  // is load-bearing — client/src/index.css @media print pins an explicit
  // `break-inside: avoid` rule to `[data-testid^="upsell-"]` so this callout
  // never splits across PDF pages (the old literal-`rounded-lg` class hook
  // silently died when the class was dropped; the explicit rule + lockstep
  // tests replaced it). Pinned by report-empty-states +
  // report-smoke-page-break-detector.
  return (
    <div
      className={`rounded-lg flex items-start gap-3 border-l-4 border-report-gold px-4 py-3 mb-6 ${
        isDark ? "bg-report-gold/10 border border-report-gold/30" : "bg-report-gold/10 border border-report-gold/40"
      }`}
      data-testid={testId}
    >
      <Sparkles
        className={`w-4 h-4 mt-0.5 shrink-0 ${isDark ? "text-report-gold" : "text-report-gold-ink"}`}
        aria-hidden="true"
      />
      <p className={`text-sm font-medium ${isDark ? "text-report-gold" : "text-report-gold-ink"}`}>{message}</p>
    </div>
  );
}

/**
 * Quiet placeholder frame rendered where a chart/funnel would draw when its
 * data is absent — a dashed, muted box, never a fabricated zero-value chart.
 */
export function ChartPlaceholderFrame({
  label,
  variant,
  testId,
}: {
  /** One quiet line naming what will draw here once data exists. */
  label: string;
  variant: "light" | "dark";
  testId: string;
}) {
  const isDark = variant === "dark";
  // Print atomicity: the `data-testid` (chart-placeholder-* prefix) is
  // load-bearing — same explicit index.css print rule + lockstep-test
  // rationale as SectionUpsellCallout above (Tasks #4715/#4747).
  return (
    <div
      className={`rounded-lg mt-6 border border-dashed p-6 min-h-[140px] flex items-center justify-center text-center ${
        isDark ? "border-white/15 bg-white/[0.03]" : "border-report-ink/15 bg-report-ink/[0.03]"
      }`}
      data-testid={testId}
    >
      <span className={`text-xs max-w-[52ch] ${isDark ? "text-report-ink-inverse-muted" : "text-report-ink-muted"}`}>
        {label}
      </span>
    </div>
  );
}

export function EmptySlideBand({
  icon: Icon,
  monthLabel,
  unlocks,
  variant,
  testId,
}: {
  /** The section's own header icon — keeps the collapsed slide recognizable. */
  icon: LucideIcon;
  /** Report data month ("June 2026"). Omit for sections that aren't month-scoped. */
  monthLabel?: string;
  /** One line: what makes this section light up. */
  unlocks: string;
  /** Match the slide surface: 'light' on cream/beige, 'dark' on charcoal/burgundy. */
  variant: "light" | "dark";
  testId: string;
}) {
  const isDark = variant === "dark";
  return (
    <div
      className={`${isDark ? "card-dark" : "card-light rounded-[var(--radius-xl)]"} p-8 text-center mt-4`}
      data-testid={testId}
    >
      <Icon
        className={`w-10 h-10 mx-auto mb-4 ${isDark ? "text-report-gold/60" : "text-report-crimson/50"}`}
        aria-hidden="true"
      />
      <div className={`text-lg mb-1 ${isDark ? "text-report-ink-inverse" : "text-report-ink"}`}>
        {monthLabel ? `${NO_DATA_LABEL} entered for ${monthLabel}` : `${NO_DATA_LABEL} entered yet`}
      </div>
      <div className={`text-xs max-w-[68ch] mx-auto ${isDark ? "text-report-ink-inverse-muted" : "text-report-ink-muted"}`}>
        {unlocks}
      </div>
    </div>
  );
}

/**
 * Lifetime Value, cases-never-reported payoff (Task #4714): the slide HAS
 * lifetime data (leads/reviews) but no hard case data and no meaningful
 * estimate, so the pitch names the specific gap instead of the generic
 * "No data" line. Same `casesLabel` contract as above.
 */
export function buildLifetimeNoCasesUpsellMessage(casesLabel: string): string {
  return `You haven't reported any ${casesLabel} to us yet — CaseIntake™ captures your signed ${casesLabel} automatically. Ask us about upgrading.`;
}

/**
 * Marketing Deep Dive gap-naming variants (Task #4850, same honesty rule as
 * the Lifetime Value pair above): the callout's trigger legs (zero leads,
 * zero reviews, $0 ad spend on a paid-media client) stay — every missing
 * data point remains a visible sales lever — but when the section HAS data,
 * the copy names the actual gap instead of the whole-section "No data" line,
 * which would read as false next to visible numbers. All are month-scoped:
 * the gap is "nothing recorded for THIS report month".
 */
export function buildMarketingReviewsGapUpsellMessage(monthLabel: string): string {
  return `No reviews recorded for ${monthLabel} — CaseIntake™ tracks review generation automatically. Ask us about upgrading.`;
}

/** Paid-media client ($0 recorded ad spend) — Google Ads and/or LSA active. */
export function buildMarketingAdSpendGapUpsellMessage(monthLabel: string): string {
  return `No ad spend recorded for ${monthLabel} — CaseIntake™ tracks paid-media spend automatically. Ask us about upgrading.`;
}

/** Both gaps at once — one combined sentence, still exactly one callout. */
export function buildMarketingReviewsAndAdSpendGapUpsellMessage(monthLabel: string): string {
  return `No reviews or ad spend recorded for ${monthLabel} — CaseIntake™ tracks both automatically. Ask us about upgrading.`;
}

/**
 * Zero leads on a section that still has data (real prod shape: reviews-only
 * report months). `leadsLabel` is the client's configured terminology,
 * lowercased (t("leads").toLowerCase()) — same contract as `casesLabel`.
 */
export function buildMarketingLeadsGapUpsellMessage(monthLabel: string, leadsLabel: string): string {
  return `No ${leadsLabel} recorded for ${monthLabel} — CaseIntake™ tracks ${leadsLabel} automatically. Ask us about upgrading.`;
}
