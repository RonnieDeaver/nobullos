import React from "react";

export type SparklinePoint = { t: number; v: number | null };

interface SparklineProps {
  points: SparklinePoint[];
  color?: string;
  height?: number;
  width?: number;
  testId?: string;
}

/**
 * Task #1094: tiny inline-SVG sparkline used under each counter on
 * the "Archive pipeline health" card and the call-archive drill-in.
 * Intentionally dependency-free (no recharts wrapper) so it stays
 * cheap to render inside cards that already refresh on a 60s
 * interval.
 *
 * Renders three layers:
 *   1. A faint baseline at y=0 so flat-zero series stay visible.
 *   2. The polyline of values (nulls drop the segment).
 *   3. A small dot at the most-recent point so operators can see
 *      where "now" sits on the trend.
 */
export function ArchiveHealthSparkline({
  points,
  color = "#9c2c46",
  height = 28,
  width = 140,
  testId,
}: SparklineProps) {
  const validPoints = points.filter((p) => p.v != null) as { t: number; v: number }[];
  if (validPoints.length === 0) {
    return (
      <div
        className="text-xs text-muted-foreground italic"
        data-testid={testId ? `${testId}-empty` : undefined}
      >
        No trend data yet — first sample lands within 15 minutes.
      </div>
    );
  }

  const minT = points[0]?.t ?? validPoints[0].t;
  const maxT = points[points.length - 1]?.t ?? validPoints[validPoints.length - 1].t;
  const tSpan = Math.max(1, maxT - minT);

  const maxV = validPoints.reduce((m, p) => (p.v > m ? p.v : m), 0);
  const minV = 0;
  const vSpan = Math.max(1, maxV - minV);

  const padding = 2;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const xy = (p: { t: number; v: number }): [number, number] => {
    const x = padding + ((p.t - minT) / tSpan) * innerW;
    const y = padding + (1 - (p.v - minV) / vSpan) * innerH;
    return [x, y];
  };

  // Build a polyline path that breaks across nulls so a single
  // missing sample doesn't draw a misleading straight line across
  // a gap.
  const segments: string[] = [];
  let current: string[] = [];
  for (const p of points) {
    if (p.v == null) {
      if (current.length > 0) {
        segments.push(current.join(" "));
        current = [];
      }
      continue;
    }
    const [x, y] = xy({ t: p.t, v: p.v });
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (current.length > 0) segments.push(current.join(" "));

  const last = validPoints[validPoints.length - 1];
  const first = validPoints[0];
  const delta = last.v - first.v;
  const deltaLabel =
    delta === 0 ? "flat" : delta > 0 ? `+${delta}` : `${delta}`;
  const baselineY = padding + innerH; // y at value 0

  return (
    <div
      className="flex items-center gap-2"
      data-testid={testId}
      title={`24h trend: ${first.v} → ${last.v} (${deltaLabel})`}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible"
        aria-hidden="true"
      >
        <line
          x1={padding}
          y1={baselineY}
          x2={width - padding}
          y2={baselineY}
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={1}
        />
        {segments.map((seg, i) => (
          <polyline
            key={i}
            points={seg}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {(() => {
          const [lx, ly] = xy(last);
          return <circle cx={lx} cy={ly} r={2} fill={color} />;
        })()}
      </svg>
      <span
        className={`text-xs tabular-nums ${
          delta > 0 ? "text-amber-700" : delta < 0 ? "text-green-700" : "text-muted-foreground"
        }`}
        data-testid={testId ? `${testId}-delta` : undefined}
      >
        24h {deltaLabel}
      </span>
    </div>
  );
}
