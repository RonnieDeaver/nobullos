// Shared performance-metric pill used across all three dashboards (Main / GAds /
// LSA). One pill carries the metric VALUE and its 30-day % change. Small moves
// (< 10%) read as "basically flat" and stay grey like the neutral Spend/Cost
// pills; only bigger swings get tinted by how the change reads for that metric:
//   - "neutral"  (Spend / Cost): always grey — spend going up or down isn't
//                 good or bad on its own.
//   - "up-good"  (Leads / Conversions): up ≥10% = green; down ≥10% = red; within ±10% = grey.
//   - "down-good" (CPL / CPA): down ≥10% = green; up ≥10% = red; within ±10% = grey.
// Matches the soft-tinted look of the hygiene / traffic-quality pills.
// Verbatim port of the bundle's frontend/src/components/MetricPill.tsx.

export type MetricKind = "neutral" | "up-good" | "down-good";

// A change smaller than this (either direction) is treated as flat → grey. Uses
// the same rounded % that the pill displays, so the color and the shown number
// never disagree at the boundary (a pill reading "10%" is always tinted).
const SIGNIFICANT_PCT = 10;

export function metricTone(
  kind: MetricKind,
  cur: number,
  prev: number | null
): "n" | "g" | "b" {
  if (kind === "neutral") return "n";
  if (prev === null || cur === prev) return "n"; // no baseline / no change → neutral
  const pct = prev > 0 ? Math.round((Math.abs(cur - prev) / prev) * 100) : Infinity;
  if (pct < SIGNIFICANT_PCT) return "n"; // within ±10% → flat (grey, like Spend)
  const up = cur > prev;
  const good = kind === "up-good" ? up : !up;
  return good ? "g" : "b";
}

// Just the colored % change (no pill) — used in the summary tiles, where the big
// value stays a plain number and only the change is tinted.
export function MetricChange({
  cur,
  prev,
  kind,
  title,
}: {
  cur: number;
  prev: number | null;
  kind: MetricKind;
  title?: string;
}) {
  if (prev === null || cur === prev) return null;
  const t = metricTone(kind, cur, prev);
  const up = cur > prev;
  const pct = prev > 0 ? Math.round((Math.abs(cur - prev) / prev) * 100) : null;
  return (
    <span className={`metric-change ${t}`} title={title}>
      {up ? "▲" : "▼"}
      {pct !== null ? ` ${pct}%` : ""}
    </span>
  );
}

export function MetricPill({
  value,
  cur,
  prev,
  kind,
  size,
  title,
}: {
  value: string; // pre-formatted display value (e.g. "$11,726.26" or "231")
  cur: number;
  prev: number | null;
  kind: MetricKind;
  size?: "lg";
  title?: string;
}) {
  const t = metricTone(kind, cur, prev);
  const changed = prev !== null && cur !== prev;
  const up = cur > (prev ?? cur);
  const pct = changed && prev! > 0 ? Math.round((Math.abs(cur - prev!) / prev!) * 100) : null;
  return (
    <span className={`metric-pill ${t}${size === "lg" ? " lg" : ""}`} title={title}>
      <span className="mp-val">{value}</span>
      {changed && (
        <span className="mp-delta">
          {up ? "▲" : "▼"}
          {pct !== null ? ` ${pct}%` : ""}
        </span>
      )}
    </span>
  );
}
