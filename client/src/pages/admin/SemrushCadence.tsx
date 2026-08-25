import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/admin/PageHeader";

interface CadenceTrendsResponse {
  generatedAt: string;
  settings: {
    demandDrivenEnabled: boolean;
    autoRetryBackoffEnabled: boolean;
    identicalResultSuppressionEnabled: boolean;
    intervalMs: number;
    stalenessThresholdHours: number;
    activeWindowDays: number;
    killSwitches: Record<string, boolean>;
  };
  dailyRollup: Array<{
    date: string;
    queue_name: string;
    reason: string;
    count: number;
    client_count: number;
    campaign_count: number;
  }>;
  todayByReason: Array<{ reason: string; count: number }>;
  hashCoverage: {
    total_keys: number;
    distinct_campaigns: number;
    distinct_locations: number;
    most_recent_apply: string | null;
  } | null;
  activeClients: { active: number; total: number; windowDays: number };
  deadLetters: Array<{ queue_name: string; dead_letters: number; failed: number }>;
  queuePauseState: Array<{ queue_name: string; paused: boolean }>;
  retryBackoff: { waiting: number; next_due_at: string | null; due_now: number };
  permanentErrors: {
    total: number;
    mostRecent: string | null;
    byCategory: Array<{ category: string; count: number }>;
  };
  lastRuns: Array<{ queue_name: string; last_completed_at: string | null; completed_24h: number }>;
}

export default function SemrushCadence() {
  const { data, isLoading, error } = useQuery<CadenceTrendsResponse>({
    queryKey: ["/api/admin/semrush/cadence"],
    refetchInterval: 60_000,
  });

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-semrush-cadence">
      <PageHeader
        title="SEMrush Demand-Driven Cadence"
        backHref="/admin/integrations/semrush"
        subtitle="Task #1785 — staleness + active-client gating with identical-result apply suppression."
      />

      {isLoading && <div data-testid="status-loading">Loading…</div>}
      {error && (
        <div className="text-destructive" data-testid="status-error">
          {(error as Error).message}
        </div>
      )}

      {data && (
        <>
          <Card data-testid="card-settings">
            <CardHeader>
              <CardTitle>Live settings</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div data-testid="text-setting-demand-driven">
                <div className="text-muted-foreground">Demand-driven</div>
                <Badge variant={data.settings.demandDrivenEnabled ? "default" : "destructive"}>
                  {data.settings.demandDrivenEnabled ? "ON" : "OFF"}
                </Badge>
              </div>
              <div data-testid="text-setting-auto-retry">
                <div className="text-muted-foreground">Auto-retry backoff</div>
                <Badge variant={data.settings.autoRetryBackoffEnabled ? "default" : "destructive"}>
                  {data.settings.autoRetryBackoffEnabled ? "ON" : "OFF"}
                </Badge>
              </div>
              <div data-testid="text-setting-identical">
                <div className="text-muted-foreground">Identical-result suppression</div>
                <Badge
                  variant={
                    data.settings.identicalResultSuppressionEnabled ? "default" : "destructive"
                  }
                >
                  {data.settings.identicalResultSuppressionEnabled ? "ON" : "OFF"}
                </Badge>
              </div>
              <div data-testid="text-setting-interval">
                <div className="text-muted-foreground">Refresh interval</div>
                <div className="font-medium">
                  {(data.settings.intervalMs / 60_000).toFixed(0)} min
                </div>
              </div>
              <div data-testid="text-setting-staleness">
                <div className="text-muted-foreground">Staleness threshold</div>
                <div className="font-medium">{data.settings.stalenessThresholdHours} h</div>
              </div>
              <div data-testid="text-setting-active-window">
                <div className="text-muted-foreground">Active-client window</div>
                <div className="font-medium">{data.settings.activeWindowDays} days</div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-queue-pause">
            <CardHeader>
              <CardTitle>Queue pause state</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              {data.queuePauseState.map((q) => (
                <div key={q.queue_name} data-testid={`row-pause-${q.queue_name}`}>
                  <div className="font-mono text-xs text-muted-foreground">{q.queue_name}</div>
                  <Badge variant={q.paused ? "destructive" : "default"}>
                    {q.paused ? "PAUSED" : "RUNNING"}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card data-testid="card-retry-backoff">
            <CardHeader>
              <CardTitle>Retry-backoff queue</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-4 text-sm">
              <div data-testid="text-retry-waiting">
                <div className="text-muted-foreground">Waiting in backoff</div>
                <div className="text-2xl font-bold">{data.retryBackoff.waiting}</div>
              </div>
              <div data-testid="text-retry-due-now">
                <div className="text-muted-foreground">Due now</div>
                <div className="text-2xl font-bold">{data.retryBackoff.due_now}</div>
              </div>
              <div data-testid="text-retry-next-due">
                <div className="text-muted-foreground">Next due at</div>
                <div className="text-sm">
                  {data.retryBackoff.next_due_at
                    ? new Date(data.retryBackoff.next_due_at).toLocaleString()
                    : "—"}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-permanent-errors">
            <CardHeader>
              <CardTitle>Permanent-error triage</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <div className="text-muted-foreground">Locations with terminal/dead-letter</div>
                <div className="text-2xl font-bold" data-testid="text-permanent-total">
                  {data.permanentErrors.total}
                </div>
                {data.permanentErrors.mostRecent && (
                  <div className="text-xs text-muted-foreground">
                    Most recent {new Date(data.permanentErrors.mostRecent).toLocaleString()}
                  </div>
                )}
              </div>
              {data.permanentErrors.byCategory.length > 0 && (
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1">Category</th>
                      <th className="py-1 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.permanentErrors.byCategory.map((c) => (
                      <tr key={c.category} data-testid={`row-terminal-${c.category}`}>
                        <td className="py-1 font-mono">{c.category || "(unknown)"}</td>
                        <td className="py-1 text-right">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-last-runs">
            <CardHeader>
              <CardTitle>Recent activity (24h)</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1">Queue</th>
                    <th className="py-1 text-right">Completed 24h</th>
                    <th className="py-1 text-right">Last completed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lastRuns.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-2 text-muted-foreground">
                        No completed runs in window.
                      </td>
                    </tr>
                  ) : (
                    data.lastRuns.map((r) => (
                      <tr key={r.queue_name} data-testid={`row-lastrun-${r.queue_name}`}>
                        <td className="py-1 font-mono">{r.queue_name}</td>
                        <td className="py-1 text-right">{r.completed_24h}</td>
                        <td className="py-1 text-right">
                          {r.last_completed_at
                            ? new Date(r.last_completed_at).toLocaleString()
                            : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card data-testid="card-active-clients">
            <CardHeader>
              <CardTitle>Active clients</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-active-count">
                {data.activeClients.active}
                <span className="text-base font-normal text-muted-foreground">
                  {" "}
                  / {data.activeClients.total}
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                Viewed within the last {data.activeClients.windowDays} days
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-today-by-reason">
            <CardHeader>
              <CardTitle>Today — decisions by reason</CardTitle>
            </CardHeader>
            <CardContent>
              {data.todayByReason.length === 0 ? (
                <div className="text-sm text-muted-foreground" data-testid="text-no-decisions-today">
                  No cadence decisions recorded yet today.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1">Reason</th>
                      <th className="py-1 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.todayByReason.map((r) => (
                      <tr key={r.reason} data-testid={`row-reason-${r.reason}`}>
                        <td className="py-1 font-mono">{r.reason}</td>
                        <td className="py-1 text-right">{r.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-hash-coverage">
            <CardHeader>
              <CardTitle>Identical-result hash coverage</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div data-testid="text-hash-total-keys">
                <div className="text-muted-foreground">Total keys</div>
                <div className="text-xl font-bold">{data.hashCoverage?.total_keys ?? 0}</div>
              </div>
              <div data-testid="text-hash-campaigns">
                <div className="text-muted-foreground">Campaigns</div>
                <div className="text-xl font-bold">
                  {data.hashCoverage?.distinct_campaigns ?? 0}
                </div>
              </div>
              <div data-testid="text-hash-locations">
                <div className="text-muted-foreground">Locations</div>
                <div className="text-xl font-bold">
                  {data.hashCoverage?.distinct_locations ?? 0}
                </div>
              </div>
              <div data-testid="text-hash-recent">
                <div className="text-muted-foreground">Most recent apply</div>
                <div className="text-sm">
                  {data.hashCoverage?.most_recent_apply
                    ? new Date(data.hashCoverage.most_recent_apply).toLocaleString()
                    : "—"}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-dead-letters">
            <CardHeader>
              <CardTitle>SEMrush queue health (7d)</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1">Queue</th>
                    <th className="py-1 text-right">Failed</th>
                    <th className="py-1 text-right">Dead-letters</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deadLetters.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-2 text-muted-foreground">
                        No failures or dead-letters in the last 7 days.
                      </td>
                    </tr>
                  ) : (
                    data.deadLetters.map((q) => (
                      <tr key={q.queue_name} data-testid={`row-queue-${q.queue_name}`}>
                        <td className="py-1 font-mono">{q.queue_name}</td>
                        <td className="py-1 text-right">{q.failed}</td>
                        <td className="py-1 text-right">{q.dead_letters}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card data-testid="card-daily-rollup">
            <CardHeader>
              <CardTitle>Daily decision rollup (last 7d)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1">Date</th>
                      <th className="py-1">Queue</th>
                      <th className="py-1">Reason</th>
                      <th className="py-1 text-right">Count</th>
                      <th className="py-1 text-right">Clients</th>
                      <th className="py-1 text-right">Campaigns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.dailyRollup.map((r, i) => (
                      <tr key={i} data-testid={`row-rollup-${r.date}-${r.queue_name}-${r.reason}`}>
                        <td className="py-1">{r.date}</td>
                        <td className="py-1 font-mono">{r.queue_name}</td>
                        <td className="py-1 font-mono">{r.reason}</td>
                        <td className="py-1 text-right">{r.count}</td>
                        <td className="py-1 text-right">{r.client_count}</td>
                        <td className="py-1 text-right">{r.campaign_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="text-xs text-muted-foreground" data-testid="text-generated-at">
            Generated {new Date(data.generatedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
