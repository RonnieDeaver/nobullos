// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Sampler-runtime health domain: supervised sampler loop status table.
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, RefreshCw } from "lucide-react";

  type SamplerRuntime = {
    name: string;
    intervalMs: number;
    running: boolean;
    startedAt: number | null;
    lastTickSucceededAt: number | null;
    lastTickFailedAt: number | null;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    lastSkipReason: "previous_tick_still_running" | null;
    lastSkippedAt: number | null;
    totalSkips: number;
    tickTimedOutPending: boolean;
    totalSuccesses: number;
    totalFailures: number;
    healthy: boolean;
    unhealthyReason: string | null;
    lastFreshnessAt: number | null;
    maxStalenessMs: number;
    hasFreshnessProbe: boolean;
    lastErrorSummary: string | null;
    // Task #992 heartbeat / hysteresis / recovery
    tickTimeoutMs: number;
    consecutiveMisses: number;
    consecutiveHealthy: number;
    recoveryAttempts: number;
    lastRecoveryAt: number | null;
    inFlight: boolean;
  };

// Called unconditionally by HealthDashboardSection in the same
// hook-sequence position as the original inline block (F11D).
export function useSamplersDomain({
  isAdmin,
  isTabVisible,
  pollingInterval,
}: {
  isAdmin: boolean;
  isTabVisible: boolean;
  pollingInterval: number;
}) {
  const { data: samplersData, refetch: refetchSamplers, isLoading: samplersLoading, error: samplersError } = useQuery<{
    now: number;
    samplers: SamplerRuntime[];
  }>({
    queryKey: ["/api/health/samplers"],
    refetchInterval: isTabVisible ? pollingInterval : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });

  return {
    samplersData,
    refetchSamplers,
    samplersLoading,
    samplersError,
  };
}

export type SamplersDomain = ReturnType<typeof useSamplersDomain>;

export function SamplerRuntimeCard({ domain }: { domain: SamplersDomain }) {
  const {
    samplersData,
    refetchSamplers,
    samplersLoading,
    samplersError,
  } = domain;
  return (
            <Card data-testid="card-sampler-runtime">
              <CardHeader>
                <CardTitle className="text-foreground">Sampler Runtime</CardTitle>
                <CardDescription>
                  Supervised sampler loops: running state, last success/failure, consecutive failures,
                  and watchdog health.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {samplersError ? (
                  <div className="text-sm text-red-600" data-testid="text-samplers-error">
                    Failed to load samplers: {(samplersError as Error).message}
                  </div>
                ) : samplersLoading && !samplersData ? (
                  <div className="text-sm text-muted-foreground" data-testid="text-samplers-loading">
                    Loading samplers…
                  </div>
                ) : !samplersData || samplersData.samplers.length === 0 ? (
                  <div className="text-sm text-muted-foreground" data-testid="text-no-samplers">
                    No supervised samplers registered.
                  </div>
                ) : (
                  <div className="border rounded-md overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-2 py-1">Sampler</th>
                          <th className="text-left px-2 py-1">Running</th>
                          <th className="text-left px-2 py-1">Last success</th>
                          <th className="text-right px-2 py-1">Heartbeat age</th>
                          <th className="text-left px-2 py-1">Last failure</th>
                          <th className="text-right px-2 py-1">Consec. fails</th>
                          <th className="text-right px-2 py-1">Misses</th>
                          <th className="text-right px-2 py-1">Recovery</th>
                          <th className="text-left px-2 py-1">Health</th>
                        </tr>
                      </thead>
                      <tbody>
                        {samplersData.samplers.map((s) => {
                          const fmt = (t: number | null) =>
                            t ? new Date(t).toLocaleTimeString() : "—";
                          const fmtAge = (t: number | null) => {
                            if (!t || !samplersData.now) return "—";
                            const sec = Math.max(0, Math.round((samplersData.now - t) / 1000));
                            if (sec < 60) return `${sec}s`;
                            if (sec < 3600) return `${Math.round(sec / 60)}m`;
                            return `${Math.round(sec / 3600)}h`;
                          };
                          const unhealthy = !s.healthy;
                          const ageStale =
                            !!s.lastTickSucceededAt &&
                            samplersData.now - s.lastTickSucceededAt > s.maxStalenessMs;
                          return (
                            <tr key={s.name} className="border-t" data-testid={`row-sampler-${s.name}`}>
                              <td className="px-2 py-1 font-mono" data-testid={`text-sampler-name-${s.name}`}>
                                {s.name}
                              </td>
                              <td className="px-2 py-1">
                                <Badge
                                  className={
                                    s.running ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
                                  }
                                  data-testid={`badge-sampler-running-${s.name}`}
                                >
                                  {s.running ? "running" : "stopped"}
                                </Badge>
                              </td>
                              <td
                                className="px-2 py-1 text-muted-foreground"
                                title={s.lastTickSucceededAt ? new Date(s.lastTickSucceededAt).toLocaleString() : ""}
                                data-testid={`text-sampler-last-success-${s.name}`}
                              >
                                {fmt(s.lastTickSucceededAt)}
                              </td>
                              <td
                                className={`px-2 py-1 text-right ${ageStale ? "text-red-700 font-semibold" : "text-muted-foreground"}`}
                                title={`Heartbeat threshold: ${Math.round(s.maxStalenessMs / 1000)}s · interval ${Math.round(s.intervalMs / 1000)}s · tickTimeout ${Math.round(s.tickTimeoutMs / 1000)}s`}
                                data-testid={`text-sampler-heartbeat-age-${s.name}`}
                              >
                                {fmtAge(s.lastTickSucceededAt)}
                              </td>
                              <td
                                className="px-2 py-1 text-muted-foreground"
                                title={
                                  s.lastTickFailedAt
                                    ? `${new Date(s.lastTickFailedAt).toLocaleString()}${
                                        s.lastErrorSummary ? ` — ${s.lastErrorSummary}` : ""
                                      }`
                                    : s.lastErrorSummary ?? ""
                                }
                                data-testid={`text-sampler-last-failure-${s.name}`}
                              >
                                {fmt(s.lastTickFailedAt)}
                              </td>
                              <td
                                className={`px-2 py-1 text-right ${s.consecutiveFailures > 0 ? "text-red-700 font-semibold" : ""}`}
                                data-testid={`text-sampler-consec-${s.name}`}
                              >
                                {s.consecutiveFailures}
                              </td>
                              <td
                                className={`px-2 py-1 text-right ${s.consecutiveMisses > 0 ? "text-amber-700 font-semibold" : "text-muted-foreground"}`}
                                title={`Consecutive missed heartbeats. Opens an incident at 3.${s.inFlight ? " · tick in flight" : ""}`}
                                data-testid={`text-sampler-misses-${s.name}`}
                              >
                                {s.consecutiveMisses}
                              </td>
                              <td
                                className={`px-2 py-1 text-right ${s.recoveryAttempts > 0 ? "text-amber-700" : "text-muted-foreground"}`}
                                title={
                                  s.lastRecoveryAt
                                    ? `Last in-process recovery: ${new Date(s.lastRecoveryAt).toLocaleString()}`
                                    : "No recovery attempted"
                                }
                                data-testid={`text-sampler-recovery-${s.name}`}
                              >
                                {s.recoveryAttempts}
                              </td>
                              <td className="px-2 py-1">
                                {unhealthy ? (
                                  <span
                                    className="inline-flex items-center gap-1 text-red-700"
                                    title={s.unhealthyReason ?? undefined}
                                    data-testid={`text-sampler-unhealthy-${s.name}`}
                                  >
                                    <AlertTriangle className="w-3 h-3" />
                                    {s.unhealthyReason ?? "stalled"}
                                  </span>
                                ) : s.tickTimedOutPending ? (
                                  <span
                                    className="inline-flex items-center gap-1 text-amber-700"
                                    title="A tick exceeded its timeout and is still running. The next interval fires will be skipped until it settles."
                                    data-testid={`text-sampler-timeout-pending-${s.name}`}
                                  >
                                    <AlertTriangle className="w-3 h-3" />
                                    tick pending after timeout
                                  </span>
                                ) : s.lastSkipReason ? (
                                  <span
                                    className="inline-flex items-center gap-1 text-amber-700"
                                    title={`Most recent fire was skipped (${s.lastSkipReason}). Total skips: ${s.totalSkips}.`}
                                    data-testid={`text-sampler-skipping-${s.name}`}
                                  >
                                    <AlertTriangle className="w-3 h-3" />
                                    skipping ({s.lastSkipReason})
                                  </span>
                                ) : (
                                  <span
                                    className="inline-flex items-center gap-1 text-green-700"
                                    data-testid={`text-sampler-healthy-${s.name}`}
                                  >
                                    <CheckCircle className="w-3 h-3" />
                                    healthy
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="text-right mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchSamplers()}
                    data-testid="button-refresh-samplers"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />
                    Refresh
                  </Button>
                </div>
              </CardContent>
            </Card>
  );
}
