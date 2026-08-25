import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, UserCheck } from "lucide-react";
import { format } from "date-fns";

interface HealAttempt {
  sub: string;
  outcome: string;
  error?: string;
}

interface OrphanedUserHealLastRun {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  maxPerTick: number;
  candidates: number;
  attempted: HealAttempt[];
  healed: number;
  errors: number;
  reason?: string;
}

interface OrphanedUserHealConfig {
  enabled: boolean;
  maxPerTick: number;
  tickIntervalMinutes: number;
}

interface OrphanedUserHealStatus {
  config: OrphanedUserHealConfig;
  caps?: { maxPerTick: number };
  lastRun: OrphanedUserHealLastRun | null;
  lastRunStatus: "ok" | "never_run" | "unreadable";
  lastRunError?: string;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return format(new Date(value), "yyyy-MM-dd HH:mm");
  } catch {
    return value;
  }
}

export function OrphanedUserHealSection({ enabled = true }: { enabled?: boolean }) {
  const { data, isLoading, isFetching, refetch, error } =
    useQuery<OrphanedUserHealStatus>({
      queryKey: ["/api/admin/orphaned-user-heal/status"],
      queryFn: async () => {
        const res = await apiRequest(
          "GET",
          "/api/admin/orphaned-user-heal/status",
        );
        return res.json();
      },
      enabled,
    });

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center py-12 text-muted-foreground"
        data-testid="status-orphan-heal-loading"
      >
        <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading account-heal
        status…
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent
          className="py-6 text-red-700"
          data-testid="status-orphan-heal-error"
        >
          Could not load the account-heal status. Please try again.
        </CardContent>
      </Card>
    );
  }

  const { config, lastRun, lastRunStatus, lastRunError } = data;

  return (
    <Card data-testid="card-orphan-heal-status">
      <CardContent className="py-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-foreground" />
            <h2
              className="text-sm font-semibold"
              data-testid="text-orphan-heal-title"
            >
              Account auto-heal sweep
            </h2>
            <Badge
              variant="outline"
              className={
                config.enabled
                  ? "bg-green-100 text-green-800 border-green-200"
                  : "bg-gray-100 text-gray-700 border-gray-200"
              }
              data-testid="badge-orphan-heal-enabled"
            >
              {config.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-orphan-heal-refresh"
          >
            {isFetching ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>

        <p
          className="text-xs text-muted-foreground"
          data-testid="text-orphan-heal-config"
        >
          Re-creates the account row for logged-in users still missing one.
          Runs every {config.tickIntervalMinutes} min · up to{" "}
          {config.maxPerTick} per run.
        </p>

        {lastRunStatus === "unreadable" ? (
          <p
            className="text-xs text-red-700"
            data-testid="text-orphan-heal-unreadable"
          >
            The last run could not be read:{" "}
            {lastRunError || "the stored value was not readable."}
          </p>
        ) : lastRun ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span data-testid="text-orphan-heal-last-ran">
                Last run: {fmtDate(lastRun.ranAt)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700">
              <span data-testid="text-orphan-heal-candidates">
                {lastRun.candidates} candidate(s)
              </span>
              <span
                className="text-green-700"
                data-testid="text-orphan-heal-healed"
              >
                {lastRun.healed} healed
              </span>
              <span className="text-red-700" data-testid="text-orphan-heal-errors">
                {lastRun.errors} errors
              </span>
            </div>
            {lastRun.reason && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="text-orphan-heal-reason"
              >
                {lastRun.reason}
              </p>
            )}
          </div>
        ) : (
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-orphan-heal-never-run"
          >
            Has not run yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
