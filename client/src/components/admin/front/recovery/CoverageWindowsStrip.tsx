// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";

import type { CoverageMonth, CoverageReport, RecoveryWindow } from "./types";

type Props = {
  coverageReport: CoverageReport | undefined;
  gapCount: number;
  months: CoverageMonth[];
};

export function CoverageWindowsStrip({ coverageReport, gapCount, months }: Props) {
  const maxCov = Math.max(1, ...months.map((m: CoverageMonth) => m.totalCoverage ?? 0));

  return (
    <>
        <div>
          <h4 className="text-xs font-semibold text-gray-700 mb-2">Coverage by month</h4>
          {!coverageReport ? (
            <InlineLoadingSkeleton />
          ) : months.length === 0 ? (
            <div className="text-xs text-gray-500">No coverage data yet.</div>
          ) : (
            <>
              <div className="flex items-end gap-0.5 overflow-x-auto pb-2" data-testid="chart-coverage-by-month">
                {months.map((m: CoverageMonth) => {
                  const total = m.totalCoverage ?? 0;
                  const frontSync = m.frontSyncCount ?? 0;
                  const rawComm = m.rawCommCount ?? 0;
                  const pipeline = m.pipelineEventCount ?? 0;
                  const heightPct = Math.max(4, Math.round((total / maxCov) * 100));
                  const isGap = (coverageReport.gaps ?? []).some((g: RecoveryWindow) => g.label === m.month || (g.label?.includes("–") && g.label.split("–").includes(m.month)));
                  const frontPct = total > 0 ? (frontSync / total) * 100 : 0;
                  const rawPct = total > 0 ? (rawComm / total) * 100 : 0;
                  const pipelinePct = total > 0 ? (pipeline / total) * 100 : 0;
                  return (
                    <div key={m.month} className="flex flex-col items-center" title={`${m.month}: ${total} records (front_sync=${frontSync}, raw_comm=${rawComm}, pipeline=${pipeline})${isGap ? " — gap" : ""}`} data-testid={`bar-coverage-${m.month}`}>
                      <div className={`w-3 bg-gray-100 rounded-t ${isGap ? "ring-1 ring-amber-400" : ""}`} style={{ height: 48 }}>
                        <div className="w-full rounded-t overflow-hidden flex flex-col" style={{ height: `${heightPct}%`, marginTop: `${100 - heightPct}%` }}>
                          {total === 0 ? (
                            <div className={`w-full flex-1 ${isGap ? "bg-amber-400" : "bg-gray-300"}`} />
                          ) : (
                            <>
                              {frontSync > 0 && <div className="w-full bg-emerald-500" style={{ height: `${frontPct}%` }} data-testid={`bar-segment-front-${m.month}`} />}
                              {rawComm > 0 && <div className="w-full bg-sky-500" style={{ height: `${rawPct}%` }} data-testid={`bar-segment-raw-${m.month}`} />}
                              {pipeline > 0 && <div className="w-full bg-violet-500" style={{ height: `${pipelinePct}%` }} data-testid={`bar-segment-pipeline-${m.month}`} />}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-[8px] text-gray-500 mt-0.5 -rotate-45 origin-top-left h-6 w-3">{m.month?.slice(2)}</div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600" data-testid="legend-coverage-by-month">
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-500" />Front sync</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-sky-500" />Raw comms</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-violet-500" />Pipeline events</span>
              </div>
            </>
          )}
          {coverageReport && (
            <div className="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1 mt-1" data-testid="text-coverage-summary">
              <span>Front sync rows: <span className="font-medium text-gray-700">{coverageReport.totalFrontSync}</span></span>
              <span>Raw comms: <span className="font-medium text-gray-700">{coverageReport.totalRawComm}</span></span>
              <span>Pipeline events: <span className="font-medium text-gray-700">{coverageReport.totalPipelineEvents}</span></span>
              {coverageReport.earliestRecord && (
                <span>Earliest: <span className="font-medium text-gray-700">{new Date(coverageReport.earliestRecord).toLocaleDateString()}</span></span>
              )}
              {coverageReport.latestRecord && (
                <span>Latest: <span className="font-medium text-gray-700">{new Date(coverageReport.latestRecord).toLocaleDateString()}</span></span>
              )}
            </div>
          )}
        </div>

        {gapCount > 0 && coverageReport?.gaps && (
          <div className="text-xs text-gray-700 bg-amber-50 border border-amber-200 rounded p-2" data-testid="text-recovery-gap-list">
            <span className="font-medium">Detected gaps:</span> {coverageReport.gaps.map((g: RecoveryWindow) => g.label).join(", ")}
          </div>
        )}
    </>
  );
}
