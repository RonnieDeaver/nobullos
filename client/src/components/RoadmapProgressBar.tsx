/**
 * Task #4215 — the ONE progress-bar rendering used by every roadmap surface
 * (admin kanban, public page, embed). Percent/stage come exclusively from
 * shared/roadmapProgress.ts so surfaces can never disagree; callers pass
 * `now` from useNow() so bars tick without a refetch.
 */
import {
  completionQuarterKey,
  quarterLabel,
  roadmapProgress,
  roadmapProgressStageLabels,
} from "@shared/roadmapProgress";

export function RoadmapProgressBar({
  status,
  releaseQuarter,
  completedAt,
  now,
  size = "md",
  testId,
  variant,
}: {
  status: string;
  releaseQuarter: string | null;
  completedAt?: string | Date | null;
  now: Date;
  size?: "sm" | "md";
  testId?: string;
  /** 'report' swaps the stock emerald/slate/amber/primary classes for
   *  `--report-*` token classes inside the public client report
   *  (`.report-surface`). Omit on OS/roadmap surfaces — default styling
   *  is unchanged. */
  variant?: "report";
}) {
  const report = variant === "report";
  const progress = roadmapProgress({ status, releaseQuarter }, now);
  // "Later" items deliberately carry no bar at all.
  if (progress.percent === null) return null;
  const done = progress.stage === "done";
  const completedIn = done ? completionQuarterKey(completedAt ?? null) : null;
  const label =
    done && completedIn
      ? `Completed ${quarterLabel(completedIn)}`
      : roadmapProgressStageLabels[progress.stage];
  return (
    <div data-testid={testId}>
      <div
        className={`flex items-center justify-between gap-2 font-medium ${
          size === "sm" ? "text-[11px]" : "text-[11px]"
        }`}
      >
        <span className={done ? (report ? "text-report-healthy" : "text-emerald-700") : report ? "text-report-ink-muted" : "text-slate-500"}>{label}</span>
        <span
          className={done ? (report ? "text-report-healthy" : "text-emerald-700") : report ? "text-report-ink-muted" : "text-slate-500"}
          data-testid={testId ? `${testId}-percent` : undefined}
        >
          {progress.percent}%
        </span>
      </div>
      <div
        className={`mt-1 w-full overflow-hidden rounded-full ${report ? "bg-report-cream-deep" : "bg-slate-200/70"} ${
          size === "sm" ? "h-1" : "h-1.5"
        }`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${
            done
              ? report
                ? "bg-report-healthy"
                : "bg-emerald-500"
              : progress.stage === "held"
                ? report
                  ? "bg-report-attention"
                  : "bg-amber-400"
                : report
                  ? "bg-report-crimson"
                  : "bg-primary"
          }`}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}
