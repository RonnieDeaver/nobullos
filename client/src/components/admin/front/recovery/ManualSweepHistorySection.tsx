// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import type { IntegrationStatus, RecoveryManualSweepHistoryResponse } from "./types";
import { CopyIdButton } from "./shared";

type Props = {
  isAdmin: boolean;
  status: IntegrationStatus | undefined;
};

export function ManualSweepHistorySection({ isAdmin, status }: Props) {
  const isTabVisible = useTabVisibility();
  const { user } = useAuth();

  const [expandedManualSweepIds, setExpandedManualSweepIds] = useState<Record<string, boolean>>({});


  const [recoveryManualSweepOnlyFailed, setRecoveryManualSweepOnlyFailed] = useState(false);

  const { data: recoveryManualSweepHistory } = useQuery<RecoveryManualSweepHistoryResponse>({
    queryKey: [
      "/api/integrations/front/historical-recovery/manual-sweep-history",
      { onlyFailed: recoveryManualSweepOnlyFailed },
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (recoveryManualSweepOnlyFailed) params.set("onlyFailed", "true");
      const qs = params.toString();
      const url = `/api/integrations/front/historical-recovery/manual-sweep-history${qs ? `?${qs}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load manual sweep history (${res.status})`);
      return res.json();
    },
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: isTabVisible ? 60_000 : false,
    refetchIntervalInBackground: false,
  });

  return (
    <>
            {recoveryManualSweepHistory && (recoveryManualSweepHistory.entries.length > 0 || recoveryManualSweepOnlyFailed) && (
              <div
                className="pt-1"
                data-testid="section-recovery-manual-sweep-history"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="text-xs font-semibold text-foreground">
                    Recent manual sweep runs
                  </div>
                  <label
                    className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none"
                    data-testid="label-recovery-manual-sweep-only-failed"
                  >
                    <input
                      type="checkbox"
                      className="h-3 w-3"
                      checked={recoveryManualSweepOnlyFailed}
                      onChange={(e) => setRecoveryManualSweepOnlyFailed(e.target.checked)}
                      data-testid="toggle-recovery-manual-sweep-only-failed"
                    />
                    Only failed
                  </label>
                </div>
                {recoveryManualSweepHistory.entries.length === 0 && (
                  <div
                    className="text-xs text-muted-foreground italic px-1 py-0.5"
                    data-testid="text-recovery-manual-sweep-empty"
                  >
                    No failed manual sweep runs in recent history.
                  </div>
                )}
                <ul className="space-y-0.5">
                  {recoveryManualSweepHistory.entries.map((entry) => {
                    const isExpanded = !!expandedManualSweepIds[entry.id];
                    let metadataPretty = "";
                    try {
                      metadataPretty = entry.metadata == null
                        ? ""
                        : JSON.stringify(entry.metadata, null, 2);
                    } catch {
                      metadataPretty = String(entry.metadata);
                    }
                    return (
                      <li
                        key={entry.id}
                        className="text-xs text-muted-foreground"
                        data-testid={`row-recovery-manual-sweep-${entry.id}`}
                      >
                        <button
                          type="button"
                          className="w-full text-left flex items-start gap-1 hover:bg-muted/50 rounded px-1 py-0.5 -mx-1"
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? "Hide audit log details" : "Show audit log details"}
                          data-testid={`button-recovery-manual-sweep-toggle-${entry.id}`}
                          onClick={() =>
                            setExpandedManualSweepIds((prev) => ({
                              ...prev,
                              [entry.id]: !prev[entry.id],
                            }))
                          }
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" />
                          )}
                          <span className="flex-1">
                            <span data-testid={`text-recovery-manual-sweep-user-${entry.id}`}>
                              {entry.userName || entry.userId || "Unknown user"}
                            </span>
                            {" — "}
                            <span data-testid={`text-recovery-manual-sweep-time-${entry.id}`}>
                              {new Date(entry.timestamp).toLocaleString()}
                            </span>
                            {" — "}
                            <span data-testid={`text-recovery-manual-sweep-pruned-${entry.id}`}>
                              {entry.prunedCount == null
                                ? "pruned ?"
                                : `pruned ${entry.prunedCount}`}
                            </span>
                            {entry.lastError && (
                              <span className="text-red-600"> ({entry.lastError})</span>
                            )}
                          </span>
                        </button>
                        {isExpanded && (
                          <div
                            className="mt-1 ml-4 mb-1 border rounded bg-card px-2 py-1.5 space-y-1 text-xs text-foreground"
                            data-testid={`details-recovery-manual-sweep-${entry.id}`}
                          >
                            <div>
                              <span className="font-semibold text-foreground">Audit log id:</span>{" "}
                              <span
                                className="font-mono text-muted-foreground break-all"
                                data-testid={`text-recovery-manual-sweep-id-${entry.id}`}
                              >
                                {entry.id}
                              </span>
                              <CopyIdButton
                                value={entry.id}
                                label="audit log id"
                                testId={`button-copy-recovery-manual-sweep-id-${entry.id}`}
                              />
                            </div>
                            <div>
                              <span className="font-semibold text-foreground">Route:</span>{" "}
                              <span
                                className="font-mono text-muted-foreground break-all"
                                data-testid={`text-recovery-manual-sweep-route-${entry.id}`}
                              >
                                {entry.route ?? "—"}
                              </span>
                            </div>
                            <div>
                              <span className="font-semibold text-foreground">Session id:</span>{" "}
                              <span
                                className="font-mono text-muted-foreground break-all"
                                data-testid={`text-recovery-manual-sweep-session-${entry.id}`}
                              >
                                {entry.sessionId ?? "—"}
                              </span>
                              {entry.sessionId && (
                                <CopyIdButton
                                  value={entry.sessionId}
                                  label="session id"
                                  testId={`button-copy-recovery-manual-sweep-session-${entry.id}`}
                                />
                              )}
                            </div>
                            {entry.actionDetail && (
                              <div>
                                <span className="font-semibold text-foreground">Detail:</span>{" "}
                                <span
                                  className="text-muted-foreground"
                                  data-testid={`text-recovery-manual-sweep-detail-${entry.id}`}
                                >
                                  {entry.actionDetail}
                                </span>
                              </div>
                            )}
                            {entry.lastError && (
                              <div>
                                <span className="font-semibold text-red-700">Error:</span>{" "}
                                <span
                                  className="text-red-700 whitespace-pre-wrap break-words"
                                  data-testid={`text-recovery-manual-sweep-error-${entry.id}`}
                                >
                                  {entry.lastError}
                                </span>
                              </div>
                            )}
                            <div>
                              <div className="font-semibold text-foreground mb-0.5">Metadata:</div>
                              <pre
                                className="bg-muted/50 border rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-words text-[10.5px] text-foreground max-h-60"
                                data-testid={`text-recovery-manual-sweep-metadata-${entry.id}`}
                              >
                                {metadataPretty || "—"}
                              </pre>
                            </div>
                            <div className="pt-0.5">
                              <a
                                href={`/admin/activity?compare=${encodeURIComponent(entry.id)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                                data-testid={`link-recovery-manual-sweep-activity-${entry.id}`}
                              >
                                Open in Activity Dashboard ↗
                              </a>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
    </>
  );
}
