import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown, ChevronRight, AlertTriangle,
} from "lucide-react";
import { format } from "date-fns";
import type { ConsoleJob } from "./types";
import { jobStatusColor, relativeTime } from "./utils";

export function JobRow({ job, defaultExpanded = false }: { job: ConsoleJob; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);
  const progressEntries = job.progress
    ? Object.entries(job.progress).filter(([, v]) => v != null && v !== "")
    : [];

  return (
    <div
      id={`front-job-${job.id}`}
      className="border rounded-lg overflow-hidden"
      data-testid={`row-front-job-${job.id}`}
    >
      <div
        className="flex flex-wrap items-center gap-2 sm:gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`button-expand-job-${job.id}`}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground" data-testid={`text-job-type-${job.id}`}>
              {job.typeLabel}
            </span>
            {job.deprecated && (
              <Badge
                variant="outline"
                className="bg-red-50 text-red-700 border-red-200"
                data-testid={`badge-job-deprecated-${job.id}`}
              >
                Deprecated
              </Badge>
            )}
            {!job.deprecated && job.canonical && (
              <Badge
                variant="outline"
                className="bg-purple-50 text-purple-700 border-purple-200"
                data-testid={`badge-job-canonical-${job.id}`}
              >
                Canonical
              </Badge>
            )}
            <Badge
              variant="outline"
              className={
                job.durability === "durable"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-amber-50 text-amber-700 border-amber-200"
              }
              title={
                job.durability === "durable"
                  ? "DB-backed — survives server restarts"
                  : "In-memory only — only survives current process lifetime"
              }
              data-testid={`badge-job-durability-${job.id}`}
            >
              {job.durability === "durable" ? "Durable" : "Ephemeral"}
            </Badge>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
            <code className="font-mono truncate max-w-[180px] sm:max-w-none" title={job.id}>
              {job.id.slice(0, 8)}…
            </code>
            <span>·</span>
            <span data-testid={`text-job-updated-${job.id}`}>
              Updated {relativeTime(job.lastUpdateAt)}
            </span>
          </div>
        </div>

        <Badge
          variant="outline"
          className={jobStatusColor(job.status)}
          data-testid={`badge-job-status-${job.id}`}
        >
          {job.status}
        </Badge>
      </div>

      {expanded && (
        <div className="border-t bg-muted/50 p-4 space-y-3 text-sm" data-testid={`expanded-job-${job.id}`}>
          {job.durability === "ephemeral" && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              <AlertTriangle className="w-3 h-3 inline mr-1 -mt-0.5" />
              Ephemeral job: only survives the current process lifetime. If the
              server restarts, this entry disappears and progress cannot be
              resumed.
            </p>
          )}
          {job.deprecated && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
              <AlertTriangle className="w-3 h-3 inline mr-1 -mt-0.5" />
              This is a legacy code path. Use the canonical Historical Recovery
              flow instead.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground font-medium">Started</p>
              <p>{job.startedAt ? format(new Date(job.startedAt), "MMM d, yyyy h:mm a") : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium">Started by</p>
              <p>{job.startedBy ?? <span className="text-muted-foreground">unknown</span>}</p>
            </div>
            {job.statusReason && (
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground font-medium">Status reason</p>
                <p className="font-mono text-xs">{job.statusReason}</p>
              </div>
            )}
          </div>
          {progressEntries.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-1">Progress</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {progressEntries.map(([k, v]) => (
                  <div
                    key={k}
                    className="bg-card border rounded px-2 py-1 text-xs"
                    data-testid={`text-job-progress-${job.id}-${k}`}
                  >
                    <span className="text-muted-foreground">{k}:</span>{" "}
                    <span className="font-medium">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {job.finalSummary && (
            <div>
              <p className="text-xs text-muted-foreground font-medium">Final summary</p>
              <p
                className="text-xs bg-card border rounded p-2 whitespace-pre-wrap break-words"
                data-testid={`text-job-final-summary-${job.id}`}
              >
                {job.finalSummary}
              </p>
            </div>
          )}
          {job.lastError && (
            <div>
              <p className="text-xs text-red-600 font-medium">Last error</p>
              <p className="text-xs bg-red-50 border border-red-200 rounded p-2 font-mono whitespace-pre-wrap break-words">
                {job.lastError}
              </p>
            </div>
          )}
          {Array.isArray(job.itemErrors) && job.itemErrors.length > 0 && (
            <div data-testid={`section-job-item-errors-${job.id}`}>
              <p className="text-xs text-red-600 font-medium mb-1">
                Per-item failures ({job.itemErrors.length})
              </p>
              <div className="text-xs bg-red-50 border border-red-200 rounded p-2 max-h-48 overflow-auto space-y-1">
                {job.itemErrors.map((e, i) => (
                  <div
                    key={`${e.rawCommId}-${i}`}
                    className="font-mono break-words"
                    data-testid={`text-job-item-error-${job.id}-${i}`}
                  >
                    <span className="text-red-700">{e.rawCommId}</span>
                    <span className="text-muted-foreground"> — </span>
                    <span>{e.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {Array.isArray(job.windows) && job.windows.length > 0 && (
            <div data-testid={`section-job-windows-${job.id}`}>
              <p className="text-xs text-muted-foreground font-medium mb-1">
                Windows ({job.windows.length})
              </p>
              <div className="space-y-1.5 max-h-72 overflow-auto">
                {job.windows.map((w, i) => {
                  const isError =
                    w.status === "failed" ||
                    w.status === "blocked" ||
                    (w.errorCount > 0 && w.scanned === 0);
                  const isWarn =
                    w.status === "partial" || w.status === "empty_source" || w.errorCount > 0;
                  return (
                    <div
                      key={`${w.label}-${i}`}
                      className={`text-xs border rounded p-2 ${
                        isError
                          ? "bg-red-50 border-red-200"
                          : isWarn
                          ? "bg-amber-50 border-amber-200"
                          : "bg-card"
                      }`}
                      data-testid={`row-job-window-${job.id}-${i}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="font-mono font-medium"
                          data-testid={`text-job-window-label-${job.id}-${i}`}
                        >
                          {w.label}
                        </span>
                        <Badge
                          variant="outline"
                          className={jobStatusColor(w.status)}
                          data-testid={`badge-job-window-status-${job.id}-${i}`}
                        >
                          {w.status}
                        </Badge>
                        <span className="text-muted-foreground">
                          {w.pages}p · {w.scanned} scanned · {w.ingested} ingested · {w.skipped} dup
                        </span>
                        {w.errorCount > 0 && (
                          <span
                            className="text-red-700 font-medium"
                            data-testid={`text-job-window-error-count-${job.id}-${i}`}
                          >
                            {w.errorCount} {w.errorCount === 1 ? "error" : "errors"}
                          </span>
                        )}
                      </div>
                      {w.statusReason && (
                        <p
                          className="mt-1 font-mono text-xs text-foreground break-words"
                          data-testid={`text-job-window-reason-${job.id}-${i}`}
                        >
                          {w.statusReason}
                        </p>
                      )}
                      {w.firstError && (
                        <p
                          className="mt-1 font-mono text-xs text-red-700 break-words whitespace-pre-wrap"
                          data-testid={`text-job-window-first-error-${job.id}-${i}`}
                        >
                          {w.firstError}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
