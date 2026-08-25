/**
 * Semicircular SVG gauge (port of the bundle's frontend/src/components/
 * Gauge.tsx). No chart lib — keeps the bundle tiny and the rendering crisp
 * for screenshots.
 */

import { scoreColorVar } from "../lib/theme";

interface Props {
  score: number;
  band: string;
  rawScore: number;
  capped: boolean;
}

export function Gauge({ score, band, rawScore, capped }: Props) {
  const radius = 120;
  const stroke = 22;
  const cx = 150;
  const cy = 150;
  // Semicircle from 180deg (left) to 0deg (right).
  const circumference = Math.PI * radius;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = circumference * pct;
  const color = scoreColorVar(score);

  const arc = (r: number) => `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  // Band boundaries (match scoreColor): small notches so the tier reads at a
  // glance without recalling the thresholds.
  const ticks = [40, 60, 75].map((t) => {
    const a = Math.PI * (1 - t / 100);
    const r1 = radius - stroke / 2 - 1;
    const r2 = radius + stroke / 2 + 1;
    return {
      t,
      x1: cx + r1 * Math.cos(a),
      y1: cy - r1 * Math.sin(a),
      x2: cx + r2 * Math.cos(a),
      y2: cy - r2 * Math.sin(a),
    };
  });

  return (
    <div className="gauge" data-testid="gauge-score">
      <svg viewBox="0 0 300 175" width="300" height="175" role="img"
           aria-label={`Health score ${score} out of 100`}>
        <path d={arc(radius)} fill="none" stroke="var(--track)" strokeWidth={stroke}
              strokeLinecap="round" />
        <path
          d={arc(radius)}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          style={{ transition: "stroke-dasharray 0.8s ease, stroke 0.4s ease" }}
        />
        {ticks.map((tk) => (
          <line
            key={tk.t}
            x1={tk.x1}
            y1={tk.y1}
            x2={tk.x2}
            y2={tk.y2}
            stroke="var(--panel)"
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.9}
          />
        ))}
        <text x={cx} y={cy - 18} textAnchor="middle" className="gauge-score" fill={color}>
          {Math.round(score)}
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" className="gauge-band">
          {band}
        </text>
      </svg>
      {capped && (
        <div className="gauge-capped">
          computed {Math.round(rawScore)} · capped to {Math.round(score)}
        </div>
      )}
    </div>
  );
}
