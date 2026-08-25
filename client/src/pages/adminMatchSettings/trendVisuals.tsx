// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { useLocation } from "wouter";
import { type GuardrailChangeTrendRow, type GuardrailImpactBucket, type GuardrailImpactPerKey, dismissReasonLabel } from "./model";

export function RoutedToReviewSparkline(props: {
  trend: GuardrailChangeTrendRow;
  testId: string;
}) {
  const { trend, testId } = props;
  const buckets = trend.routedToReview.buckets;
  if (!buckets || buckets.length === 0) return null;
  const width = 160;
  const height = 32;
  const padX = 2;
  const padY = 2;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const barW = (width - padX * 2) / buckets.length;
  const half = buckets.length / 2;
  const before = trend.routedToReview.before;
  const after = trend.routedToReview.after;
  const delta = after - before;
  const deltaCls =
    delta > 0 ? "text-rose-600" : delta < 0 ? "text-emerald-600" : "text-gray-500";
  return (
    <div className="inline-flex items-center gap-2" data-testid={testId}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block"
        style={{ width: `${width}px`, height: `${height}px` }}
        role="img"
        aria-label={`Routed-to-review counts ${formatDurationShort(trend.routedToReview.windowMs)} before and after this change`}
        data-before={before}
        data-after={after}
      >
        {buckets.map((b, i) => {
          const h = ((b.count) / maxCount) * (height - padY * 2);
          const x = padX + i * barW;
          const y = height - padY - h;
          const isAfter = i >= half;
          const fill = isAfter ? "#4f46e5" : "#94a3b8";
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={Math.max(1, barW - 1)}
              height={Math.max(0.5, h)}
              fill={fill}
              data-testid={`${testId}-bucket-${i}`}
              data-count={b.count}
              data-half={isAfter ? "after" : "before"}
            >
              <title>{`${new Date(b.start).toLocaleString()} → ${new Date(b.end).toLocaleString()}: ${b.count}`}</title>
            </rect>
          );
        })}
        <line
          x1={padX + half * barW}
          x2={padX + half * barW}
          y1={0}
          y2={height}
          stroke="#1f2937"
          strokeDasharray="2 2"
          strokeWidth={1}
        />
      </svg>
      <span
        className="text-[10px] font-mono whitespace-nowrap text-gray-600"
        title={`Routed to review: ${before} in the ${formatDurationShort(trend.routedToReview.windowMs)} before this change · ${after} in the ${formatDurationShort(trend.routedToReview.windowMs)} after`}
      >
        <span data-testid={`${testId}-before`}>{before}</span>
        <span className="mx-0.5 text-gray-400">→</span>
        <span data-testid={`${testId}-after`}>{after}</span>
        <span className={`ml-1 ${deltaCls}`} data-testid={`${testId}-delta`}>
          ({delta > 0 ? "+" : ""}{delta})
        </span>
      </span>
    </div>
  );
}

export function DismissReasonDelta(props: {
  trend: GuardrailChangeTrendRow;
  testId: string;
}) {
  const { trend, testId } = props;
  const before = trend.dismissReasons.before.byReason;
  const after = trend.dismissReasons.after.byReason;
  const reasons = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)]),
  ).sort();
  const beforeTotal = trend.dismissReasons.before.total;
  const afterTotal = trend.dismissReasons.after.total;
  if (reasons.length === 0 && beforeTotal === 0 && afterTotal === 0) {
    return (
      <span
        className="text-[10px] text-gray-500 italic"
        data-testid={`${testId}-empty`}
      >
        No dismissals in this window.
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <span
        className="text-[10px] text-gray-500 uppercase tracking-wide mr-0.5"
        title={`Dismissals in the ${formatDurationShort(trend.routedToReview.windowMs)} window before vs after this change`}
      >
        Dismiss
      </span>
      {reasons.map((reason) => {
        const b = before[reason] ?? 0;
        const a = after[reason] ?? 0;
        if (b === 0 && a === 0) return null;
        const diff = a - b;
        const diffCls =
          diff > 0 ? "text-rose-700" : diff < 0 ? "text-emerald-700" : "text-gray-600";
        return (
          <span
            key={reason}
            className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-mono"
            data-testid={`${testId}-${reason}`}
            title={`${dismissReasonLabel(reason)}: ${b} before → ${a} after`}
          >
            <span className="font-sans text-gray-700">{dismissReasonLabel(reason)}</span>
            <span>{b}</span>
            <span className="text-gray-400">→</span>
            <span>{a}</span>
            {diff !== 0 && (
              <span className={diffCls}>
                ({diff > 0 ? "+" : ""}{diff})
              </span>
            )}
          </span>
        );
      })}
      <span
        className="inline-flex items-center gap-1 text-[10px] text-gray-600"
        data-testid={`${testId}-total`}
        title="Total dismissals before → after"
      >
        total {beforeTotal}
        <span className="text-gray-400">→</span>
        {afterTotal}
      </span>
    </div>
  );
}

function GuardrailImpactSparkline(props: {
  buckets: GuardrailImpactBucket[] | undefined;
  sampleMs: number;
  reasonLabel: string;
  testId: string;
  reasonKey?: string;
}) {
  const { buckets, sampleMs, reasonLabel, testId, reasonKey } = props;
  const [, navigate] = useLocation();
  if (!buckets || buckets.length === 0) return null;
  const width = 64;
  const height = 16;
  const padX = 1;
  const padY = 1;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const barW = (width - padX * 2) / buckets.length;
  const half = buckets.length / 2;
  const sampleLabel = formatDurationShort(sampleMs);
  const interactive = !!reasonKey;
  const handleBarClick = (b: GuardrailImpactBucket) => {
    if (!reasonKey) return;
    const params = new URLSearchParams({
      reviewReason: reasonKey,
      from: b.start,
      to: b.end,
    });
    navigate(`/admin/zoom/review?${params.toString()}`);
  };
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block"
      style={{ width: `${width}px`, height: `${height}px` }}
      role="img"
      aria-label={`${reasonLabel} routed-to-review per-bucket counts ${sampleLabel} before and after the last change`}
      data-testid={testId}
    >
      {buckets.map((b, i) => {
        const h = (b.count / maxCount) * (height - padY * 2);
        const x = padX + i * barW;
        const y = height - padY - h;
        const isAfter = i >= half;
        const fill = isAfter ? "#4f46e5" : "#cbd5e1";
        const startLabel = new Date(b.start).toLocaleString();
        const endLabel = new Date(b.end).toLocaleString();
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={Math.max(0.75, barW - 0.5)}
            height={Math.max(0.5, h)}
            fill={fill}
            data-testid={`${testId}-bucket-${i}`}
            data-count={b.count}
            data-half={isAfter ? "after" : "before"}
            data-bucket-start={b.start}
            data-bucket-end={b.end}
            style={interactive ? { cursor: "pointer" } : undefined}
            onClick={interactive ? () => handleBarClick(b) : undefined}
            onMouseEnter={interactive ? (e) => { (e.currentTarget as SVGRectElement).style.opacity = "0.7"; } : undefined}
            onMouseLeave={interactive ? (e) => { (e.currentTarget as SVGRectElement).style.opacity = "1"; } : undefined}
          >
            <title>
              {interactive
                ? `${startLabel} → ${endLabel}: ${b.count} (click to open ${reasonLabel} in the review queue for this range)`
                : `${startLabel} → ${endLabel}: ${b.count}`}
            </title>
          </rect>
        );
      })}
      <line
        x1={padX + half * barW}
        x2={padX + half * barW}
        y1={0}
        y2={height}
        stroke="#1f2937"
        strokeDasharray="1.5 1.5"
        strokeWidth={0.75}
      />
    </svg>
  );
}

function GuardrailDismissReasonAnchoredDelta(props: {
  perKey: GuardrailImpactPerKey | undefined | null;
  testId: string;
}) {
  const { perKey, testId } = props;
  if (!perKey || !perKey.anchor || !perKey.dismissAfter || !perKey.dismissBefore) {
    return null;
  }
  const before = perKey.dismissBefore.byReason || {};
  const after = perKey.dismissAfter.byReason || {};
  const beforeTotal = perKey.dismissBefore.total ?? 0;
  const afterTotal = perKey.dismissAfter.total ?? 0;
  const reasons = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)]),
  ).sort();
  const sampleLabel = formatDurationShort(perKey.sampleMs);
  if (reasons.length === 0 && beforeTotal === 0 && afterTotal === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-500 italic"
        title={`No dismissals in the ${sampleLabel} window before or after the anchored change.`}
        data-testid={`${testId}-empty`}
      >
        Dismiss: none
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 flex-wrap text-[10px] px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-900"
      title={`Dismissals in the ${sampleLabel} window before vs after the last change to this guardrail.`}
      data-testid={testId}
    >
      <span className="uppercase tracking-wide font-medium text-amber-700">Dismiss</span>
      {reasons.map((reason) => {
        const b = before[reason] ?? 0;
        const a = after[reason] ?? 0;
        if (b === 0 && a === 0) return null;
        const diff = a - b;
        const diffCls =
          diff > 0 ? "text-rose-700" : diff < 0 ? "text-emerald-700" : "text-amber-900";
        return (
          <span
            key={reason}
            className="inline-flex items-center gap-0.5 font-mono"
            data-testid={`${testId}-${reason}`}
            title={`${dismissReasonLabel(reason)}: ${b} before → ${a} after`}
          >
            <span className="font-sans font-normal">{dismissReasonLabel(reason)}:</span>
            <span>{b}</span>
            <span className="text-amber-500">→</span>
            <span>{a}</span>
            <span className={diffCls}>({diff > 0 ? "+" : ""}{diff})</span>
          </span>
        );
      })}
    </span>
  );
}

function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) return `${totalHr}h`;
  const totalDay = Math.floor(totalHr / 24);
  return `${totalDay}d`;
}

function formatAnchorTooltip(perKey: GuardrailImpactPerKey | undefined | null): string {
  if (!perKey || !perKey.anchor) {
    return "No persisted change recorded for this setting yet — delta unavailable.";
  }
  const sample = formatDurationShort(perKey.sampleMs);
  const ts = new Date(perKey.anchor);
  return `Anchored at last change ${ts.toLocaleString()} · ${sample} before vs ${sample} after`;
}

function renderTrendDelta(current: number, previous: number | null | undefined) {
  if (previous == null) return null;
  const diff = current - previous;
  if (diff === 0) {
    return (
      <span className="inline-flex items-center text-[10px] text-gray-500" title={`Unchanged vs prior window (${previous})`}>
        <Minus className="w-2.5 h-2.5" />0
      </span>
    );
  }
  const isUp = diff > 0;
  const cls = isUp ? "text-rose-600" : "text-emerald-600";
  const Icon = isUp ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] ${cls}`}
      title={`${isUp ? "+" : ""}${diff} vs prior window (was ${previous})`}
    >
      <Icon className="w-2.5 h-2.5" />
      {isUp ? "+" : ""}{diff}
    </span>
  );
}
export { GuardrailImpactSparkline, GuardrailDismissReasonAnchoredDelta, formatDurationShort, formatAnchorTooltip, renderTrendDelta };
