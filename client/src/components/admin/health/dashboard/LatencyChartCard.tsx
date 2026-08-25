// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Core status domain: DB round-trip vs API pool wait latency chart card.
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Database } from "lucide-react";
import type { HealthHistory, ThresholdConfig } from "./types";
import { LatencyChart } from "./charts";

export function LatencyChartCard({
  history,
  thresholds,
  windowMs,
}: {
  history: HealthHistory | undefined;
  thresholds: ThresholdConfig | undefined;
  windowMs: number;
}) {
  return (
            <Card data-testid="card-latency-chart">
              <CardHeader>
                <CardTitle className="text-foreground flex items-center gap-2">
                  <Database className="w-5 h-5" />
                  DB round-trip vs API pool wait
                </CardTitle>
                <CardDescription>
                  {history?.oldestSample && history?.newestSample
                    ? `${new Date(history.oldestSample).toLocaleString()} — ${new Date(history.newestSample).toLocaleString()}`
                    : "Collecting samples..."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LatencyChart
                  samples={history?.samples ?? []}
                  thresholds={thresholds ?? null}
                  windowMs={windowMs}
                />
              </CardContent>
            </Card>
  );
}
