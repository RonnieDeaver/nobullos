/**
 * CeoPulseSlide — one slide of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 2294–2406 @ d31d7c0c7, Task #4271).
 *
 * Task #4276 (§8.7-3 design-audit residuals) — the "By The Numbers" card is
 * capped at TWO charts plus ONE insight paragraph (deriveCeoPulseSlideContent
 * keeps each chart's "Source: …" attribution as its legible source line and
 * promotes the first chart's prose to the single paragraph). Display strings
 * come from the centralized NOBULL_BRIEF_STRINGS module so a future rename
 * lands in one place.
 */

import { Eye, MoveRight } from "lucide-react";
import { ceoPulseEditionLabel } from "@shared/schema";
import { ReportProductUpdatesBlock } from "@/components/ReportProductUpdates";
import CeoPulseChartRenderer from "@/components/CeoPulseChartRenderer";
import { deriveCeoPulseSlideContent } from "@/components/ceoPulseSlideContent";
import { NOBULL_BRIEF_STRINGS } from "@/components/ceoPulseCopy";
import { deriveRoadmapContent, roadmapCategoryLabel, roadmapCategoryIcon } from "@/components/ceoPulseRoadmap";
import { Slide } from "./Slide";
import { REPORT_CEO_PULSE_CHART_PALETTE } from "./reportTokens";
import type { PublicReportViewModel } from "./derive";

/** Task #4813 — name-first split of a takeaway/implication for the
 *  company-update announcement layout. Legacy string items surface whole as
 *  the lead; overlong legacy details render contained (clamped) until the
 *  brief is re-analyzed. `status` is an additive optional aiAnalysis field —
 *  absent on every legacy row. Compact twin of the helper in
 *  CeoPulseVisual.tsx (the deck slide is a deliberately separate
 *  implementation; keep the two split rules in sync). */
function announcementParts(item: string | { highlight?: string; detail?: string }): { lead: string; detail: string; url?: string; status?: string } {
  if (typeof item === 'string') return { lead: item, detail: '' };
  const rawUrl = (item as any).url;
  const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
  const rawStatus = (item as any).status;
  const status = typeof rawStatus === 'string' && rawStatus.trim().length > 0 ? rawStatus.trim() : undefined;
  return item.highlight
    ? { lead: item.highlight, detail: item.detail || '', url, status }
    : { lead: item.detail || '', detail: '', url, status };
}

export function CeoPulseSlide({ view }: { view: PublicReportViewModel }) {
  const { ceoPulse, data, monthLabel, productUpdates, report, slideNumbers } = view;
  // Root renders this component only under `hasCeoPulse && ceoPulse?.aiAnalysis` —
  // this guard re-establishes that narrowing for TypeScript (behaviorally inert).
  if (!ceoPulse?.aiAnalysis) return null;
  // Task #4834 / #4984 — freshly analyzed company updates carry
  // roadmap-template fields and render a compact deck twin of the roadmap
  // layout (snapshot → why this matters → pull quote; hook-free derivation;
  // legacy rows keep the Task #4813 layout below).
  const roadmap = deriveRoadmapContent(ceoPulse.aiAnalysis);
  const slideShowCharts = (ceoPulse.includeGraphs !== false)
    && Array.isArray(ceoPulse.aiAnalysis?.charts)
    && ((ceoPulse.aiAnalysis?.charts?.length || 0) > 0);
  const isRoadmapSlide = !slideShowCharts && ceoPulse.edition === 'company_update' && roadmap.isRoadmap;
  return (
          <Slide slideNumber={slideNumbers.ceoPulse} variant="charcoal" pattern="lines" id="ceo-pulse">
            <div className="slide-header">
              <Eye className="slide-header-icon text-report-gold" />
              <h2 className="slide-title text-white">{NOBULL_BRIEF_STRINGS.title}</h2>
              {ceoPulseEditionLabel(ceoPulse.edition) && (
                <span
                  className="ml-2 inline-flex items-center self-center rounded border border-report-gold/50 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.15em] text-report-gold"
                  data-testid="tag-edition-report"
                >
                  {ceoPulseEditionLabel(ceoPulse.edition)}
                </span>
              )}
            </div>
            <p className="slide-subtitle-dark">{NOBULL_BRIEF_STRINGS.tagline}</p>
            <div className="divider-thin" />

            <div className="space-y-6">
              {/* Headline */}
              <div className="bg-report-crimson text-white rounded-lg p-6 shadow-md">
                {isRoadmapSlide && (
                  <p className="text-white/80 text-xs font-medium uppercase tracking-[0.25em] mb-2" data-testid="text-roadmap-kicker">{NOBULL_BRIEF_STRINGS.roadmapKicker}</p>
                )}
                <h3 className="metric-large" data-testid="text-ceo-headline">{ceoPulse.aiAnalysis.headline}</h3>
                {isRoadmapSlide && roadmap.supportingLine && (
                  <p className="text-white/80 text-sm mt-2 leading-relaxed" data-testid="text-supporting-line">{roadmap.supportingLine}</p>
                )}
                {monthLabel && (
                  <p className="text-white/60 text-sm mt-2">{monthLabel} Data</p>
                )}
              </div>

              {/* Two Column Layout - Content Left, Chart Right (single column when no graphs) */}
              {(() => {
                const showCeoCharts = (ceoPulse.includeGraphs !== false)
                  && Array.isArray(ceoPulse.aiAnalysis?.charts)
                  && (ceoPulse.aiAnalysis?.charts?.length || 0) > 0;
                // Task #4813 — company-update announcement layout (compact
                // deck parity with CeoPulseVisual): name-first initiative grid
                // + short commitment statements instead of the stacked bullet
                // columns. Static settled render (no animations) and
                // break-inside-avoid tiles keep it print-safe. Market-shift /
                // legacy text-only briefs keep the stacked layout below
                // byte-for-byte; report token classes only (no stock hexes).
                if (!showCeoCharts && ceoPulse.edition === 'company_update') {
                  // Task #4834 / #4984 — roadmap-template deck twin: update
                  // snapshot cards → why this matters (short lead + skimmable
                  // bullets, paragraph fallback for legacy rows) → pull
                  // quote, compacted for print (static render,
                  // break-inside-avoid cards, report tokens only, no sub-12px
                  // type). The retired Before & After / What's Coming Next
                  // bands never render, even when a stored legacy analysis
                  // still carries those fields. Renders only when the
                  // analysis carries roadmap fields; legacy rows keep the
                  // announcement layout below.
                  if (roadmap.isRoadmap) {
                    return (
                      <div className="grid grid-cols-1 gap-6">
                        {(ceoPulse.aiAnalysis.keyTakeaways || []).filter(Boolean).length > 0 && (
                          <div className="card-light p-6 break-inside-avoid" data-testid="roadmap-snapshot">
                            <div className="section-label-light mb-4">{NOBULL_BRIEF_STRINGS.roadmapSnapshotLabel}</div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              {(ceoPulse.aiAnalysis.keyTakeaways || []).filter(Boolean).map((takeaway, i) => {
                                const { lead, detail, status } = announcementParts(takeaway);
                                if (!lead) return null;
                                const category = roadmapCategoryLabel(takeaway);
                                const Icon = roadmapCategoryIcon(category);
                                return (
                                  <div key={i} className="border border-report-ink/10 bg-white p-4 break-inside-avoid" data-testid={`snapshot-card-${i}`}>
                                    <div className="flex items-center justify-between gap-2 mb-2">
                                      {category ? (
                                        <span className="text-report-ink-muted text-xs font-semibold uppercase tracking-[0.15em]" data-testid={`snapshot-category-${i}`}>{category}</span>
                                      ) : (
                                        <span aria-hidden="true" />
                                      )}
                                      {Icon ? (
                                        <Icon className="w-5 h-5 text-report-crimson shrink-0" aria-hidden="true" data-testid={`snapshot-icon-${i}`} />
                                      ) : (
                                        <span className="text-report-crimson/40 text-xl font-bold leading-none" data-testid={`snapshot-number-${i}`}>{String(i + 1).padStart(2, '0')}</span>
                                      )}
                                    </div>
                                    <h4 className="text-report-ink text-sm font-semibold leading-snug">{lead}</h4>
                                    {detail && <p className="text-report-ink-muted text-xs leading-relaxed mt-1 line-clamp-3">{detail}</p>}
                                    {status && (
                                      <span
                                        className="mt-2 inline-flex items-center rounded-full bg-report-crimson/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.1em] text-report-crimson"
                                        data-testid={`snapshot-status-${i}`}
                                      >
                                        {status}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {(roadmap.whyBullets.length > 0 || roadmap.whyParagraphs.length > 0) && (
                          <div className="card-light p-6 break-inside-avoid" data-testid="roadmap-why">
                            <div className="section-label-light mb-3">{NOBULL_BRIEF_STRINGS.roadmapWhyLabel}</div>
                            {roadmap.whyBullets.length > 0 ? (
                              /* Task #4984 — skimmable shape: one short lead
                                 paragraph plus the bullets that absorbed the
                                 retired Before & After / What's Coming Next
                                 bands' job. */
                              <>
                                {roadmap.whyLead && (
                                  <p className="text-report-ink text-sm leading-relaxed mb-3" data-testid="why-lead">{roadmap.whyLead}</p>
                                )}
                                <ul className="space-y-2">
                                  {roadmap.whyBullets.map((bullet, i) => (
                                    <li key={i} className="text-report-ink text-sm leading-relaxed flex items-start gap-2 break-inside-avoid" data-testid={`why-bullet-${i}`}>
                                      <span className="text-report-crimson mt-0.5 font-bold" aria-hidden="true">•</span>
                                      <span>{bullet}</span>
                                    </li>
                                  ))}
                                </ul>
                              </>
                            ) : (
                              /* Legacy rows that predate whyBullets keep the
                                 paragraph rendering unchanged. */
                              <div className="space-y-3">
                                {roadmap.whyParagraphs.map((paragraph, i) => (
                                  <p key={i} className="text-report-ink text-sm leading-relaxed" data-testid={`why-paragraph-${i}`}>{paragraph}</p>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {roadmap.pullQuote && (
                          <div className="bg-report-crimson text-white p-6 text-center break-inside-avoid shadow-md" data-testid="roadmap-pull-quote">
                            <p className="text-white/70 text-xs font-medium uppercase tracking-[0.25em] mb-2">{NOBULL_BRIEF_STRINGS.roadmapPullQuoteLabel}</p>
                            <blockquote className="report-display font-report-serif text-xl leading-snug">
                              {'\u201C'}{roadmap.pullQuote}{'\u201D'}
                            </blockquote>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div className="grid grid-cols-1 gap-6">
                      <div className="card-light p-6 break-inside-avoid">
                        <div className="section-label-light mb-4">{NOBULL_BRIEF_STRINGS.updateInitiativesLabel}</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-5">
                          {(ceoPulse.aiAnalysis.keyTakeaways || []).filter(Boolean).map((takeaway, i) => {
                            const { lead, detail, url, status } = announcementParts(takeaway);
                            if (!lead) return null;
                            return (
                              <div key={i} className="border-t-2 border-report-gold pt-2.5 break-inside-avoid" data-testid={`initiative-card-${i}`}>
                                <div className="flex items-start justify-between gap-2">
                                  <h4 className="text-report-ink text-sm font-semibold leading-snug">{lead}</h4>
                                  {status && (
                                    <span
                                      className="shrink-0 inline-flex items-center rounded-full bg-report-crimson/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.1em] text-report-crimson"
                                      data-testid={`initiative-status-${i}`}
                                    >
                                      {status}
                                    </span>
                                  )}
                                </div>
                                {/* Legacy overlong details render contained: title-first, clamped support. */}
                                {detail && <p className="text-report-ink-muted text-xs leading-relaxed mt-1 line-clamp-3">{detail}</p>}
                                {url && (
                                  <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1.5 text-report-crimson text-xs font-medium hover:underline inline-flex items-center gap-1">
                                    Learn More <span className="text-xs">→</span>
                                  </a>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div className="card-light p-6 break-inside-avoid">
                        <div className="section-label-light mb-4">{NOBULL_BRIEF_STRINGS.updateCommitmentsLabel}</div>
                        <ul className="space-y-3">
                          {(ceoPulse.aiAnalysis.strategicImplications || []).filter(Boolean).map((implication, i) => {
                            const { lead, detail } = announcementParts(implication);
                            if (!lead) return null;
                            return (
                              <li key={i} className="flex items-start gap-2" data-testid={`commitment-${i}`}>
                                <MoveRight className="w-4 h-4 text-report-crimson mt-0.5 shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-report-ink text-sm font-semibold leading-snug">{lead}</p>
                                  {detail && <p className="text-report-ink-muted text-xs leading-relaxed mt-0.5 line-clamp-2">{detail}</p>}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </div>
                  );
                }
                return (
              <div className={showCeoCharts ? "grid grid-cols-1 lg:grid-cols-2 gap-6" : "grid grid-cols-1 gap-6"}>
                {/* Left Column: Key Takeaways & Implications */}
                <div className="space-y-6">
                  {/* Key Takeaways Card */}
                  <div className="card-light p-6">
                    <div className="section-label-light mb-4">Key Takeaways</div>
                    <ul className="space-y-2">
                      {(ceoPulse.aiAnalysis.keyTakeaways || []).filter(Boolean).map((takeaway, i) => {
                        const text = typeof takeaway === 'object' && takeaway.highlight
                          ? `${takeaway.highlight} ${takeaway.detail || ''}`
                          : (typeof takeaway === 'string' ? takeaway : '');
                        const rawUrl = typeof takeaway === 'object' && (takeaway as any).url ? (takeaway as any).url : undefined;
                        const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
                        const parts = text.split(/(\d+%|\d+x)/);
                        return (
                          <li key={i} className="text-report-ink text-sm leading-relaxed flex items-start gap-2" data-testid={`text-takeaway-${i}`}>
                            <span className="text-report-crimson mt-1 font-bold">•</span>
                            <span>
                              {parts.map((part, j) => 
                                /\d+%|\d+x/.test(part) ? <strong key={j} className="text-report-crimson">{part}</strong> : part
                              )}
                              {url && (
                                <a href={url} target="_blank" rel="noopener noreferrer" className="ml-2 text-report-crimson text-xs font-medium hover:underline inline-flex items-center gap-1">
                                  Learn More <span className="text-[11px]">→</span>
                                </a>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  {/* Strategic Implications Card */}
                  <div className="card-light p-6">
                    <div className="section-label-light mb-4">What This Means</div>
                    <ul className="space-y-2">
                      {(ceoPulse.aiAnalysis.strategicImplications || []).filter(Boolean).map((implication, i) => {
                        const text = typeof implication === 'object' && implication.highlight
                          ? `${implication.highlight} ${implication.detail || ''}`
                          : (typeof implication === 'string' ? implication : '');
                        const words = text.split(' ');
                        const firstTwo = words.slice(0, 2).join(' ');
                        const rest = words.slice(2).join(' ');
                        return (
                          <li key={i} className="text-report-ink text-sm leading-relaxed flex items-start gap-2" data-testid={`text-implication-${i}`}>
                            <MoveRight className="w-4 h-4 text-report-crimson mt-1 shrink-0" />
                            <span><strong>{firstTwo}</strong> {rest}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>

                {/* Right Column: Data Visualizations (only when graphs enabled & present).
                    §8.7-3 — at most two charts + one insight paragraph; each
                    chart keeps its own "Source: …" attribution line. */}
                {showCeoCharts && (() => {
                  const { charts: slideCharts, insight } = deriveCeoPulseSlideContent(ceoPulse.aiAnalysis!.charts || []);
                  return (
                    <div className="card-light p-6">
                      <div className="section-label-light mb-4">By The Numbers</div>
                      {/* animate={false} (Task #4286, audit #28): the deck's
                          mini-chart grid renders settled — recharts entry
                          animations batch on tall slides and double-paint in
                          print. Internal previews keep the default. */}
                      {/* palette (Task #4414): the shared renderer keeps its
                          stock OS colors everywhere else; inside the report
                          it rides the --report-* brand palette. */}
                      <CeoPulseChartRenderer charts={slideCharts} animate={false} palette={REPORT_CEO_PULSE_CHART_PALETTE} />
                      {insight && (
                        <p
                          className="text-report-ink text-sm leading-relaxed mt-4 pt-4 border-t border-report-crimson/10"
                          data-testid="text-ceo-pulse-insight"
                        >
                          {insight}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
                );
              })()}

              {/* Task #4216 — live product-roadmap block: what's shipping
                  this quarter (bars tick via useNow at render time) plus
                  recent completions. Server sends null when nothing
                  qualifies or the report has no CEO Pulse. */}
              {productUpdates && <ReportProductUpdatesBlock updates={productUpdates} />}

              {ceoPulse.fullLetterHtml && ceoPulse.shareToken && (
                <div className="mt-6">
                  <a
                    href={`/pulse/${ceoPulse.shareToken}/letter`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block bg-gradient-to-r from-report-crimson to-report-crimson-deep rounded-lg p-6 text-center hover:from-report-crimson hover:to-report-crimson-shadow transition-all group shadow-md"
                    data-testid="link-full-letter-report"
                  >
                    <p className="text-white/60 text-xs uppercase tracking-widest mb-1">{NOBULL_BRIEF_STRINGS.letterCtaEyebrow}</p>
                    <p className="text-white text-lg font-semibold group-hover:tracking-wide transition-all">
                      {NOBULL_BRIEF_STRINGS.letterCtaLabel} <span className="inline-block group-hover:translate-x-1 transition-transform">→</span>
                    </p>
                  </a>
                </div>
              )}
            </div>
          </Slide>
  );
}
