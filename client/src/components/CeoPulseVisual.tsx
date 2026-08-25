import { motion, useReducedMotion } from "framer-motion";
import { Eye, MoveRight, AlertCircle } from "lucide-react";
import { ceoPulseEditionLabel, CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS } from "@shared/schema";
import CeoPulseChartRenderer, { type CeoPulseChart, type CeoPulseChartPalette } from "./CeoPulseChartRenderer";
import { NOBULL_BRIEF_STRINGS } from "./ceoPulseCopy";
import { deriveRoadmapContent, roadmapCategoryLabel, roadmapCategoryIcon } from "./ceoPulseRoadmap";

function parseMarkdownBold(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

type TakeawayItem = string | { highlight: string; detail: string; url?: string; status?: string; category?: string };

/** Task #4813 — name-first split of a takeaway/implication for the
 *  company-update announcement layout. Legacy string items surface whole as
 *  the lead; overlong legacy details render contained (clamped) until the
 *  brief is re-analyzed. `status` is an additive optional aiAnalysis field —
 *  absent on every legacy row — rendered only when present and non-empty.
 *  (The report deck slide keeps a compact twin of this helper — the deck is a
 *  deliberately separate implementation; keep the two split rules in sync.) */
function announcementParts(item: TakeawayItem): { lead: string; detail: string; url?: string; status?: string } {
  if (typeof item === 'string') return { lead: item, detail: '' };
  const rawUrl = item.url;
  const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
  const status = typeof item.status === 'string' && item.status.trim().length > 0 ? item.status.trim() : undefined;
  return item.highlight
    ? { lead: item.highlight, detail: item.detail || '', url, status }
    : { lead: item.detail || '', detail: '', url, status };
}

type StatCallout = { label: string; value: string; source?: string };

type CeoPulseAnalysis = {
  headline?: string;
  keyTakeaways?: TakeawayItem[];
  strategicImplications?: TakeawayItem[];
  charts?: CeoPulseChart[];
  contextNarrative?: string[];
  byTheNumbers?: StatCallout[];
};

/** Task #4293 — uploaded supporting image, already resolved to a serving URL by the caller. */
type SupportingImageView = { slot: number; url: string; caption?: string | null };

type CeoPulseVisualProps = {
  analysis: CeoPulseAnalysis;
  monthLabel?: string;
  animate?: boolean;
  slideNumber?: number;
  letterUrl?: string;
  includeGraphs?: boolean;
  /** "company_update" | "market_shift"; null/undefined for legacy untagged briefs (no tag rendered). */
  edition?: string | null;
  /** Task #4293 — ordered uploaded images; rendered in both charts and text-only modes. */
  supportingImages?: SupportingImageView[];
  /** Task #4576 — brand palette for the chart card (see CeoPulseChartRenderer).
   *  The /pulse share page passes the report brand palette (its `card-light`
   *  chrome already rides the `--report-*` token layer, so charts match);
   *  the internal admin preview omits it and keeps the stock OS colors. */
  chartPalette?: CeoPulseChartPalette;
};

export default function CeoPulseVisual({ analysis, monthLabel, animate = true, slideNumber = 2, letterUrl, includeGraphs = true, edition, supportingImages, chartPalette }: CeoPulseVisualProps) {
  const prefersReducedMotion = useReducedMotion();
  const editionLabel = ceoPulseEditionLabel(edition);
  const shouldAnimate = animate && !prefersReducedMotion;
  const showCharts = includeGraphs && Array.isArray(analysis?.charts) && analysis.charts.length > 0;
  const textOnly = !showCharts;
  // Task #4813 — company-update briefs are announcements, not market
  // analysis: text-only company updates render the announcement layout
  // (initiative grid + commitments band + mechanics/visual split) instead of
  // the two stacked bullet columns. Market-shift, legacy untagged, and
  // charts-mode briefs keep the existing layouts byte-for-byte. Mirrors the
  // generation branch in server/routes/reports.ts (announcement mode).
  const companyUpdate = textOnly && edition === 'company_update';
  // Task #4834 — freshly analyzed company updates carry roadmap-template
  // fields inside aiAnalysis (supportingLine / beforeAfter / timeline /
  // pullQuote / per-takeaway category) and render the six-section executive
  // roadmap layout instead. Legacy rows (no roadmap fields) keep the Task
  // #4813 announcement layout below unchanged until they're re-analyzed.
  const roadmap = deriveRoadmapContent(analysis);
  const isRoadmapLayout = companyUpdate && roadmap.isRoadmap;
  // Task #4804 — the report visual is a brief, not a letter: the mechanics
  // card renders at most CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS paragraphs on
  // every surface (Studio preview, /pulse share page, report slide), so
  // legacy briefs with long stored narratives render short without
  // re-analysis. The full-letter page carries the long form.
  const narrative = Array.isArray(analysis?.contextNarrative) ? analysis.contextNarrative.filter(p => typeof p === 'string' && p.trim().length > 0).slice(0, CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS) : [];
  const stats = Array.isArray(analysis?.byTheNumbers) ? analysis.byTheNumbers.filter(s => s && (s.label || s.value)) : [];
  const images = Array.isArray(supportingImages) ? supportingImages.filter(img => img && typeof img.url === 'string' && img.url.length > 0) : [];

  // Task #4293 — supporting visuals card, shared by both layout modes. In
  // text-only update briefs it takes the visual slot charts would occupy;
  // with charts on it renders full-width below the two-column grid.
  const supportingImagesBlock = images.length > 0 ? (
    <motion.div
      initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: textOnly ? 0.35 : 0.4 }}
      className={`card-light ${textOnly ? 'p-7' : 'p-6'}`}
      data-testid="ceo-pulse-supporting-images"
    >
      <div className="section-label-light mb-5">Supporting Visuals</div>
      <div className={images.length === 1 ? 'max-w-xl mx-auto' : 'grid grid-cols-1 md:grid-cols-2 gap-6'}>
        {images.map((img) => (
          <figure key={img.slot} className="m-0" data-testid={`supporting-image-${img.slot}`}>
            <img
              src={img.url}
              alt={img.caption || 'Supporting visual'}
              className="w-full h-auto shadow-md"
              loading="lazy"
            />
            {img.caption && (
              <figcaption className="text-brief-muted text-sm text-center italic mt-2" data-testid={`supporting-image-caption-${img.slot}`}>
                {img.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
    </motion.div>
  ) : null;

  return (
    <section id="ceo-pulse" className="slide slide-charcoal slide-frame relative overflow-hidden print:break-after-page">
      {/* Pattern overlay - lines */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{
        backgroundImage: `repeating-linear-gradient(90deg, white 0px, white 1px, transparent 1px, transparent 40px)`
      }} />
      
      {/* Slide number */}
      <div className="absolute bottom-4 right-6 text-xs text-white/50 font-medium print:hidden">
        {String(slideNumber).padStart(2, '0')}
      </div>
      
      <div className="relative z-10">
        <div className="slide-header">
          <Eye className="slide-header-icon text-brief-gold" />
          <h2 className="slide-title text-white">{NOBULL_BRIEF_STRINGS.title}</h2>
        </div>
        <div className="mt-1 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="masthead-brief">
          <p className="text-brief-gold text-[11px] md:text-xs uppercase tracking-[0.25em] font-medium">{NOBULL_BRIEF_STRINGS.masthead}</p>
          {editionLabel && (
            <span
              className="inline-flex items-center rounded-full border border-brief-gold/50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.15em] text-brief-gold"
              data-testid="tag-edition"
            >
              {editionLabel}
            </span>
          )}
        </div>
        <p className="slide-subtitle-dark">{NOBULL_BRIEF_STRINGS.tagline}</p>
        <div className="divider-thin" />

      {analysis ? (
        <div className={textOnly ? "space-y-7" : "space-y-6"}>
          {/* Headline */}
          <motion.div 
            initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className={`bg-brief-crimson text-white shadow-md ${textOnly ? 'p-8' : 'p-6'}`}
          >
            {/* Explicit white ink: a base-layer heading rule otherwise paints this with the
                THEMED foreground token — near-black on the crimson banner in light mode (~1.6:1). */}
            {isRoadmapLayout && (
              <p className="text-white/80 text-xs font-medium uppercase tracking-[0.25em] mb-2" data-testid="text-roadmap-kicker">{NOBULL_BRIEF_STRINGS.roadmapKicker}</p>
            )}
            <h3 className={textOnly ? 'metric-large text-2xl md:text-3xl leading-tight text-white' : 'metric-large text-white'} data-testid="text-ceo-headline">{analysis.headline}</h3>
            {isRoadmapLayout && roadmap.supportingLine && (
              <p className="text-white/85 mt-2 text-base md:text-lg leading-relaxed" data-testid="text-supporting-line">{roadmap.supportingLine}</p>
            )}
            {monthLabel && (
              <p className={`text-white/75 mt-2 ${textOnly ? 'text-base' : 'text-sm'}`}>{monthLabel}</p>
            )}
          </motion.div>

          {/* Two Column Layout - Content Left, Chart Right (text-only uses richer layout) */}
          {showCharts ? (
            <div className="grid grid-cols-2 gap-6">
              {/* Left Column: Key Takeaways & Implications */}
              <div className="space-y-5">
                {/* Key Takeaways Card */}
                <motion.div 
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.1 }}
                  className="card-light p-5"
                >
                  <div className="section-label-light mb-3">Key Takeaways</div>
                  <ul className="space-y-2.5">
                    {analysis.keyTakeaways?.map((takeaway, i) => {
                      const text = typeof takeaway === 'object' && takeaway.highlight
                        ? `**${takeaway.highlight}** ${takeaway.detail || ''}`
                        : (typeof takeaway === 'string' ? takeaway : '');
                      const rawUrl = typeof takeaway === 'object' ? takeaway.url : undefined;
                      const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
                      return (
                        <li key={i} className="text-brief-ink-soft text-sm leading-relaxed flex items-start gap-2" data-testid={`text-takeaway-${i}`}>
                          <span className="text-brief-crimson mt-0.5 font-bold">•</span>
                          <span>
                            {parseMarkdownBold(text)}
                            {url && (
                              <a href={url} target="_blank" rel="noopener noreferrer" className="ml-1.5 text-brief-crimson text-xs font-medium hover:underline inline-flex items-center gap-0.5" data-testid={`link-takeaway-${i}`}>
                                Learn More <span className="text-[10px]">→</span>
                              </a>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </motion.div>

                {/* Strategic Implications Card */}
                <motion.div 
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.2 }}
                  className="card-light p-5"
                >
                  <div className="section-label-light mb-3">What This Means</div>
                  <ul className="space-y-2.5">
                    {analysis.strategicImplications?.map((implication, i) => {
                      const text = typeof implication === 'object' && implication.highlight
                        ? `**${implication.highlight}** ${implication.detail || ''}`
                        : (typeof implication === 'string' ? implication : '');
                      return (
                        <li key={i} className="text-brief-ink-soft text-sm leading-relaxed flex items-start gap-2" data-testid={`text-implication-${i}`}>
                          <MoveRight className="w-4 h-4 text-brief-crimson mt-0.5 shrink-0" />
                          <span>{parseMarkdownBold(text)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </motion.div>
              </div>

              {/* Right Column: Large Data Visualization */}
              <motion.div 
                initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.3 }}
                className="card-light p-6"
              >
                <div className="section-label-light mb-4">By The Numbers</div>
                <CeoPulseChartRenderer charts={analysis.charts || []} compact animate={shouldAnimate} palette={chartPalette} />
              </motion.div>
            </div>
          ) : null}
          {showCharts && supportingImagesBlock}
          {!showCharts && companyUpdate && roadmap.isRoadmap && (
            <>
              {/* COMPANY-UPDATE ROADMAP TEMPLATE (Task #4834, simplified by
                  Task #4984): executive product-roadmap briefing — update
                  snapshot cards → why this matters (short lead + skimmable
                  bullets) → pull quote, in the template's exact order. The
                  old Before & After and What's Coming Next bands are retired;
                  legacy analyses that still store those fields keep this
                  template but the bands never render. Renders only when the
                  analysis carries roadmap fields (freshly analyzed text-only
                  company updates). Sections whose data is absent are omitted
                  entirely — never rendered blank. */}
              {(analysis.keyTakeaways?.length || 0) > 0 && (
                <motion.div
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.1 }}
                  className="card-light p-7"
                  data-testid="roadmap-snapshot"
                >
                  <div className="section-label-light mb-5">{NOBULL_BRIEF_STRINGS.roadmapSnapshotLabel}</div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    {analysis.keyTakeaways?.map((takeaway, i) => {
                      const { lead, detail, url, status } = announcementParts(takeaway);
                      if (!lead) return null;
                      const category = roadmapCategoryLabel(takeaway);
                      const Icon = roadmapCategoryIcon(category);
                      return (
                        <div key={i} className="border border-brief-ink/10 bg-white p-5" data-testid={`snapshot-card-${i}`}>
                          <div className="flex items-center justify-between gap-2 mb-3">
                            {category ? (
                              <span className="text-brief-muted text-xs font-semibold uppercase tracking-[0.15em]" data-testid={`snapshot-category-${i}`}>{category}</span>
                            ) : (
                              <span aria-hidden="true" />
                            )}
                            {Icon ? (
                              <Icon className="w-6 h-6 text-brief-crimson shrink-0" aria-hidden="true" data-testid={`snapshot-icon-${i}`} />
                            ) : (
                              <span className="text-brief-crimson/40 text-2xl font-bold leading-none" data-testid={`snapshot-number-${i}`}>{String(i + 1).padStart(2, '0')}</span>
                            )}
                          </div>
                          <h4 className="text-brief-ink-strong text-base md:text-lg font-semibold leading-snug">{lead}</h4>
                          {detail && (
                            <p className="text-brief-muted text-sm leading-relaxed mt-1.5 line-clamp-3">{parseMarkdownBold(detail)}</p>
                          )}
                          {status && (
                            <span
                              className="mt-3 inline-flex items-center rounded-full bg-brief-crimson/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.1em] text-brief-crimson"
                              data-testid={`snapshot-status-${i}`}
                            >
                              {status}
                            </span>
                          )}
                          {url && (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 block text-brief-crimson text-xs font-medium hover:underline" data-testid={`link-takeaway-${i}`}>
                              Learn More <span aria-hidden="true">→</span>
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}

              {(roadmap.whyBullets.length > 0 || roadmap.whyParagraphs.length > 0) && (
                <motion.div
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.2 }}
                  className="card-light p-8"
                  data-testid="roadmap-why"
                >
                  <div className="section-label-light mb-4">{NOBULL_BRIEF_STRINGS.roadmapWhyLabel}</div>
                  {roadmap.whyBullets.length > 0 ? (
                    /* Task #4984 — skimmable shape: one short lead paragraph
                       (drop-cap, the treatment the paragraphs used) plus the
                       bullets that absorbed the retired Before & After and
                       What's Coming Next bands' job. */
                    <>
                      {roadmap.whyLead && (
                        <p
                          className="text-brief-ink text-base md:text-lg leading-relaxed mb-4 first-letter:text-3xl first-letter:font-semibold first-letter:text-brief-crimson first-letter:mr-1 first-letter:float-left"
                          data-testid="why-lead"
                        >
                          {parseMarkdownBold(roadmap.whyLead)}
                        </p>
                      )}
                      <ul className="space-y-2.5">
                        {roadmap.whyBullets.map((bullet, i) => (
                          <li key={i} className="text-brief-ink text-sm md:text-base leading-relaxed flex items-start gap-2.5" data-testid={`why-bullet-${i}`}>
                            <span className="text-brief-crimson mt-0.5 font-bold" aria-hidden="true">•</span>
                            <span>{parseMarkdownBold(bullet)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    /* Legacy rows that predate whyBullets keep the paragraph
                       rendering unchanged. */
                    <div className="space-y-4 text-brief-ink text-base md:text-lg leading-relaxed first-letter:text-3xl first-letter:font-semibold first-letter:text-brief-crimson first-letter:mr-1 first-letter:float-left">
                      {roadmap.whyParagraphs.map((paragraph, i) => (
                        <p key={i} data-testid={`why-paragraph-${i}`}>
                          {parseMarkdownBold(paragraph)}
                        </p>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}

              {roadmap.pullQuote && (
                <motion.div
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.3 }}
                  className="bg-brief-crimson text-white p-8 md:p-10 text-center shadow-md"
                  data-testid="roadmap-pull-quote"
                >
                  <p className="text-white/70 text-xs font-medium uppercase tracking-[0.25em] mb-3">{NOBULL_BRIEF_STRINGS.roadmapPullQuoteLabel}</p>
                  <blockquote className="font-report-serif text-2xl md:text-3xl leading-snug">
                    {'\u201C'}{roadmap.pullQuote}{'\u201D'}
                  </blockquote>
                </motion.div>
              )}

              {supportingImagesBlock}

              {/* By The Numbers — brand-chrome stat callouts survive on the
                  roadmap template too (presence-gated, brief tokens). */}
              {stats.length > 0 && (
                <motion.div
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  className="card-light p-7"
                  data-testid="ceo-pulse-by-the-numbers"
                >
                  <div className="section-label-light mb-5">By The Numbers</div>
                  <div className={`grid gap-5 ${stats.length >= 4 ? 'grid-cols-2 md:grid-cols-4' : stats.length === 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1 md:grid-cols-2'}`}>
                    {stats.map((s, i) => (
                      <div key={i} className="border-l-4 border-l-brief-gold pl-4 py-1" data-testid={`stat-callout-${i}`}>
                        <div className="text-brief-crimson text-2xl md:text-3xl font-bold leading-tight" data-testid={`stat-value-${i}`}>{s.value}</div>
                        <div className="text-brief-ink text-sm font-medium mt-1" data-testid={`stat-label-${i}`}>{s.label}</div>
                        {s.source && (
                          <div className="text-brief-muted text-xs mt-1 italic">Source: {s.source}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </>
          )}
          {!showCharts && companyUpdate && !roadmap.isRoadmap && (
            <>
              {/* COMPANY-UPDATE ANNOUNCEMENT LAYOUT (Task #4813): what we're
                  building (name-first initiative grid) → what it means for you
                  (short commitment statements) → why (mechanics card) with the
                  supporting visual promoted alongside as the anchor. Scannable
                  announcement cards — never the market-shift bullet columns. */}
              <motion.div
                initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="card-light p-7"
                data-testid="ceo-pulse-initiatives"
              >
                <div className="section-label-light mb-5">{NOBULL_BRIEF_STRINGS.updateInitiativesLabel}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-6">
                  {analysis.keyTakeaways?.map((takeaway, i) => {
                    const { lead, detail, url, status } = announcementParts(takeaway);
                    if (!lead) return null;
                    return (
                      <div key={i} className="border-t-2 border-brief-gold pt-3" data-testid={`initiative-card-${i}`}>
                        <div className="flex items-start justify-between gap-3">
                          <h4 className="text-brief-ink-strong text-base md:text-lg font-semibold leading-snug">{lead}</h4>
                          {status && (
                            <span
                              className="shrink-0 inline-flex items-center rounded-full bg-brief-crimson/10 px-2.5 py-0.5 mt-1 text-xs font-semibold uppercase tracking-[0.1em] text-brief-crimson"
                              data-testid={`initiative-status-${i}`}
                            >
                              {status}
                            </span>
                          )}
                        </div>
                        {/* Legacy overlong details (rows analyzed before the
                            announcement spec) render contained: title-first
                            with clamped, de-emphasized support. */}
                        {detail && (
                          <p className="text-brief-muted text-sm leading-relaxed mt-1.5 line-clamp-3">{parseMarkdownBold(detail)}</p>
                        )}
                        {url && (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 text-brief-crimson text-xs font-medium hover:underline inline-flex items-center gap-0.5" data-testid={`link-takeaway-${i}`}>
                            Learn More <span className="text-xs">→</span>
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              </motion.div>

              <motion.div
                initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="card-light p-7"
                data-testid="ceo-pulse-commitments"
              >
                <div className="section-label-light mb-4">{NOBULL_BRIEF_STRINGS.updateCommitmentsLabel}</div>
                <ul className="space-y-4">
                  {analysis.strategicImplications?.map((implication, i) => {
                    const { lead, detail } = announcementParts(implication);
                    if (!lead) return null;
                    return (
                      <li key={i} className="flex items-start gap-3" data-testid={`commitment-${i}`}>
                        <MoveRight className="w-5 h-5 text-brief-crimson mt-1 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-brief-ink-strong text-base md:text-lg font-semibold leading-snug">{lead}</p>
                          {detail && (
                            <p className="text-brief-muted text-sm leading-relaxed mt-0.5 line-clamp-2">{parseMarkdownBold(detail)}</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </motion.div>

              {/* Mechanics card with the single supporting visual promoted
                  alongside it as the visual anchor; multi-image briefs keep
                  the shared full-width grid below instead. */}
              {(narrative.length > 0 || images.length === 1) && (
                <motion.div
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.3 }}
                  className={narrative.length > 0 && images.length === 1 ? 'grid grid-cols-1 md:grid-cols-5 gap-6 items-start' : ''}
                >
                  {narrative.length > 0 && (
                    <div className={`card-light p-8 ${images.length === 1 ? 'md:col-span-3' : ''}`} data-testid="ceo-pulse-narrative">
                      <div className="section-label-light mb-4">The Mechanics Behind It</div>
                      <div className="space-y-4 text-brief-ink text-base md:text-base leading-relaxed first-letter:text-3xl first-letter:font-semibold first-letter:text-brief-crimson first-letter:mr-1 first-letter:float-left">
                        {narrative.map((paragraph, i) => (
                          <p key={i} data-testid={`text-narrative-${i}`}>
                            {parseMarkdownBold(paragraph)}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                  {images.length === 1 && (
                    <div className={`card-light p-7 ${narrative.length > 0 ? 'md:col-span-2' : ''}`} data-testid="ceo-pulse-supporting-images">
                      <div className="section-label-light mb-5">Supporting Visuals</div>
                      <figure className="m-0" data-testid={`supporting-image-${images[0].slot}`}>
                        <img
                          src={images[0].url}
                          alt={images[0].caption || 'Supporting visual'}
                          className="w-full h-auto shadow-md"
                          loading="lazy"
                        />
                        {images[0].caption && (
                          <figcaption className="text-brief-muted text-sm text-center italic mt-2" data-testid={`supporting-image-caption-${images[0].slot}`}>
                            {images[0].caption}
                          </figcaption>
                        )}
                      </figure>
                    </div>
                  )}
                </motion.div>
              )}
              {images.length > 1 && supportingImagesBlock}

              {/* By The Numbers — stat callouts (announcement briefs usually
                  have none; renders only when real numbers were extracted) */}
              {stats.length > 0 && (
                <motion.div
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  className="card-light p-7"
                  data-testid="ceo-pulse-by-the-numbers"
                >
                  <div className="section-label-light mb-5">By The Numbers</div>
                  <div className={`grid gap-5 ${stats.length >= 4 ? 'grid-cols-2 md:grid-cols-4' : stats.length === 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1 md:grid-cols-2'}`}>
                    {stats.map((s, i) => (
                      <div key={i} className="border-l-4 border-l-primary pl-4 py-1" data-testid={`stat-callout-${i}`}>
                        <div className="text-brief-crimson text-2xl md:text-3xl font-bold leading-tight" data-testid={`stat-value-${i}`}>{s.value}</div>
                        <div className="text-brief-ink text-sm font-medium mt-1" data-testid={`stat-label-${i}`}>{s.label}</div>
                        {s.source && (
                          <div className="text-brief-muted text-xs mt-1 italic">Source: {s.source}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </>
          )}
          {!showCharts && !companyUpdate && (
            <>
              {/* TEXT-ONLY MODE: takeaways + implications side-by-side, then narrative, then stat callouts */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Key Takeaways Card */}
                <motion.div 
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.1 }}
                  className="card-light p-7"
                >
                  <div className="section-label-light mb-4">Key Takeaways</div>
                  <ul className="space-y-4">
                    {analysis.keyTakeaways?.map((takeaway, i) => {
                      const text = typeof takeaway === 'object' && takeaway.highlight
                        ? `**${takeaway.highlight}** ${takeaway.detail || ''}`
                        : (typeof takeaway === 'string' ? takeaway : '');
                      const rawUrl = typeof takeaway === 'object' ? takeaway.url : undefined;
                      const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
                      return (
                        <li key={i} className="text-brief-ink text-base leading-relaxed flex items-start gap-3" data-testid={`text-takeaway-${i}`}>
                          <span className="text-brief-crimson mt-1 font-bold text-lg leading-none">•</span>
                          <span>
                            {parseMarkdownBold(text)}
                            {url && (
                              <a href={url} target="_blank" rel="noopener noreferrer" className="ml-1.5 text-brief-crimson text-xs font-medium hover:underline inline-flex items-center gap-0.5" data-testid={`link-takeaway-${i}`}>
                                Learn More <span className="text-[10px]">→</span>
                              </a>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </motion.div>

                {/* Strategic Implications Card */}
                <motion.div 
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.2 }}
                  className="card-light p-7"
                >
                  <div className="section-label-light mb-4">What This Means</div>
                  <ul className="space-y-4">
                    {analysis.strategicImplications?.map((implication, i) => {
                      const text = typeof implication === 'object' && implication.highlight
                        ? `**${implication.highlight}** ${implication.detail || ''}`
                        : (typeof implication === 'string' ? implication : '');
                      return (
                        <li key={i} className="text-brief-ink text-base leading-relaxed flex items-start gap-3" data-testid={`text-implication-${i}`}>
                          <MoveRight className="w-5 h-5 text-brief-crimson mt-1 shrink-0" />
                          <span>{parseMarkdownBold(text)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </motion.div>
              </div>

              {/* Context Narrative — short orienting intro, capped at CEO_PULSE_NARRATIVE_MAX_PARAGRAPHS (the full letter carries the long form) */}
              {narrative.length > 0 && (
                <motion.div
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.3 }}
                  className="card-light p-8"
                  data-testid="ceo-pulse-narrative"
                >
                  <div className="section-label-light mb-4">The Mechanics Behind It</div>
                  <div className="space-y-4 text-brief-ink text-base md:text-[17px] leading-relaxed first-letter:text-3xl first-letter:font-semibold first-letter:text-brief-crimson first-letter:mr-1 first-letter:float-left">
                    {narrative.map((paragraph, i) => (
                      <p key={i} data-testid={`text-narrative-${i}`}>
                        {parseMarkdownBold(paragraph)}
                      </p>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Task #4293 — supporting visuals take the visual slot for
                  text-only update briefs (stat callouts still render below
                  when present). */}
              {supportingImagesBlock}

              {/* By The Numbers — stat callouts (replaces the chart card) */}
              {stats.length > 0 && (
                <motion.div
                  initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  className="card-light p-7"
                  data-testid="ceo-pulse-by-the-numbers"
                >
                  <div className="section-label-light mb-5">By The Numbers</div>
                  <div className={`grid gap-5 ${stats.length >= 4 ? 'grid-cols-2 md:grid-cols-4' : stats.length === 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1 md:grid-cols-2'}`}>
                    {stats.map((s, i) => (
                      <div key={i} className="border-l-4 border-l-primary pl-4 py-1" data-testid={`stat-callout-${i}`}>
                        <div className="text-brief-crimson text-2xl md:text-3xl font-bold leading-tight" data-testid={`stat-value-${i}`}>{s.value}</div>
                        <div className="text-brief-ink text-sm font-medium mt-1" data-testid={`stat-label-${i}`}>{s.label}</div>
                        {s.source && (
                          <div className="text-brief-muted text-xs mt-1 italic">Source: {s.source}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </>
          )}
          {letterUrl && (
            <motion.div
              initial={shouldAnimate ? { opacity: 0, y: 20 } : {}}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="mt-6"
            >
              <a
                href={letterUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`block bg-gradient-to-r from-report-crimson to-primary text-center hover:from-report-crimson-deep hover:to-primary/90 transition-all group shadow-md ${textOnly ? 'p-7' : 'p-5'}`}
                data-testid="link-full-letter"
              >
                <p className={`text-white/75 uppercase tracking-widest mb-1 ${textOnly ? 'text-sm' : 'text-xs'}`}>{NOBULL_BRIEF_STRINGS.letterCtaEyebrow}</p>
                <p className={`text-white font-semibold group-hover:tracking-wide transition-all ${textOnly ? 'text-xl md:text-2xl' : 'text-lg'}`}>
                  {NOBULL_BRIEF_STRINGS.letterCtaLabel} <span className="inline-block group-hover:translate-x-1 transition-transform">→</span>
                </p>
              </a>
            </motion.div>
          )}
        </div>
      ) : (
        <div className="bg-white/10 backdrop-blur-sm p-8 border border-white/20 text-center">
          <AlertCircle className="w-12 h-12 text-white/60 mx-auto mb-4" />
          <p className="text-white/75 text-sm">{NOBULL_BRIEF_STRINGS.emptyTitle}</p>
          <p className="text-white/60 text-xs mt-2">{NOBULL_BRIEF_STRINGS.emptySubtitle}</p>
        </div>
      )}
      </div>
    </section>
  );
}
