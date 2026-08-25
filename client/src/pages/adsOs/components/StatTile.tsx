import type { ReactNode } from "react";

// Shared summary stat tile for the dashboards (was a duplicated `Stat` in each).
// Optional `attn` styles it as the clickable "needs attention" filter toggle.
// Port of the bundle's frontend/src/components/StatTile.tsx, made keyboard-
// operable: when `onClick` is present the tile renders as a real <button> so it
// is focusable and activates on Enter/Space, and `pressed` drives aria-pressed
// for the "needs attention" filter toggle.
export function StatTile({
  val,
  label,
  attn,
  onClick,
  pressed,
  testId,
}: {
  val: ReactNode;
  label: string;
  attn?: boolean;
  onClick?: () => void;
  /** aria-pressed for filter-toggle tiles (only meaningful with onClick). */
  pressed?: boolean;
  testId?: string;
}) {
  const className = `dash-stat${attn ? " attn" : ""}`;
  const inner = (
    <>
      <div className="dash-stat-val">{val}</div>
      <div className="dash-stat-label">{label}</div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        aria-pressed={pressed}
        aria-label={label}
        data-testid={testId}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className={className} data-testid={testId}>
      {inner}
    </div>
  );
}
