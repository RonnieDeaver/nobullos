// Date-window selector shared by all three dashboards: pick the current window
// (last 7 / 14 / 30 days) and what it's compared against — the immediately
// previous window, or a trailing multi-period average normalized to one window.
// Verbatim port of the bundle's frontend/src/components/RangeSelector.tsx.

export type DashWindow = 7 | 14 | 30;
export type DashCompare = "previous" | "average";
export interface DashRange {
  window: DashWindow;
  compare: DashCompare;
}

export const DEFAULT_RANGE: DashRange = { window: 30, compare: "previous" };

const AVG_LABEL: Record<DashWindow, string> = {
  7: "4-week average",
  14: "8-week average",
  30: "90-day average",
};

// Human label for the comparison basis (used in tooltips / sublabels).
export function compareLabel(r: DashRange): string {
  return r.compare === "average"
    ? `vs ${AVG_LABEL[r.window]}`
    : `vs previous ${r.window} days`;
}

export function RangeSelector({
  range,
  onChange,
  disabled,
}: {
  range: DashRange;
  onChange: (r: DashRange) => void;
  disabled?: boolean;
}) {
  return (
    <div className="range-sel">
      <select
        className="range-dd"
        value={range.window}
        disabled={disabled}
        aria-label="Date window"
        onChange={(e) => onChange({ ...range, window: Number(e.target.value) as DashWindow })}
      >
        <option value={7}>Last 7 days</option>
        <option value={14}>Last 14 days</option>
        <option value={30}>Last 30 days</option>
      </select>
      <select
        className="range-dd"
        value={range.compare}
        disabled={disabled}
        aria-label="Comparison basis"
        onChange={(e) => onChange({ ...range, compare: e.target.value as DashCompare })}
      >
        <option value="previous">vs previous {range.window} days</option>
        <option value="average">vs {AVG_LABEL[range.window]}</option>
      </select>
    </div>
  );
}
