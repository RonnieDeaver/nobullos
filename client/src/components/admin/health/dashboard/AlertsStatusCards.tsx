// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Core status domain: active-alerts card and the all-clear card.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import type { HealthHistory, ThresholdConfig } from "./types";

export function AlertsStatusCards({
  history,
  thresholds,
}: {
  history: HealthHistory | undefined;
  thresholds: ThresholdConfig | undefined;
}) {
  return (
    <>
            {history?.currentAlerts && history.currentAlerts.length > 0 && (
              <Card className="border-amber-200" data-testid="card-active-alerts">
                <CardHeader>
                  <CardTitle className="text-amber-700 flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" />
                    Active Alerts ({history.currentAlerts.length})
                    {thresholds && history.currentAlerts.some((a) => /(_window(:|$)|^manual_wait_p95_ms$)/.test(a.metric)) && (
                      <Badge
                        variant="outline"
                        className="ml-2 font-normal text-amber-700 border-amber-300"
                        title="Reserve-pressure deltas (timeouts / delayed / saturation / wait p95) are evaluated over this rolling window. Adjust under Threshold Settings → Reserve Pressure Window."
                        data-testid="badge-reserve-pressure-window"
                      >
                        Window: ~{Math.max(1, Math.round((thresholds.manualReserveWindowSamples * 30) / 60))}min ({thresholds.manualReserveWindowSamples} samples)
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {history.currentAlerts.map((alert, i) => (
                      <div
                        key={i}
                        className={`flex items-start gap-3 p-3 rounded-md ${
                          alert.severity === "critical"
                            ? "bg-red-50 border border-red-200"
                            : "bg-amber-50 border border-amber-200"
                        }`}
                        data-testid={`alert-item-${i}`}
                      >
                        {alert.severity === "critical" ? (
                          <XCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                        )}
                        <div>
                          <div className="text-sm font-medium">
                            {alert.message}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {alert.metric} = {alert.value} (threshold: {alert.threshold})
                          </div>
                        </div>
                        <Badge
                          className={`ml-auto shrink-0 ${
                            alert.severity === "critical"
                              ? "bg-red-100 text-red-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                          data-testid={`badge-alert-severity-${i}`}
                        >
                          {alert.severity}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {history && !history.currentAlerts?.length && (
              <Card className="border-green-200" data-testid="card-no-alerts">
                <CardContent className="py-4 flex items-center gap-2 text-green-700">
                  <CheckCircle className="w-5 h-5" />
                  <span className="font-medium">No active alerts — system is healthy</span>
                </CardContent>
              </Card>
            )}
    </>
  );
}
