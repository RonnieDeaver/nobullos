// Shared daily-spend-vs-target chart for GAds + LSA budget pacing.
// A smooth (monotone-cubic, no overshoot on $0 days) area chart with a gradient
// fill, soft gridlines, and hover dots — port of the bundle's PacingChart.tsx.

import { moneyShort, monotonePath } from "../lib/chart";

export interface PacingPoint {
  date: string;
  spend: number;
  target: number | null;
}

export function PacingChart({
  points,
  hasBudget,
}: {
  points: PacingPoint[];
  cur?: string;
  hasBudget: boolean;
}) {
  if (points.length === 0) {
    return (
      <div className="bp-chart-card">
        <div className="bp-chart-head">
          <span className="muted">Daily spend vs target · month to date</span>
        </div>
        <div className="muted" style={{ padding: "8px 2px" }}>
          No spend recorded yet this month.
        </div>
      </div>
    );
  }

  const W = 760, H = 250;
  const padL = 52, padR = 16, padT = 16, padB = 30;
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
  const n = points.length;
  const maxV = Math.max(1, ...points.map((p) => Math.max(p.spend, p.target ?? 0))) * 1.15;
  const xFor = (i: number) => (n === 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1));
  const yFor = (v: number) => y1 - (v / maxV) * (y1 - y0);

  const spend = points.map((p, i) => [xFor(i), yFor(p.spend)] as [number, number]);
  const target = points.map((p, i) => [xFor(i), yFor(p.target ?? 0)] as [number, number]);
  const spendPath = monotonePath(spend);
  const targetPath = monotonePath(target);
  const areaPath = `${spendPath} L ${spend[n - 1][0].toFixed(2)},${y1} L ${spend[0][0].toFixed(2)},${y1} Z`;

  const grid = [0, maxV / 2, maxV];
  const step = Math.max(1, Math.ceil(n / 8)); // ~8 x labels max

  return (
    <div className="bp-chart-card" data-testid="chart-pacing">
      <div className="bp-chart-head">
        <span className="muted">Daily spend vs target · month to date</span>
        <span className="bp-legend">
          <span className="bp-legend-item">
            <span className="bp-swatch actual" /> Spend
          </span>
          {hasBudget && (
            <span className="bp-legend-item">
              <span className="bp-swatch target" /> Target
            </span>
          )}
        </span>
      </div>
      <svg
        className="bp-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Daily spend versus target, month to date"
      >
        <defs>
          <linearGradient id="bpAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--accent)", stopOpacity: 0.22 }} />
            <stop offset="100%" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>

        {grid.map((g, i) => (
          <g key={i}>
            <line className="bp-grid" x1={x0} y1={yFor(g)} x2={x1} y2={yFor(g)} />
            <text className="bp-axis" x={x0 - 9} y={yFor(g) + 3.5} textAnchor="end">
              {moneyShort(g)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % step === 0 ? (
            <text key={i} className="bp-axis" x={xFor(i)} y={y1 + 18} textAnchor="middle">
              {dayNum(p.date)}
            </text>
          ) : null
        )}

        <path className="bp-area" d={areaPath} fill="url(#bpAreaGrad)" />
        {hasBudget && <path className="bp-line target" d={targetPath} />}
        <path className="bp-line actual" d={spendPath} />

        {points.map((p, i) => (
          <circle key={i} className="bp-dot" cx={xFor(i)} cy={yFor(p.spend)} r={4}>
            <title>
              {`${p.date}\nSpend: ${money(p.spend)}${
                p.target != null ? `\nTarget: ${money(p.target)}` : ""
              }`}
            </title>
          </circle>
        ))}

        {/* Always-visible marker + label for the latest (live MTD) spend day. */}
        <circle className="bp-dot-last" cx={xFor(n - 1)} cy={yFor(points[n - 1].spend)} r={4.5} />
        <text
          className="bp-last-label"
          x={xFor(n - 1)}
          y={Math.max(yFor(points[n - 1].spend) - 11, y0 + 9)}
          textAnchor="end"
        >
          {money(points[n - 1].spend)}
        </text>
      </svg>
    </div>
  );
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}
function dayNum(iso: string): string {
  return String(Number(iso.slice(8, 10))); // day-of-month, TZ-safe from the ISO string
}
