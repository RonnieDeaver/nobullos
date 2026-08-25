// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Activity, AlertTriangle, Clock, Download, Loader2, RotateCcw } from "lucide-react";
import type { CoverageMonth, IntegrationStatus, RecoveryJobSummary, RecoveryJobsListResponse, RecoveryWindow } from "./types";
import type { RecoveryJobsHook } from "./useRecoveryJobs";

type Props = {
  customRangeOpen: boolean;
  months: CoverageMonth[];
  recoveryExecuteMutation: RecoveryJobsHook["recoveryExecuteMutation"];
  recoveryJobsList: RecoveryJobsListResponse | undefined;
  recoveryRunning: boolean;
  status: IntegrationStatus | undefined;
};

export function CustomRangeSection({ customRangeOpen, months, recoveryExecuteMutation, recoveryJobsList, recoveryRunning, status }: Props) {
  const [customRangeStart, setCustomRangeStart] = useState("");

  const [customRangeEnd, setCustomRangeEnd] = useState("");

  const [customRangeLabel, setCustomRangeLabel] = useState("");

  // Task #4420 — field validation is inline (FormField), never a toast.
  const [rangeErrors, setRangeErrors] = useState<{ start?: string; end?: string }>({});

  // Pending "Recover range" confirmation (validated on click, confirmed via dialog).
  const [pendingCustomRun, setPendingCustomRun] = useState<{
    label: string;
    startMs: number;
    endMs: number;
    rangeDays: number;
    estimatedMonths: number;
    isLarge: boolean;
  } | null>(null);

  // Shared validate-on-submit for both "Recover range" and "Dry run range".
  // Returns the epoch-ms bounds when valid, or null after setting inline errors.
  const validateRange = (): { startMs: number; endMs: number } | null => {
    const startMs = new Date(`${customRangeStart}T00:00:00Z`).getTime();
    const endMs = new Date(`${customRangeEnd}T23:59:59.999Z`).getTime();
    const next: { start?: string; end?: string } = {};
    if (!isFinite(startMs)) next.start = "Pick a valid start date.";
    if (!isFinite(endMs)) next.end = "Pick a valid end date.";
    if (!next.start && !next.end && startMs >= endMs) {
      next.end = "End date must be after the start date.";
    }
    setRangeErrors(next);
    if (next.start || next.end) return null;
    return { startMs, endMs };
  };


  const recentCustomRanges = useMemo(() => {
    const jobs: RecoveryJobSummary[] = Array.isArray(recoveryJobsList?.jobs) ? recoveryJobsList.jobs : [];
    const seen = new Set<string>();
    const out: Array<{ jobId: string; label: string; afterTimestamp: number; beforeTimestamp: number; startedAt: string; status: string; dryRun: boolean }> = [];
    for (const job of jobs) {
      const reqWindows: RecoveryWindow[] = Array.isArray(job?.requestedCustomWindows) ? job.requestedCustomWindows : [];
      if (reqWindows.length === 0) continue;
      for (const w of reqWindows) {
        if (!w || typeof w.label !== "string" || typeof w.afterTimestamp !== "number" || typeof w.beforeTimestamp !== "number") continue;
        const key = `${w.label}|${w.afterTimestamp}|${w.beforeTimestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          jobId: job.jobId,
          label: w.label,
          afterTimestamp: w.afterTimestamp,
          beforeTimestamp: w.beforeTimestamp,
          startedAt: job.startedAt,
          status: job.status,
          dryRun: !!job.dryRun,
        });
        if (out.length >= 5) break;
      }
      if (out.length >= 5) break;
    }
    return out;
  }, [recoveryJobsList]);

  return (
    <>
        {customRangeOpen && (
          <div className="border rounded-[var(--radius-lg)] p-3 space-y-3 bg-muted/50" data-testid="section-recovery-custom-range">
            <div className="text-xs text-muted-foreground">
              Recover a specific Front date range (e.g. after a Front data fix). The end date is inclusive.
            </div>
            {recentCustomRanges.length > 0 && (
              <div className="border rounded-md p-2 bg-card" data-testid="section-recovery-recent-custom-ranges">
                <div className="text-xs font-medium text-foreground mb-1">Recent custom ranges</div>
                <ul className="space-y-1">
                  {recentCustomRanges.map((r) => {
                    const startDate = new Date(r.afterTimestamp * 1000).toISOString().slice(0, 10);
                    const endDate = new Date(r.beforeTimestamp * 1000).toISOString().slice(0, 10);
                    const key = `${r.jobId}-${r.label}-${r.afterTimestamp}-${r.beforeTimestamp}`;
                    const idSuffix = `${r.afterTimestamp}-${r.beforeTimestamp}`;
                    return (
                      <li
                        key={key}
                        className="flex items-center justify-between gap-2 text-xs"
                        data-testid={`row-recent-custom-range-${idSuffix}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-foreground truncate" data-testid={`text-recent-range-label-${idSuffix}`}>
                            {r.label}
                          </div>
                          <div className="text-muted-foreground" data-testid={`text-recent-range-dates-${idSuffix}`}>
                            {startDate} → {endDate}
                            {r.dryRun ? " · dry run" : ""}
                            {r.status ? ` · ${r.status}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            data-testid={`button-recent-range-prefill-${idSuffix}`}
                            onClick={() => {
                              setCustomRangeStart(startDate);
                              setCustomRangeEnd(endDate);
                              setCustomRangeLabel(r.label);
                              setRangeErrors({});
                            }}
                          >
                            Prefill
                          </Button>
                          <ConfirmActionDialog
                            trigger={
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2"
                                disabled={recoveryRunning || recoveryExecuteMutation.isPending}
                                data-testid={`button-recent-range-run-${idSuffix}`}
                              >
                                <RotateCcw className="w-3 h-3 mr-1" />
                                Run again
                              </Button>
                            }
                            title={`Re-run Front recovery for "${r.label}"?`}
                            description={`This starts a real (non-dry-run) recovery over ${startDate} → ${endDate}, re-fetching that range from Front's API. Only one recovery job can run at a time.`}
                            confirmLabel="Run again"
                            onConfirm={() => {
                              recoveryExecuteMutation.mutate({
                                dryRun: false,
                                customWindows: [{
                                  label: r.label,
                                  afterTimestamp: r.afterTimestamp,
                                  beforeTimestamp: r.beforeTimestamp,
                                }],
                              });
                            }}
                            testId={`dialog-recent-range-run-${idSuffix}`}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <FormField
                label="Start date"
                htmlFor="input-recovery-custom-start"
                labelClassName="text-xs"
                error={rangeErrors.start}
                className="space-y-0.5"
              >
                <Input
                  type="date"
                  value={customRangeStart}
                  onChange={(e) => {
                    setCustomRangeStart(e.target.value);
                    setRangeErrors((prev) => ({ ...prev, start: undefined }));
                  }}
                  data-testid="input-recovery-custom-start"
                />
              </FormField>
              <FormField
                label="End date"
                htmlFor="input-recovery-custom-end"
                labelClassName="text-xs"
                error={rangeErrors.end}
                className="space-y-0.5"
              >
                <Input
                  type="date"
                  value={customRangeEnd}
                  onChange={(e) => {
                    setCustomRangeEnd(e.target.value);
                    setRangeErrors((prev) => ({ ...prev, end: undefined }));
                  }}
                  data-testid="input-recovery-custom-end"
                />
              </FormField>
              <div>
                <Label htmlFor="input-recovery-custom-label" className="text-xs">Label</Label>
                <Input
                  id="input-recovery-custom-label"
                  type="text"
                  placeholder="e.g. Mar 2026 re-sync"
                  value={customRangeLabel}
                  onChange={(e) => setCustomRangeLabel(e.target.value)}
                  data-testid="input-recovery-custom-label"
                />
              </div>
            </div>
            {(() => {
              if (!customRangeStart || !customRangeEnd) return null;
              const startMs = new Date(`${customRangeStart}T00:00:00Z`).getTime();
              const endMs = new Date(`${customRangeEnd}T23:59:59.999Z`).getTime();
              if (!isFinite(startMs) || !isFinite(endMs) || startMs >= endMs) return null;
              const rangeDays = Math.ceil((endMs - startMs) / (1000 * 60 * 60 * 24));
              const estimatedMonths = Math.max(1, Math.ceil(rangeDays / 30));
              const LARGE_RANGE_DAYS = 90;
              const isLarge = rangeDays > LARGE_RANGE_DAYS;
              return (
                <div
                  className={`flex items-start gap-2 text-xs rounded border px-2 py-1.5 ${
                    isLarge
                      ? "bg-amber-50 border-amber-300 text-amber-800"
                      : "bg-card border-border text-muted-foreground"
                  }`}
                  data-testid="text-recovery-custom-range-summary"
                >
                  {isLarge ? (
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  )}
                  <div>
                    <span className="font-medium">~{estimatedMonths} {estimatedMonths === 1 ? "month" : "months"} / {rangeDays} {rangeDays === 1 ? "day" : "days"}</span>
                    {isLarge && (
                      <span> — large range, we recommend running a Dry run first to estimate the work.</span>
                    )}
                  </div>
                </div>
              );
            })()}
            <div className="flex flex-wrap gap-2">
              <ConfirmActionDialog
                open={pendingCustomRun != null}
                onOpenChange={(open) => { if (!open) setPendingCustomRun(null); }}
                title={
                  pendingCustomRun?.isLarge
                    ? "Large range warning — recover anyway?"
                    : `Recover Front history for "${pendingCustomRun?.label ?? ""}"?`
                }
                description={
                  pendingCustomRun?.isLarge
                    ? `This range (${customRangeStart} → ${customRangeEnd}) spans ${pendingCustomRun.rangeDays} days (~${pendingCustomRun.estimatedMonths} month${pendingCustomRun.estimatedMonths === 1 ? "" : "s"}) of Front history. Recovering a large range can take a long time and put significant load on Front's API. We strongly recommend running a Dry run first to estimate the work.`
                    : `This starts a real (non-dry-run) recovery over ${customRangeStart} → ${customRangeEnd}, re-fetching that range from Front's API. Only one recovery job can run at a time.`
                }
                confirmLabel={pendingCustomRun?.isLarge ? "Recover anyway" : "Recover range"}
                onConfirm={() => {
                  if (!pendingCustomRun) return;
                  recoveryExecuteMutation.mutate({
                    dryRun: false,
                    customWindows: [{
                      label: pendingCustomRun.label,
                      afterTimestamp: Math.floor(pendingCustomRun.startMs / 1000),
                      beforeTimestamp: Math.floor(pendingCustomRun.endMs / 1000),
                    }],
                  });
                  setPendingCustomRun(null);
                }}
                testId="dialog-recovery-custom-run"
              />
              <Button
                size="sm"
                variant="default"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                data-testid="button-recovery-custom-run"
                disabled={recoveryRunning || recoveryExecuteMutation.isPending || !customRangeStart || !customRangeEnd || !customRangeLabel.trim()}
                onClick={() => {
                  const range = validateRange();
                  if (!range) return;
                  const { startMs, endMs } = range;
                  const rangeDays = Math.ceil((endMs - startMs) / (1000 * 60 * 60 * 24));
                  const estimatedMonths = Math.max(1, Math.ceil(rangeDays / 30));
                  const LARGE_RANGE_DAYS = 90;
                  setPendingCustomRun({
                    label: customRangeLabel.trim(),
                    startMs,
                    endMs,
                    rangeDays,
                    estimatedMonths,
                    isLarge: rangeDays > LARGE_RANGE_DAYS,
                  });
                }}
              >
                {recoveryRunning ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
                Recover range
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="button-recovery-custom-dry-run"
                disabled={recoveryRunning || recoveryExecuteMutation.isPending || !customRangeStart || !customRangeEnd || !customRangeLabel.trim()}
                onClick={() => {
                  const range = validateRange();
                  if (!range) return;
                  const { startMs, endMs } = range;
                  recoveryExecuteMutation.mutate({
                    dryRun: true,
                    customWindows: [{
                      label: customRangeLabel.trim(),
                      afterTimestamp: Math.floor(startMs / 1000),
                      beforeTimestamp: Math.floor(endMs / 1000),
                    }],
                  });
                }}
              >
                {recoveryExecuteMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Activity className="w-3 h-3 mr-1" />}
                Dry run range
              </Button>
            </div>
          </div>
        )}
    </>
  );
}
