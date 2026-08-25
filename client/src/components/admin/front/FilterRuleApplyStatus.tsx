import { Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { FilterRule, FilterRuleApplyJobState } from "./types";
import { isApplyJobActive } from "./utils";
import { FilterRuleApplyAuditDrawer } from "./FilterRuleApplyAuditDrawer";

export function FilterRuleApplyStatus({
  rule,
  state,
}: {
  rule: FilterRule;
  state: FilterRuleApplyJobState;
}) {
  const active = isApplyJobActive(state);
  const skipped = Math.max(0, state.totalSelected - state.totalProcessed);
  const denom = state.totalSelected > 0 ? state.totalSelected : 0;
  const pct = active && denom > 0
    ? Math.min(100, Math.round((state.totalProcessed / denom) * 100))
    : null;

  const containerClass =
    state.status === "failed"
      ? "bg-red-50 border-red-200 text-red-800"
      : state.status === "partial"
      ? "bg-amber-50 border-amber-200 text-amber-900"
      : state.status === "complete"
      ? "bg-green-50 border-green-200 text-green-800"
      : "bg-blue-50 border-blue-200 text-blue-800";

  return (
    <div
      className={`mt-2 text-xs border rounded p-2 space-y-1 ${containerClass}`}
      data-testid={`apply-status-${rule.id}`}
    >
      {active ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 font-medium">
              <Loader2 className="w-3 h-3 animate-spin" />
              {state.status === "queued" ? "Queued — waiting for worker…" : "Applying retroactively…"}
            </span>
            <span data-testid={`apply-status-progress-${rule.id}`}>
              {state.totalProcessed.toLocaleString()} / {state.totalSelected.toLocaleString()}
              {pct !== null && <> · {pct}%</>}
            </span>
          </div>
          {denom > 0 && (
            <div className="h-1.5 w-full rounded bg-blue-100 overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${pct ?? 0}%` }}
              />
            </div>
          )}
          {state.finalSummary && (
            <p className="opacity-80 break-words">{state.finalSummary}</p>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-medium" data-testid={`apply-status-label-${rule.id}`}>
              {state.status === "complete" && "Apply complete"}
              {state.status === "partial" && "Apply finished with errors"}
              {state.status === "failed" && "Apply failed"}
            </span>
            <span className="opacity-80">
              Finished {formatDistanceToNow(new Date(state.updatedAt), { addSuffix: true })}
            </span>
          </div>
          <div className="flex items-center gap-3 flex-wrap" data-testid={`apply-status-totals-${rule.id}`}>
            <span data-testid={`apply-status-succeeded-${rule.id}`}>
              <strong>{state.succeeded.toLocaleString()}</strong> succeeded
            </span>
            <span data-testid={`apply-status-failed-${rule.id}`}>
              <strong>{state.failed.toLocaleString()}</strong> failed
            </span>
            <span data-testid={`apply-status-skipped-${rule.id}`}>
              <strong>{skipped.toLocaleString()}</strong> skipped
            </span>
            <span className="opacity-70">
              of {state.totalSelected.toLocaleString()} selected
            </span>
          </div>
          {state.finalSummary && (
            <p
              className="opacity-90 break-words"
              data-testid={`apply-status-summary-${rule.id}`}
            >
              {state.finalSummary}
            </p>
          )}
          <p className="text-xs break-all flex items-center gap-2 flex-wrap">
            <FilterRuleApplyAuditDrawer rule={rule} jobId={state.jobId} />
            <span className="opacity-70 font-mono">
              job {state.jobId}
              {state.childBulkJobId && <> · bulk {state.childBulkJobId}</>}
            </span>
          </p>
        </>
      )}
    </div>
  );
}
