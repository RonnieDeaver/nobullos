/**
 * Mini score-history trend shown next to the Gauge on the audit reports.
 * Read-only: renders the stored score trail (newest first) as a delta badge
 * ("+8 pts vs last run") plus a tiny inline-SVG sparkline. No chart lib.
 */

import type { ScoreHistoryEntry } from "../lib/types";
import { scoreColorVar } from "../lib/theme";

interface Props {
  /** Stored history, newest first (as returned by the /history routes). */
  history: ScoreHistoryEntry[];
}

export function ScoreTrend({ history }: Props) {
  if (history.length < 2) return null; // a single point has no trend

  // Chronological (oldest → newest) for the sparkline.
  const points = [...history].reverse();
  const latest = points[points.length - 1];
  const prev = points[points.length - 2];
  const delta = latest.final_score - prev.final_score;
  const deltaLabel = delta === 0 ? "±0 pts" : `${delta > 0 ? "+" : ""}${delta} pts`;
  const deltaClass = delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  const w = 120;
  const h = 34;
  const pad = 3;
  const scores = points.map((p) => p.final_score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = Math.max(1, max - min);
  const x = (i: number) =>
    points.length === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (s: number) => h - pad - ((s - min) * (h - pad * 2)) / span;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.final_score).toFixed(1)}`).join(" ");

  return (
    <div className="score-trend" data-testid="score-trend">
      <div className={`score-trend-delta ${deltaClass}`} data-testid="badge-score-delta">
        {deltaLabel} <span className="muted">vs last run</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        role="img"
        aria-label={`Score trend over the last ${points.length} runs`}
      >
        <path d={path} fill="none" stroke={scoreColorVar(latest.final_score)} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={p.generated_at + i} cx={x(i)} cy={y(p.final_score)} r={i === points.length - 1 ? 3 : 2} fill={scoreColorVar(p.final_score)}>
            <title>{`${p.generated_at.slice(0, 10)}: ${p.final_score} (${p.band})`}</title>
          </circle>
        ))}
      </svg>
      <div className="score-trend-caption muted">last {points.length} runs</div>
    </div>
  );
}
