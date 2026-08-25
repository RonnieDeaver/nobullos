/**
 * EngineHealthSlide — one slide of the public client report.
 *
 * Task #4278 (audit §8.7-5): restructured from the SaaS traffic-light
 * triptych to the report's own system — ONE hero number (est. top-line
 * revenue) above three compact squared status tags (▲/▼/— glyph redundancy
 * via ReportStatusTag), plus the leads → consults → cases flow strip.
 *
 * The strip and the hero render `view.engineFunnel` — the shared computed
 * source Revenue Leak also renders (shared/reportFunnel.ts) — so the two
 * slides reconcile by construction. A non-monotonic funnel (consults >
 * leads) always renders its carry-over annotation (§8.5).
 *
 * Task #4841: when revenue can't compute but the month HAS leads, the leads
 * count (same shared funnel stage) takes the hero slot instead of a
 * slide-dominating "No data" — see the hero comment below for the three
 * states.
 */

import { ChevronRight, Settings } from "lucide-react";
import { formatReportCurrency, funnelCarryoverNote } from "@shared/reportFunnel";
import { Slide } from "./Slide";
import { ReportStatusTag } from "./StatusTag";
import { VerdictLine } from "./VerdictLine";
import {
  buildManualUpsellMessage,
  buildPartialManualUpsellMessage,
  buildUpgradeUpsellMessage,
  buildValueUpsellMessage,
  NO_DATA_LABEL,
  SectionUpsellCallout,
} from "./EmptyState";
import type { ReportStatusLevel } from "./reportTokens";
import type { PublicReportViewModel } from "./derive";

/**
 * Status bands preserved from the traffic-light era (gap vs target):
 * ≤0 healthy, ≤5 watch, ≤attentionCeiling attention (15 intake / 10 sales),
 * else critical. Presence gating stays per Task #3688 — a never-entered
 * rate shows its explanatory text with NO status tag (Task #4285 badge
 * suppression), never a red 0%.
 */
const levelFromGap = (gap: number, attentionCeiling: number): ReportStatusLevel => {
  if (gap <= 0) return 'healthy';
  if (gap <= 5) return 'watch';
  if (gap <= attentionCeiling) return 'attention';
  return 'critical';
};

const statusLabel = (level: ReportStatusLevel): string => {
  if (level === 'healthy') return 'On Track';
  if (level === 'watch') return 'Watch';
  if (level === 'attention') return 'Needs Attention';
  return 'Critical';
};

export function EngineHealthSlide({ view }: { view: PublicReportViewModel }) {
  const { avgCaseValue, consultToCaseRate, data, engineFunnel, hasAvgCaseValueData, hasCasesData, hasConsultsData, hasConsultToCaseData, hasLeadToConsultData, intakeTargetRate, leadToConsultRate, marketingSection, monthLabel, otherLeadsCount, salesTargetRate, sectionPresence, slideNumbers, t, totalCases, totalLeads } = view;

  const intakeLevel = levelFromGap(intakeTargetRate - leadToConsultRate, 15);
  const salesLevel = levelFromGap(salesTargetRate - consultToCaseRate, 10);
  const intakeDelta = Math.round((leadToConsultRate - intakeTargetRate) * 10) / 10;
  const salesDelta = Math.round((consultToCaseRate - salesTargetRate) * 10) / 10;

  const posture = marketingSection?.data?.posture || 'scaling';
  const postureLabel = posture === 'ramp-up' ? 'Ramp-Up' : posture === 'stable' ? 'Stable' : posture === 'baseline' ? 'Baseline' : 'Scaling';

  const [leadsStage, consultsStage, casesStage] = engineFunnel.stages;

  // Task #4693 — deck-wide no-data upsell convention (supersedes the Task
  // #4285 collapse): a fully-empty section renders its FULL slide skeleton
  // (muted "No data" slots, no fabricated 0-lead rows) and ONE gold section
  // callout carries the CaseIntake™ pitch. Hand-built views without the
  // presence map fail open (skeleton mode simply never engages).
  const sectionEmpty = !(sectionPresence?.engineHealth ?? true);

  // Callout variant (Task #4845 — client attribution): consults/cases are
  // manually reportable, so their absence wins the month-scoped "waiting on
  // your count" wording (joined label when both are missing). Average case
  // value is ALSO client-supplied — when it is the only gap, the value
  // variant attributes it to the client too; only NoBull-tracked gaps fall
  // through to the generic pitch.
  const missingManualPoints = !hasConsultsData || !hasCasesData;
  const manualLabel =
    !hasConsultsData && !hasCasesData
      ? `${t("consults").toLowerCase()} and ${t("cases").toLowerCase()}`
      : !hasConsultsData
        ? t("consults").toLowerCase()
        : t("cases").toLowerCase();
  const anyMissing =
    missingManualPoints ||
    totalLeads === 0 ||
    !hasLeadToConsultData ||
    !hasConsultToCaseData ||
    engineFunnel.estTopLineRevenue === null;

  // Task #4845 follow-through: the revenue-missing sublines must name ONLY
  // the client-reportable inputs actually absent — telling a client who
  // already shared their cases to send "cases and average case value" reads
  // as NoBull losing data they provided. Defensive fallback: if the funnel
  // can't price revenue for any other reason, keep the full enumeration.
  const missingRevenueInputs = [
    ...(!hasCasesData ? [t("cases").toLowerCase()] : []),
    ...(!hasAvgCaseValueData ? [t("averageCaseValue").toLowerCase()] : []),
  ];
  const missingRevenueInputsPhrase = (
    missingRevenueInputs.length > 0
      ? missingRevenueInputs
      : [t("cases").toLowerCase(), t("averageCaseValue").toLowerCase()]
  ).join(" and ");

  return (
    <Slide slideNumber={slideNumbers.engineHealth} variant="cream" pattern="lines" id="engine-health">
      <div className="slide-header">
        <Settings className="slide-header-icon text-report-crimson" />
        <h2 className="slide-title text-report-crimson">Engine Health</h2>
      </div>
      <p className="slide-subtitle-light">Current state of your Revenue Engine — conversion metrics that drive case volume.</p>
      <VerdictLine verdict={data.slideVerdicts?.engineHealth} slideKey="engineHealth" className="mb-2" />

      {/* Task #4693 — ONE gold callout per section when any data point is
          missing; per-metric slots stay quiet "No data". */}
      {anyMissing && (
        <SectionUpsellCallout
          variant="light"
          testId="upsell-engine-health"
          message={
            missingManualPoints
              ? (!sectionEmpty && totalLeads > 0
                  ? buildPartialManualUpsellMessage(monthLabel, manualLabel)
                  : buildManualUpsellMessage(monthLabel, manualLabel))
              : !hasAvgCaseValueData
                ? buildValueUpsellMessage(monthLabel, t("averageCaseValue").toLowerCase())
                : buildUpgradeUpsellMessage()
          }
        />
      )}

      {/* Hero (§8.7-5: one number leads the slide) — est. top-line revenue,
          priced off the ENTERED avg case value via the shared funnel source
          (never the retired hard-coded $5K). Task #4841: on a partial month
          (leads entered, revenue not computable) the strongest available
          number — the shared funnel's leads stage — takes the hero at full
          scale and the revenue miss shrinks to one compact muted line. A
          month with zero/untracked leads keeps the muted "No data" hero
          (never a fabricated 0), and a fully-empty section keeps the #4693
          skeleton unchanged. */}
      <div className="text-center mt-6 mb-6">
        {engineFunnel.estTopLineRevenue !== null ? (
          <>
            <div className="text-xs uppercase tracking-[0.2em] font-bold text-report-ink-muted mb-2">Est. Top-Line Revenue — {monthLabel}</div>
            <div className="report-hero-metric text-report-crimson" data-testid="text-engine-hero-revenue">
              {formatReportCurrency(engineFunnel.estTopLineRevenue)}
            </div>
            <div className="text-sm text-report-ink-muted mt-4">
              {totalCases} {t("cases").toLowerCase()} × {formatReportCurrency(avgCaseValue, true)} {t("averageCaseValue").toLowerCase()}
            </div>
          </>
        ) : !sectionEmpty && totalLeads > 0 ? (
          <>
            <div className="text-xs uppercase tracking-[0.2em] font-bold text-report-ink-muted mb-2">{t("leads")} Generated — {monthLabel}</div>
            <div className="report-hero-metric text-report-crimson" data-testid="text-engine-hero-leads">
              {leadsStage.value}
            </div>
            {/* Task #4982 — same disclosure as the Marketing hero: this
                total includes the "Other" bucket the Lifetime slide's
                campaign figure excludes. Gated on the derive layer's FINAL
                otherLeadsCount (one shared value), so the slides can never
                disagree about when the clarifier shows. */}
            {otherLeadsCount > 0 && (
              <div className="text-caption text-report-ink-muted mt-2" data-testid="text-engine-hero-leads-other-note">includes {otherLeadsCount} "Other" {t("leads").toLowerCase()} — not attributed to our campaigns</div>
            )}
            <div className="text-sm text-report-ink-muted mt-4" data-testid="text-engine-hero-revenue-missing-compact">
              Est. top-line revenue: {NO_DATA_LABEL} — we'll estimate it once you share this month's {missingRevenueInputsPhrase}
            </div>
          </>
        ) : (
          <>
            <div className="text-xs uppercase tracking-[0.2em] font-bold text-report-ink-muted mb-2">Est. Top-Line Revenue — {monthLabel}</div>
            <div className="metric-large text-report-ink-muted" data-testid="text-engine-hero-revenue-missing">{NO_DATA_LABEL}</div>
            <div className="text-sm text-report-ink-muted mt-4">
              We'll estimate top-line revenue once you share this month's {missingRevenueInputsPhrase}
            </div>
          </>
        )}
      </div>

      {/* Three compact status rows — Marketing / Intake / Sales (funnel
          order, Task #4522; §8.7-5: squared glyph tags replace the
          traffic-light cards) */}
      <div className="border-y border-report-ink/10 divide-y divide-report-ink/10">
        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-4">
          <span className="text-[11px] uppercase tracking-wider font-bold text-report-ink-muted w-28 shrink-0">Marketing</span>
          {sectionEmpty ? (
            // Task #4693 skeleton — a fully-empty month shows a muted "No
            // data" slot, never a fabricated "0 leads generated" row.
            <span className="text-sm text-report-ink-muted flex-1" data-testid="text-engine-marketing-missing">{NO_DATA_LABEL} — {t("leads").toLowerCase()} not tracked this month</span>
          ) : (
            <span className="text-sm text-report-ink flex-1" data-testid="text-engine-marketing-metric">
              <span className="font-bold tabular-nums">{totalLeads}</span> {t("leads").toLowerCase()} generated this month
            </span>
          )}
          {/* Task #4982 — compact Other-leads disclosure beside the row count
              (the full "not attributed" wording lives on the heroes); same
              shared derive-layer gate as the hero clarifiers. Sibling span so
              text-engine-marketing-metric's pinned text stays unchanged. */}
          {!sectionEmpty && otherLeadsCount > 0 && (
            <span className="text-xs text-report-ink-muted shrink-0" data-testid="text-engine-marketing-other-note">includes {otherLeadsCount} "Other" {t("leads").toLowerCase()}</span>
          )}
          {/* Task #4285 — the posture badge never sits over zero volume;
              with no leads the row's count text stands alone, untagged. */}
          {totalLeads > 0 && (
            <ReportStatusTag level="neutral" label={postureLabel} data-testid="tag-engine-marketing" />
          )}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-4">
          <span className="text-[11px] uppercase tracking-wider font-bold text-report-ink-muted w-28 shrink-0">Intake</span>
          {hasLeadToConsultData ? (
            <>
              <span className="text-sm text-report-ink flex-1" data-testid="text-engine-intake-metric">
                {t("leads")} → {t("consults").toLowerCase()}: <span className="font-bold tabular-nums">{leadToConsultRate}%</span>
                <span className="text-report-ink-muted"> vs {intakeTargetRate}% target ({intakeDelta >= 0 ? `+${intakeDelta}` : intakeDelta}%)</span>
              </span>
              <ReportStatusTag level={intakeLevel} label={statusLabel(intakeLevel)} data-testid="tag-engine-intake" />
            </>
          ) : (
            // Task #4285 — badge suppression: the explanatory text stands
            // alone; no neutral tag asserts a status over absent data.
            <span className="text-sm text-report-ink-muted flex-1" data-testid="text-engine-intake-missing">{t("leads")} → {t("consults").toLowerCase()} rate — waiting on your {t("consults").toLowerCase()} count for this month</span>
          )}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-4">
          <span className="text-[11px] uppercase tracking-wider font-bold text-report-ink-muted w-28 shrink-0">Sales</span>
          {hasConsultToCaseData ? (
            <>
              <span className="text-sm text-report-ink flex-1" data-testid="text-engine-sales-metric">
                {t("consults")} → {t("cases").toLowerCase()}: <span className="font-bold tabular-nums">{consultToCaseRate}%</span>
                <span className="text-report-ink-muted"> vs {salesTargetRate}% target ({salesDelta >= 0 ? `+${salesDelta}` : salesDelta}%)</span>
              </span>
              <ReportStatusTag level={salesLevel} label={statusLabel(salesLevel)} data-testid="tag-engine-sales" />
            </>
          ) : (
            // Task #4285 — badge suppression (see intake row above).
            <span className="text-sm text-report-ink-muted flex-1" data-testid="text-engine-sales-missing">{t("consults")} → {t("cases").toLowerCase()} rate — waiting on your {t("cases").toLowerCase()} count for this month</span>
          )}
        </div>
      </div>

      {/* Engine flow — rendered from the SHARED funnel source (revenue cell
          retired: the hero above is the one revenue number) */}
      <div className="bg-report-ink rounded-xl p-4 mt-6">
        <div className="flex items-center justify-center gap-6">
          <div className="text-center">
            {/* Task #4693 skeleton — with nothing entered the leads cell goes
                muted "No data" like its consult/case siblings, never a
                fabricated 0. */}
            {sectionEmpty ? (
              <div className="text-sm font-semibold text-white/50 leading-8 tabular-nums" data-testid="text-engine-flow-leads-missing">{NO_DATA_LABEL}</div>
            ) : (
              <div className="metric-large text-white" data-testid="text-engine-flow-leads">{leadsStage.value}</div>
            )}
            <div className="text-[11px] uppercase tracking-wider text-white/60">{t("leads")}</div>
          </div>
          <div className="flex items-center gap-1 text-report-gold">
            <div className="w-8 h-0.5 bg-report-gold/50"></div>
            <ChevronRight className="w-4 h-4" />
          </div>
          <div className="text-center">
            {consultsStage.value !== null ? (
              <div className="metric-large text-white" data-testid="text-engine-flow-consults">{consultsStage.value}</div>
            ) : (
              <div className="text-sm font-semibold text-white/50 leading-8 tabular-nums" data-testid="text-engine-flow-consults-missing">No data</div>
            )}
            <div className="text-[11px] uppercase tracking-wider text-white/60">{t("consults")}</div>
          </div>
          <div className="flex items-center gap-1 text-report-gold">
            <div className="w-8 h-0.5 bg-report-gold/50"></div>
            <ChevronRight className="w-4 h-4" />
          </div>
          <div className="text-center">
            {casesStage.value !== null ? (
              <div className="metric-large text-report-gold" data-testid="text-engine-flow-cases">{casesStage.value}</div>
            ) : (
              <div className="text-sm font-semibold text-white/50 leading-8 tabular-nums" data-testid="text-engine-flow-cases-missing">No data</div>
            )}
            <div className="text-[11px] uppercase tracking-wider text-white/60">{t("cases")}</div>
          </div>
        </div>
        {/* §8.5 monotonicity guard: an "impossible" funnel shape never renders
            without its explanation */}
        {engineFunnel.breaks.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {engineFunnel.breaks.map((brk) => (
              <span key={`${brk.from}-${brk.to}`} className="text-xs font-semibold text-report-gold border border-report-gold/40 bg-report-gold/10 px-2 py-1" data-testid={`text-engine-flow-annotation-${brk.to}`}>
                {funnelCarryoverNote(t(brk.from), t(brk.to), "month")}
              </span>
            ))}
          </div>
        )}
      </div>
    </Slide>
  );
}
