/**
 * IntakeSlide — one slide of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 2654–2876 @ d31d7c0c7, Task #4271).
 *
 * Task #4279 (audit §8.7-6): redesigned as an editorial brief on the paper
 * surface — charcoal demoted per §8.1, VerdictLine opener, one hero number,
 * token type scale (11px strings → 12px caption floor, Montserrat metrics),
 * Common Issues as max-3 bullets at a 68ch measure. Data semantics are
 * unchanged: Task #3688 No-Data gating and the Task #2460 shared severity
 * bands (`@shared/commonIssuesSeverity` stays the ONLY threshold source, so
 * UI color and AI tone keep agreeing).
 */

import { TrendingUp, AlertCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { displayedSupportingMetric, sectionHasEntryTracking } from "@shared/reportMetrics";
import { getIntakeSeverityBand } from "@shared/commonIssuesSeverity";
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

export function IntakeSlide({ view }: { view: PublicReportViewModel }) {
  const { correctedTrendData, data, displayedMissedCallRate, hasConsultsData, hasLeadToConsultData, intakeExecutionScore, intakeNoDataFlags, intakeSection, intakeTargetRate, isPaidConsults, leadToConsultRate, monthLabel, sectionPresence, slideNumbers, t } = view;

  // Task #4693 — deck-wide no-data upsell convention (supersedes the Task
  // #4285 collapse): a fully-empty section renders its FULL slide skeleton
  // (muted "No data" slots, placeholder frames where charts would draw) and
  // ONE gold section callout carries the CaseIntake™ pitch. Hand-built
  // views without the presence map fail open (skeleton mode simply never
  // engages).
  const sectionEmpty = !(sectionPresence?.intake ?? true);

  return (
        <Slide slideNumber={slideNumbers.intake} variant="beige" pattern="geometric" id="intake">
          {(() => {
            // Task #3688 — no toggle-gated "Data Not Provided" early-return;
            // each metric shows its value when entered and "No data"
            // otherwise (the only collapse is the presence-gated empty band
            // above, Task #4285).
            const intakeData = {
              leadToConsultRate,
              consultType: (isPaidConsults ? 'paid' : 'free') as 'free' | 'paid',
              // Task #4983 — missed-call data is PUSHED from client call
              // reporting (or typed), so the card shows the shared three-tier
              // resolution: bucket-evidence recompute, else a pushed stored
              // rate > 0, else null → "No data" (no status chip) — never a
              // fabricated healthy 0% recomputed off structural-default
              // buckets.
              missedCallRate: displayedMissedCallRate,
              // Task #3688 — absent-or-flagged → null ("No data" card), never a
              // fabricated healthy-looking 0; an ENTERED 0 is a real
              // measurement, but a legacy section's blank-coerced 0 (no entry
              // tracking) is not.
              avgTimeToAnswer: displayedSupportingMetric(intakeSection?.data?.avgTimeToAnswer, intakeNoDataFlags.avgTimeToAnswer, sectionHasEntryTracking(intakeSection?.data)),
              qualityScore: intakeExecutionScore,
              noDataFlags: intakeNoDataFlags as Record<string, boolean>,
            };

            // Task #2460 — band thresholds now live in the shared
            // `@shared/commonIssuesSeverity` module so the report UI and the
            // server Common Issues formatter classify identically. This wrapper
            // maps the shared band to the token color set (opaque card tints —
            // §8.2 paper field).
            const getLeadToConsultStatus = (rate: number, consultType: 'free' | 'paid') => {
              const level = getIntakeSeverityBand(rate, consultType);
              const styles: Record<string, any> = {
                critical: { color: 'bg-report-critical', textColor: 'text-report-critical', bgColor: 'report-card-tint-critical', borderColor: 'border-report-critical/40' },
                big_issue: { color: 'bg-report-attention', textColor: 'text-report-attention', bgColor: 'report-card-tint-attention', borderColor: 'border-report-attention/40' },
                issue: { color: 'bg-report-watch', textColor: 'text-report-watch', bgColor: 'report-card-tint-watch', borderColor: 'border-report-watch/40' },
                healthy: { color: 'bg-report-healthy', textColor: 'text-report-healthy', bgColor: 'report-card-tint-healthy', borderColor: 'border-report-healthy/40' },
              };
              return { level, ...styles[level] };
            };

            const getSupportingStatus = (metric: string, value: number) => {
              if (metric === 'missedCallRate') {
                if (value > 20) return { level: 'critical', color: 'bg-report-critical', textColor: 'text-report-critical', bgColor: 'report-card-tint-critical', borderColor: 'border-report-critical/30' };
                if (value > 15) return { level: 'big_issue', color: 'bg-report-attention', textColor: 'text-report-attention', bgColor: 'report-card-tint-attention', borderColor: 'border-report-attention/30' };
                if (value > 10) return { level: 'issue', color: 'bg-report-watch', textColor: 'text-report-watch', bgColor: 'report-card-tint-watch', borderColor: 'border-report-watch/30' };
                return { level: 'healthy', color: 'bg-report-healthy', textColor: 'text-report-healthy', bgColor: 'report-card-tint-healthy', borderColor: 'border-report-healthy/30' };
              }
              if (metric === 'avgTimeToAnswer') {
                if (value > 20) return { level: 'critical', color: 'bg-report-critical', textColor: 'text-report-critical', bgColor: 'report-card-tint-critical', borderColor: 'border-report-critical/30' };
                if (value > 15) return { level: 'big_issue', color: 'bg-report-attention', textColor: 'text-report-attention', bgColor: 'report-card-tint-attention', borderColor: 'border-report-attention/30' };
                if (value > 10) return { level: 'issue', color: 'bg-report-watch', textColor: 'text-report-watch', bgColor: 'report-card-tint-watch', borderColor: 'border-report-watch/30' };
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
            const coreStatus = hasLeadToConsultData
              ? getLeadToConsultStatus(intakeData.leadToConsultRate, intakeData.consultType)
              : { level: 'no_data', color: 'bg-report-neutral', textColor: 'text-report-ink-muted', bgColor: 'report-card-tint-neutral', borderColor: 'border-report-ink/10' };
            const missedStatus = getSupportingStatus('missedCallRate', intakeData.missedCallRate ?? 0);
            const timeStatus = getSupportingStatus('avgTimeToAnswer', intakeData.avgTimeToAnswer ?? 0);
            const qualityStatus = getSupportingStatus('qualityScore', intakeData.qualityScore ?? 0);

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
            const issuesPresentation = parseCommonIssuesForPresentation(intakeSection?.data?.commonIssues);
            const visibleIssues = issuesPresentation.kind === 'structured'
              ? issuesPresentation.issues.slice(0, PUBLIC_COMMON_ISSUES_MAX)
              : [];

            return (
              <>
                <div className="slide-header">
                  <TrendingUp className="slide-header-icon text-report-crimson" />
                  <h2 className="slide-title text-report-crimson">Intake Deep Dive</h2>
                  {/* Task #4285 — badge suppression: an un-entered core rate
                      renders NO header tag (the old neutral no-data badge
                      asserted a status the data can't back). */}
                  {coreStatus.level !== 'no_data' && (
                    <ReportStatusTag level={reportStatusLevelFromDomain(coreStatus.level)} label={statusLabel(coreStatus.level)} />
                  )}
                </div>
                {/* §8.1-1 — the slide opens with its stored verdict sentence. */}
                <VerdictLine verdict={data.slideVerdicts?.intake} slideKey="intake" className="mb-2 max-w-[68ch]" />
                <p className="slide-subtitle-light">How well are we capturing and qualifying inbound opportunities?</p>
                <div className="divider-thin" />

                {/* Task #4693 — ONE gold callout per section when any data
                    point is missing; consults are manually reportable, so the
                    month-scoped "waiting on your count" variant wins whenever
                    consults are absent. Per-metric cards stay quiet "No data"
                    — the pitch is never repeated. */}
                {(!hasConsultsData ||
                  !hasLeadToConsultData ||
                  intakeData.missedCallRate === null ||
                  intakeData.avgTimeToAnswer === null ||
                  intakeData.noDataFlags?.qualityScore ||
                  intakeData.qualityScore === null) && (
                  <SectionUpsellCallout
                    variant="light"
                    testId="upsell-intake"
                    message={
                      !hasConsultsData
                        ? buildManualUpsellMessage(monthLabel, t("consults").toLowerCase())
                        : buildUpgradeUpsellMessage()
                    }
                  />
                )}

                {/* HERO — the slide's one big number (§8.1-2) */}
                <div className={`rounded-xl p-6 mb-6 border ${coreStatus.borderColor} ${coreStatus.bgColor}`} data-testid="core-metric-lead-to-consult">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
                    <span className="report-eyebrow text-report-crimson">Core Metric</span>
                    <span className="report-eyebrow">{t("leads")} to {t("consults")} Rate · {isPaidConsults ? 'Paid' : 'Free'} {t("consults")}</span>
                  </div>
                  <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
                    <div className={`report-hero-metric ${coreStatus.textColor}`}>
                      {hasLeadToConsultData ? `${intakeData.leadToConsultRate}%` : NO_DATA_LABEL}
                    </div>
                    <div className="pb-2 text-sm text-report-ink-muted">Target ≥{intakeTargetRate}%</div>
                  </div>
                  <p className="text-sm text-report-ink-muted mt-2 max-w-[68ch]">
                    Percentage of {t("leads").toLowerCase()} that book a {isPaidConsults ? 'paid' : 'free'} consultation. Below {intakeTargetRate}% indicates intake friction.
                  </p>
                </div>

                {/* SUPPORTING METRICS — compact evidence row under the hero */}
                <div className="mb-6">
                  <div className="report-eyebrow mb-2">Supporting Metrics</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {intakeData.missedCallRate === null ? (
                      <div className="rounded-lg p-4 border border-report-ink/10 report-card-tint-neutral" data-testid="stat-missed-call-rate">
                        <div className="text-xs font-medium text-report-ink-muted mb-1">{t("missedCallRate")}</div>
                        <div className="metric-large text-report-ink-muted">{NO_DATA_LABEL}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: &lt;10% · % of inbound calls that went unanswered</div>
                      </div>
                    ) : (
                      <div className={`rounded-lg p-4 border ${missedStatus.borderColor} ${missedStatus.bgColor}`} data-testid="stat-missed-call-rate">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-medium text-report-ink-muted">{t("missedCallRate")}</span>
                          <ReportStatusTag level={reportStatusLevelFromDomain(missedStatus.level)} label={statusLabel(missedStatus.level)} />
                        </div>
                        <div className={`metric-large ${missedStatus.textColor}`}>{intakeData.missedCallRate}%</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: &lt;10% · % of inbound calls that went unanswered</div>
                      </div>
                    )}

                    {intakeData.avgTimeToAnswer === null ? (
                      <div className="rounded-lg p-4 border border-report-ink/10 report-card-tint-neutral" data-testid="stat-avg-time-to-answer">
                        <div className="text-xs font-medium text-report-ink-muted mb-1">Avg Time to Human Answer</div>
                        <div className="metric-large text-report-ink-muted">{NO_DATA_LABEL}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: &lt;10s · how fast calls are answered by a human</div>
                      </div>
                    ) : (
                      <div className={`rounded-lg p-4 border ${timeStatus.borderColor} ${timeStatus.bgColor}`} data-testid="stat-avg-time-to-answer">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-medium text-report-ink-muted">Avg Time to Human Answer</span>
                          <ReportStatusTag level={reportStatusLevelFromDomain(timeStatus.level)} label={statusLabel(timeStatus.level)} />
                        </div>
                        {/* Task #4287 — whole seconds on display ("11s", never "10.99s");
                            status math upstream keeps the raw value. */}
                        <div className={`metric-large ${timeStatus.textColor}`}>{Math.round(intakeData.avgTimeToAnswer)}s</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: &lt;10s · how fast calls are answered by a human</div>
                      </div>
                    )}

                    {intakeData.noDataFlags?.qualityScore || intakeData.qualityScore === null ? (
                      <div className="rounded-lg p-4 border border-report-ink/10 report-card-tint-neutral" data-testid="stat-quality-score">
                        <div className="text-xs font-medium text-report-ink-muted mb-1">Intake Execution Score</div>
                        <div className="metric-large text-report-ink-muted">{NO_DATA_LABEL}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: ≥85 · intake skill and conversion outcome combined</div>
                      </div>
                    ) : (
                      <div className={`rounded-lg p-4 border ${qualityStatus.borderColor} ${qualityStatus.bgColor}`} data-testid="stat-quality-score">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-xs font-medium text-report-ink-muted">Intake Execution Score</span>
                          <ReportStatusTag level={reportStatusLevelFromDomain(qualityStatus.level)} label={statusLabel(qualityStatus.level)} />
                        </div>
                        <div className={`metric-large ${qualityStatus.textColor}`}>{intakeData.qualityScore}</div>
                        <div className="text-xs text-report-ink-muted mt-1">Target: ≥85 · intake skill and conversion outcome combined</div>
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
                    <div className="text-sm leading-relaxed text-report-ink max-w-[68ch] [&_p]:my-1" data-testid="intake-issues-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{issuesPresentation.markdown}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="max-w-[68ch]" data-testid="intake-issues-list">
                      {issuesPresentation.intro ? (
                        <p className="text-sm leading-relaxed text-report-ink-muted italic mb-4" data-testid="intake-issues-intro">{issuesPresentation.intro}</p>
                      ) : null}
                      <ul className="space-y-4">
                        {visibleIssues.map((issue, i) => (
                          <li key={i} className="flex gap-4" data-testid={`intake-issue-bullet-${i}`}>
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

                {/* Intake Trend Charts — Task #4693: with the section fully
                    empty and no trend months, render a quiet placeholder
                    frame where the charts would draw (TrendsSection returns
                    null there; never fabricate zero-value charts). */}
                {sectionEmpty && (!correctedTrendData || correctedTrendData.length < 1) ? (
                  <ChartPlaceholderFrame
                    variant="light"
                    testId="chart-placeholder-intake"
                    label={`Monthly trend charts for ${t("leads").toLowerCase()}, ${t("consults").toLowerCase()}, and intake speed draw here once this data is tracked.`}
                  />
                ) : (
                  <TrendsSection
                    trendData={correctedTrendData}
                    section="intake"
                    metrics={[
                      { key: 'totalConsults', label: t("consults"), unit: '' },
                      { key: 'leadToConsultRate', label: `${t("leads")}→${t("consults")}`, unit: '%' },
                      { key: 'missedCallRate', label: t("missedCallRate"), unit: '%', lowerIsBetter: true },
                      { key: 'avgTimeToAnswer', label: 'Avg Time to Human Answer', unit: 's', lowerIsBetter: true },
                      { key: 'intakeExecutionScore', label: 'Intake Execution Score', unit: '' },
                    ]}
                  />
                )}
              </>
            );
          })()}
        </Slide>
  );
}
