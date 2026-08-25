import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";

interface FlushStatus {
  pendingCount: number;
  lastFlushedTimestamp: number | null;
}

interface MetricsFlushSectionProps {
  enabled?: boolean;
}

export function MetricsFlushSection({ enabled = true }: MetricsFlushSectionProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isTabVisible = useTabVisibility();

  const { data: flushStatus } = useQuery<FlushStatus>({
    queryKey: ["/api/health/flush-status"],
    enabled,
    refetchInterval: isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const flushMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/health/flush", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Flush request failed" }));
        throw new Error(body.error || `Flush failed with status ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      const count = typeof data?.flushedCount === "number" ? data.flushedCount : 0;
      void queryClient.invalidateQueries({ queryKey: ["/api/health/flush-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      if (count > 0) {
        toast({
          title: `Flushed ${count} sample${count === 1 ? "" : "s"}`,
          description:
            data?.message ||
            `${count} pending health sample${count === 1 ? " has" : "s have"} been written to the database.`,
        });
      } else {
        toast({
          title: "No pending samples",
          description: data?.message || "Health metrics are already up to date — nothing to flush.",
        });
      }
    },
    onError: (err: any) => {
      toast({ title: "Flush failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card className="bg-card" data-testid="card-health-metrics-flush">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-5 h-5 text-green-600" />
          Metrics Flush
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground min-w-0">
            Health samples are flushed to the database every 5 minutes. Use this button to trigger an immediate flush.
          </div>
          <div className="flex flex-wrap items-center gap-3 min-w-0 sm:shrink-0">
            <div className="text-right text-xs text-muted-foreground leading-tight">
              <div data-testid="text-flush-pending-count">
                <span className="font-medium text-foreground">
                  {flushStatus ? flushStatus.pendingCount : "—"}
                </span>{" "}
                pending sample{flushStatus?.pendingCount === 1 ? "" : "s"}
              </div>
              <div className="text-muted-foreground" data-testid="text-flush-last-time">
                Last flush:{" "}
                {flushStatus?.lastFlushedTimestamp
                  ? new Date(flushStatus.lastFlushedTimestamp).toLocaleString()
                  : "never"}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-flush-health-metrics"
              disabled={flushMutation.isPending}
              onClick={() => flushMutation.mutate()}
            >
              {flushMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Download className="w-4 h-4 mr-1.5" />
              )}
              Flush Now
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default MetricsFlushSection;
