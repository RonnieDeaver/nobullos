import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Filter, Pencil, Trash2, Plus, RefreshCw, Play, Loader2,
  ChevronDown, ChevronUp, History, AlertTriangle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { FilterRule, FilterRuleApplyJobState } from "./types";
import { RULE_TYPE_LABELS, RULE_TYPE_BADGE, RULE_SCOPE_LABELS } from "./types";
import { isApplyJobActive, ruleIsStale, STALE_RULE_THRESHOLD_DAYS } from "./utils";
import { FilterRuleEditorDialog } from "./FilterRuleEditorDialog";
import { FilterRuleApplyStatus } from "./FilterRuleApplyStatus";
import { FilterRuleRecentHits } from "./FilterRuleRecentHits";

export function FrontFilterRules() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, refetch, isFetching, isError, error } = useQuery<{ rules: FilterRule[] }>({
    queryKey: ["/api/integrations/front/filter-rules"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/front/filter-rules", { credentials: "include" });
      if (!res.ok) {
        // Task #2502 (Bug C) — the list query times out / 500s under DB-pool
        // contention (e.g. a 9.5s hold on front_operational_rules during a heavy
        // reprocess). Surface a status-aware message so the retry/backoff and the
        // error affordance can explain a transient stall vs a hard failure.
        const transient = res.status >= 500 || res.status === 429;
        throw new Error(
          transient
            ? `Filter rules are temporarily unavailable (server busy, ${res.status}). Retrying…`
            : `Failed to load filter rules (${res.status}).`,
        );
      }
      return res.json();
    },
    // Tolerate transient pool contention: a few retries with exponential backoff
    // (capped at 5s) instead of failing on the first stalled query.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  const applyJobsQuery = useQuery<{ byRuleId: Record<string, FilterRuleApplyJobState> }>({
    queryKey: ["/api/integrations/front/filter-rules/apply-jobs/active"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/front/filter-rules/apply-jobs/active", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load apply-job status");
      return res.json();
    },
    refetchInterval: (query) => {
      const states = Object.values(query.state.data?.byRuleId ?? {});
      return states.some(isApplyJobActive) ? 2_000 : 15_000;
    },
    refetchOnWindowFocus: true,
  });
  const applyJobsByRuleId = applyJobsQuery.data?.byRuleId ?? {};
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<FilterRule | null>(null);
  const [applyTarget, setApplyTarget] = useState<FilterRule | null>(null);
  const [applyPreview, setApplyPreview] = useState<{ totalSelected: number; eligibleCount: number } | null>(null);
  const [applyPreviewLoading, setApplyPreviewLoading] = useState(false);
  const [applyConfirming, setApplyConfirming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FilterRule | null>(null);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [expandedHitsRuleIds, setExpandedHitsRuleIds] = useState<Record<string, boolean>>({});

  const rules = data?.rules ?? [];

  const invalidateAllFrontConsole = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/filter-rules"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/messages"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/console/overview"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/filter-rules/apply-jobs/active"] }); // fire-and-forget: cache refresh only
  };

  const handleToggle = async (rule: FilterRule, next: boolean) => {
    try {
      await apiRequest("PATCH", `/api/integrations/front/filter-rules/${rule.id}`, { enabled: next });
      invalidateAllFrontConsole();
      toast({ title: next ? "Rule enabled" : "Rule disabled" });
    } catch (err: any) {
      toast({ title: "Toggle failed", description: err?.message, variant: "destructive" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteConfirming(true);
    try {
      await apiRequest("DELETE", `/api/integrations/front/filter-rules/${deleteTarget.id}`);
      invalidateAllFrontConsole();
      toast({ title: "Filter rule deleted" });
      setDeleteTarget(null);
    } catch (err: any) {
      toast({ title: "Delete failed", description: err?.message, variant: "destructive" });
    } finally {
      setDeleteConfirming(false);
    }
  };

  const openApplyDialog = async (rule: FilterRule) => {
    setApplyTarget(rule);
    setApplyPreview(null);
    setApplyPreviewLoading(true);
    try {
      const res = await apiRequest("POST", "/api/integrations/front/filter-rules/preview", {
        type: rule.type, scope: rule.scope, value: rule.value,
      });
      const data = await res.json();
      setApplyPreview({
        totalSelected: data.totalSelected ?? 0,
        eligibleCount: data.eligibleCount ?? 0,
      });
    } catch (err: any) {
      toast({ title: "Preview failed", description: err?.message, variant: "destructive" });
      setApplyPreview({ totalSelected: 0, eligibleCount: 0 });
    } finally {
      setApplyPreviewLoading(false);
    }
  };

  const confirmApplyRetroactively = async () => {
    if (!applyTarget) return;
    setApplyConfirming(true);
    try {
      const res = await apiRequest("POST", `/api/integrations/front/filter-rules/${applyTarget.id}/apply`, {});
      const json = await res.json();
      toast({ title: "Apply enqueued", description: `~${json.estimatedCount ?? 0} item(s) queued (job ${json.jobId}).` });
      setApplyTarget(null);
      setApplyPreview(null);
      invalidateAllFrontConsole();
      setTimeout(invalidateAllFrontConsole, 5_000);
    } catch (err: any) {
      toast({ title: "Apply failed", description: err?.message, variant: "destructive" });
    } finally {
      setApplyConfirming(false);
    }
  };

  return (
    <Card data-testid="card-front-filter-rules">
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
            <Filter className="w-5 h-5 text-purple-600" />
            Filter rules
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-refresh-filter-rules"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => { setEditing(null); setEditorOpen(true); }}
              data-testid="button-create-filter-rule"
            >
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              New filter rule
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1" data-testid="text-filter-rules-subtitle">
          Rules are evaluated at ingestion. Precedence:{" "}
          <strong>block</strong> &gt; <strong>dismiss</strong> &gt; <strong>never_match</strong>.
          Saving or applying a rule refreshes Overview & Jobs and the Messages browser above.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <InlineLoadingSkeleton />}
        {!isLoading && isError && (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-2"
            data-testid="error-filter-rules"
            role="alert"
          >
            <AlertTriangle className="w-4 h-4 text-red-700 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-800">Couldn't load filter rules</p>
              <p className="text-xs text-red-700/90 mt-0.5">
                {(error as Error)?.message ?? "The request failed."} This is usually a temporary
                database stall under load — retry in a moment.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-7 text-xs border-red-300 text-red-700 hover:bg-red-100"
                onClick={() => refetch()}
                disabled={isFetching}
                data-testid="button-retry-filter-rules"
              >
                <RefreshCw className={`w-3 h-3 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
                {isFetching ? "Retrying…" : "Retry"}
              </Button>
            </div>
          </div>
        )}
        {!isLoading && !isError && rules.length === 0 && (
          <p className="text-sm text-muted-foreground italic" data-testid="text-no-filter-rules">
            No filter rules yet. Click "New filter rule" to add one.
          </p>
        )}
        {rules.map((rule) => {
          const applyJob = applyJobsByRuleId[rule.id];
          const jobActive = applyJob ? isApplyJobActive(applyJob) : false;
          const stale = ruleIsStale(rule);
          const hitsOpen = !!expandedHitsRuleIds[rule.id];
          return (
          <div
            key={rule.id}
            data-testid={`card-filter-rule-${rule.id}`}
            className={`border rounded-lg p-3 ${rule.enabled ? "bg-card" : "bg-muted/50 opacity-75"} ${stale ? "border-amber-300 bg-amber-50/40" : ""}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className={`border ${RULE_TYPE_BADGE[rule.type]}`}>
                    {RULE_TYPE_LABELS[rule.type]}
                  </Badge>
                  <Badge variant="outline" className="font-normal">
                    {RULE_SCOPE_LABELS[rule.scope]}
                  </Badge>
                  <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded break-all">
                    {rule.value}
                  </code>
                  {jobActive && (
                    <Badge
                      className="border bg-blue-100 text-blue-700 border-blue-200 inline-flex items-center gap-1"
                      data-testid={`badge-rule-applying-${rule.id}`}
                    >
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {applyJob!.status === "queued" ? "Queued…" : "Applying…"}
                    </Badge>
                  )}
                  {stale && (
                    <Badge
                      className="border bg-amber-100 text-amber-800 border-amber-300 inline-flex items-center gap-1"
                      data-testid={`badge-rule-stale-${rule.id}`}
                      title={`No hits recorded in the last ${STALE_RULE_THRESHOLD_DAYS} days`}
                    >
                      <AlertTriangle className="w-3 h-3" />
                      Stale
                    </Badge>
                  )}
                </div>
                {rule.notes && (
                  <p className="text-xs text-muted-foreground">{rule.notes}</p>
                )}
                <p className="text-xs text-muted-foreground" data-testid={`text-rule-affected-count-${rule.id}`}>
                  Hits: <strong>{rule.affectedCount}</strong>
                  {rule.lastAppliedAt ? (
                    <> · Last hit {formatDistanceToNow(new Date(rule.lastAppliedAt), { addSuffix: true })}</>
                  ) : (
                    <> · <span className="italic text-muted-foreground">Never fired</span></>
                  )}
                  <> · Created {formatDistanceToNow(new Date(rule.createdAt), { addSuffix: true })}</>
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() =>
                    setExpandedHitsRuleIds((prev) => ({ ...prev, [rule.id]: !prev[rule.id] }))
                  }
                  data-testid={`button-toggle-hits-${rule.id}`}
                >
                  {hitsOpen ? (
                    <ChevronUp className="w-3 h-3 mr-1" />
                  ) : (
                    <ChevronDown className="w-3 h-3 mr-1" />
                  )}
                  <History className="w-3 h-3 mr-1" />
                  {hitsOpen ? "Hide recent hits" : "Show recent hits"}
                </Button>
                {hitsOpen && <FilterRuleRecentHits ruleId={rule.id} />}
                {applyJob && <FilterRuleApplyStatus rule={rule} state={applyJob} />}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={rule.enabled}
                  onCheckedChange={(next) => handleToggle(rule, next)}
                  aria-label={`Enable rule ${rule.value}`}
                  data-testid={`switch-rule-enabled-${rule.id}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openApplyDialog(rule)}
                  data-testid={`button-apply-rule-${rule.id}`}
                  title="Apply retroactively"
                  aria-label={`Apply rule ${rule.value} retroactively`}
                >
                  <Play className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setEditing(rule); setEditorOpen(true); }}
                  data-testid={`button-edit-rule-${rule.id}`}
                  aria-label={`Edit rule ${rule.value}`}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDeleteTarget(rule)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  data-testid={`button-delete-rule-${rule.id}`}
                  aria-label={`Delete rule ${rule.value}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
          );
        })}
      </CardContent>
      <FilterRuleEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editing}
        onSaved={() => {
          invalidateAllFrontConsole();
        }}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent data-testid="dialog-delete-rule-confirm" className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this filter rule?</DialogTitle>
            <DialogDescription>
              {deleteTarget && (
                <>
                  This permanently removes the{" "}
                  <strong>{RULE_TYPE_LABELS[deleteTarget.type]}</strong> rule on{" "}
                  <strong>{RULE_SCOPE_LABELS[deleteTarget.scope]}</strong> ={" "}
                  <code className="font-mono bg-muted px-1 rounded">{deleteTarget.value}</code>.
                  Existing dismissed/blocked rows are not reverted.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteConfirming}
              data-testid="button-cancel-delete-rule"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteConfirming}
              data-testid="button-confirm-delete-rule"
            >
              {deleteConfirming ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Delete rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!applyTarget} onOpenChange={(o) => { if (!o) { setApplyTarget(null); setApplyPreview(null); } }}>
        <DialogContent data-testid="dialog-apply-rule-confirm" className="max-w-md">
          <DialogHeader>
            <DialogTitle>Apply filter rule retroactively?</DialogTitle>
            <DialogDescription>
              {applyTarget && (
                <>
                  This will apply{" "}
                  <strong>{RULE_TYPE_LABELS[applyTarget.type]}</strong> to existing messages
                  matching <strong>{RULE_SCOPE_LABELS[applyTarget.scope]}</strong> ={" "}
                  <code className="font-mono bg-muted px-1 rounded">{applyTarget.value}</code>.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm bg-blue-50 border border-blue-200 rounded p-3" data-testid="text-apply-preview-count">
            {applyPreviewLoading ? (
              <span className="flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Computing preview…</span>
            ) : applyPreview ? (
              <>
                <strong>{applyPreview.eligibleCount}</strong> message(s) will be affected
                {" "}<span className="text-muted-foreground">({applyPreview.totalSelected} matched the selection).</span>
              </>
            ) : (
              "Preview unavailable."
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setApplyTarget(null); setApplyPreview(null); }}
              data-testid="button-cancel-apply-rule"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmApplyRetroactively}
              disabled={applyConfirming || applyPreviewLoading}
              data-testid="button-confirm-apply-rule"
            >
              {applyConfirming ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Apply to {applyPreview?.eligibleCount ?? 0} message{(applyPreview?.eligibleCount ?? 0) === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
