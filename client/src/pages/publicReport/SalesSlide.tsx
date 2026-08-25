/**
 * SalesSlide — one slide of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 2881–3114 @ d31d7c0c7, Task #4271).
 *
 * Task #4279 (audit §8.7-6): redesigned as an editorial brief on the paper
 * surface — VerdictLine opener, one hero number, token type scale (11px
 * strings → 12px caption floor, Montserrat metrics), Common Issues as max-3
 * bullets at a 68ch measure. "BETA — experimental" hedges removed from the
 * client deliverable: Pipeline Momentum Index is KEPT and stood behind
 * (per-metric decision documented on the task). Data semantics are
 * unchanged: Task #3688 No-Data gating and the Task #2460 shared severity
 * bands (`@shared/commonIssuesSeverity` stays the ONLY threshold source, so
 * UI color and AI tone keep agreeing).
 */

import { TrendingUp, AlertCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { displayedSupportingMetric, sectionHasEntryTracking } from "@shared/reportMetrics";
import { getSalesSeverityBand } from "@shared/commonIssuesSeverity";
import { Slide } from "./Slide";
import { ReportStatusTag } from "./StatusTag";
import { reportStatusLevelFromDomain } from "./reportTokens";
import { TrendsSection } from "./TrendsSection";
import { VerdictLine } from "./VerdictLine";
import {
  parseCommonIssuesForPresentation,
  PUBLIC_COMMON_ISSUES_MAX,
} from "./commonIssuesPresentation";
import {
  buildManualUpsellMessage,
  buildUpgradeUpsellMessage,
  ChartPlaceholderFrame,
  NO_DATA_LABEL,
  SectionUpsellCallout,
} from "./EmptyState";
import type { PublicReportViewModel } from "./derive";

export function SalesSlide({ view }: { view: PublicReportViewModel }) {
  const { consultToCaseRate, data, effectiveSalesQuality, hasCasesData, hasConsultToCaseData, isPaidConsults, monthLabel, pipelineMomentumIndex, salesNoDataFlags, salesSection, salesTargetRate, sectionPresence, slideNumbers, t, trendData } = view;

  // Task #4693 — deck-wide no-data upsell convention (supersedes the Task
  // #4285 collapse): a fully-empty section renders its FULL slide skeleton
  // (muted "No data" slots, placeholder frames where charts would draw) and
  // ONE gold section callout carries the CaseIntake™ pitch. Hand-built
  // views without the presence map fail open (skeleton mode simply never
  // engages).
  const sectionEmpty = !(sectionPresence?.sales ?? true);

  return (
        <Slide slideNumber={slideNumbers.sales} variant="cream" pattern="dots" id="sales">
          {(() => {
            // Task #3688 — no toggle-gated "Data Not Provided" early-return;
            // each metric shows its value when entered and "No data"
            // otherwise (the only collapse is the presence-gated empty band
            // above, Task #4285).
            const salesData = {
              consultToCaseRate,
              consultType: (isPaidConsults ? 'paid' : 'free') as 'free' | 'paid',
              // Task #3688 — absent-or-flagged → null ("No data" card), never a
              // fabricated healthy-looking 0%; a stored 0 is a real measurement.
              // (The Pipeline Momentum card reads `pipelineMomentumIndex`, which
              // already resolves absent/0 to null — no defaulted copy here.)
              noShowRate: displayedSupportingMetric(salesSection?.data?.noShowRate, salesNoDataFlags.noShowRate, sectionHasEntryTracking(salesSection?.data), { clampAsPercent: true }),
              qualityScore: effectiveSalesQuality,
              noDataFlags: salesNoDataFlags as Record<string, boolean>,
            };

            // Task #2460 — band thresholds sourced from the shared
            // `@shared/commonIssuesSeverity` module (see intake wrapper). This
            // wrapper maps the shared band to the token color set (opaque card
            // tints — §8.2 paper field).
            const getConsultToCaseStatus = (rate: number, consultType: 'free' | 'paid') => {
              const level = getSalesSeverityBand(rate, consultType);
              const styles: Record<string, any> = {
                critical: { color: 'bg-report-critical', textColor: 'text-report-critical', bgColor: 'report-card-tint-critical', borderColor: 'border-report-critical/40' },
                big_issue: { color: 'bg-report-attention', textColor: 'text-report-attention', bgColor: 'report-card-tint-attention', borderColor: 'border-report-attention/40' },
                issue: { color: 'bg-report-watch', textColor: 'text-report-watch', bgColor: 'report-card-tint-watch', borderColor: 'border-report-watch/40' },
                healthy: { color: 'bg-report-healthy', textColor: 'text-report-healthy', bgColor: 'report-card-tint-healthy', borderColor: 'border-report-healthy/40' },
              };
              return { level, ...styles[level] };
            };

            const getSupportingStatus = (metric: string, value: number) => {
              if (metric === 'noShowRate') {
                if (value >= 45) return { level: 'critical', color: 'bg-report-critical', textColor: 'text-report-critical', bgColor: 'report-card-tint-critical', borderColor: 'border-report-critical/30' };
                if (value >= 35) return { level: 'big_issue', color: 'bg-report-attention', textColor: 'text-report-attention', bgColor: 'report-card-tint-attention', borderColor: 'border-report-attention/30' };
                if (value > 25) return { level: 'issue', color: 'bg-report-watch', textColor: 'text-report-watch', bgColor: 'report-card-tint-watch', borderColor: 'border-report-watch/30' };
                return { level: 'healthy', color: 'bg-report-healthy', textColor: 'text-report-healthy', bgColor: 'report-card-tint-healthy', borderColor: 'border-report-healthy/30' };
              }
              if (metric === 'avgFollowUpTouches') {
                if (value < 4) return { level: 'critical', color: 'bg-report-critical', textColor: 'text-report-critical', bgColor: 'report-card-tint-critical', borderColor: 'border-report-critical/30' };
                if (value < 8) return { level: 'big_issue', color: 'bg-report-attention', textColor: 'text-report-attention', bgColor: 'report-card-tint-attention', borderColor: 'border-report-attention/30' };
                if (value < 12) return { level: 'issue', color: 'bg-report-watch', textColor: 'text-report-watch', bgColor: 'report-card-tint-watch', borderColor: 'border-report-watch/30' };
                return { level: 'healthy', color: 'bg-report-healthy', textColor: 'text-report-healthy', bgColor: 'report-card-tint-healthy', borderColor: 'border-report-healthy/30' };
              }
              if (metric === 'qualityScore') {
                if (value < 65) return { level: 'critical', color: 'bg-report-critical', textColor: 'text-report-critical', bgColor: 'report-card-tint-critical', borderColor: 'border-report-critical/30' };
                if (value < 75) return { level: 'big_issue', color: 'bg-report-attention', textColor: 'text-report-attention', bgColor: 'report-card-tint-attention', borderColor: 'border-report-attention/30' };
                if (value < 85) return { level: 'issue', color: 'bg-report-watch', textColor: 'text-report-watch', bgColor: 'report-card-tint-watch', borderColor: 'border-report-watch/30' };
                return { level: 'healthy', color: 'bg-report-healthy', textColor: 'text-report-healthy', bgColor: 'report-card-tint-healthy', borderColor: 'border-report-healthy/30' };
              }
              return { level: 'healthy', color: 'bg-report-healthy', textColor: 'text-report-healthy', bgColor: 'report-card-tint-healthy', borderColor: 'border-report-healthy/30' };
            };

            // Task #3688 — when the core rate wasn't entered, the card goes
            // neutral instead of screaming Critical about a metric that
            // simply has no data (and per Task #4285 renders NO status tag).
            const coreStatus = hasConsultToCaseData
              ? getConsultToCaseStatus(salesData.consultToCaseRate, salesData.consultType)
              : { level: 'no_data', color: 'bg-report-neutral', textColor: 'text-report-ink-muted', bgColor: 'report-card-tint-neutral', borderColor: 'border-report-ink/10' };
            const noShowStatus = getSupportingStatus('noShowRate', salesData.noShowRate ?? 0);
            const qualityStatus = getSupportingStatus('qualityScore', salesData.qualityScore ?? 0);

            // Task #4285 — no 'no_data' label: absent metrics render no tag
            // at all (badge suppression), so labels only cover real levels.
            const statusLabel = (level: string) => {
              if (level === 'critical') return 'Critical';
              if (level === 'big_issue') return 'Needs Attention';
              if (level === 'issue') return 'Watch';
              return 'Healthy';
            };

            // §8.7-6 — Common Issues render as max-3 editorial bullets at a
            // 68ch measure. Quality gating happens at finalize (Task #4227);
            // the cap here is presentation-only. The bullet marker carries the
            // section's shared severity color, so color and AI tone agree.
            const issuesPresentation = parseCommonIssuesForPresentation(salesSection?.data?.commonIssues);
            const visibleIssues = issuesPresentation.kind === 'structured'
              ? issuesPresentation.issues.slice(0, PUBLIC_COMMON_ISSUES_MAX)
              : [];

            return (
              <>
                <div className="slide-header">
                  <TrendingUp className="slide-header-icon text-report-crimson" />
                  <h2 className="slide-title text-report-crimson">Sales Deep Dive</h2>
                  {/* Task #4285 — badge suppression: an un-entered core rate
                      renders NO header tag (the old neutral no-data badge
                      asserted a status the data can't back). */}
                  {coreStatus.level !== 'no_data' && (
                    <ReportStatusTag level={reportStatusLevelFromDomain(coreStatus.level)} label={statusLabel(coreStatus.level)} />
                  )}
                </div>
                {/* §8.1-1 — the slide opens with its stored verdict sentence. */}
                <VerdictLine verdict={data.slideVerdicts?.sales} slideKey="sales" className="mb-2 max-w-[68ch]" />
                <p className="slide-subtitle-light">How effectively are we converting qualified {t("leads").toLowerCase()} into signed clients?</p>
                <div className="divider-thin" />

                {/* Task #4693 — ONE gold callout per section when any data
                    point is missing; cases are manually reportable, so the
                    month-scoped "waiting on your count" variant wins whenever
                    cases are absent. Per-metric cards stay quiet "No data" —
                    the pitch is never repeated. */}
                {(!hasCasesData ||
                  !hasConsultToCaseData ||
                  salesData.noShowRate === null ||
                  salesData.noDataFlags?.qualityScore ||
                  salesData.qualityScore === null ||
                  pipelineMomentumIndex === null) && (
                  <SectionUpsellCallout
                    variant="light"
                    testId="upsell-sales"
                    message={
                      !hasCasesData
                        ? buildManualUpsellMessage(monthLabel, t("cases").toLowerCase())
                        : buildUpgradeUpsellMessage()
                    }
                  />
                )}

                {/* HERO — the slide's one big number (§8.1-2) */}
                <div className={`rounded-xl p-6 mb-6 border ${coreStatus.borderColor} ${coreStatus.bgColor}`} data-testid="core-metric-consult-to-case">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
                    <span className="report-eyebrow text-report-crimson">Core Metric</span>
                    <span className="report-eyebrow">{t("consults")} to {t("cases")} Rate · {isPaidConsults ? 'Paid' : 'Free'} {t("consults")}</span>
                  </div>
                  <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
                    <div className={`report-hero-metric ${coreStatus.textColor}`}>
                      {hasConsultToCaseData ? `${salesData.consultToCaseRate}%` : NO_DATA_LABEL}
                    </div>
                    <div className="pb-2 text-sm text-report-ink-muted">Target ≥{salesTargetRate}%</div>
                  </div>
                  <p className="text-sm text-report-ink-muted mt-2 max-w-[68ch]">
                    Percentage of consultations that convert to signed {t("cases").toLowerCase()}. Below {salesTargetRate}% indicates sales friction.
                  </p>
                </div>

                {/* SUPPORTING METRICS — compact evidence row under the hero */}
                <div className="mb-6">
                  <div className="report-eyebrow mb-2">Supporting Metrics</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {salesData.noShowRate === null ? (
                      <div className="rounded-lg p-4 border border-report-ink/10 report-card-tint-neutral" data-testid="stat-no-show-rate">
                        <div className="text-xs font-medium text-report-ink-muted mb-1">{t("noShowRate")}</div>
                        <div className="metric-large text-report-ink-muted">{NO_DATA_LABEL}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: ≤25% · % of booked {t("consults").toLowerCase()} where the lead didn't show</div>
                      </div>
                    ) : (
                      <div className={`rounded-lg p-4 border ${noShowStatus.borderColor} ${noShowStatus.bgColor}`} data-testid="stat-no-show-rate">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-medium text-report-ink-muted">{t("noShowRate")}</span>
                          <ReportStatusTag level={reportStatusLevelFromDomain(noShowStatus.level)} label={statusLabel(noShowStatus.level)} />
                        </div>
                        <div className={`metric-large ${noShowStatus.textColor}`}>{salesData.noShowRate}%</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: ≤25% · % of booked {t("consults").toLowerCase()} where the lead didn't show</div>
                      </div>
                    )}

                    {salesData.noDataFlags?.qualityScore || salesData.qualityScore === null ? (
                      <div className="rounded-lg p-4 border border-report-ink/10 report-card-tint-neutral" data-testid="stat-sales-quality-score">
                        <div className="text-xs font-medium text-report-ink-muted mb-1">Consult Execution Score</div>
                        <div className="metric-large text-report-ink-muted">{NO_DATA_LABEL}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: ≥85 · consultation skill and close outcome combined</div>
                      </div>
                    ) : (
                      <div className={`rounded-lg p-4 border ${qualityStatus.borderColor} ${qualityStatus.bgColor}`} data-testid="stat-sales-quality-score">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-medium text-report-ink-muted">Consult Execution Score</span>
                          <ReportStatusTag level={reportStatusLevelFromDomain(qualityStatus.level)} label={statusLabel(qualityStatus.level)} />
                        </div>
                        <div className={`metric-large ${qualityStatus.textColor}`}>{salesData.qualityScore}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: ≥85 · consultation skill and close outcome combined</div>
                      </div>
                    )}

                    {/* Task #4279 — BETA hedge removed (§8.7-6): the index is
                        presented as a first-class metric; thresholds unchanged. */}
                    {pipelineMomentumIndex !== null ? (
                      <div className={`rounded-lg p-4 border ${
                        pipelineMomentumIndex >= 70 ? 'border-report-healthy/30 report-card-tint-healthy' :
                        pipelineMomentumIndex >= 40 ? 'border-report-watch/30 report-card-tint-watch' :
                        'border-report-critical/30 report-card-tint-critical'
                      }`} data-testid="stat-pipeline-momentum-index">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-medium text-report-ink-muted">Pipeline Momentum Index</span>
                          <ReportStatusTag
                            level={pipelineMomentumIndex >= 70 ? 'healthy' : pipelineMomentumIndex >= 40 ? 'watch' : 'attention'}
                            label={pipelineMomentumIndex >= 70 ? 'Healthy' : pipelineMomentumIndex >= 40 ? 'Watch' : 'Needs Attention'}
                          />
                        </div>
                        <div className={`metric-large ${
                          pipelineMomentumIndex >= 70 ? 'text-report-healthy' :
                          pipelineMomentumIndex >= 40 ? 'text-report-watch' :
                          'text-report-critical'
                        }`}>{pipelineMomentumIndex}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: ≥70 · how aggressively open opportunities are pursued</div>
                      </div>
                    ) : (
                      <div className="rounded-lg p-4 border border-report-ink/10 report-card-tint-neutral" data-testid="stat-pipeline-momentum-index">
                        <div className="text-xs font-medium text-report-ink-muted mb-1">Pipeline Momentum Index</div>
                        <div className="metric-large text-report-ink-muted">{NO_DATA_LABEL}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: ≥70 · how aggressively open opportunities are pursued</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* COMMON ISSUES — max-3 bullets, 68ch (§8.7-6) */}
                <div className="card-light rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <AlertCircle className="w-4 h-4 text-report-crimson" />
                    <span className="report-eyebrow">Common Issues</span>
                  </div>
                  {issuesPresentation.kind === 'empty' ? (
                    <p className="text-sm text-report-ink-muted italic">No issues identified</p>
                  ) : issuesPresentation.kind === 'prose' ? (
                    <div className="text-sm leading-relaxed text-report-ink max-w-[68ch] [&_p]:my-1" data-testid="sales-issues-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{issuesPresentation.markdown}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="max-w-[68ch]" data-testid="sales-issues-list">
                      {issuesPresentation.intro ? (
                        <p className="text-sm leading-relaxed text-report-ink-muted italic mb-4" data-testid="sales-issues-intro">{issuesPresentation.intro}</p>
                      ) : null}
                      <ul className="space-y-4">
                        {visibleIssues.map((issue, i) => (
                          <li key={i} className="flex gap-4" data-testid={`sales-issue-bullet-${i}`}>
                            <span className={`mt-2 h-2 w-2 shrink-0 rounded-sm ${coreStatus.color}`} aria-hidden="true" />
                            <div className="text-sm leading-relaxed">
                              <p className="font-medium text-report-ink">{issue.issue}</p>
                              {issue.impact ? <p className="text-report-ink-muted">{issue.impact}</p> : null}
                              {issue.fix ? <p className="text-report-crimson"><span className="font-semibold">Fix:</span> {issue.fix}</p> : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Sales Trend Charts — Task #4693: with the section fully
                    empty and no trend months, render a quiet placeholder
                    frame where the charts would draw (TrendsSection returns
                    null there; never fabricate zero-value charts). */}
                {sectionEmpty && (!trendData || trendData.length < 1) ? (
                  <ChartPlaceholderFrame
                    variant="light"
                    testId="chart-placeholder-sales"
                    label={`Monthly trend charts for ${t("cases").toLowerCase()}, conversion rate, and ${t("averageCaseValue").toLowerCase()} draw here once this data is tracked.`}
                  />
                ) : (
                  <TrendsSection
                    trendData={trendData}
                    section="sales"
                    metrics={[
                      { key: 'totalCases', label: t("cases"), unit: '' },
                      { key: 'consultToCaseRate', label: `${t("consults")}→${t("cases")}`, unit: '%' },
                      { key: 'avgCaseValue', label: t("averageCaseValue"), unit: '$' },
                      { key: 'noShowRate', label: t("noShowRate"), unit: '%', lowerIsBetter: true },
                      { key: 'pipelineMomentumScore', label: 'Pipeline Momentum', unit: '' },
                      { key: 'effectiveSalesQuality', label: 'Consult Execution Score', unit: '' },
                    ]}
                  />
                )}
              </>
            );
          })()}
        </Slide>
  );
}
