/**
 * Task #4367 (audit P1-5 §6.2) — clamped percentage text for the Front console.
 *
 * Every rendered ratio on the console routes through the shared
 * `frontPercentDisplay` gate (shared/frontConsoleMetrics.ts): in-range values
 * render exactly as before (caller-chosen digits), impossible values render as
 * the explicit "needs recount" data-quality state with the raw value preserved
 * in the tooltip, and missing values render "—". Presentation only — no stored
 * value or computation changes.
 */
import { frontPercentDisplay } from "@shared/frontConsoleMetrics";

export function PercentText({
  value,
  digits = 1,
  className,
}: {
  value: number | string | null | undefined;
  digits?: number;
  /** Extra classes for the in-range/missing rendering only. */
  className?: string;
}) {
  const d = frontPercentDisplay(value, digits);
  if (d.state === "out_of_range") {
    return (
      <span
        className="text-amber-600 font-medium"
        title={d.title}
        data-percent-state="out_of_range"
      >
        {d.text}
      </span>
    );
  }
  return (
    <span className={className} data-percent-state={d.state}>
      {d.text}
    </span>
  );
}
