import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { FilterRuleHit } from "./types";

export function FilterRuleRecentHits({ ruleId }: { ruleId: string }) {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<{ hits: FilterRuleHit[] }>({
    queryKey: ["/api/integrations/front/filter-rules", ruleId, "hits"],
    queryFn: async () => {
      const res = await fetch(`/api/integrations/front/filter-rules/${ruleId}/hits?limit=25`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load recent hits");
      return res.json();
    },
    staleTime: 5_000,
  });

  const hits = data?.hits ?? [];

  return (
    <div
      className="mt-2 border rounded bg-muted/50 p-2 space-y-1"
      data-testid={`recent-hits-${ruleId}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">
          Last {hits.length} hit{hits.length === 1 ? "" : "s"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid={`button-refresh-hits-${ruleId}`}
        >
          <RefreshCw className={`w-3 h-3 mr-1 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
      {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {isError && <p className="text-xs text-red-600">Failed to load recent hits.</p>}
      {!isLoading && !isError && hits.length === 0 && (
        <p className="text-xs text-muted-foreground italic" data-testid={`text-no-hits-${ruleId}`}>
          No recorded hits yet. Inbound matches will appear here within a few seconds of firing.
        </p>
      )}
      {hits.length > 0 && (
        <ul className="space-y-1 max-h-64 overflow-y-auto">
          {hits.map((hit) => (
            <li
              key={hit.id}
              // Decorative list rail (brand purple, not a status signal) —
              // exempt from the --status-* token sweep (Task #4492).
              className="text-xs border-l-2 border-purple-200 pl-2 py-0.5"
              data-testid={`hit-row-${hit.id}`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-foreground">
                  {hit.senderEmail ?? "(no sender)"}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground truncate" title={hit.subject ?? ""}>
                  {hit.subject || <em className="text-muted-foreground">(no subject)</em>}
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground mt-0.5">
                <span title={new Date(hit.createdAt).toLocaleString()}>
                  {formatDistanceToNow(new Date(hit.createdAt), { addSuffix: true })}
                </span>
                <span>·</span>
                <span>{hit.source}</span>
                {hit.conversationId && (
                  <>
                    <span>·</span>
                    <code className="font-mono text-xs bg-card border rounded px-1">
                      {hit.conversationId}
                    </code>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
