import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw } from "lucide-react";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { useAuth } from "@/hooks/use-auth";
import type { CanonicalAction, ConsoleOverview } from "./types";
import { relativeTime } from "./utils";
import { JobRow } from "./JobRow";
import { CanonicalActionModal } from "./CanonicalActionModal";
import { LegacyBackfillDisclosure } from "./LegacyBackfillDisclosure";

export function FrontJobsTab() {
  const { user } = useAuth();
  // rematch-all / reprocess-dismissed / full-backfill all post to
  // requireTeamLead server routes; hide the affordances for account
  // managers instead of letting them submit and get a 403.
  const canRunCanonicalActions = user?.role === "ceo" || user?.role === "team_lead";
  const { data, isLoading, isFetching, refetch, error } = useQuery<ConsoleOverview>({
    queryKey: ["/api/integrations/front/console/overview"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/front/console/overview", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Front console overview");
      return res.json();
    },
    refetchInterval: (query) => {
      const overview = query.state.data as ConsoleOverview | undefined;
      const hasLiveRecovery = overview?.jobs?.some(
        (j) => j.type === "historical_recovery" && (j.status === "running" || j.status === "queued"),
      );
      return hasLiveRecovery ? 5_000 : false;
    },
    refetchOnWindowFocus: true,
  });

  const [actionModal, setActionModal] = useState<CanonicalAction | null>(null);
  const jobs = data?.jobs ?? [];

  return (
    <Card data-testid="card-front-jobs">
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
            <Activity className="w-5 h-5 text-blue-600" />
            Jobs & Bulk Actions
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-front-overview"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-gray-500 mt-1" data-testid="text-overview-generated">
          {data?.generatedAt
            ? `Updated ${relativeTime(data.generatedAt)}`
            : isLoading
            ? "Loading…"
            : "—"}
          {" "}· Canonical operator actions are below. Each runs as a tracked job.
        </p>
        {canRunCanonicalActions ? (
          <div className="flex flex-wrap gap-2 mt-3" data-testid="toolbar-canonical-actions">
            <Button size="sm" variant="outline" onClick={() => setActionModal("rematch_all")} data-testid="button-run-rematch-all">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Rematch All
            </Button>
            <Button size="sm" variant="outline" onClick={() => setActionModal("reprocess_dismissed")} data-testid="button-run-reprocess-dismissed">
              <Activity className="w-3.5 h-3.5 mr-1.5" />
              Reprocess Dismissed
            </Button>
          </div>
        ) : (
          <p className="text-xs text-gray-400 mt-3" data-testid="text-canonical-actions-role-note">
            Team lead or CEO role required to run bulk actions.
          </p>
        )}
        {actionModal && (
          <CanonicalActionModal
            open={true}
            onOpenChange={(v) => { if (!v) setActionModal(null); }}
            action={actionModal}
            onAfter={() => refetch()}
          />
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <div
            className="text-sm bg-red-50 border border-red-200 rounded p-3 text-red-700"
            data-testid="error-front-overview"
          >
            Failed to load overview: {(error as Error).message}
          </div>
        ) : null}

        <div data-testid="section-front-jobs">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-800">
              Current & recent jobs
              <span className="text-gray-400 font-normal ml-1.5">({jobs.length})</span>
            </h3>
          </div>
          {isLoading ? (
            <InlineLoadingSkeleton lines={3} />
          ) : jobs.length === 0 ? (
            <p
              className="text-sm text-gray-500 bg-gray-50 border rounded p-3"
              data-testid="empty-front-jobs"
            >
              No jobs running or recently completed. Historical recovery,
              rematch, and reprocess-dismissed jobs are tracked here when
              they execute.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <div className="space-y-2 min-w-[640px]">
                {jobs.map((j) => (
                  <JobRow
                    key={j.id}
                    job={j}
                    defaultExpanded={j.type === "historical_recovery" && j.status === "failed"}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <LegacyBackfillDisclosure onAfter={() => refetch()} />
      </CardContent>
    </Card>
  );
}
