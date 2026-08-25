/**
 * MarketingSlide — one slide of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 3119–3911 @ d31d7c0c7, Task #4271).
 *
 * Task #4280 (audit §8.7-7 + §8.5) — restructured from a ~2,890px wall of ~20
 * objects into a 2-viewport hierarchy: verdict → one hero number (Total Leads
 * — Task #4843; Good Leads is the first KPI tag when quality is shown)
 * → four compact KPI tags → ONE source chart (Leads by Source trend) → the
 * lead-quality stacked bar + a small per-source table (replacing the donut
 * cluster and per-source ring grid) → GBP 56px-thumbnail cards → prominent
 * Paid Search per-channel card (Task #4913 restored its pre-restructure
 * position and weight: the #4280 demotion to bottom-of-slide chips buried
 * spend/CPL below the tall map cards on shipped share links) → a Map
 * Rankings grid with ONE shared legend (canonical served palette), fixed
 * 380px maps and a one-line takeaway per map — since Task #4848 one card per
 * LOCATION, with pills switching between distinct keywords (same-keyword
 * weekly scans collapse to the latest) → single-row webinar/review stats.
 * Internal automation state (post-consult / post-case-closed review
 * access) is no longer rendered anywhere on the client surface.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, MapPin, TrendingUp } from "lucide-react";
import { scanThumbUrl, useScanImageStatus } from "./scanImageGuard";
import { type CanonicalProduct } from "@shared/productResolution";
import { computeQualityHeadline } from "@shared/activeProductsHeadline";
import { getReviewVelocityBand, getReviewVelocityBandLabel, resolveReviewMonthlyTarget } from "@shared/reviewVelocitySeverity";
import { HEATMAP_RANK_LEGEND } from "@shared/heatmapColors";
import { computeReviewVelocity, computeReviewVelocityChange } from "@/lib/reviewVelocity";
import InteractiveHeatmap from "@/components/InteractiveHeatmap";
import { CartesianGrid, ResponsiveContainer, XAxis, YAxis, Tooltip, Line, LineChart, Area, AreaChart, ReferenceLine } from "recharts";
import { Slide } from "./Slide";
import { VerdictLine } from "./VerdictLine";
import { deriveCompetitorStanding } from "./competitorStanding";
import { formatTrendMonth, trendSpansMultipleYears } from "./TrendsSection";
import {
  buildMarketingAdSpendGapUpsellMessage,
  buildMarketingLeadsGapUpsellMessage,
  buildMarketingReviewsAndAdSpendGapUpsellMessage,
  buildMarketingReviewsGapUpsellMessage,
  buildUpgradeUpsellMessage,
  ChartPlaceholderFrame,
  NO_DATA_LABEL,
  SectionUpsellCallout,
} from "./EmptyState";
import type { PublicReportViewModel } from "./derive";
import { REPORT_COLORS, REPORT_STATUS_COLORS, REPORT_TICK_FONT_SIZE } from './reportTokens';

// Task #4468 — consolidated here from publicHeatmaps.tsx (now deleted): after
// the Task #4280 restructure removed the per-location dominance tab UI, this
// slide's map-zone code was the only remaining consumer of these two pieces.

// Task #4544 — scan-guarded imagery. Both renderers below verify the stored
// upload actually serves as a scan image (PNG/WebP screenshot) before showing
// it; a portrait photo stored in the slot renders an explicit placeholder /
// pending state instead. Separate components so the probe hook never runs
// inside the slide's conditional render paths.

function formatSpendK(amount: number): string {
  return `$${(amount / 1000).toFixed(1).replace(/\.0$/, "")}K`;
}

/**
 * Task #4682 — non-hue differentiators for the Leads-by-Source chart (WCAG
 * 1.4.1). Each series carries a distinct dash pattern; `undefined` = solid.
 * Webinar and Total deliberately share gold (brand), so their dash patterns
 * MUST differ; GBP crimson vs LSA green is a red/green CVD confusion pair,
 * separated the same way. The legend swatches below render the SAME pattern
 * via SeriesLineSwatch so chart and legend can't drift.
 */
const LEAD_SOURCE_SERIES_STYLE = {
  gbp: { dash: undefined },
  googleAds: { dash: "7 3" },
  lsa: { dash: "2 3" },
  webinar: { dash: "8 3 2 3" },
  total: { dash: undefined },
} as const;

/** 18×8 line sample for a chart legend entry, carrying the series' dash. */
function SeriesLineSwatch({ color, dash, thick }: { color: string; dash?: string; thick?: boolean }) {
  return (
    <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true" className="shrink-0">
      <line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth={thick ? 3 : 2} strokeDasharray={dash} />
    </svg>
  );
}

export function MarketingSlide({ view }: { view: PublicReportViewModel }) {
  const { WEBINAR_LEAD_EQUIVALENCY, blendedCPL, client, clientProducts, data, gAdsLeadQuality, gbpAggLeadQuality, gbpLocations, gbpTotalLeads, gbpTotalReviews, goodLeadPercent, googleAds, hasGBP, hasGoogleAds, hasLSA, hasPaidMedia, hasWebinar, hasWebinarLeadQualityData, hideOtherLeads, leadSourceBreakdown, leadSourceTotal, lsa, lsaLeadQuality, marketingSection, monthLabel, otherLeadsCount, otherLeadsData, sectionPresence, slideNumbers, t, totalAdSpend, totalGoodExcludingWebinar, totalLeads, totalLeadsExcludingWebinar, totalPaidLeads, trendData, webinarLeadCount, webinarLeadEquiv, webinarLeadQuality, webinarUsingFallback, webinars } = view;
  // Task #4290 — server-computed effective privacy flag (privacy_mode OR
  // ?private=true). Under privacy the payload already carries masked labels
  // ("Market A", "Keyword A"…); this flag additionally suppresses every
  // client-side fetch/fallback that could surface a REAL name (heatmap meta).
  const privacyMode = data.report.privacyApplied === true;

  // Task #4693 — deck-wide no-data upsell convention (supersedes the Task
  // #4285 collapse): a fully-empty section renders its FULL slide skeleton
  // (muted "No data" hero/KPI slots, a quiet placeholder frame where the
  // source chart would draw — never a wall of fabricated zeros) and ONE
  // gold section callout carries the CaseIntake™ pitch. Hand-built views
  // without the presence map fail open (skeleton mode simply never
  // engages).
  const sectionEmpty = !(sectionPresence?.marketing ?? true);

  return (
        <Slide slideNumber={slideNumbers.marketing} variant="charcoal" pattern="lines" id="marketing">
          {(() => {
            const marketingPosture = marketingSection?.data?.posture || 'scaling';

            // Task #1028: headline math runs through the canonical shared
            // helper `computeQualityHeadline` so the public renderer, the
            // storage aggregate (`aggregateActiveLeadQuality`), and any
            // future surface (PDF export uses this same React render with
            // print CSS) stay in lock-step. Active products are derived
            // from the report-attached `safeClient.products` set the
            // server already gated through the canonical resolver — no
            // direct reads of CP/client.products on the renderer side.
            const headline = computeQualityHeadline(
              marketingSection?.data,
              (clientProducts ?? []) as CanonicalProduct[],
            );
            // Task #4914 — rated-based quality % (owner decision, supersedes
            // Task #1028's all-buckets denominator): the headline answers "of
            // the leads we could actually RATE, how many were good?" and is
            // NULL when nothing was rated — rendered as "—"/"not yet rated",
            // never a 0%/100% off an empty denominator. `goodLeadPercent`
            // (the legacy fallback from derive.ts) follows the same
            // convention and is itself null when nothing was rated. The
            // coverage counts keep the excluded "No data" leads visible
            // beside every quality %.
            const overallQuality: number | null = headline.qualityPercent ?? goodLeadPercent;
            const answerRatePercent = headline.answerRatePercent;
            const ratedLeadCount = headline.ratedCount;
            const noDataLeadCount = headline.noDataCount;
            const ratedPlusNoData = ratedLeadCount + noDataLeadCount;

            const reviewGen = marketingSection?.data?.reviewGeneration;
            const reviewSources = {
              list: { count: reviewGen?.list?.reviews || 0, activationRate: reviewGen?.list?.activationRate || 0 },
              webinar: { count: reviewGen?.webinar?.reviews || 0, activationRate: reviewGen?.webinar?.activationRate || 0 },
              other: { count: reviewGen?.other?.count || 0 }
            };
            const totalReviewsFromSources = reviewSources.list.count + reviewSources.webinar.count + reviewSources.other.count;

            // Task #4850 — honest upsell copy. The trigger legs are unchanged
            // (every missing data point stays a visible sales lever,
            // owner-approved), but the MESSAGE is selected by state: the
            // generic whole-section "No data" line may only render on a
            // fully-empty section — next to visible numbers it would claim
            // the entire section is empty (deck rule, Task #4714 precedent).
            // A section with data names the actual gap instead. When several
            // legs fire at once, the reviews/spend naming wins — a zero lead
            // count is already visible in the hero/KPI slots right below,
            // while reviews and spend gaps are otherwise invisible.
            const leadsGap = totalLeads === 0;
            const reviewsGap = (totalReviewsFromSources || gbpTotalReviews) === 0;
            const adSpendGap = hasPaidMedia && totalAdSpend === 0;
            const upsellMessage = sectionEmpty
              ? buildUpgradeUpsellMessage()
              : reviewsGap && adSpendGap
                ? buildMarketingReviewsAndAdSpendGapUpsellMessage(monthLabel)
                : reviewsGap
                  ? buildMarketingReviewsGapUpsellMessage(monthLabel)
                  : adSpendGap
                    ? buildMarketingAdSpendGapUpsellMessage(monthLabel)
                    : buildMarketingLeadsGapUpsellMessage(monthLabel, t("leads").toLowerCase());

            const hideLeadQuality = !!data?.report?.hideLeadQuality;

            const getPostureLabel = (posture: string) => {
              if (posture === 'baseline') return 'Establishing Baseline';
              if (posture === 'ramp-up') return 'Ramp-Up';
              if (posture === 'stable') return 'Stable';
              return 'Scaling';
            };

            const getPostureStyle = (posture: string) => {
              if (posture === 'baseline') return 'bg-report-earth/40 text-report-ink-inverse';
              if (posture === 'ramp-up') return 'bg-report-liberty/30 text-report-ink-inverse';
              if (posture === 'stable') return 'bg-report-neutral/30 text-report-ink-inverse-muted';
              return 'bg-report-gold/30 text-report-gold';
            };

            // Webinar annotation for the Total-Leads hero (Task #4843: the
            // hero is Total Leads in BOTH quality modes) — same wording as
            // the pre-restructure card.
            const totalLeadsWebinarAnnotation = hasWebinarLeadQualityData
              ? webinarLeadCount + ' webinar leads (' + Math.ceil(webinarLeadCount * WEBINAR_LEAD_EQUIVALENCY) + ' lead equiv.)'
              : webinars.hotTransfers + ' Hot Transfers (' + Math.ceil(webinars.hotTransfers * WEBINAR_LEAD_EQUIVALENCY) + ' lead equiv.)';

            return (
              <>
                {/* Title + Posture Badge — suppressed at zero lead volume
                    (Task #4285: the stored posture defaults to 'scaling', and
                    a "Scaling" badge over 0 leads asserts momentum the data
                    can't back; audit backlog #17). */}
                <div className="flex items-center justify-between mb-2">
                  <div className="slide-header" style={{ marginBottom: 0 }}>
                    <TrendingUp className="slide-header-icon text-report-gold" />
                    <h2 className="slide-title text-white">Marketing Deep Dive</h2>
                  </div>
                  {totalLeads > 0 && (
                    <span className={`text-xs font-bold px-4 py-1 rounded ${getPostureStyle(marketingPosture)}`}>
                      {getPostureLabel(marketingPosture)}
                    </span>
                  )}
                </div>
                <p className="slide-subtitle-dark" style={{ marginBottom: '0.75rem' }}>{t("leads")} generation performance across all channels</p>
                <div className="divider-thin" style={{ marginBottom: '1rem' }} />

                {/* Verdict — server-stored one-liner; renders nothing when absent. */}
                <VerdictLine verdict={data?.slideVerdicts?.marketing} slideKey="marketing" className="mb-4" />

                {/* Task #4693 — ONE gold callout per section when any data
                    point is missing (leads, reviews, or spend on a paid-media
                    client). Marketing data is tracked, not hand-reported, so
                    every variant is upgrade-only. Per-metric slots stay quiet
                    "No data" — the pitch is never repeated. Task #4850: copy
                    is state-selected above — generic only when fully empty,
                    gap-naming otherwise. */}
                {(leadsGap || reviewsGap || adSpendGap) && (
                  <SectionUpsellCallout
                    variant="dark"
                    testId="upsell-marketing"
                    message={upsellMessage}
                  />
                )}

                {/* ========== HERO NUMBER + FOUR KPI TAGS ========== */}
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(250px,1fr)_1.8fr] gap-4 mb-6 items-stretch">
                  <div className="bg-report-charcoal-card border border-report-gold/30 rounded-xl p-6 text-center flex flex-col justify-center" data-testid="card-marketing-hero">
                    {/* Task #4693 skeleton — muted "No data" hero, never a
                        fabricated 0 lead count. Task #4843 — the hero is Total
                        Leads in BOTH quality modes (operator request: the
                        biggest number on the slide is the total); Good Leads
                        is demoted to the first KPI tag below. The hero is the
                        ONLY text-total-leads-ht instance in every mode. */}
                    {sectionEmpty ? (
                      <>
                        <div className="metric-large text-white/50" data-testid="text-marketing-hero-missing">{NO_DATA_LABEL}</div>
                        <div className="text-xs text-white/50 uppercase tracking-wider mt-2">Total {t("leads")}</div>
                      </>
                    ) : (
                      <>
                        <div className="report-hero-metric text-report-gold" data-testid="text-total-leads-ht">{totalLeadsExcludingWebinar}</div>
                        <div className="text-xs text-white/50 uppercase tracking-wider mt-2">Total {t("leads")}</div>
                        {hasWebinar && webinarLeadCount > 0 && (
                          <div className="text-caption text-white/60 mt-1" data-testid="text-total-leads-webinar-annotation">+ {totalLeadsWebinarAnnotation}</div>
                        )}
                        {/* Task #4982 — disclosure: this monthly total
                            includes the "Other" bucket, while the Lifetime
                            slide's campaign figure excludes it; state the
                            count so the two reconcile at a glance. Gated on
                            the derive layer's FINAL otherLeadsCount (0 under
                            the hide-Other toggle), wording mirroring the
                            Lifetime slide's fine print. */}
                        {otherLeadsCount > 0 && (
                          <div className="text-caption text-white/60 mt-1" data-testid="text-total-leads-other-annotation">includes {otherLeadsCount} "Other" {t("leads").toLowerCase()} — not attributed to our campaigns</div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {/* Task #4843 — Good Leads tag in the slot the Total
                        Leads tag used to occupy (the total moved to the
                        hero). The "of N total" sub-line keeps the good/total
                        ratio visible beside the Leads Quality % tag. */}
                    {!hideLeadQuality && (
                      <div className="bg-report-charcoal-card border border-white/10 rounded-xl px-4 py-4 flex flex-col justify-center" data-testid="kpi-good-leads">
                        {sectionEmpty ? (
                          <div className="metric-large text-white/50">{NO_DATA_LABEL}</div>
                        ) : (
                          <div className="metric-large text-report-healthy-bright" data-testid="text-good-leads">{totalGoodExcludingWebinar}</div>
                        )}
                        <div className="text-xs text-white/50 uppercase tracking-wider">Good {t("leads")}</div>
                        {!sectionEmpty && (
                          <div className="text-caption text-white/60 mt-1">of {totalLeadsExcludingWebinar} total</div>
                        )}
                        {hasWebinar && webinarLeadCount > 0 && (
                          <div className="text-caption text-white/60 mt-1" data-testid="text-good-leads-webinar-annotation">+ {hasWebinarLeadQualityData ? (webinarLeadQuality.good || 0) + ' good webinar leads' : webinars.hotTransfers + ' Hot Transfers'}</div>
                        )}
                      </div>
                    )}
                    <div className="bg-report-charcoal-card border border-white/10 rounded-xl px-4 py-4 flex flex-col justify-center" data-testid="kpi-reviews-generated">
                      <div className={`metric-large ${sectionEmpty ? 'text-white/50' : 'text-white'}`}>{sectionEmpty ? NO_DATA_LABEL : (totalReviewsFromSources || gbpTotalReviews)}</div>
                      <div className="text-xs text-white/50 uppercase tracking-wider">Reviews Generated</div>
                    </div>
                    {!hideLeadQuality && (
                      <div className="bg-report-charcoal-card border border-white/10 rounded-xl px-4 py-4 flex flex-col justify-center" data-testid="card-lead-quality">
                        {sectionEmpty ? (
                          <div className="metric-large text-white/50" data-testid="text-lead-quality-missing">{NO_DATA_LABEL}</div>
                        ) : overallQuality === null ? (
                          /* Task #4914 — zero rated leads: never a 0%/100%
                             off an empty denominator. The coverage sub-line
                             below carries the counts. */
                          <div className="metric-large text-white/50" data-testid="text-lead-quality-unrated">—</div>
                        ) : (
                          <div className={`metric-large ${overallQuality >= 60 ? 'text-report-healthy-bright' : overallQuality >= 40 ? 'text-report-gold' : 'text-report-crimson-bright'}`} data-testid="text-lead-quality-percent">{overallQuality}%</div>
                        )}
                        <div className="text-xs text-white/50 uppercase tracking-wider">{t("leads")} Quality</div>
                        {/* Task #4914 — coverage sub-line: the % above is
                            Good-of-RATED (good + not quotable + missed).
                            "No data" leads are excluded from the math but
                            never hidden. */}
                        {!sectionEmpty && ratedPlusNoData > 0 && (
                          <div className="text-caption text-white/60 mt-1" data-testid="text-lead-quality-coverage">
                            {ratedLeadCount > 0
                              ? `${ratedLeadCount} of ${ratedPlusNoData} ${t("leads").toLowerCase()} rated`
                              : `not yet rated · ${noDataLeadCount} ${t("leads").toLowerCase()} without data`}
                          </div>
                        )}
                        {answerRatePercent !== null && (
                          <div className="text-caption text-white/50 mt-1" data-testid="text-answer-rate-percent">
                            Answer Rate: <span className="font-semibold text-white/70">{answerRatePercent}%</span>
                          </div>
                        )}
                        {hasWebinar && webinarLeadCount > 0 && (
                          <div className="text-caption text-white/60 mt-1">Excludes webinar</div>
                        )}
                      </div>
                    )}
                    {hasPaidMedia ? (
                      <div className="bg-report-charcoal-card border border-white/10 rounded-xl px-4 py-4 flex flex-col justify-center" data-testid="kpi-blended-cpl">
                        <div className={`metric-large ${sectionEmpty ? 'text-white/50' : 'text-white'}`}>{sectionEmpty ? NO_DATA_LABEL : totalPaidLeads > 0 ? `$${Math.round(blendedCPL)}` : '–'}</div>
                        <div className="text-xs text-white/50 uppercase tracking-wider">Blended CPL</div>
                      </div>
                    ) : (
                      <div className="bg-report-charcoal-card border border-white/10 rounded-xl px-4 py-4 flex flex-col justify-center" data-testid="kpi-gbp-leads">
                        <div className={`metric-large ${sectionEmpty ? 'text-white/50' : 'text-white'}`}>{sectionEmpty ? NO_DATA_LABEL : gbpTotalLeads}</div>
                        <div className="text-xs text-white/50 uppercase tracking-wider">GBP {t("leads")}</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* ========== THE ONE SOURCE CHART: Leads by Source (Monthly) ========== */}
                {/* Task #4693 skeleton — with the section fully empty and no
                    trend months, a quiet placeholder frame stands where the
                    source chart would draw (never a fabricated zero chart). */}
                {sectionEmpty && (!trendData || trendData.length < 1) && (
                  <div className="mb-6">
                    <ChartPlaceholderFrame
                      variant="dark"
                      testId="chart-placeholder-marketing"
                      label={`The monthly ${t("leads").toLowerCase()}-by-source chart draws here once lead activity is tracked.`}
                    />
                  </div>
                )}
                {trendData && trendData.length >= 1 && (
                    <div className="bg-report-charcoal-card rounded-lg p-4 border border-white/10 mb-6">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs uppercase tracking-wider font-bold text-white/60">{t("leads")} by Source (Monthly)</span>
                        {/* Task #4682 — legend swatches are line samples carrying each
                            series' dash pattern (see LEAD_SOURCE_SERIES_STYLE), so
                            series are tellable apart without relying on hue alone
                            (Webinar and Total share gold; LSA green vs GBP crimson is
                            a classic CVD confusion pair). Labels ≥12px at ≥AA ink. */}
                        <div className="flex items-center gap-4 flex-wrap">
                          {hasGBP && <span className="flex items-center gap-1.5"><SeriesLineSwatch color={REPORT_COLORS.crimsonBright} dash={LEAD_SOURCE_SERIES_STYLE.gbp.dash} /><span className="text-xs text-white/75">GBP</span></span>}
                          {hasGoogleAds && <span className="flex items-center gap-1.5"><SeriesLineSwatch color={REPORT_COLORS.steel} dash={LEAD_SOURCE_SERIES_STYLE.googleAds.dash} /><span className="text-xs text-white/75">Google Ads</span></span>}
                          {hasLSA && <span className="flex items-center gap-1.5"><SeriesLineSwatch color="#4ADE80" dash={LEAD_SOURCE_SERIES_STYLE.lsa.dash} /><span className="text-xs text-white/75">LSA</span></span>}
                          {hasWebinar && <span className="flex items-center gap-1.5"><SeriesLineSwatch color={REPORT_COLORS.gold} dash={LEAD_SOURCE_SERIES_STYLE.webinar.dash} /><span className="text-xs text-white/75">Webinar (equiv.)</span></span>}
                          <span className="flex items-center gap-1.5"><SeriesLineSwatch color={REPORT_COLORS.gold} dash={LEAD_SOURCE_SERIES_STYLE.total.dash} thick /><span className="text-xs text-white/75">Total</span></span>
                        </div>
                      </div>
                      <ResponsiveContainer width="100%" height={150}>
                        <LineChart 
                          data={(trendData || []).map((d, _i, arr) => {
                            const marketing = d.marketing as any;
                            const includeYear = trendSpansMultipleYears(arr.map(t => t.month));
                            const gbp = marketing?.leadsBySource?.gbp ?? 0;
                            const googleAds = marketing?.leadsBySource?.googleAds ?? 0;
                            const lsa = marketing?.leadsBySource?.lsa ?? 0;
                            const webinar = marketing?.leadsBySource?.webinar ?? 0;
                            const webinarHT = marketing?.leadsBySource?.webinarHT ?? 0;
                            // Task #2667 — this chart draws no explicit "Other" line, so the
                            // Other bucket is the gap between totalLeads and the visible
                            // sources. When the per-client toggle hides Other, rebuild the
                            // Total line from only the ACTIVE/visible sources so it reconciles
                            // with what's drawn and excludes Other — including any
                            // inactive-product leads, which are folded into Other and gated
                            // out here by the same hasGBP/hasGoogleAds/hasLSA/hasWebinar flags
                            // that decide whether each source line renders.
                            //
                            // Task #2789 — DELIBERATE: for webinar clients this rebuilt Total
                            // INCLUDES the webinar lead-equivalent series, so it can differ
                            // from the Total Leads card beside it (which uses
                            // totalLeadsExcludingWebinar and annotates webinar separately).
                            // The chart's Total must reconcile with the lines actually drawn —
                            // a "Webinar (equiv.)" line renders here, so excluding it would
                            // leave Total < sum-of-lines, a worse inconsistency inside the
                            // chart than the cross-widget difference. A footnote below the
                            // chart (text-trend-total-webinar-footnote) explains the
                            // difference whenever this divergent case is visible. Locked by
                            // tests/client/hide-other-leads-rendered.test.tsx scenario (D).
                            const total = hideOtherLeads
                              ? ((hasGBP ? gbp : 0) + (hasGoogleAds ? googleAds : 0) + (hasLSA ? lsa : 0) + (hasWebinar ? webinar : 0))
                              : (marketing?.totalLeads ?? 0);
                            return {
                              month: formatTrendMonth(d.month, includeYear),
                              total,
                              gbp,
                              googleAds,
                              lsa,
                              webinar,
                              webinarHT,
                            };
                          })} 
                          margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                          <XAxis dataKey="month" tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: REPORT_TICK_FONT_SIZE }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                          <YAxis allowDecimals={false} tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: REPORT_TICK_FONT_SIZE }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                          <Tooltip 
                            contentStyle={{ backgroundColor: REPORT_COLORS.charcoalCard, border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: REPORT_COLORS.white }}
                            labelStyle={{ color: REPORT_COLORS.white }}
                            itemStyle={{ color: REPORT_COLORS.white }}
                            formatter={(value: number, name: string, props: any) => {
                              if (name === 'Webinar (equiv.)' && props?.payload?.webinarHT !== undefined) {
                                return [`${value} equiv. (${props.payload.webinarHT} HT × 1.6)`, name];
                              }
                              return [value, name];
                            }}
                          />
                          {/* Task #4286 (audit #28) — series render settled;
                              entry animations batch on tall slides and
                              double-paint in print. */}
                          {/* Task #4682 — per-series strokeDasharray gives every line a
                              non-hue differentiator (WCAG 1.4.1: color not the only
                              visual means). Patterns live in LEAD_SOURCE_SERIES_STYLE
                              so the legend swatches above stay in lockstep. */}
                          {hasGBP && <Line type="monotone" isAnimationActive={false} dataKey="gbp" stroke={REPORT_COLORS.crimsonBright} strokeWidth={2} strokeDasharray={LEAD_SOURCE_SERIES_STYLE.gbp.dash} dot={{ r: 3, fill: REPORT_COLORS.crimsonBright }} name="GBP" />}
                          {hasGoogleAds && <Line type="monotone" isAnimationActive={false} dataKey="googleAds" stroke={REPORT_COLORS.steel} strokeWidth={2} strokeDasharray={LEAD_SOURCE_SERIES_STYLE.googleAds.dash} dot={{ r: 3, fill: REPORT_COLORS.steel }} name="Google Ads" />}
                          {hasLSA && <Line type="monotone" isAnimationActive={false} dataKey="lsa" stroke="#4ADE80" strokeWidth={2} strokeDasharray={LEAD_SOURCE_SERIES_STYLE.lsa.dash} dot={{ r: 3, fill: '#4ADE80' }} name="LSA" />}
                          {hasWebinar && <Line type="monotone" isAnimationActive={false} dataKey="webinar" stroke={REPORT_COLORS.gold} strokeWidth={2} strokeDasharray={LEAD_SOURCE_SERIES_STYLE.webinar.dash} dot={{ r: 3, fill: REPORT_COLORS.gold }} name="Webinar (equiv.)" />}
                          <Line type="monotone" isAnimationActive={false} dataKey="total" stroke={REPORT_COLORS.gold} strokeWidth={3} strokeDasharray={LEAD_SOURCE_SERIES_STYLE.total.dash} dot={{ r: 4, fill: REPORT_COLORS.gold }} name="Total" />
                        </LineChart>
                      </ResponsiveContainer>
                      {/* Task #2803 — the footnote renders for EVERY webinar client,
                          toggle ON or OFF, because BOTH totals include webinar while
                          the Total Leads card (totalLeadsExcludingWebinar) does not:
                          - toggle ON: the rebuilt Total sums the drawn lines, including
                            the "Webinar (equiv.)" series (hot transfers × 1.6, Task #2789).
                          - toggle OFF: the raw persisted marketing.totalLeads is the
                            source report's grand total, which the import parser
                            canonically treats as GBP + Google Ads + LSA + webinar
                            leads + Other (see pdfImportParser.ts reconciliation /
                            Other-residual math and the Task #2760 raw-persist
                            invariant in server/routes/reports.ts) — so
                            import-lane months include RAW webinar leads, while
                            editor-saved months persist webinar lead EQUIVALENTS
                            (Task #4511, matching the live derivation). The
                            generic "includes webinar leads" wording covers the
                            mixed lane; only the toggle-ON rebuilt Total is
                            provably all-equivalents, hence the more specific
                            wording there. */}
                      {hasWebinar && (
                        <div className="text-caption text-white/60 italic mt-2" data-testid="text-trend-total-webinar-footnote">
                          {hideOtherLeads
                            ? `* Total line includes webinar lead equivalents (× 1.6); the Total ${t("leads")} card counts webinar separately.`
                            : `* Total line includes webinar ${t("leads").toLowerCase()}; the Total ${t("leads")} card counts webinar separately.`}
                        </div>
                      )}
                    </div>
                )}

                {/* ========== LEAD SOURCES & QUALITY: stacked bar + small table ========== */}
                {(() => {
                  const leadQualitySources = [
                    hasGBP && { name: 'GBP', lq: gbpAggLeadQuality },
                    hasGoogleAds && { name: 'Google Ads', lq: gAdsLeadQuality },
                    hasLSA && { name: 'LSA', lq: lsaLeadQuality }
                  ].filter(Boolean) as Array<{ name: string; lq: { good: number; notQuotable: number; missedCalls?: number; noData?: number } }>;

                  const allGood = leadQualitySources.reduce((sum, s) => sum + s.lq.good, 0);
                  const allBad = leadQualitySources.reduce((sum, s) => sum + s.lq.notQuotable, 0);
                  const allMissed = leadQualitySources.reduce((sum, s) => sum + (s.lq.missedCalls || 0), 0);
                  const allNoData = leadQualitySources.reduce((sum, s) => sum + (s.lq.noData || 0), 0);
                  const allTotal = allGood + allBad + allMissed + allNoData;

                  // Task #4914 — the quality bar shows shares of RATED leads
                  // only (good + not quotable + missed: every KNOWN
                  // disposition). "No data" is a COVERAGE stat, pulled aside
                  // into the muted strip under the bar — excluded from the %
                  // math, never hidden. Rounding: good and bad round, the
                  // last non-zero rated segment absorbs the drift, so the
                  // segments always sum to 100% of the rated bar.
                  const allRated = allGood + allBad + allMissed;
                  const ratedPct = allTotal > 0 ? Math.round((allRated / allTotal) * 100) : 0;
                  const pctGood = allRated > 0 ? Math.round((allGood / allRated) * 100) : 0;
                  let pctBad = allRated > 0 ? Math.round((allBad / allRated) * 100) : 0;
                  let pctMissed = 0;
                  if (allRated > 0) {
                    if (allMissed > 0) {
                      pctMissed = Math.max(0, 100 - pctGood - pctBad);
                    } else if (allBad > 0) {
                      pctBad = 100 - pctGood;
                    }
                  }

                  const showQuality = !hideLeadQuality;
                  // Per-source quality lookup for the table — same canonical
                  // aggregates the old ring cluster read. Webinar only has
                  // quality columns when real webinar lead-quality data exists.
                  const qualityBySource: Record<string, { good: number; notQuotable: number; missedCalls?: number; noData?: number } | undefined> = {
                    'GBP': hasGBP ? gbpAggLeadQuality : undefined,
                    'Google Ads': hasGoogleAds ? gAdsLeadQuality : undefined,
                    'LSA': hasLSA ? lsaLeadQuality : undefined,
                    'Webinar': hasWebinarLeadQualityData ? webinarLeadQuality : undefined,
                  };

                  if (leadSourceBreakdown.length === 0 && (!showQuality || allTotal === 0)) return null;

                  return (
                    <div className="bg-report-charcoal-card rounded-xl p-6 border border-white/10 mb-6" data-testid="card-lead-sources-quality">
                      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
                        <div className="flex items-center gap-2">
                          <BarChart3 className="w-4 h-4 text-report-gold" />
                          <span className="text-sm font-bold text-white/80">{showQuality ? `${t("leads")} Sources & Quality` : `${t("leads")} Sources`}</span>
                        </div>
                        {showQuality && allTotal > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-white/50">{allTotal} total {t("leads").toLowerCase()}</span>
                            {overallQuality !== null ? (
                              <span className={`metric-large ${overallQuality >= 60 ? 'text-report-healthy-bright' : overallQuality >= 40 ? 'text-report-gold' : 'text-report-crimson-bright'}`}>{overallQuality}% Good</span>
                            ) : (
                              /* Task #4914 — nothing rated yet: no % off an
                                 empty denominator (matches the KPI card's "—"). */
                              <span className="text-sm font-bold text-white/50" data-testid="text-lead-sources-not-yet-rated">Not yet rated</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Stacked horizontal bar — shares of RATED leads only
                          (Task #4914). "No data" lives in the coverage strip
                          below, never inside the quality bar. */}
                      {showQuality && allTotal > 0 && (
                        <div className="mb-6">
                          {allRated > 0 ? (
                            <div className="h-8 rounded-lg overflow-hidden flex" data-testid="bar-lead-quality-rated" style={{ background: REPORT_COLORS.charcoal }}>
                              {pctGood > 0 && (
                                <div 
                                  className="h-full bg-report-healthy flex items-center justify-center transition-all"
                                  style={{ width: `${pctGood}%` }}
                                >
                                  {pctGood >= 10 && <span className="text-xs font-bold text-white drop-shadow">{pctGood}%</span>}
                                </div>
                              )}
                              {pctBad > 0 && (
                                <div 
                                  className="h-full bg-report-critical flex items-center justify-center transition-all"
                                  style={{ width: `${pctBad}%` }}
                                >
                                  {pctBad >= 10 && <span className="text-xs font-bold text-white drop-shadow">{pctBad}%</span>}
                                </div>
                              )}
                              {pctMissed > 0 && (
                                <div 
                                  className="h-full bg-report-watch flex items-center justify-center transition-all"
                                  style={{ width: `${pctMissed}%` }}
                                >
                                  {pctMissed >= 10 && <span className="text-xs font-bold text-white drop-shadow">{pctMissed}%</span>}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="h-8 rounded-lg border border-dashed border-white/10 flex items-center justify-center" data-testid="bar-lead-quality-unrated">
                              <span className="text-xs text-white/50">No rated {t("leads").toLowerCase()} yet</span>
                            </div>
                          )}

                          {/* Legend — the rated dispositions (the bar's segments) */}
                          <div className="flex justify-center gap-6 mt-4 flex-wrap">
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-sm bg-report-healthy"></div>
                              <span className="text-caption text-white/70">Good ({allGood})</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-sm bg-report-critical"></div>
                              <span className="text-caption text-white/70">Not Quotable ({allBad})</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-sm bg-report-watch"></div>
                              <span className="text-caption text-white/70">Missed ({allMissed})</span>
                            </div>
                          </div>

                          {/* Task #4914 — coverage strip: "No data" pulled OUT
                              of the quality bar. Counts stay visible and the
                              label spells out the exclusion from % Good. */}
                          <div className="flex items-center justify-center gap-2 mt-2 flex-wrap" data-testid="text-lead-quality-coverage-strip">
                            <span className="text-caption text-white/60">Rated {allRated} of {allTotal} ({ratedPct}%)</span>
                            {allNoData > 0 && (
                              <>
                                <span className="text-caption text-white/40">·</span>
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="w-3 h-3 rounded-[var(--radius-sm)] bg-report-neutral inline-block"></span>
                                  <span className="text-caption text-white/60">No data: {allNoData} — not in % Good</span>
                                </span>
                              </>
                            )}
                          </div>
                          {hasWebinar && webinarLeadCount > 0 && (
                            <div className="text-center mt-2">
                              <span className="text-caption text-white/60">+ {hasWebinarLeadQualityData ? webinarLeadCount + ' webinar leads' : webinars.hotTransfers + ' Hot Transfers (' + Math.ceil(webinars.hotTransfers * WEBINAR_LEAD_EQUIVALENCY) + ' lead equiv.)'} shown separately</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Small per-source table (replaces the donut legend + ring cluster) */}
                      {leadSourceBreakdown.length > 0 && (
                        <>
                          <div className="overflow-x-auto">
                            <table className="w-full text-left" data-testid="table-lead-sources">
                              <thead>
                                <tr className="text-xs uppercase tracking-wider text-white/60 border-b border-white/10">
                                  <th className="py-2 pr-4 font-bold">Source</th>
                                  <th className="py-2 pr-4 font-bold text-right">{t("leads")}</th>
                                  <th className="py-2 pr-4 font-bold text-right">Share</th>
                                  {showQuality && (
                                    <>
                                      <th className="py-2 pr-4 font-bold text-right">Good</th>
                                      <th className="py-2 pl-4 font-bold text-right">% Good</th>
                                    </>
                                  )}
                                </tr>
                              </thead>
                              <tbody>
                                {leadSourceBreakdown.map((source) => {
                                  const lq = showQuality ? qualityBySource[source.name] : undefined;
                                  // Task #4914 — per-source % Good is rated-based
                                  // too: good / (good + NQ + missed), "—" when the
                                  // source has no rated leads, and the rated count
                                  // renders beside every % so the denominator is
                                  // never a mystery.
                                  const lqRated = lq ? lq.good + lq.notQuotable + (lq.missedCalls || 0) : 0;
                                  const lqNoData = lq ? (lq.noData || 0) : 0;
                                  const pctGoodSource = lq && lqRated > 0 ? Math.round((lq.good / lqRated) * 100) : null;
                                  const sourceSlug = source.name.toLowerCase().replace(/\s+/g, '-');
                                  return (
                                    <tr key={source.name} className="border-b border-white/5" data-testid={`row-lead-source-${sourceSlug}`}>
                                      <td className="py-2 pr-4">
                                        <span className="inline-flex items-center gap-2">
                                          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: source.color }} />
                                          <span className="text-xs text-white/80 font-medium">{source.name}</span>
                                        </span>
                                      </td>
                                      <td className="py-2 pr-4 text-right text-sm font-bold text-white">{source.value}{source.isWebinar ? <span className="text-caption font-normal text-white/50"> equiv.</span> : null}</td>
                                      <td className="py-2 pr-4 text-right text-xs text-white/50">{leadSourceTotal > 0 ? Math.round((source.value / leadSourceTotal) * 100) : 0}%</td>
                                      {showQuality && (
                                        <>
                                          <td className="py-2 pr-4 text-right text-xs text-white/70">{lq ? lq.good : '—'}</td>
                                          <td className="py-2 pl-4 text-right">
                                            {pctGoodSource !== null ? (
                                              <div className="flex flex-col items-end">
                                                <span className={`text-xs font-bold ${pctGoodSource >= 60 ? 'text-report-healthy-bright' : pctGoodSource >= 40 ? 'text-report-gold' : 'text-report-crimson-bright'}`}>{pctGoodSource}%</span>
                                                <span className="text-[10px] text-white/40" data-testid={`text-rated-count-${sourceSlug}`}>of {lqRated} rated</span>
                                              </div>
                                            ) : (
                                              <div className="flex flex-col items-end">
                                                <span className="text-xs text-white/50">—</span>
                                                {lqNoData > 0 && (
                                                  <span className="text-[10px] text-white/40" data-testid={`text-rated-count-${sourceSlug}`}>0 rated</span>
                                                )}
                                              </div>
                                            )}
                                          </td>
                                        </>
                                      )}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          {otherLeadsData.description && otherLeadsCount > 0 && (
                            <div className="text-xs text-white/60 italic mt-2">Other sources: {otherLeadsData.description}</div>
                          )}
                          {hasWebinar && webinarLeadEquiv > 0 && (
                            <div className="text-xs text-white/60 italic mt-1" data-testid="text-webinar-equiv-footnote">
                              * Webinar: {hasWebinarLeadQualityData ? webinarLeadCount + ' leads' : webinars.hotTransfers + ' Hot Transfers'} × 1.6 = {webinarLeadEquiv} lead equiv.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* ========== GBP FOCUS ZONE: aggregate strip + 56px thumbnail cards ========== */}
                <div className="bg-report-charcoal-card rounded-xl border border-report-gold/30 p-6 mb-6">
                  <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
                    <div className="flex items-center gap-4 flex-wrap">
                      <div>
                        <span className="text-xs font-bold text-report-gold uppercase tracking-wider">Google Business Profile</span>
                        {sectionEmpty ? (
                          <div className="metric-large text-white/50 mt-1">{NO_DATA_LABEL}</div>
                        ) : (
                          <div className="metric-large text-report-gold mt-1">{gbpTotalLeads} <span className="text-lg text-white/60">{t("leads").toLowerCase()}</span></div>
                        )}
                      </div>
                      {/* Task #4542 (audit R5 cosmetic) — the demo deck's GBP strip rendered a
                          row of raw zeros; when every aggregate is 0 the trio (and its divider)
                          drops out instead of asserting "0 / 0 / 0". */}
                      {(() => {
                        const gbpNewReviews = gbpLocations.reduce((sum: number, loc: any) => sum + (loc.reviewsGenerated || 0), 0);
                        const gbpRepliedReviews = gbpLocations.reduce((sum: number, loc: any) => sum + (loc.reviewsRespondedTo || 0), 0);
                        const gbpPostsQa = gbpLocations.reduce((sum: number, loc: any) => sum + (loc.postsQaCount || 0), 0);
                        if (gbpNewReviews + gbpRepliedReviews + gbpPostsQa === 0) return null;
                        return (
                          <>
                            <div className="h-12 w-px bg-white/20" />
                            <div className="flex gap-6">
                              <div className="text-center">
                                <div className="text-xl font-bold text-white">{gbpNewReviews}</div>
                                <div className="text-caption text-white/50">New Reviews</div>
                              </div>
                              <div className="text-center">
                                <div className="text-xl font-bold text-white">{gbpRepliedReviews}</div>
                                <div className="text-caption text-white/50">Reviews Replied</div>
                              </div>
                              <div className="text-center">
                                <div className="text-xl font-bold text-white">{gbpPostsQa}</div>
                                <div className="text-caption text-white/50">Posts/Q&A</div>
                              </div>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                    {marketingSection?.data?.gbp?.shared?.blogPostUrl && (
                      <a 
                        href={marketingSection.data.gbp.shared.blogPostUrl} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-caption bg-report-gold/20 text-report-gold px-4 py-2 rounded hover:bg-report-gold/30 transition-colors flex items-center gap-2"
                      >
                        View Monthly Blog Post →
                      </a>
                    )}
                  </div>

                  {/* Per-location thumbnail cards (56px map thumbnail, no full-bleed portraits) */}
                  {gbpLocations.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" data-testid="grid-gbp-location-cards">
                      {gbpLocations.map((loc: any, idx: number) => (
                        // Task #2813 — older/imported report payloads can lack `id`
                        // (server only stamps it for command-panel-resolved rows),
                        // which made this key null and triggered React's missing-key
                        // warning. And multi-location firms can repeat the same `name`
                        // (public share payloads also strip `id`), so the key is
                        // index-composited to stay unique either way.
                        <div key={`${loc.id ?? loc.name ?? "location"}-${idx}`} className="bg-report-charcoal rounded-lg border border-white/10 p-4 flex items-center gap-4" data-testid={`card-gbp-location-${String(loc.name || `location-${idx}`).toLowerCase().replace(/\s+/g, '-')}`}>
                          {loc.heatmapImageUrl ? (
                            <GbpMapThumb url={loc.heatmapImageUrl} name={loc.name} />
                          ) : (
                            <div className="w-14 h-14 rounded-lg bg-report-charcoal-card border border-white/10 flex items-center justify-center shrink-0">
                              <MapPin className="w-6 h-6 text-report-gold/60" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-white truncate">{loc.name}</div>
                            <div className="flex gap-4 text-caption text-white/60 mt-1 flex-wrap">
                              <span><span className="text-report-gold font-bold">{loc.uniqueLeads}</span> {t("leads").toLowerCase()}</span>
                              <span><span className="text-white font-medium">{loc.reviewsGenerated || 0}</span> new reviews</span>
                              <span><span className="text-white font-medium">{loc.reviewsRespondedTo || 0}</span> replied</span>
                              <span><span className="text-white font-medium">{loc.postsQaCount || 0}</span> posts</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ========== PAID SEARCH: prominent per-channel breakdown ========== */}
                {/* Task #4913 — restored to its pre-#4280 home (right after
                    the GBP zone, ABOVE Map Rankings) and re-promoted from a
                    single-row chip strip back to a full card: the restructure
                    had demoted spend/CPL to ~11px chips below the tall map
                    cards, which buried the paid story on shipped share links
                    (the deck renders live code, so already-delivered reports
                    regressed retroactively). Per-channel sub-cards carry
                    leads, spend, and CPL at metric size; Total Spend +
                    Blended CPL ride as chips under the combined-leads header.
                    Empty months keep the Task #4693 skeleton conventions
                    (muted "No data" slot, no fabricated zeros; the
                    ad-spend-gap callout at the top of the slide is
                    unchanged). */}
                {hasPaidMedia && (
                  <div className="bg-report-charcoal-card rounded-xl border border-white/10 p-6 mb-6" data-testid="card-paid-media">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div>
                        <span className="text-sm font-bold text-white/80">Paid Search Advertising</span>
                        <div className="text-xs text-white/60 mt-1">
                          {hasGoogleAds && hasLSA ? 'Google Ads + Local Services Ads' : hasGoogleAds ? 'Google Ads' : 'Local Services Ads'}
                        </div>
                      </div>
                      <div className="text-right">
                        {sectionEmpty ? (
                          <span className="metric-large text-white/50" data-testid="text-paid-media-missing">{NO_DATA_LABEL}</span>
                        ) : (
                          <>
                            <div className="metric-large text-report-gold">{totalPaidLeads}</div>
                            <div className="text-xs text-white/50">{hasGoogleAds && hasLSA ? `Combined ${t("leads")}` : `Total ${t("leads")}`}</div>
                          </>
                        )}
                      </div>
                    </div>
                    {!sectionEmpty && (
                      <>
                        <div className="flex gap-2 flex-wrap mt-4">
                          <span className="text-xs bg-report-ink text-white/70 px-3 py-1.5 rounded" data-testid="chip-paid-total-spend">Total Spend: <span className="text-white font-bold">{formatSpendK(totalAdSpend)}</span></span>
                          <span className="text-xs bg-report-ink text-white/70 px-3 py-1.5 rounded" data-testid="chip-paid-blended-cpl">Blended CPL: <span className="text-white font-bold">{totalPaidLeads > 0 ? `$${Math.round(blendedCPL)}` : '–'}</span></span>
                        </div>
                        {/* Sub-cards spell the radius as rounded-[var(--radius-lg)]
                            (same declaration the rounded-lg utility emits under
                            Tailwind v4, so the paint is identical) to stay
                            neutral under the lint-design-rounded frozen-count
                            ratchet. Print atomicity is inherited: the OUTER
                            card's literal rounded-xl (sans p-8) matches the
                            @media print atomic-card rule, so these children can
                            never straddle a page break on their own. */}
                        <div className={`grid grid-cols-1 ${hasGoogleAds && hasLSA ? 'sm:grid-cols-2' : ''} gap-4 mt-4 pt-4 border-t border-white/10`}>
                          {hasGoogleAds && (
                            <div className="bg-report-charcoal rounded-[var(--radius-lg)] border border-white/10 p-4" data-testid="card-paid-google-ads">
                              <div className="text-xs font-bold text-white/70 uppercase tracking-wider mb-2">Google Ads</div>
                              <div className="flex items-start gap-x-6 gap-y-2 flex-wrap">
                                <div>
                                  <div className="metric-large text-report-gold" data-testid="text-paid-google-ads-leads">{googleAds.uniqueLeads}</div>
                                  <div className="text-xs text-white/50 uppercase tracking-wider">{t("leads")}</div>
                                </div>
                                <div>
                                  <div className="metric-large text-white" data-testid="text-paid-google-ads-spend">{formatSpendK(googleAds.adSpend)}</div>
                                  <div className="text-xs text-white/50 uppercase tracking-wider">Spend</div>
                                </div>
                                <div>
                                  {/* CPL mirrors the blended chip's honesty rule: a
                                      channel with zero leads renders "–", never a
                                      fabricated $0 cost-per-lead. */}
                                  <div className="metric-large text-white" data-testid="text-paid-google-ads-cpl">{googleAds.uniqueLeads > 0 ? `$${Math.round(googleAds.costPerLead)}` : '–'}</div>
                                  <div className="text-xs text-white/50 uppercase tracking-wider">CPL</div>
                                </div>
                              </div>
                            </div>
                          )}
                          {hasLSA && (
                            <div className="bg-report-charcoal rounded-[var(--radius-lg)] border border-white/10 p-4" data-testid="card-paid-lsa">
                              <div className="text-xs font-bold text-white/70 uppercase tracking-wider mb-2">Local Services Ads</div>
                              <div className="flex items-start gap-x-6 gap-y-2 flex-wrap">
                                <div>
                                  <div className="metric-large text-report-gold" data-testid="text-paid-lsa-leads">{lsa.uniqueLeads}</div>
                                  <div className="text-xs text-white/50 uppercase tracking-wider">{t("leads")}</div>
                                </div>
                                <div>
                                  <div className="metric-large text-white" data-testid="text-paid-lsa-spend">{formatSpendK(lsa.adSpend)}</div>
                                  <div className="text-xs text-white/50 uppercase tracking-wider">Spend</div>
                                </div>
                                <div>
                                  <div className="metric-large text-white" data-testid="text-paid-lsa-cpl">{lsa.uniqueLeads > 0 ? `$${Math.round(lsa.costPerLead)}` : '–'}</div>
                                  <div className="text-xs text-white/50 uppercase tracking-wider">CPL</div>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ========== MAP RANKINGS: one card per location, pills per distinct keyword, ONE shared legend ========== */}
                {(() => {
                  // Task #4848 — group per LOCATION, then per distinct keyword.
                  // SEMrush scans weekly, so shipped reports' stored
                  // heatmapSnapshotIds can carry ~4 same-keyword snapshots per
                  // month; one card per id rendered a wall of near-identical
                  // maps. Same-keyword scans collapse to the latest in-payload
                  // scan; distinct keywords become pills on the location's one
                  // card. Masked payloads group identically (masking maps one
                  // keyword to one masked label, e.g. "Keyword A").
                  const heatmapCards: LocationHeatmapCardData[] = gbpLocations.flatMap((loc: any): LocationHeatmapCardData[] => {
                    const ids: string[] = loc.heatmapSnapshotIds?.length > 0 ? loc.heatmapSnapshotIds : loc.heatmapSnapshotId ? [loc.heatmapSnapshotId] : [];
                    if (ids.length > 0) {
                      return [{
                        locName: loc.name,
                        keywords: groupSnapshotIdsByKeyword(
                          ids,
                          loc.localDominance?.keywordSnapshots as KeywordSnapshotEntry[] | undefined,
                        ),
                      }];
                    }
                    if (loc.heatmapImageUrl) return [{ locName: loc.name, imageUrl: loc.heatmapImageUrl, keywords: [] }];
                    return [];
                  });
                  if (heatmapCards.length === 0) return null;

                  return (
                    <div className="bg-report-charcoal-card rounded-xl border border-white/10 p-6 mb-6" data-testid="section-map-rankings">
                      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                        <div className="flex items-center gap-2">
                          <MapPin className="w-4 h-4 text-report-gold" />
                          <span className="text-sm font-bold text-white/80">Map Rankings</span>
                        </div>
                        {/* ONE shared legend for every map below — canonical served palette (shared/heatmapColors). */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="heatmap-shared-legend">
                          {/* Task #4682 — legend chips at 12px/AA ink (were 11px @ white/50,
                              sub-AA fine print for low-vision readers). */}
                          {HEATMAP_RANK_LEGEND.map((item) => (
                            <div key={item.label} className="flex items-center gap-1.5 text-xs">
                              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: item.color, opacity: 0.85 }} />
                              <span className="text-white/75">{item.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className={`grid grid-cols-1 ${heatmapCards.length > 1 ? 'lg:grid-cols-2' : ''} gap-4`}>
                        {/* Key is index-composited: sanitized share payloads can repeat the
                            same snapshotId across locations (and location names repeat on
                            multi-location firms), so neither is unique on its own. */}
                        {heatmapCards.map((card, idx) => (
                          <PublicLocationHeatmapCard
                            key={`${card.keywords[0]?.snapshotId ?? card.locName}-${idx}`}
                            card={card}
                            cardIdx={idx}
                            privacyMode={privacyMode}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* ========== WEBINARS: single-row stats ========== */}
                {hasWebinar && (
                  <div className="bg-report-charcoal-card rounded-xl p-4 border border-white/10 mb-4" data-testid="card-webinars">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <span className="text-sm font-bold text-white/80">Webinars</span>
                      <div className="flex items-baseline gap-2">
                        {sectionEmpty ? (
                          <span className="metric-large text-white/50" data-testid="text-webinars-missing">{NO_DATA_LABEL}</span>
                        ) : (
                          <>
                            <span className="metric-large text-report-gold">{webinars.hotTransfers}</span>
                            <span className="text-caption text-white/50">Hot Transfer / Schedule</span>
                          </>
                        )}
                      </div>
                    </div>
                    {!sectionEmpty && (
                    <div className="flex gap-2 flex-wrap mt-4">
                      <span className="text-caption bg-report-ink text-white/70 px-2 py-1 rounded">Registrants: {webinars.registrants}</span>
                      <span className="text-caption bg-report-ink text-white/70 px-2 py-1 rounded">Attendees: {webinars.attendees}</span>
                      <span className="text-caption bg-report-ink text-white/70 px-2 py-1 rounded">Show Rate: {webinars.showRate}%</span>
                      <span className="text-caption bg-report-ink text-white/70 px-2 py-1 rounded">HT / Schedule Rate: {webinars.hotTransferRate || 0}%</span>
                    </div>
                    )}
                    {webinarUsingFallback && (
                      <div className="mt-2 text-caption text-white/60">
                        Webinar consultations count as 1.6 {t("leads")} Equivalents (rounded up)
                      </div>
                    )}
                  </div>
                )}

                {/* ========== REVIEW GENERATION: velocity focus + single-row source stats ========== */}
                <div className="bg-report-charcoal-card rounded-xl p-6 border border-white/10">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-bold text-white/80">Review Generation</span>
                    {sectionEmpty ? (
                      <span className="metric-large text-white/50">{NO_DATA_LABEL}</span>
                    ) : (
                      <span className="metric-large text-report-gold">{totalReviewsFromSources || gbpTotalReviews}</span>
                    )}
                  </div>
                  {/* ===== Review Velocity focus (Task #2566) ===== */}
                  {(() => {
                    const panelTotal = totalReviewsFromSources || gbpTotalReviews;
                    // Velocity series + this-month count + trailing-window total /
                    // average + window-aware labels are ALL derived by the ONE pure
                    // `computeReviewVelocity` helper (unit-tested, Tasks #2580/#4844)
                    // so the three stats and the sparkline can never disagree.
                    const { series, monthsCount, trailingAvg, avgLabel, currentMonth, windowTotal, totalLabel } = computeReviewVelocity(trendData, panelTotal);
                    const velocityIncludeYear = trendSpansMultipleYears(series.map(t => t.month));
                    const chartData = series.map(d => ({ month: formatTrendMonth(d.month, velocityIncludeYear), value: d.value }));
                    // Month-over-month change badge math is derived by the pure
                    // `computeReviewVelocityChange` helper (unit-tested, Task #2598).
                    const { delta, pct, show: showChange } = computeReviewVelocityChange(series);
                    // Task #2579 — goal band: classify the trailing-average velocity
                    // against the admin-set per-client monthly target. No target
                    // (absent / <= 0) → neutral gold (no silent green/red).
                    // Per-report target wins; otherwise fall back to the
                    // per-client target (Task #2596) so a goal set once on the
                    // client carries to every month. <= 0 / absent → no target.
                    const monthlyTarget = resolveReviewMonthlyTarget(
                      reviewGen?.monthlyTarget,
                      client?.monthlyReviewTarget,
                    );
                    const velocityBand = getReviewVelocityBand(trailingAvg, monthlyTarget);
                    const bandStyles: Record<string, { hex: string; numClass: string; chipClass: string }> = {
                      on_track: { hex: REPORT_STATUS_COLORS.healthy, numClass: 'text-report-healthy-bright', chipClass: 'bg-report-healthy/15 text-report-healthy-bright' },
                      behind: { hex: REPORT_COLORS.gold, numClass: 'text-report-gold', chipClass: 'bg-report-watch/20 text-report-gold' },
                      off_track: { hex: REPORT_COLORS.crimsonBright, numClass: 'text-report-crimson-bright', chipClass: 'bg-report-critical/15 text-report-crimson-bright' },
                      // "none" (no target) is deliberately MUTED, not gold: gold
                      // is the "behind" warning accent on dark surfaces, and the
                      // no-target state must stay visually distinct from it
                      // (Task #2619 render contract, re-expressed in tokens).
                      none: { hex: REPORT_COLORS.inkInverseMuted, numClass: 'text-report-ink-inverse-muted', chipClass: 'bg-white/10 text-white/50' },
                    };
                    const bandStyle = bandStyles[velocityBand];
                    // Task #4981 — with <= 1 month in the trailing window (the
                    // normal first-month case: trendData needs 2+ reports),
                    // this-month, window-total, and trailing-average are all the
                    // SAME number and both window labels degrade to
                    // "Current month" — three identical stats read as broken
                    // repeated text. Collapse the row to ONE honest "This month"
                    // stat. Applies only when real data renders; empty sections
                    // keep the full three-slot skeleton (Task #4852's branch)
                    // untouched.
                    const collapseToSingleStat = !sectionEmpty && monthsCount <= 1;
                    return (
                      <div className="bg-report-charcoal rounded-lg p-4 mb-4 border border-report-gold/20">
                        {/* Task #4844 — three labeled stats from the ONE helper result:
                            this-month count (the sparkline's latest point), the
                            trailing-window total, and the trailing-window average.
                            Only the AVERAGE carries the goal-band color/chip; labels
                            adapt to sparse history ("60-day…" with 2 months) so the
                            panel never claims a 90-day window it doesn't have. With
                            <= 1 month the row collapses to the single "This month"
                            stat (Task #4981), which then carries the goal-band
                            color — the trailing average IS that month's count, so
                            the band verdict, chip, and target annotation are
                            unchanged. Empty sections keep the skeleton convention:
                            muted "No data" slots, no fake zeros. */}
                        {collapseToSingleStat ? (
                          <div className="flex items-start gap-x-6 gap-y-2 flex-wrap">
                            <div>
                              <div className="text-xs uppercase tracking-wider font-bold text-white/60" data-testid="text-review-velocity-month-label">This month</div>
                              <div className="flex items-baseline gap-2">
                                <span className={`metric-large ${bandStyle.numClass}`} data-testid="text-review-velocity">{currentMonth}</span>
                                <span className="text-xs text-white/50">reviews / mo</span>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-x-6 gap-y-2 flex-wrap">
                            <div>
                              <div className="text-xs uppercase tracking-wider font-bold text-white/60" data-testid="text-review-velocity-month-label">This month</div>
                              {sectionEmpty ? (
                                <span className="metric-large text-white/50" data-testid="text-review-velocity-month-missing">{NO_DATA_LABEL}</span>
                              ) : (
                                <span className="metric-large text-white" data-testid="text-review-velocity-month">{currentMonth}</span>
                              )}
                            </div>
                            <div>
                              <div className="text-xs uppercase tracking-wider font-bold text-white/60" data-testid="text-review-velocity-total-label">{totalLabel}</div>
                              {sectionEmpty ? (
                                <span className="metric-large text-white/50" data-testid="text-review-velocity-total-missing">{NO_DATA_LABEL}</span>
                              ) : (
                                <span className="metric-large text-white" data-testid="text-review-velocity-total">{windowTotal}</span>
                              )}
                            </div>
                            <div>
                              <div className="text-xs uppercase tracking-wider font-bold text-white/60" data-testid="text-review-velocity-label">{avgLabel}</div>
                              <div className="flex items-baseline gap-2">
                                {sectionEmpty ? (
                                  <span className="metric-large text-white/50" data-testid="text-review-velocity-missing">{NO_DATA_LABEL}</span>
                                ) : (
                                  <span className={`metric-large ${bandStyle.numClass}`} data-testid="text-review-velocity">{trailingAvg}</span>
                                )}
                                <span className="text-xs text-white/50">reviews / mo</span>
                              </div>
                            </div>
                          </div>
                        )}
                        {monthlyTarget !== null && (
                          <div className="flex items-center gap-2 mt-2">
                            <span className={`text-caption font-bold px-2 py-1 rounded ${bandStyle.chipClass}`} data-testid="badge-review-velocity-band">
                              {getReviewVelocityBandLabel(velocityBand)}
                            </span>
                            <span className="text-caption text-white/50" data-testid="text-review-velocity-target">Target: {monthlyTarget} / mo</span>
                          </div>
                        )}
                        {chartData.length >= 2 && (
                          <div className="mt-4" data-testid="chart-review-velocity-sparkline">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs uppercase tracking-wider font-bold text-white/50">Velocity Trend</span>
                              {showChange && (
                                <span className={`text-xs font-bold px-2 py-1 rounded ${delta > 0 ? 'bg-report-healthy/15 text-report-healthy-bright' : 'bg-report-critical/15 text-report-crimson-bright'}`} data-testid="badge-review-velocity-change">
                                  {delta > 0 ? '↑' : '↓'} {Math.abs(pct)}%
                                </span>
                              )}
                            </div>
                            <ResponsiveContainer width="100%" height={80}>
                              <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                                <defs>
                                  <linearGradient id="gradient-review-velocity" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={REPORT_COLORS.gold} stopOpacity={0.35}/>
                                    <stop offset="95%" stopColor={REPORT_COLORS.gold} stopOpacity={0.05}/>
                                  </linearGradient>
                                </defs>
                                <XAxis dataKey="month" tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: REPORT_TICK_FONT_SIZE }} axisLine={false} tickLine={false} />
                                <YAxis tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: REPORT_TICK_FONT_SIZE }} axisLine={false} tickLine={false} width={25} allowDecimals={false} />
                                <Tooltip
                                  formatter={(value: number) => [`${value} reviews/mo`, 'Velocity']}
                                  contentStyle={{ fontSize: REPORT_TICK_FONT_SIZE, borderRadius: 8, backgroundColor: REPORT_COLORS.charcoalCard, border: '1px solid rgba(255,255,255,0.1)', color: REPORT_COLORS.white }}
                                  labelStyle={{ color: REPORT_COLORS.white }}
                                  itemStyle={{ color: REPORT_COLORS.white }}
                                />
                                {monthlyTarget !== null && (
                                  <ReferenceLine
                                    y={monthlyTarget}
                                    stroke={bandStyle.hex}
                                    strokeDasharray="4 3"
                                    strokeWidth={1.5}
                                    label={{ value: `Target ${monthlyTarget}`, position: 'insideTopRight', fill: bandStyle.hex, fontSize: REPORT_TICK_FONT_SIZE }}
                                  />
                                )}
                                <Area type="monotone" isAnimationActive={false} dataKey="value" stroke={REPORT_COLORS.gold} strokeWidth={2} fill="url(#gradient-review-velocity)" dot={{ r: 2, fill: REPORT_COLORS.gold }} />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {/* Single-row source stats (replaces the 3-card grid; internal
                      automation state is deliberately no longer rendered). */}
                  {sectionEmpty ? (
                    <div data-testid="row-review-sources">
                      <span className="text-xs text-white/40">Review source breakdown appears here once review activity is tracked.</span>
                    </div>
                  ) : (
                    <div className="flex gap-2 flex-wrap" data-testid="row-review-sources">
                      <span className="text-xs bg-report-ink text-white/70 px-2 py-1 rounded">Via Client List: <span className="text-white font-bold">{reviewSources.list.count}</span> · {reviewSources.list.activationRate}% activation</span>
                      {hasWebinar && (
                        <span className="text-xs bg-report-ink text-white/70 px-2 py-1 rounded">Via Webinar: <span className="text-white font-bold">{reviewSources.webinar.count}</span> · {reviewSources.webinar.activationRate}% activation</span>
                      )}
                      <span className="text-xs bg-report-ink text-white/70 px-2 py-1 rounded">Organic: <span className="text-white font-bold">{reviewSources.other.count}</span> · unprompted</span>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </Slide>
  );
}

/** Fetches the heatmap snapshot's keyword name for the map-pair header;
 * falls back to the provided label on any failure. Suppressed entirely under
 * privacy mode (the caller never renders it — Task #4290). */
function PublicHeatmapTabLabel({ snapshotId, fallback }: { snapshotId: string; fallback: string }) {
  const { data } = useQuery<{ keywordName?: string }>({
    queryKey: [`/api/public/heatmaps/${snapshotId}/meta`],
    queryFn: async () => {
      const res = await fetch(`/api/public/heatmaps/${snapshotId}/meta`);
      if (!res.ok) return { keywordName: fallback };
      const d = await res.json();
      return { keywordName: d.snapshot?.keywordName || fallback };
    },
    staleTime: Infinity,
  });
  return <>{data?.keywordName || fallback}</>;
}

/** Shape of one entry in a location's `localDominance.keywordSnapshots`. */
type KeywordSnapshotEntry = {
  keywordName: string;
  snapshotId: string;
  reportDate: string;
  shareOfVoice: number | null;
  avgRank: number | null;
  previousAvgRank: number | null;
  rankChange: number | null;
  sovChange: number | null;
  distributionBands?: { bandTop3Pct: number; band4to10Pct: number; band11to20Pct: number; bandOutOfTop20Pct: number } | null;
  competitors?: Array<{ rank: number; name: string; shareOfVoice: number; averageRank: number | null; isSubjectBusiness: boolean; locationLabel?: string | null }>;
  sovHistory?: Array<{ date: string; sovRaw: number; sov90dAvg: number | null; anchorIncrease: number | null }>;
};

/** One selectable keyword option on a location's Map Rankings card. `kw` is
 * absent when the payload has no keywordSnapshots entry for the id (older
 * imports) — the option still renders with the fetched/fallback label. */
type HeatmapKeywordOption = { snapshotId: string; kw?: KeywordSnapshotEntry };
/** 56px GBP thumbnail: resized `__thumb` variant first, original only as a
 * fallback while a legacy object's variant is still unhealed. */
function GbpMapThumb({ url, name }: { url: string; name: string }) {
  const status = useScanImageStatus(url);
  const [thumbFailed, setThumbFailed] = useState(false);
  if (status !== "valid") {
    return (
      <div className="w-14 h-14 rounded-lg bg-report-charcoal-card border border-white/10 flex items-center justify-center shrink-0">
        <MapPin className="w-6 h-6 text-report-gold/60" />
      </div>
    );
  }
  return (
    <img
      src={thumbFailed ? url : scanThumbUrl(url)}
      onError={thumbFailed ? undefined : () => setThumbFailed(true)}
      alt={`${name} map thumbnail`}
      className="w-14 h-14 rounded-lg object-cover border border-white/10 shrink-0"
      loading="lazy"
      data-print-downscale="56"
    />
  );
}

/** Fixed-height Map Rankings slot for a legacy stored screenshot. */
function ScanSlotImage({ url, locName }: { url: string; locName: string }) {
  const status = useScanImageStatus(url);
  if (status !== "valid") {
    return (
      <div
        className="relative w-full overflow-hidden rounded-lg border border-white/10 bg-black/30 flex flex-col items-center justify-center gap-2"
        style={{ height: '380px' }}
        data-testid="scan-slot-pending"
      >
        <MapPin className="w-8 h-8 text-report-gold/50" />
        <span className="text-xs text-white/80">Map visibility scan pending</span>
      </div>
    );
  }
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-white/10" style={{ height: '380px' }}>
      <img src={url} alt={`${locName} heatmap`} className="absolute inset-0 w-full h-full object-contain bg-black/30" data-print-downscale="380" />
    </div>
  );
}

/** Task #4848 — one Map Rankings card per location. Multiple distinct
 * keywords render as pills; switching a pill swaps the map, the header
 * keyword label, the takeaway line, and the standing line to that keyword's
 * snapshot. Extracted as a child component so the slide body stays hook-free
 * (per-card pill selection is useState). */
function PublicLocationHeatmapCard({
  card,
  cardIdx,
  privacyMode,
}: {
  card: LocationHeatmapCardData;
  cardIdx: number;
  privacyMode: boolean;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const active: HeatmapKeywordOption | undefined =
    card.keywords[activeIdx] ?? card.keywords[0];
  // Task #4717 — honest standing from THIS map's own keyword snapshot
  // (per-keyword snapshots reconcile with the map; top-level competitor
  // arrays can mix keywords). Derivation is averageRank-only; renders
  // nothing when the snapshot has no usable competitive frame.
  const standing = deriveCompetitorStanding(active?.kw?.competitors);
  return (
    <div className="bg-report-charcoal rounded-lg border border-white/10 p-4" data-testid={`card-heatmap-${cardIdx}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-medium text-white/80 truncate">{card.locName}</span>
        {active && (
          <span className="text-xs text-report-gold/80 truncate" data-testid={`text-heatmap-keyword-${cardIdx}`}>
            {/* Task #4290 — privacy: no meta fetch (it can return the real keyword); payload keywordName is already masked. */}
            {active.kw?.keywordName ?? (privacyMode ? "Primary keyword" : <PublicHeatmapTabLabel snapshotId={active.snapshotId} fallback="Primary keyword" />)}
          </span>
        )}
      </div>
      {card.keywords.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-2" data-testid={`row-heatmap-pills-${cardIdx}`}>
          {card.keywords.map((opt, i) => (
            <button
              key={`${opt.snapshotId}-${i}`}
              type="button"
              onClick={() => setActiveIdx(i)}
              className={`text-caption px-2.5 py-1 rounded-full border transition-colors ${
                i === activeIdx
                  ? "bg-report-gold/20 border-report-gold/60 text-report-gold font-medium"
                  : "bg-report-ink border-white/10 text-white/60 hover:text-white/80"
              }`}
              data-testid={`pill-heatmap-${cardIdx}-${i}`}
            >
              {opt.kw?.keywordName ?? (privacyMode ? `Keyword ${i + 1}` : <PublicHeatmapTabLabel snapshotId={opt.snapshotId} fallback={`Keyword ${i + 1}`} />)}
            </button>
          ))}
        </div>
      )}
      {active ? (
        // key remounts the map when a pill switches snapshots.
        <InteractiveHeatmap key={active.snapshotId} snapshotId={active.snapshotId} locationName={card.locName} keywordName="" compact={true} isPublic={true} hideLegend={true} height={380} privacyMode={privacyMode} />
      ) : (
        <ScanSlotImage url={card.imageUrl!} locName={card.locName} />
      )}
      {/* Task #4682 — takeaway caption bumped 11px/50% → 12px/75% (AA). */}
      <p className="text-xs text-white/75 mt-2 leading-snug" data-testid={`text-heatmap-takeaway-${cardIdx}`}>{heatmapTakeaway(active?.kw, card.locName)}</p>
      {/* Task #4717 — standing line at the same AA-bumped 12px/75%
          treatment as the takeaway; gold marks the subject. Masked
          names ("Competitor A"…) pass through server-side as-is. */}
      {standing && (
        <p className="text-xs text-white/75 mt-1 leading-snug" data-testid={`text-heatmap-standing-${cardIdx}`}>
          <span className="text-report-gold font-semibold">You rank #{standing.position}</span>
          {` of ${standing.totalFirms} firms detected in this market${standing.topCompetitors.length > 0 ? ` — top competitors: ${standing.topCompetitors.join(", ")}` : ""}.`}
        </p>
      )}
    </div>
  );
}

/** One Map Rankings card: a location with pill-switchable keyword snapshots,
 * or (legacy) a single stored screenshot when `keywords` is empty. */
type LocationHeatmapCardData = { locName: string; imageUrl?: string; keywords: HeatmapKeywordOption[] };

/** Task #4848 — collapse a location's stored snapshot ids to one option per
 * DISTINCT keyword. The month auto-pull used to store every weekly SEMrush
 * scan, so shipped reports hold several same-keyword ids; within a keyword
 * the LATEST scan (by the payload's keywordSnapshots `reportDate`) wins.
 * Pill order is first-seen (auto-pulled payloads list newest-first, so the
 * primary keyword stays first). Ids with no keywordSnapshots entry can't be
 * grouped and each keep their own option (pre-#4848 behavior). Normalization
 * mirrors the server's canonical form (trim/collapse-space/lowercase) purely
 * defensively — stored keywordName is CHECK-constrained canonical, and
 * masked labels ("Keyword A") are already canonical strings. */
function groupSnapshotIdsByKeyword(
  ids: string[],
  keywordSnapshots: KeywordSnapshotEntry[] | undefined,
): HeatmapKeywordOption[] {
  const options: HeatmapKeywordOption[] = [];
  const indexByKeyword = new Map<string, number>();
  for (const id of ids) {
    const kw = keywordSnapshots?.find((k) => k.snapshotId === id);
    const normalized = kw?.keywordName
      ? kw.keywordName.trim().replace(/\s+/g, " ").toLowerCase()
      : null;
    if (normalized === null) {
      options.push({ snapshotId: id, kw });
      continue;
    }
    const existingIdx = indexByKeyword.get(normalized);
    if (existingIdx === undefined) {
      indexByKeyword.set(normalized, options.length);
      options.push({ snapshotId: id, kw });
      continue;
    }
    // Duplicate keyword — keep whichever scan is latest. Missing/unparseable
    // dates lose to a parseable one and never displace the first-seen entry.
    const existingTs = Date.parse(options[existingIdx].kw?.reportDate ?? "");
    const candidateTs = Date.parse(kw?.reportDate ?? "");
    if (!Number.isNaN(candidateTs) && (Number.isNaN(existingTs) || candidateTs > existingTs)) {
      options[existingIdx] = { snapshotId: id, kw };
    }
  }
  return options;
}

/** One plain-language line for the active map, from that keyword snapshot's
 * own metrics (already in the payload — no extra fetch). Equal avg ranks
 * across maps are expected when keywords perform alike; not a data bug. */
function heatmapTakeaway(kw: KeywordSnapshotEntry | undefined, locName: string): string {
  if (kw && kw.avgRank !== null && kw.avgRank !== undefined) {
    const base = `Averaging #${kw.avgRank.toFixed(1)} across the scan area for “${kw.keywordName}”`;
    // Task #4848 — a change that ROUNDS to 0.0 reads as holding steady
    // (near-zero drifts used to ship as "up 0.0 spots").
    if (
      kw.rankChange !== null &&
      kw.rankChange !== undefined &&
      kw.rankChange !== 0 &&
      Math.abs(kw.rankChange).toFixed(1) !== "0.0"
    ) {
      return `${base} — ${kw.rankChange > 0 ? 'up' : 'down'} ${Math.abs(kw.rankChange).toFixed(1)} spots vs the last scan.`;
    }
    return `${base} — holding steady vs the last scan.`;
  }
  return `Local map visibility scan for ${locName}.`;
}
