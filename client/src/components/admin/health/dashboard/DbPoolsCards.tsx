// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// DB-pool health domain: live hold attribution, attribution quality,
// kill switches, and background concurrency.
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

// Called unconditionally by HealthDashboardSection in the same
// hook-sequence position as the original inline block (F11D).
export function useDbPoolsDomain({
  isAdmin,
  isTabVisible,
  pollingInterval,
}: {
  isAdmin: boolean;
  isTabVisible: boolean;
  pollingInterval: number;
}) {
  const { toast } = useToast();

  // Task #836 Phase 8: live DB hold attribution + kill switch panel.
  const { data: dbAttribution, refetch: refetchDbAttribution } = useQuery<{
    api: {
      topByCount: Array<{ label: string; count: number; totalMs: number; avgMs: number; maxMs: number }>;
      unknownCount: number;
      unknownPct: number;
      fallbackLabelCount: number;
      poolSnapshot: { active: number; idle: number; total: number; max: number; waiting: number; utilizationPct: number };
    };
    worker: {
      topByCount: Array<{ label: string; count: number; totalMs: number; avgMs: number; maxMs: number }>;
      unknownCount: number;
      unknownPct: number;
      poolSnapshot: { active: number; idle: number; total: number; max: number; waiting: number; utilizationPct: number };
    };
    pressure: { underPressure: boolean; reasons: string[] };
    concurrency: {
      totalActive: number;
      totalBudget: number;
      byClass: Array<{ workloadClass: string; activeCount: number; maxConcurrency: number; activeWorkers: string[] }>;
    };
    killSwitches: Record<string, boolean>;
  attributionQuality?: {
    api: { totalHolds: number; attributedHolds: number; unknownHolds: number; unknownPct: number; uniqueLabels: number };
    worker: { totalHolds: number; attributedHolds: number; unknownHolds: number; unknownPct: number; uniqueLabels: number };
  };
  }>({
    queryKey: ["/api/health/db-attribution"],
    refetchInterval: isTabVisible ? pollingInterval : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });

  // Task #836 Phase 2 (post-review): runtime kill-switch toggle. Posts
  // {name, value} to /api/health/kill-switches and re-fetches the
  // attribution snapshot so the badge flips immediately.
  const toggleKillSwitchMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: { name: string; value: boolean }) => {
      const res = await apiRequest("POST", "/api/health/kill-switches", payload);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      void refetchDbAttribution();
      toast({
        title: `Kill switch ${vars.value ? "engaged" : "released"}`,
        description: vars.name,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to toggle kill switch", description: err.message, variant: "destructive" });
    },
  });

  return {
    dbAttribution,
    refetchDbAttribution,
    toggleKillSwitchMutation,
  };
}

export type DbPoolsDomain = ReturnType<typeof useDbPoolsDomain>;

export function DbPoolsCards({ domain }: { domain: DbPoolsDomain }) {
  // Task #4357: engaging a kill switch force-stops the guarded subsystem on
  // every instance — that direction gets an AlertDialog confirm. Releasing
  // (restoring normal service) stays one click so incident recovery is fast.
  const [pendingEngage, setPendingEngage] = useState<string | null>(null);
  const {
    dbAttribution,
    refetchDbAttribution,
    toggleKillSwitchMutation,
  } = domain;
  return (
    <>
            {dbAttribution?.attributionQuality && (
              <Card data-testid="card-attribution-quality">
                <CardHeader>
                  <CardTitle className="text-foreground">Attribution Quality</CardTitle>
                  <CardDescription>
                    Share of DB holds attributed to a real label vs. the <code>unknown</code> fallback.
                    A rising unknown share means a code path is checking out connections without an
                    attribution scope and should be tracked down.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {(["api", "worker"] as const).map((poolKey) => {
                      const q = dbAttribution.attributionQuality![poolKey];
                      const top = dbAttribution[poolKey].topByCount.slice(0, 5);
                      const warn = q.unknownPct >= 5;
                      const crit = q.unknownPct >= 15;
                      const badgeClass = crit
                        ? "bg-red-100 text-red-700"
                        : warn
                        ? "bg-amber-100 text-amber-700"
                        : "bg-green-100 text-green-700";
                      return (
                        <div key={poolKey} className="space-y-2" data-testid={`block-attribution-${poolKey}`}>
                          <div className="flex items-center justify-between">
                            <div className="font-semibold text-sm uppercase tracking-wide">
                              {poolKey} pool
                            </div>
                            <Badge className={badgeClass} data-testid={`badge-attribution-${poolKey}`}>
                              {q.unknownPct}% unknown
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground" data-testid={`text-attribution-${poolKey}-totals`}>
                            {q.attributedHolds.toLocaleString()} attributed · {q.unknownHolds.toLocaleString()} unknown ·{" "}
                            {q.totalHolds.toLocaleString()} total · {q.uniqueLabels} labels
                          </div>
                          <div className="text-xs">
                            <div className="font-medium mb-1">Top hold labels</div>
                            {top.length === 0 ? (
                              <div className="text-muted-foreground" data-testid={`text-attribution-${poolKey}-empty`}>
                                No samples yet.
                              </div>
                            ) : (
                              <ul className="space-y-0.5">
                                {top.map((row) => (
                                  <li
                                    key={row.label}
                                    className="flex justify-between gap-2"
                                    data-testid={`row-attribution-${poolKey}-${row.label}`}
                                  >
                                    <span className="font-mono truncate">{row.label}</span>
                                    <span className="text-muted-foreground shrink-0">{row.count}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {dbAttribution && (
              <Card data-testid="card-db-attribution">
                <CardHeader>
                  <CardTitle className="text-foreground">DB Pool Attribution</CardTitle>
                  <CardDescription>
                    Top hold labels per pool (rolling), unknown share, kill switches, and live concurrency.
                    {dbAttribution.pressure.underPressure && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 text-amber-700 font-medium"
                        data-testid="status-pool-pressure"
                      >
                        <AlertTriangle className="w-3 h-3" />
                        Under pressure ({dbAttribution.pressure.reasons.join(", ")})
                      </span>
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {(["api", "worker"] as const).map((poolKey) => {
                      const pool = dbAttribution[poolKey];
                      return (
                        <div key={poolKey} className="space-y-2" data-testid={`block-pool-${poolKey}`}>
                          <div className="flex items-center justify-between">
                            <div className="font-semibold text-sm uppercase tracking-wide" data-testid={`text-pool-${poolKey}`}>
                              {poolKey} pool
                            </div>
                            <div className="text-xs text-muted-foreground" data-testid={`text-pool-${poolKey}-snapshot`}>
                              active {pool.poolSnapshot.active}/{pool.poolSnapshot.max} · waiting {pool.poolSnapshot.waiting} · util {pool.poolSnapshot.utilizationPct}%
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground" data-testid={`text-pool-${poolKey}-unknown`}>
                            Unknown labels: {pool.unknownCount} ({pool.unknownPct}%)
                            {poolKey === "api" && (
                              <span className="ml-2" data-testid="text-api-fallback-label-count">
                                · API fallback labels: {dbAttribution.api.fallbackLabelCount}
                              </span>
                            )}
                          </div>
                          <div className="border rounded-md overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead className="bg-muted/50">
                                <tr>
                                  <th className="text-left px-2 py-1">Label</th>
                                  <th className="text-right px-2 py-1">Count</th>
                                  <th className="text-right px-2 py-1">Total ms</th>
                                  <th className="text-right px-2 py-1">Avg ms</th>
                                  <th className="text-right px-2 py-1">Max ms</th>
                                </tr>
                              </thead>
                              <tbody>
                                {pool.topByCount.length === 0 ? (
                                  <tr>
                                    <td className="px-2 py-2 text-muted-foreground" colSpan={5} data-testid={`row-pool-${poolKey}-empty`}>
                                      No samples yet.
                                    </td>
                                  </tr>
                                ) : (
                                  pool.topByCount.map((row) => (
                                    <tr key={row.label} className="border-t" data-testid={`row-pool-${poolKey}-${row.label}`}>
                                      <td className="px-2 py-1 font-mono">{row.label}</td>
                                      <td className="px-2 py-1 text-right">{row.count}</td>
                                      <td className="px-2 py-1 text-right">{row.totalMs}</td>
                                      <td className="px-2 py-1 text-right">{row.avgMs}</td>
                                      <td className="px-2 py-1 text-right">{row.maxMs}</td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div data-testid="block-kill-switches">
                      <div className="font-semibold text-sm uppercase tracking-wide mb-2">Kill Switches</div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {Object.entries(dbAttribution.killSwitches).map(([k, v]) => (
                          <div key={k} className="flex flex-wrap items-center justify-between gap-1 border rounded px-2 py-1" data-testid={`row-kill-switch-${k}`}>
                            <span className="font-mono break-all min-w-0">{k}</span>
                            <div className="flex items-center gap-2">
                              <Badge className={v ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"} data-testid={`badge-kill-switch-${k}`}>
                                {v ? "ENGAGED" : "off"}
                              </Badge>
                              <Button
                                size="sm"
                                variant={v ? "outline" : "destructive"}
                                disabled={toggleKillSwitchMutation.isPending}
                                onClick={() =>
                                  v
                                    ? toggleKillSwitchMutation.mutate({ name: k, value: false })
                                    : setPendingEngage(k)
                                }
                                data-testid={`button-toggle-kill-switch-${k}`}
                              >
                                {v ? "Release" : "Engage"}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div data-testid="block-bg-concurrency">
                      <div className="font-semibold text-sm uppercase tracking-wide mb-2">
                        Background Concurrency ({dbAttribution.concurrency.totalActive}/{dbAttribution.concurrency.totalBudget})
                      </div>
                      <div className="space-y-1 text-xs">
                        {dbAttribution.concurrency.byClass.map((row) => (
                          <div
                            key={row.workloadClass}
                            className="flex items-center justify-between border rounded px-2 py-1"
                            data-testid={`row-concurrency-${row.workloadClass}`}
                          >
                            <span className="font-mono">{row.workloadClass}</span>
                            <span data-testid={`text-concurrency-${row.workloadClass}-count`}>
                              {row.activeCount}/{row.maxConcurrency}
                              {row.activeWorkers.length > 0 && (
                                <span className="ml-2 text-muted-foreground">({row.activeWorkers.join(", ")})</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refetchDbAttribution()}
                      data-testid="button-refresh-db-attribution"
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Refresh attribution
                    </Button>
                  </div>

                  <AlertDialog
                    open={pendingEngage !== null}
                    onOpenChange={(open) => !open && setPendingEngage(null)}
                  >
                    <AlertDialogContent data-testid="dialog-confirm-engage-kill-switch">
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Engage kill switch {pendingEngage}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          Engaging immediately stops the subsystem this switch
                          guards on every instance and keeps it stopped until an
                          operator releases it. Work routed through it will fail
                          or back up while it is engaged.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel data-testid="button-engage-kill-switch-abort">
                          Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                          data-testid="button-engage-kill-switch-confirm"
                          onClick={() => {
                            const name = pendingEngage;
                            setPendingEngage(null);
                            if (name) toggleKillSwitchMutation.mutate({ name, value: true });
                          }}
                        >
                          Engage
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </CardContent>
              </Card>
            )}
    </>
  );
}
