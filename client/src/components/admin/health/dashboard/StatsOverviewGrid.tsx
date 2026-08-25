// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Core status domain: the 7-tile DB latency / pool-wait / recovery stat grid.
import { Card, CardContent } from "@/components/ui/card";
import type { HealthHistory } from "./types";

export function StatsOverviewGrid({ history }: { history: HealthHistory | undefined }) {
  return (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-4" data-testid="section-stats">
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="text-sm text-muted-foreground">Avg DB round-trip</div>
                  <div className="text-2xl font-bold text-foreground" data-testid="text-avg-latency">
                    {history?.stats?.avgDbLatencyMs ?? "—"}
                    <span className="text-sm font-normal text-muted-foreground ml-1">ms</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="text-sm text-muted-foreground">P95 DB round-trip</div>
                  <div className="text-2xl font-bold text-foreground" data-testid="text-p95-latency">
                    {history?.stats?.p95DbLatencyMs ?? "—"}
                    <span className="text-sm font-normal text-muted-foreground ml-1">ms</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="text-sm text-muted-foreground">P95 API pool wait</div>
                  <div className="text-2xl font-bold text-[#0891b2]" data-testid="text-p95-pool-wait">
                    {history?.stats?.p95ApiPoolWaitMs ?? "—"}
                    <span className="text-sm font-normal text-muted-foreground ml-1">ms</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="text-sm text-muted-foreground">Transient recoveries</div>
                  <div className="text-2xl font-bold" data-testid="text-transient-recoveries">
                    <span className={
                      (history?.stats?.transientDbRecoveriesTotal ?? 0) > 0
                        ? "text-amber-600"
                        : "text-green-600"
                    }>
                      {history?.stats?.transientDbRecoveriesTotal ?? 0}
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card
                title="Proactive DB-connection recycles performed by the Task #815 lifetime policy. Counts connections retired before they hit the host's max age, totalled across in-memory samples since the current process started."
              >
                <CardContent className="pt-4 pb-4">
                  <div className="text-sm text-muted-foreground">Connection recycles</div>
                  <div className="text-2xl font-bold" data-testid="text-connection-recycles">
                    <span className={
                      (history?.stats?.connectionRecyclesTotal ?? 0) > 0
                        ? "text-foreground"
                        : "text-muted-foreground"
                    }>
                      {history?.stats?.connectionRecyclesTotal ?? 0}
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="text-sm text-muted-foreground">DB Failures</div>
                  <div className="text-2xl font-bold" data-testid="text-failure-count">
                    <span className={history?.stats?.dbFailureCount ? "text-red-600" : "text-green-600"}>
                      {history?.stats?.dbFailureCount ?? 0}
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="text-sm text-muted-foreground">Samples</div>
                  <div className="text-2xl font-bold text-foreground" data-testid="text-sample-count">
                    {history?.sampleCount ?? 0}
                  </div>
                </CardContent>
              </Card>
            </div>
  );
}
