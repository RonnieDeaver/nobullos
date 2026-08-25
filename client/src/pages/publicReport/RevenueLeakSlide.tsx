/**
 * RevenueLeakSlide — one slide of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 3916–4165 @ d31d7c0c7, Task #4271).
 *
 * Task #4278 (audit §8.7-8) polish pass:
 * - Funnel cells render `view.engineFunnel` — the shared computed source
 *   Engine Health also renders (shared/reportFunnel.ts) — plus a
 *   reconciliation line naming the Engine Health slide, so the two slides
 *   reconcile by construction. Non-monotonic stages carry the same
 *   carry-over annotation (§8.5).
 * - Red-on-red progress bars → `bg-report-crimson-bright` (the dark-surface
 *   crimson token); sentence footnotes raised to ≥12px / white-60; pill
 *   chips → squared glyph ReportStatusTag.
 * - `formatCurrency` moved verbatim to shared/reportFunnel.ts
 *   (formatReportCurrency) so both slides share ONE value format.
 */

import { Target, AlertCircle, MoveRight, CheckCircle } from "lucide-react";
import { formatReportCurrency, funnelCarryoverNote } from "@shared/reportFunnel";
import { Slide } from "./Slide";
import { ReportStatusTag } from "./StatusTag";
import { VerdictLine } from "./VerdictLine";
import {
  buildManualUpsellMessage,
  buildUpgradeUpsellMessage,
  buildValueUpsellMessage,
  NO_DATA_LABEL,
  SectionUpsellCallout,
} from "./EmptyState";
import type { PublicReportViewModel } from "./derive";

export function RevenueLeakSlide({ view }: { view: PublicReportViewModel }) {
  const { additionalCasesGap, additionalConsultsGap, avgCaseValue, casesFromIntakeImprovement, consultToCaseRate, data, engineFunnel, hasAvgCaseValueData, hasCasesData, hasConsultToCaseData, hasConsultsData, hasLeadToConsultData, intakeTargetRate, leadToConsultRate, monthLabel, salesTargetRate, sectionPresence, slideNumbers, t, totalLeads, totalMissed, unrealizedRevenue } = view;

  // Task #4693 — deck-wide no-data upsell convention (supersedes the Task
  // #4285 collapse): a fully-empty section renders its FULL slide skeleton
  // (muted "No data" funnel cells, the existing needs-data stage cards) and
  // ONE gold section callout carries the CaseIntake™ pitch. The "Partial
  // Data" tag below stays for partially-entered months. Hand-built views
  // without the presence map fail open (skeleton mode simply never engages).
  const sectionEmpty = !(sectionPresence?.lossAudit ?? true);

  return (
        <Slide slideNumber={slideNumbers.lossAudit} variant="burgundy" pattern="geometric" id="closing">
          {(() => {
            const targetIntakeRate = intakeTargetRate;
            const targetSalesRate = salesTargetRate;
            
            // Task #3688 — presence-derived gating (value entered and not
            // No-Data-flagged) instead of the Data Access toggle.
            const hasMarketingData = totalLeads > 0;
            const hasIntakeData = hasConsultsData;
            const canCalculateIntakeLoss = hasMarketingData && hasLeadToConsultData;
            const canCalculateSalesLoss = hasIntakeData && hasConsultToCaseData;
            const canCalculateFullEfficiency = canCalculateIntakeLoss && canCalculateSalesLoss;
            
            const leadsLostAtIntake = additionalConsultsGap;
            const consultsLostAtSales = additionalCasesGap;

            const intakeBelowBenchmark = canCalculateIntakeLoss && leadToConsultRate < targetIntakeRate;
            const salesBelowBenchmark = canCalculateSalesLoss && consultToCaseRate < targetSalesRate;

            // §8.5 — same shared source Engine Health renders; never recomputed here.
            const [leadsStage, consultsStage, casesStage] = engineFunnel.stages;

            return (
              <>
                <div className="slide-header">
                  <AlertCircle className="slide-header-icon text-report-crimson-bright" />
                  <h2 className="slide-title text-white">Revenue Leak Analysis</h2>
                  {!canCalculateFullEfficiency && (
                    <ReportStatusTag level="watch" label="Partial Data" className="ml-auto" data-testid="tag-leak-partial-data" />
                  )}
                </div>
                <p className="slide-subtitle-dark">Where {t("cases").toLowerCase()} are slipping through your pipeline — and how much it's costing you.</p>
                <VerdictLine verdict={data.slideVerdicts?.revenueLeak} slideKey="revenueLeak" className="mb-2" />
                <div className="divider-thin" style={{ background: 'linear-gradient(90deg, transparent, rgba(239,68,68,0.5), transparent)' }} />

                {/* Task #4693 — ONE gold callout per section when any data
                    point is missing; consults/cases are manually reportable,
                    so their absence wins the month-scoped "waiting on your
                    count" variant, and a missing average case value (also
                    client-supplied) takes the value variant (Task #4845 —
                    only NoBull-tracked gaps fall through to the generic
                    pitch). Stage cards keep their quiet waiting-on text —
                    the pitch is never repeated. */}
                {(!canCalculateFullEfficiency || !hasAvgCaseValueData) && (
                  <SectionUpsellCallout
                    variant="dark"
                    testId="upsell-revenue-leak"
                    message={
                      !hasConsultsData || !hasCasesData
                        ? buildManualUpsellMessage(
                            monthLabel,
                            !hasConsultsData && !hasCasesData
                              ? `${t("consults").toLowerCase()} and ${t("cases").toLowerCase()}`
                              : !hasConsultsData
                                ? t("consults").toLowerCase()
                                : t("cases").toLowerCase(),
                          )
                        : !hasAvgCaseValueData
                          ? buildValueUpsellMessage(monthLabel, t("averageCaseValue").toLowerCase())
                          : buildUpgradeUpsellMessage()
                    }
                  />
                )}

                {canCalculateFullEfficiency && hasAvgCaseValueData && totalMissed > 0 ? (
                  <div className="bg-report-critical/10 backdrop-blur-sm rounded-xl p-6 border-2 border-report-crimson-bright/40 text-center mb-6 revenue-leak-headline">
                    <div className="text-sm uppercase tracking-wider font-bold text-report-crimson-bright/70 mb-2">Total Pipeline Leakage</div>
                    <div className="report-hero-metric text-report-crimson-bright mb-2" data-testid="text-total-unrealized-revenue">
                      {formatReportCurrency(unrealizedRevenue)}
                    </div>
                    <div className="text-base text-white/70">
                      in unrealized revenue — <span className="text-report-crimson-bright font-semibold" data-testid="text-total-missed-cases">{totalMissed} {t("cases").toLowerCase()}</span> slipping through your pipeline
                    </div>
                  </div>
                ) : canCalculateFullEfficiency && totalMissed === 0 ? null : (
                  <div className="bg-report-watch/10 backdrop-blur-sm rounded-xl p-6 border border-report-watch/30 text-center mb-6 revenue-leak-headline">
                    <div className="text-sm uppercase tracking-wider font-bold text-report-gold/70 mb-2">Total Pipeline Leakage</div>
                    <div className="metric-large text-report-gold mb-2">—</div>
                    <div className="text-sm text-report-gold/70">Complete pipeline data needed to calculate total leakage</div>
                  </div>
                )}

                <div className="bg-report-charcoal rounded-xl p-6 border border-white/10 mb-4 revenue-leak-breakdown">
                  <div className="text-xs uppercase tracking-wider font-bold text-white/50 mb-4 flex items-center gap-2">
                    <Target className="w-4 h-4 text-report-gold" />
                    Pipeline Leak Breakdown
                  </div>

                  <div className="flex flex-col md:flex-row items-stretch gap-4 revenue-leak-funnel">
                    <div className="flex-1 bg-white/5 rounded-lg p-4 text-center border border-white/10">
                      <div className="text-[11px] uppercase tracking-wider text-white/60 mb-1">{t("leads")}</div>
                      {/* Task #4693 skeleton — with nothing entered the leads
                          cell goes muted "No data" like its siblings, never a
                          fabricated 0. */}
                      {sectionEmpty ? (
                        <div className="text-sm font-semibold text-white/50 leading-8 tabular-nums" data-testid="text-funnel-leads-missing">{NO_DATA_LABEL}</div>
                      ) : (
                        <div className="metric-large text-white" data-testid="text-leak-funnel-leads">{leadsStage.value}</div>
                      )}
                    </div>
                    <div className="flex items-center justify-center md:flex-col">
                      {/* ONE icon rotated per breakpoint — the print stylesheet forces
                          `svg { display: inline-block !important }`, so a hidden/md:block
                          pair would print BOTH arrows (Task #4458; same fix as #4281). */}
                      <MoveRight className="w-5 h-5 text-report-crimson-bright/70 rotate-90 md:rotate-0" />
                      {canCalculateIntakeLoss && intakeBelowBenchmark && (
                        <span className="text-xs text-report-crimson-bright font-bold ml-1 md:ml-0 md:mt-1 whitespace-nowrap">-{leadsLostAtIntake} lost</span>
                      )}
                    </div>
                    <div className="flex-1 bg-white/5 rounded-lg p-4 text-center border border-white/10">
                      <div className="text-[11px] uppercase tracking-wider text-white/60 mb-1">{t("consults")}</div>
                      {consultsStage.value !== null ? (
                        <div className="metric-large text-white" data-testid="text-leak-funnel-consults">{consultsStage.value}</div>
                      ) : (
                        <div className="text-sm font-semibold text-white/50 leading-8 tabular-nums" data-testid="text-funnel-consults-missing">No data</div>
                      )}
                    </div>
                    <div className="flex items-center justify-center md:flex-col">
                      {/* ONE rotated icon — see note on the intake connector above. */}
                      <MoveRight className="w-5 h-5 text-report-crimson-bright/70 rotate-90 md:rotate-0" />
                      {canCalculateSalesLoss && salesBelowBenchmark && (
                        <span className="text-xs text-report-crimson-bright font-bold ml-1 md:ml-0 md:mt-1 whitespace-nowrap">-{consultsLostAtSales} lost</span>
                      )}
                    </div>
                    <div className="flex-1 bg-white/5 rounded-lg p-4 text-center border border-white/10">
                      <div className="text-[11px] uppercase tracking-wider text-white/60 mb-1">{t("cases")}</div>
                      {casesStage.value !== null ? (
                        <div className="metric-large text-white" data-testid="text-leak-funnel-cases">{casesStage.value}</div>
                      ) : (
                        <div className="text-sm font-semibold text-white/50 leading-8 tabular-nums" data-testid="text-funnel-cases-missing">No data</div>
                      )}
                    </div>
                  </div>

                  {/* §8.5 monotonicity guard — same annotation Engine Health renders */}
                  {engineFunnel.breaks.length > 0 && (
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                      {engineFunnel.breaks.map((brk) => (
                        <span key={`${brk.from}-${brk.to}`} className="text-xs font-semibold text-report-gold border border-report-gold/40 bg-report-gold/10 px-2 py-1" data-testid={`text-leak-funnel-annotation-${brk.to}`}>
                          {funnelCarryoverNote(t(brk.from), t(brk.to), "month")}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* §8.7-8 reconciliation line — ties this funnel to Engine Health */}
                  <div className="text-xs text-white/60 text-center mt-4 mb-6" data-testid="text-leak-reconciliation">
                    Same pipeline as Engine Health (slide {slideNumbers.engineHealth}): the {t("leads").toLowerCase()}, {t("consults").toLowerCase()}, and {t("cases").toLowerCase()} figures match — this slide measures them against benchmark targets.
                  </div>

                  <div className="space-y-4">
                    <div className={`rounded-lg p-4 border ${intakeBelowBenchmark ? 'bg-report-critical/10 border-report-crimson-bright/30' : canCalculateIntakeLoss ? 'bg-report-healthy/10 border-report-healthy/30' : 'bg-report-watch/10 border-report-watch/30'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${intakeBelowBenchmark ? 'bg-report-crimson-bright' : canCalculateIntakeLoss ? 'bg-report-healthy-bright' : 'bg-report-gold'}`} />
                          <span className="text-xs font-bold uppercase tracking-wider text-white/70">Intake Stage</span>
                          {intakeBelowBenchmark && <ReportStatusTag level="critical" label="Primary Leak" data-testid="tag-intake-primary-leak" />}
                        </div>
                        {canCalculateIntakeLoss && intakeBelowBenchmark && (
                          <span className="text-sm font-bold text-report-crimson-bright" data-testid="text-intake-cases-lost">{casesFromIntakeImprovement} {t("cases").toLowerCase()} lost</span>
                        )}
                      </div>
                      {canCalculateIntakeLoss ? (
                        leadToConsultRate >= targetIntakeRate ? (
                          <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-report-healthy-bright flex-shrink-0" />
                            <span className="text-sm text-report-healthy-bright">Exceeds benchmark — {leadToConsultRate}% vs {targetIntakeRate}% target</span>
                            <span className="text-xs text-report-healthy-bright/70 ml-auto">+{Math.round((leadToConsultRate - targetIntakeRate) * 10) / 10}% above</span>
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-center gap-2 text-sm text-white/60 mb-2">
                              <span>{t("leads")}-to-{t("consults").toLowerCase()}: <span className="text-report-crimson-bright font-semibold">{leadToConsultRate}%</span></span>
                              <MoveRight className="w-3 h-3 text-white/30" />
                              <span>Benchmark: <span className="text-report-healthy-bright font-semibold">{targetIntakeRate}%</span></span>
                              <span className="text-white/30 mx-1">=</span>
                              <span className="text-report-gold font-semibold">{leadsLostAtIntake} extra {t("consults").toLowerCase()}</span>
                            </div>
                            <div className="w-full bg-white/10 rounded-full h-1.5">
                              <div className="bg-report-crimson-bright h-1.5 rounded-full" style={{ width: `${Math.min(100, (leadToConsultRate / targetIntakeRate) * 100)}%` }} />
                            </div>
                          </div>
                        )
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-report-gold/80">
                            {!hasMarketingData ? `Needs marketing ${t("leads").toLowerCase()} data` : `Waiting on your ${t("consults").toLowerCase()} count`}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className={`rounded-lg p-4 border ${salesBelowBenchmark ? 'bg-report-critical/10 border-report-crimson-bright/30' : canCalculateSalesLoss ? 'bg-report-healthy/10 border-report-healthy/30' : 'bg-report-watch/10 border-report-watch/30'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${salesBelowBenchmark ? 'bg-report-crimson-bright' : canCalculateSalesLoss ? 'bg-report-healthy-bright' : 'bg-report-gold'}`} />
                          <span className="text-xs font-bold uppercase tracking-wider text-white/70">Sales Stage</span>
                          {salesBelowBenchmark && !intakeBelowBenchmark && <ReportStatusTag level="critical" label="Primary Leak" data-testid="tag-sales-primary-leak" />}
                          {salesBelowBenchmark && intakeBelowBenchmark && <ReportStatusTag level="attention" label="Secondary Leak" data-testid="tag-sales-secondary-leak" />}
                        </div>
                        {canCalculateSalesLoss && salesBelowBenchmark && (
                          <span className="text-sm font-bold text-report-crimson-bright" data-testid="text-sales-cases-lost">{consultsLostAtSales} {t("cases").toLowerCase()} lost</span>
                        )}
                      </div>
                      {canCalculateSalesLoss ? (
                        consultToCaseRate >= targetSalesRate ? (
                          <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-report-healthy-bright flex-shrink-0" />
                            <span className="text-sm text-report-healthy-bright">Exceeds benchmark — {consultToCaseRate}% vs {targetSalesRate}% target</span>
                            <span className="text-xs text-report-healthy-bright/70 ml-auto">+{Math.round((consultToCaseRate - targetSalesRate) * 10) / 10}% above</span>
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-center gap-2 text-sm text-white/60 mb-2">
                              <span>{t("consults")}-to-{t("cases").toLowerCase()}: <span className="text-report-crimson-bright font-semibold">{consultToCaseRate}%</span></span>
                              <MoveRight className="w-3 h-3 text-white/30" />
                              <span>Benchmark: <span className="text-report-healthy-bright font-semibold">{targetSalesRate}%</span></span>
                              <span className="text-white/30 mx-1">=</span>
                              <span className="text-report-gold font-semibold">{consultsLostAtSales} extra {t("cases").toLowerCase()}</span>
                            </div>
                            <div className="w-full bg-white/10 rounded-full h-1.5">
                              <div className="bg-report-crimson-bright h-1.5 rounded-full" style={{ width: `${Math.min(100, (consultToCaseRate / targetSalesRate) * 100)}%` }} />
                            </div>
                          </div>
                        )
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-report-gold/80">
                            {!hasIntakeData ? `Waiting on your ${t("consults").toLowerCase()} count` : `Waiting on your ${t("cases").toLowerCase()} count`}
                          </span>
                        </div>
                      )}
                    </div>

                    {canCalculateFullEfficiency && totalMissed > 0 && (
                      <div className="flex items-center justify-end gap-2 pt-1 text-xs text-white/60">
                        <span>{casesFromIntakeImprovement} from intake + {consultsLostAtSales} from sales = <span className="text-report-crimson-bright font-bold">{totalMissed} total {t("cases").toLowerCase()} lost</span></span>
                      </div>
                    )}
                  </div>
                </div>

                {canCalculateFullEfficiency ? (
                  totalMissed > 0 ? (
                    // Task #3688 — never render "$0 recoverable … × $0 avg case
                    // value" when the avg case value simply wasn't entered; the
                    // case counts are real, only the $ valuation needs the input.
                    hasAvgCaseValueData ? (
                      <div className="bg-report-gold/10 rounded-xl p-4 border border-report-gold/30 text-center">
                        <div className="text-lg text-white/80 mb-1">
                          <span className="text-report-gold font-bold">{formatReportCurrency(unrealizedRevenue)}</span> in recoverable top-line revenue opportunity
                        </div>
                        <div className="text-xs text-white/60">
                          Based on {totalMissed} additional {t("cases").toLowerCase()} at target rates × {formatReportCurrency(avgCaseValue, true)} {t("averageCaseValue").toLowerCase()}
                        </div>
                      </div>
                    ) : (
                      <div className="bg-report-watch/10 rounded-xl p-4 border border-report-watch/30 text-center">
                        <div className="text-lg text-report-gold/80 mb-1">
                          {totalMissed} additional {t("cases").toLowerCase()} available at target rates
                        </div>
                        <div className="text-xs text-white/60">
                          Provide {t("averageCaseValue").toLowerCase()} data to value this opportunity
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="bg-report-healthy/10 rounded-xl p-4 border border-report-healthy/30 text-center">
                      <div className="text-lg text-report-healthy-bright mb-1 flex items-center justify-center gap-2">
                        <CheckCircle className="w-5 h-5" />
                        Both intake and sales are at or above target!
                      </div>
                      <div className="text-xs text-white/60">
                        Pipeline is running efficiently — focus on {t("leads").toLowerCase()} volume growth
                      </div>
                    </div>
                  )
                ) : (
                  <div className="bg-report-watch/10 rounded-xl p-4 border border-report-watch/30 text-center">
                    <div className="text-lg text-report-gold/80 mb-1">
                      Top-line revenue opportunity calculation requires complete pipeline data
                    </div>
                    <div className="text-xs text-white/60">
                      Provide intake and sales metrics to see unrealized top-line revenue analysis
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </Slide>
  );
}
