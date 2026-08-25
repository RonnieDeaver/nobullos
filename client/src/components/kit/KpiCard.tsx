import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";

import { Card, CardContent, type CardAccent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * KpiCard — the app's one way to render a headline metric, standardizing the
 * Ads OS KPI pattern (label + value + unit + delta arrow + caption).
 *
 * The `label` is required and the `caption` slot exists precisely so no
 * surface ever ships a bare "0.76" again: every number says what it is, and
 * captions carry scale/window context ("Avg health score (0–1) · last 30
 * days").
 *
 * Delta semantics mirror the Ads OS MetricPill: the *direction* comes from
 * the sign of `delta.value`, but the *tone* comes from what that direction
 * means for the metric (`goodWhen`): up-good (leads), down-good (CPL), or
 * none (spend — movement is neither good nor bad). Good movement renders in
 * `--status-ok`, bad movement in `--status-critical`, flat/neutral movement
 * stays quiet.
 */
export type KpiDeltaTone = "ok" | "critical" | "neutral";

export interface KpiDelta {
  /** Signed change vs the comparison window, e.g. `12`, `-8.4`. */
  value: number;
  /**
   * Which direction is good news for this metric. Default `"up"`.
   * `"none"` = movement is neutral either way (spend-like metrics).
   */
  goodWhen?: "up" | "down" | "none";
  /** How `value` renders: `"percent"` (default) appends `%`. */
  format?: "percent" | "absolute";
  /** Pre-formatted display text overriding the default magnitude text. */
  display?: string;
  /** Comparison-window caption rendered after the delta, e.g. "vs. May". */
  label?: string;
}

/** Tone of a delta: good movement, bad movement, or neutral/flat. */
export function kpiDeltaTone(delta: KpiDelta): KpiDeltaTone {
  if (delta.value === 0 || delta.goodWhen === "none") return "neutral";
  const up = delta.value > 0;
  const good = (delta.goodWhen ?? "up") === "up" ? up : !up;
  return good ? "ok" : "critical";
}

function deltaText(delta: KpiDelta): string {
  if (delta.display) return delta.display;
  const magnitude = Math.abs(delta.value);
  return (delta.format ?? "percent") === "percent"
    ? `${magnitude}%`
    : `${magnitude}`;
}

const DELTA_TONE_CLASSES: Record<KpiDeltaTone, string> = {
  ok: "text-status-ok",
  critical: "text-status-critical",
  neutral: "text-muted-foreground",
};

export interface KpiCardProps {
  /** What the number is. Required — no more unlabeled metrics. */
  label: ReactNode;
  /** The headline value, pre-formatted ("$11,726", "0.76", "231"). */
  value: ReactNode;
  /** Unit rendered after the value ("%", "calls", "days"). */
  unit?: ReactNode;
  /** Change vs a comparison window; renders the arrow chip. */
  delta?: KpiDelta | null;
  /** Scale/window context ("Avg health score (0–1) · last 30 days"). */
  caption?: ReactNode;
  /** Optional icon aligned with the label row. */
  icon?: ReactNode;
  /** Sanctioned Card side-accent stripe (see Card `accent`). */
  accent?: CardAccent;
  className?: string;
  /** Convenience alias for `data-testid`; child nodes get suffixed ids. */
  testId?: string;
}

export function KpiCard({
  label,
  value,
  unit,
  delta,
  caption,
  icon,
  accent,
  className,
  testId,
}: KpiCardProps) {
  const tone = delta ? kpiDeltaTone(delta) : null;
  const direction =
    delta == null || delta.value === 0 ? "flat" : delta.value > 0 ? "up" : "down";

  return (
    <Card
      accent={accent}
      data-testid={testId}
      // h-full: KPI cards habitually sit in grid rows (dashboard, CEO
      // Insights) — filling the grid track keeps every sibling's border
      // flush even when a wrapper (e.g. a Link) sits between card and grid.
      className={cn("h-full rounded-none", className)}
    >
      {/* Task #4993 — fixed internal zones so sibling cards read as one calm
          row: a single-line label zone (numbers start on the same line in
          every card), the value zone, and a caption zone pinned to the card
          bottom (mt-auto) so captions align across siblings instead of
          floating at whatever height each card's content happens to end. */}
      <CardContent className="flex h-full flex-col gap-1 p-4">
        <div className="flex items-center justify-between gap-2">
          <div
            className="min-w-0 truncate text-caption font-medium uppercase tracking-wide text-muted-foreground"
            title={typeof label === "string" ? label : undefined}
          >
            {label}
          </div>
          {icon && (
            <span aria-hidden="true" className="shrink-0 text-muted-foreground">
              {icon}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className="text-display leading-none"
            data-testid={testId ? `${testId}-value` : undefined}
          >
            {value}
          </span>
          {unit != null && (
            <span className="text-caption text-muted-foreground">{unit}</span>
          )}
          {delta && tone && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-caption font-semibold",
                DELTA_TONE_CLASSES[tone],
              )}
              data-testid={testId ? `${testId}-delta` : undefined}
              data-direction={direction}
              data-tone={tone}
              aria-label={`${
                direction === "up" ? "Up" : direction === "down" ? "Down" : "Unchanged"
              } ${deltaText(delta)}${
                tone === "ok" ? " (improving)" : tone === "critical" ? " (worsening)" : ""
              }`}
            >
              {direction === "up" && <ArrowUp aria-hidden="true" className="h-3 w-3" />}
              {direction === "down" && (
                <ArrowDown aria-hidden="true" className="h-3 w-3" />
              )}
              {deltaText(delta)}
              {delta.label && (
                <span className="ml-1 font-normal text-muted-foreground">
                  {delta.label}
                </span>
              )}
            </span>
          )}
        </div>
        {caption && (
          <div
            className="mt-auto text-caption text-muted-foreground"
            data-testid={testId ? `${testId}-caption` : undefined}
          >
            {caption}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
