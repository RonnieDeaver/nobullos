// Performance trend charts: a 3-up row of compact single-metric charts — Spend, Leads,
// CPL — side by side on the same date buckets. Each metric keeps its own scale (never a
// dual axis). House hand-rolled SVG: fixed viewBox, monotone lines, soft area fills
// under the spend and leads lines, native <title> tooltips on full-height hover columns
// (every tooltip carries all three metrics for the bucket). A bucket with 0 leads has
// CPL = null and the CPL line breaks there instead of faking a zero.

import { moneyShort, monotonePath } from "../lib/chart";
import { formatCpl } from "../lib/format";

export interface PerfBucket {
  key: string;          // stable bucket id (ISO date / week-monday / YYYY-MM)
  label: string;        // short x-axis + tooltip label ("Jul 5", "Jul '26")
  days: number;         // days of data in the bucket
  partial: boolean;     // first/last bucket not covering its full week/month
  spend: number;
  leads: number;
  cpl: number | null;   // spend/leads, null when leads = 0
}

// Metric colors as theme variables so the charts follow the Ads OS light/dark
// theme. Light values (adsOs.css) are the validated hexes #8b292f/#16a34a/#1d4ed8
// (dataviz six checks, light surface); dark mode lifts them for contrast.
export const METRIC_COLORS = {
  spend: "var(--chart-spend)",
  leads: "var(--chart-leads)",
  cpl: "var(--chart-cpl)",
} as const;

const W = 320, H = 150;
const PAD_L = 46, PAD_R = 8, PAD_T = 18, PAD_B = 20;

function fmtSpend(v: number): string {
  return `$${Math.round(v).toLocaleString()}`;
}
function fmtLeads(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function leadsShort(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v * 10) / 10);
}

function bucketTooltip(b: PerfBucket): string {
  return (
    `${b.label}${b.partial ? ` (partial, ${b.days}d)` : ""}\n` +
    `Spend: ${fmtSpend(b.spend)}\nLeads: ${fmtLeads(b.leads)}\nCPL: ${formatCpl(b.cpl)}`
  );
}

function MiniChart({
  title,
  color,
  buckets,
  value,
  fmtAxis,
  kind,
}: {
  title: string;
  color: string;
  buckets: PerfBucket[];
  value: (b: PerfBucket) => number | null;
  fmtAxis: (v: number) => string;
  kind: "area" | "line" | "bar";
}) {
  const n = buckets.length;
  const x0 = PAD_L, x1 = W - PAD_R, y0 = PAD_T + 6, y1 = H - PAD_B;
  // Bars use slot-centered positions (each bucket owns a column); lines spread the
  // points edge-to-edge. Both share the same tooltip columns.
  const slot = (x1 - x0) / n;
  const xFor = (i: number) =>
    kind === "bar"
      ? x0 + slot * (i + 0.5)
      : n === 1
        ? (x0 + x1) / 2
        : x0 + (i * (x1 - x0)) / (n - 1);
  const vals = buckets.map(value);
  const maxV = Math.max(1e-9, ...vals.map((v) => v ?? 0)) * 1.1;
  const yFor = (v: number) => y1 - (v / maxV) * (y1 - y0);
  const xStep = Math.max(1, Math.ceil(n / 4)); // ~4 x labels on the small charts
  const showDots = kind !== "bar" && n <= 40;
  const barW = Math.min(22, Math.max(2.5, slot * 0.55));

  // Segments of consecutive non-null points, so a gap breaks the line (unused for bars).
  const segs: [number, number][][] = [];
  let cur: [number, number][] = [];
  if (kind !== "bar") {
    vals.forEach((v, i) => {
      if (v === null) {
        if (cur.length) segs.push(cur);
        cur = [];
      } else {
        cur.push([xFor(i), yFor(v)]);
      }
    });
    if (cur.length) segs.push(cur);
  }

  return (
    <div className="perf-mini">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} over time`}>
        <text className="perf-strip-title" x={x0} y={11} style={{ fill: color }}>
          {title}
        </text>
        {[0, maxV].map((g, gi) => (
          <g key={gi}>
            <line className="bp-grid" x1={x0} y1={yFor(g)} x2={x1} y2={yFor(g)} />
            <text className="bp-axis" x={x0 - 7} y={yFor(g) + 3.5} textAnchor="end">
              {fmtAxis(g === 0 ? 0 : g / 1.1)}
            </text>
          </g>
        ))}
        {kind === "area" &&
          segs.map((s, si) =>
            s.length > 1 ? (
              <path
                key={`a${si}`}
                d={`${monotonePath(s)} L ${s[s.length - 1][0].toFixed(2)},${y1} L ${s[0][0].toFixed(2)},${y1} Z`}
                fill={color}
                opacity={0.09}
              />
            ) : null
          )}
        {kind !== "bar" &&
          segs.map((s, si) => (
            <path key={si} className="perf-line" d={monotonePath(s)} style={{ stroke: color }} />
          ))}
        {kind === "bar" &&
          buckets.map((b, i) => {
            const v = value(b);
            if (v === null) return null; // no leads -> no CPL -> no bar (not a fake $0)
            const h = Math.max(1.5, y1 - yFor(v));
            return (
              <rect
                key={`b${i}`}
                x={(xFor(i) - barW / 2).toFixed(2)}
                y={(y1 - h).toFixed(2)}
                width={barW.toFixed(2)}
                height={h.toFixed(2)}
                rx={Math.min(2, barW / 3)}
                style={{ fill: color, opacity: b.partial ? 0.45 : 1 }}
              />
            );
          })}
        {buckets.map((b, i) => {
          const v = value(b);
          if (v === null) return null;
          const isolated =
            (i === 0 || value(buckets[i - 1]) === null) &&
            (i === n - 1 || value(buckets[i + 1]) === null);
          return showDots || (kind !== "bar" && isolated) ? (
            <circle
              key={`d${i}`}
              cx={xFor(i)}
              cy={yFor(v)}
              r={2.2}
              style={{ fill: color, opacity: b.partial ? 0.45 : 1 }}
            />
          ) : null;
        })}
        {buckets.map((b, i) =>
          i % xStep === 0 ? (
            <text
              key={`x${i}`}
              className="bp-axis"
              x={xFor(i)}
              y={H - 6}
              textAnchor="middle"
              opacity={b.partial ? 0.6 : 1}
            >
              {b.label}
            </text>
          ) : null
        )}
        {buckets.map((b, i) => (
          <rect
            key={`h${i}`}
            className="perf-hit"
            x={kind === "bar" ? x0 + slot * i : n === 1 ? x0 : xFor(i) - (x1 - x0) / (n - 1) / 2}
            y={PAD_T}
            width={kind === "bar" ? slot : n === 1 ? x1 - x0 : (x1 - x0) / (n - 1)}
            height={H - PAD_T - PAD_B}
          >
            <title>{bucketTooltip(b)}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

// The 3-up row: Spend · Leads · CPL side by side over the same buckets. CPL draws as
// BARS — its series is legitimately sparse (a 0-lead bucket has no CPL), and bars read
// cleanly with gaps where a line would shatter into fragments.
export function TrendRow({ buckets }: { buckets: PerfBucket[] }) {
  if (buckets.length === 0)
    return (
      <div className="perf-note muted" role="status">
        No spend or leads recorded in this range. Widen the date range to see trend charts.
      </div>
    );
  return (
    <div className="perf-trio">
      <MiniChart title="Spend" color={METRIC_COLORS.spend} buckets={buckets}
                 value={(b) => b.spend} fmtAxis={moneyShort} kind="area" />
      <MiniChart title="Leads" color={METRIC_COLORS.leads} buckets={buckets}
                 value={(b) => b.leads} fmtAxis={leadsShort} kind="area" />
      <MiniChart title="CPL" color={METRIC_COLORS.cpl} buckets={buckets}
                 value={(b) => b.cpl} fmtAxis={moneyShort} kind="bar" />
    </div>
  );
}
