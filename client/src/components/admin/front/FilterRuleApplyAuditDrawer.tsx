import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import type { FilterRule, FilterRuleAuditEntry } from "./types";
import { APPLY_AUDIT_LABELS } from "./types";

export function FilterRuleApplyAuditDrawer({ rule, jobId }: { rule: FilterRule; jobId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<{
    jobId: string;
    items: FilterRuleAuditEntry[];
  }>({
    queryKey: ["/api/integrations/front/filter-rules/apply-jobs", jobId, "audit"],
    queryFn: async () => {
      const res = await fetch(
        `/api/integrations/front/filter-rules/apply-jobs/${encodeURIComponent(jobId)}/audit`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`Failed to load audit entries (${res.status})`);
      return res.json();
    },
    enabled: open,
    staleTime: 10_000,
  });

  const items = data?.items ?? [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="underline font-medium hover:opacity-80"
        data-testid={`apply-status-audit-link-${rule.id}`}
      >
        View audit →
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-2xl w-[calc(100vw-2rem)]"
          data-testid={`dialog-apply-audit-${rule.id}`}
        >
          <DialogHeader>
            <DialogTitle>Apply audit trail</DialogTitle>
            <DialogDescription>
              <span className="block">
                Rule <span className="font-medium">{rule.type}</span> / {rule.scope} /{" "}
                <span className="font-mono">{rule.value}</span>
              </span>
              <span className="block text-xs opacity-70 mt-0.5 font-mono break-all">
                job {jobId}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-2">
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading audit entries…
              </div>
            ) : isError ? (
              <div
                className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3"
                data-testid={`apply-audit-error-${rule.id}`}
              >
                {(error as Error)?.message || "Failed to load audit entries"}
              </div>
            ) : items.length === 0 ? (
              <div
                className="text-sm text-muted-foreground py-6 text-center"
                data-testid={`apply-audit-empty-${rule.id}`}
              >
                No audit entries recorded for this job yet.
              </div>
            ) : (
              <ol className="space-y-2" data-testid={`apply-audit-list-${rule.id}`}>
                {items.map((entry) => {
                  const meta = APPLY_AUDIT_LABELS[entry.actionType] ?? {
                    label: entry.actionType,
                    tone: "bg-muted/50 text-foreground border-border",
                  };
                  return (
                    <li
                      key={entry.id}
                      className="border rounded-md p-3 bg-card"
                      data-testid={`apply-audit-entry-${entry.id}`}
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <Badge variant="outline" className={meta.tone}>
                          {meta.label}
                        </Badge>
                        <span className="text-xs text-muted-foreground" title={entry.timestamp}>
                          {format(new Date(entry.timestamp), "MMM d, yyyy h:mm:ss a")}
                        </span>
                      </div>
                      {entry.actionDetail && (
                        <p className="text-sm mt-2 break-words">{entry.actionDetail}</p>
                      )}
                      <div className="mt-2 text-xs text-muted-foreground">
                        by{" "}
                        <span className="font-medium text-foreground">
                          {entry.userName || (entry.userId ? "Unknown user" : "System")}
                        </span>
                      </div>
                      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                            Metadata
                          </summary>
                          <pre className="mt-1 bg-muted/50 border rounded p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
                            {JSON.stringify(entry.metadata, null, 2)}
                          </pre>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid={`button-apply-audit-refresh-${rule.id}`}
            >
              {isFetching ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              )}
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => setOpen(false)}
              data-testid={`button-apply-audit-close-${rule.id}`}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
