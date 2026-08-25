/**
 * Task #4216 — "Product updates this quarter" block on the CEO Pulse slide
 * of client reports (share / preview / demo, screen + print).
 *
 * The server selects WHICH items appear (shared quarter-window rules over
 * the single public roadmap projection — see server/lib/publicRoadmap.ts);
 * percentages are computed HERE at render time from shared/roadmapProgress
 * via useNow, so an already-published report's bars tick up between views
 * with zero regeneration — the same live model as every other roadmap
 * surface. Completed items render the shared bar's done styling (100%,
 * "Completed Qn YYYY"). The server omits the block (null) when nothing
 * qualifies or the report has no CEO Pulse; this component also self-hides
 * on an empty payload as a belt-and-suspenders guard.
 */
import { CheckCircle2, Rocket } from "lucide-react";
import type { ReportProductUpdates } from "@shared/schema";
import { RoadmapMarkdown } from "@/components/RoadmapMarkdown";
import { RoadmapProgressBar } from "@/components/RoadmapProgressBar";
import { useNow } from "@/hooks/useNow";

export function ReportProductUpdatesBlock({ updates }: { updates: ReportProductUpdates }) {
  const now = useNow(60_000);
  const items = [
    ...updates.upcoming.map((item) => ({ item, done: false })),
    ...updates.completed.map((item) => ({ item, done: true })),
  ];
  if (items.length === 0) return null;
  return (
    <div className="card-light p-5 break-inside-avoid" data-testid="ceo-pulse-product-updates">
      <div className="flex items-baseline justify-between gap-3 print-keep-together">
        <div className="section-label-light">Product Updates This Quarter</div>
        {/* Task #4414 — this block renders ONLY inside the public report
            (.report-surface), so its inks ride the --report-* token classes. */}
        <span className="text-[11px] font-semibold text-report-crimson">{updates.quarterLabel}</span>
      </div>
      <p className="text-xs text-report-ink-muted mt-1 mb-4">
        What our team is building for you right now — progress is live and updates every time you
        open this report.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
        {items.map(({ item, done }) => (
          <div
            key={item.id}
            className="flex items-start gap-2 break-inside-avoid"
            data-testid={`product-update-${item.id}`}
          >
            {done ? (
              <CheckCircle2 className="w-4 h-4 text-report-healthy mt-0.5 shrink-0" />
            ) : (
              <Rocket className="w-4 h-4 text-report-crimson mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <span className="text-sm font-semibold text-report-ink leading-snug block">
                {item.title}
              </span>
              <div className="text-[11px] uppercase tracking-wider text-report-ink-muted mt-0.5">
                {item.typeName}
              </div>
              {item.description && (
                // Markdown-aware (#4266), same muted styling + 2-line clamp as
                // the old plain-text rendering.
                <RoadmapMarkdown
                  source={item.description}
                  className="text-xs text-report-ink-muted mt-0.5 line-clamp-2"
                />
              )}
              <div className="mt-1.5">
                <RoadmapProgressBar
                  status={item.status}
                  releaseQuarter={item.releaseQuarter}
                  completedAt={item.completedAt}
                  now={now}
                  size="sm"
                  variant="report"
                  testId={`product-update-progress-${item.id}`}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
