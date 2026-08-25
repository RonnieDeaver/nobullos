/**
 * LifetimeValueSlide — one slide of the public client report.
 * Extracted verbatim in Task #4271; redesigned in Task #4281 (audit §8.7-9,
 * backlog #25/#26): the off-palette navy card system is retired onto the
 * report tokens (radii ≤4px via card primitives, token typography, no
 * white-alpha inks), and the slide now tells one transformation story —
 * the monthly work → the reputation it compounds into → the payoff —
 * carried by a single cumulative-arc chart and a single story line, with
 * `vCenter` resolving the audit's bottom dead zone (§8.4). Task #4902: this
 * slide carries NO verdict line (slot retired from the shared key set).
 *
 * The arc chart is presentation-only arithmetic over payload data the slide
 * already receives: it anchors to the server's `lifetimeValue.totalLeads`
 * (formula untouched — out of scope) and walks BACKWARD through the trend
 * window's per-source monthly sums, so its endpoint always equals the
 * headline number and pre-window history + the pre-engagement baseline
 * compress into the "Start" point.
 */

import { Briefcase, Heart, MoveRight, Star, Users } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Slide } from "./Slide";
import {
  buildLifetimeEstimateUpsellMessage,
  buildLifetimeNoCasesUpsellMessage,
  buildUpgradeUpsellMessage,
  ChartPlaceholderFrame,
  NO_DATA_LABEL,
  SectionUpsellCallout,
} from "./EmptyState";
import { hasLifetimeData } from "./sectionPresence";
import type { PublicReportViewModel } from "./derive";
import {
  formatTrendMonth,
  trendSpansMultipleYears,
  TREND_FILL_BOTTOM_OPACITY,
  TREND_FILL_TOP_OPACITY,
  TREND_STROKE_WIDTH,
} from "./TrendsSection";
import { REPORT_COLORS, REPORT_TICK_FONT_SIZE } from "./reportTokens";

/** X-axis label for the arc's synthetic origin point. */
const ARC_START_LABEL = "Start";

/** Payoff-card cap on individually named gap months — longer lists truncate to "+ N more". */
const MAX_NAMED_MISSING_MONTHS = 3;

/**
 * Task #4849 — "Incomplete data — missing Feb '26, Mar '26, Apr '26 + 2 more".
 * Trend-style month labels via the shared formatTrendMonth helper, year always
 * shown ('26): the lifetime span routinely crosses years, and the annotation
 * must stay unambiguous when it does. Plain text so print/PDF renders it
 * unchanged.
 */
function formatIncompleteCasesAnnotation(missingMonths: string[]): string {
  const named = missingMonths
    .slice(0, MAX_NAMED_MISSING_MONTHS)
    .map((m) => formatTrendMonth(m, true));
  const extra = missingMonths.length - named.length;
  return `Incomplete data — missing ${named.join(", ")}${extra > 0 ? ` + ${extra} more` : ""}`;
}

/**
 * Gold connector between story beats: right-pointing on desktop rows, down on
 * stacked mobile. ONE icon rotated per breakpoint — the print stylesheet
 * forces `svg { display: inline-block !important }`, so a hidden/md:block
 * icon pair would print BOTH arrows; transform-based switching survives it.
 */
function StageArrow() {
  return (
    <div className="flex items-center justify-center shrink-0" aria-hidden="true">
      <MoveRight className="w-5 h-5 text-report-gold/70 rotate-90 md:rotate-0" />
    </div>
  );
}

export function LifetimeValueSlide({ view }: { view: PublicReportViewModel }) {
  const { client, data, slideNumbers, t } = view;
  const lifetimeData = data.lifetimeValue;
  // Task #4285 — the data gate lives in the shared sectionPresence helper so
  // this slide and the agenda drop-out rule can never disagree.
  const hasData = hasLifetimeData(lifetimeData);
  // Tasks #3687/#4849 — the confirmed-number branch requires BOTH the
  // server's hasHardData flag AND a positive total. The shared accumulator
  // already makes a "confirmed 0" impossible by construction (only unflagged
  // POSITIVE monthly values count as genuinely provided — report forms and
  // the AI-parse path coerce absent→0, so stored unflagged zeros mean "never
  // provided"); the render-side positive-total requirement keeps a numeral 0
  // unreachable even for defensive/hand-built payloads. When neither hard
  // case data nor a meaningful estimate exists (estimates of 0 round away),
  // the card shows "Not reported to us yet" (Task #4845 client-attribution
  // wording) instead of presenting never-provided data as a confirmed 0.
  const hasHardCases = !!lifetimeData?.hasHardData && (lifetimeData?.totalCases ?? 0) > 0;
  const showEstimate = !!lifetimeData && !hasHardCases && !!lifetimeData.estimatedCases;
  // Task #4849 — per-month provenance from the shared accumulator: when the
  // confirmed total is real but the accumulation span has gap months (no
  // genuinely provided case data — report-less months included), the payoff
  // card annotates the number instead of implying complete coverage. Absent
  // on legacy/hand-built payloads → no annotation.
  const missingCaseMonths = lifetimeData?.casesCoverage?.missingMonths ?? [];

  // Calculate client tenure in months
  const clientTenureMonths = (() => {
    const startDate = client.clientStartDate;
    if (!startDate) return null;
    const start = new Date(startDate);
    const now = new Date();
    const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    return Math.max(1, months);
  })();

  // The one chart (§8.7-9): cumulative campaign-lead arc. Reconciles with the
  // headline by construction — the trend window's per-source sums use the
  // same formula the lifetime accumulation does, and everything the window
  // can't see (pre-window months + the pre-engagement baseline) is carried
  // into the "Start" point, so the last point IS `totalLeads`.
  const trendData = data.trendData;
  const arc = (() => {
    if (!lifetimeData || lifetimeData.totalLeads <= 0) return null;
    if (!trendData || trendData.length < 2) return null;
    const sources = trendData.map((m) => m.marketing?.leadsBySource);
    // Legacy payloads without the per-source breakdown can't reconcile a
    // cumulative series with the headline formula — never chart a guess.
    if (sources.some((s) => !s)) return null;
    const monthly = sources.map(
      (s) => (s!.gbp || 0) + (s!.googleAds || 0) + (s!.lsa || 0) + (s!.webinar || 0),
    );
    const windowTotal = monthly.reduce((a, b) => a + b, 0);
    // Task #4592 — data-inconsistency gate: if the trend window's per-source
    // sum EXCEEDS the lifetime headline, the ≥0 clamp on carried-in would
    // make the arc's endpoint disagree with the headline number (the chart's
    // core credibility claim). Never chart that — hide the arc (same policy
    // as the legacy-payload gate above) and flag the inconsistency.
    if (windowTotal > lifetimeData.totalLeads) {
      console.warn(
        `[LifetimeValueSlide] Data inconsistency: trend-window lead sum (${windowTotal}) ` +
          `exceeds lifetimeValue.totalLeads (${lifetimeData.totalLeads}); hiding the compounding arc ` +
          `rather than charting an endpoint above the headline.`,
      );
      return null;
    }
    const carriedIn = Math.max(0, lifetimeData.totalLeads - windowTotal);
    const includeYear = trendSpansMultipleYears(trendData.map((m) => m.month));
    let running = carriedIn;
    const points = [{ month: ARC_START_LABEL, value: carriedIn }];
    trendData.forEach((m, i) => {
      running += monthly[i];
      points.push({ month: formatTrendMonth(m.month, includeYear), value: running });
    });
    return { points };
  })();

  // §8.5 endpoint labels: value text on the first (where you started) and
  // last (today = the headline lifetime number) points only.
  const lastArcIdx = arc ? arc.points.length - 1 : -1;
  const renderArcEndpointLabel = (props: { x?: number; y?: number; value?: number | null; index?: number }) => {
    const { x, y, value, index } = props ?? {};
    if (index !== 0 && index !== lastArcIdx) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || typeof value !== "number") return null;
    return (
      <text
        x={x}
        y={(y as number) - 10}
        textAnchor={index === 0 ? "start" : "end"}
        fontSize={REPORT_TICK_FONT_SIZE}
        fontWeight={700}
        fill={index === 0 ? REPORT_COLORS.inkInverseMuted : REPORT_COLORS.gold}
      >
        {value.toLocaleString()}
      </text>
    );
  };

  const subtitle = clientTenureMonths
    ? `${clientTenureMonths} month${clientTenureMonths !== 1 ? "s" : ""} of partnership — and what ${clientTenureMonths !== 1 ? "they've" : "it's"} compounded into.`
    : "Your cumulative partnership impact — compounding month after month.";

  return (
    <Slide slideNumber={slideNumbers.lifetimeValue} variant="charcoal" pattern="dots" id="lifetime-value" vCenter>
      <div className="slide-header">
        <Heart className="slide-header-icon text-report-gold" />
        <h2 className="slide-title text-report-ink-inverse">Relationship Lifetime Value</h2>
      </div>
      <p className="slide-subtitle-dark">{subtitle}</p>
      {/* Task #4902 — no verdict line on this slide (owner decision): the
          lifetimeValue slot is retired from the shared key set, so even a
          legacy stored verdict never renders here. */}
      <div className="divider-thin" />

      {/* Task #4693 — deck-wide no-data upsell convention (supersedes the
          Task #4285 collapse band): the story always renders. With no
          lifetime data the beats show muted "No data" slots and the arc
          position renders a quiet placeholder frame; ONE gold callout
          carries the CaseIntake™ pitch (upgrade-only variant — lifetime
          value is cumulative, not month-scoped, so no month clause).
          Task #4714 (owner-approved wording): when the slide HAS lifetime
          data but the payoff is soft, the single callout swaps to a
          finer-grained pitch — "industry estimates" wording when a ~N
          benchmark estimate renders, "no cases reported yet" wording when
          case data was never provided (incl. estimates that round to 0).
          Hard case data ⇒ no callout at all: the cases card is showing
          CONFIRMED data, and a "tracks this automatically" pitch beside it
          would undercut that; the remaining lifetime beats (leads/reviews)
          are campaign outputs that accumulate without client action, and
          their "No data" skeleton slots still render honestly. Task #4849:
          hard case data now requires a POSITIVE confirmed total (a numeral
          0 is never acceptable there), so zero/never-provided payloads —
          including defensive hasHardData-with-0 shapes — fall to these
          callout variants instead; partial coverage keeps the confirmed
          number and adds the "Incomplete data" annotation on the card. */}
      {!hasHardCases &&
        (!hasData ? (
          <SectionUpsellCallout
            variant="dark"
            testId="upsell-lifetime-value"
            message={buildUpgradeUpsellMessage()}
          />
        ) : (
          <SectionUpsellCallout
            variant="dark"
            testId="upsell-lifetime-value"
            message={
              showEstimate
                ? buildLifetimeEstimateUpsellMessage(t("cases").toLowerCase())
                : buildLifetimeNoCasesUpsellMessage(t("cases").toLowerCase())
            }
          />
        ))}

      <>
          {/* The story line: monthly work → compounding reputation → payoff. */}
          <div className="ltv-story flex flex-col md:flex-row items-stretch gap-4 mt-4">
            <div className="card-dark flex-1 min-w-0 p-6">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-report-gold" aria-hidden="true" />
                <span className="section-label-dark">The work</span>
              </div>
              <div className="report-eyebrow mb-4">Campaign {t("leads")} Generated</div>
              {hasData ? (
                <div className="metric-large text-report-ink-inverse" data-testid="text-lifetime-leads">
                  {(lifetimeData?.totalLeads ?? 0).toLocaleString()}
                </div>
              ) : (
                // Task #4693 skeleton — muted "No data", never a fabricated 0.
                <div className="metric-large text-report-ink-inverse-muted" data-testid="text-lifetime-leads-missing">{NO_DATA_LABEL}</div>
              )}
              <div className="text-xs text-report-ink-inverse-muted mt-2">
                From GBP, Google Ads, LSA &amp; Webinars — excludes "Other" {t("leads").toLowerCase()}
              </div>
            </div>

            <StageArrow />

            <div className="card-dark flex-1 min-w-0 p-6">
              <div className="flex items-center gap-2 mb-1">
                <Star className="w-4 h-4 text-report-gold" aria-hidden="true" />
                <span className="section-label-dark">The reputation</span>
              </div>
              <div className="report-eyebrow mb-4">Total Reviews Generated</div>
              {hasData ? (
                <div className="metric-large text-report-ink-inverse" data-testid="text-lifetime-reviews">
                  {(lifetimeData?.totalReviews ?? 0).toLocaleString()}
                </div>
              ) : (
                // Task #4693 skeleton — muted "No data", never a fabricated 0.
                <div className="metric-large text-report-ink-inverse-muted" data-testid="text-lifetime-reviews-missing">{NO_DATA_LABEL}</div>
              )}
              <div className="text-xs text-report-ink-inverse-muted mt-2">Reputation compounding into referrals</div>
            </div>

            <StageArrow />

            <div className="card-dark-accent flex-1 min-w-0 p-6">
              <div className="flex items-center gap-2 mb-1">
                <Briefcase className="w-4 h-4 text-report-gold" aria-hidden="true" />
                <span className="section-label-dark">The payoff</span>
              </div>
              <div className="report-eyebrow mb-4">
                {showEstimate ? `Estimated ${t("cases")}` : `Total ${t("cases")} Signed`}
              </div>
              {showEstimate ? (
                <div className="metric-large text-report-ink-inverse" data-testid="text-lifetime-cases">
                  {`~${(lifetimeData?.estimatedCases ?? 0).toLocaleString()}`}
                </div>
              ) : hasHardCases ? (
                <div className="metric-large text-report-ink-inverse" data-testid="text-lifetime-cases">
                  {(lifetimeData?.totalCases ?? 0).toLocaleString()}
                </div>
              ) : (
                <div className="text-base font-semibold text-report-ink-inverse-muted leading-9" data-testid="text-lifetime-cases-missing">
                  Not reported to us yet
                </div>
              )}
              <div className="text-xs text-report-ink-inverse-muted mt-2">
                {showEstimate
                  ? "Based on industry benchmarks"
                  : hasHardCases
                    ? "Confirmed client signings"
                    : `No ${t("cases").toLowerCase()} data reported yet`}
              </div>
              {hasHardCases && missingCaseMonths.length > 0 && (
                // Task #4849 — honest partial-coverage annotation: the total
                // above is real, but the accumulation span has months with no
                // genuinely provided case data (report-less months included).
                <div className="text-xs text-report-ink-inverse-muted mt-1" data-testid="text-lifetime-cases-incomplete">
                  {formatIncompleteCasesAnnotation(missingCaseMonths)}
                </div>
              )}
            </div>
          </div>

          {/* The one chart: the lifetime arc, anchored to the headline number. */}
          {arc && (
            <div className="ltv-arc card-dark p-6 mt-6">
              <div className="flex items-baseline justify-between gap-4 flex-wrap mb-2">
                <span className="report-eyebrow">The compounding arc — cumulative campaign {t("leads").toLowerCase()}</span>
                <span className="text-xs text-report-ink-inverse-muted">since day one of the partnership</span>
              </div>
              <div className="ltv-arc-plot h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={arc.points} margin={{ top: 22, right: 14, left: 14, bottom: 4 }}>
                    <defs>
                      <linearGradient id="ltv-arc-fill" x1="0" y1="0" x2="0" y2="1">
                        {/* §8.5 area fill ramp — gradient stops are the single opacity source */}
                        <stop offset="5%" stopColor={REPORT_COLORS.gold} stopOpacity={TREND_FILL_TOP_OPACITY} />
                        <stop offset="95%" stopColor={REPORT_COLORS.gold} stopOpacity={TREND_FILL_BOTTOM_OPACITY} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: REPORT_TICK_FONT_SIZE, fill: REPORT_COLORS.inkInverseMuted }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                      minTickGap={24}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke={REPORT_COLORS.gold}
                      strokeWidth={TREND_STROKE_WIDTH}
                      fillOpacity={1}
                      fill="url(#ltv-arc-fill)"
                      dot={{ r: 2.5, fill: REPORT_COLORS.gold, strokeWidth: 0 }}
                      label={renderArcEndpointLabel}
                      isAnimationActive={false}
                    />
                    <Tooltip
                      formatter={(value: number) => [Number(value).toLocaleString(), `Cumulative ${t("leads").toLowerCase()}`]}
                      labelFormatter={(label) => (label === ARC_START_LABEL ? "Where you started" : String(label))}
                      contentStyle={{
                        fontSize: REPORT_TICK_FONT_SIZE,
                        borderRadius: 4,
                        backgroundColor: REPORT_COLORS.charcoalCard,
                        border: "1px solid rgba(255,255,255,0.1)",
                        color: REPORT_COLORS.white,
                      }}
                      labelStyle={{ color: REPORT_COLORS.white }}
                      itemStyle={{ color: REPORT_COLORS.white }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {!arc && (lifetimeData?.totalLeads ?? 0) > 0 && (!trendData || trendData.length < 2) && (
            <p className="text-xs text-report-ink-inverse-muted text-center mt-6">
              The compounding arc chart unlocks with next month's report.
            </p>
          )}
          {/* Task #4693 skeleton — with no lifetime data at all, a quiet
              placeholder frame stands where the arc would draw (never a
              fabricated zero-value chart). */}
          {!hasData && (
            <ChartPlaceholderFrame
              variant="dark"
              testId="chart-placeholder-lifetime-value"
              label={`The compounding arc — cumulative campaign ${t("leads").toLowerCase()} since day one — draws here as monthly reports accumulate.`}
            />
          )}

          {/* The story line's closing beat — one sentence, no banner box. */}
          <p className="ltv-coda text-sm text-report-ink-inverse-muted text-center max-w-[60ch] mx-auto mt-6">
            <span className="text-report-ink-inverse font-semibold">This is more than a vendor relationship</span>
            {" — the work, the reputation, and the results compound month after month."}
          </p>
        </>
    </Slide>
  );
}
