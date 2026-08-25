import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  HelpCircle,
  History,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type BackfillJobRow = {
  id: string;
  jobType: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  triggeredBy: string | null;
  parametersJson: unknown;
  totalUnits: number;
  processedUnits: number;
  succeededUnits: number;
  failedUnits: number;
  alreadyCurrentUnits: number;
  coverageGapsJson: unknown;
  resultJson: unknown;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type CoverageGap = {
  clientId: string;
  locationId: string;
  campaignId: string;
  reportDate: string;
  expected: number;
  observed: number;
  missingKeywords: string[];
  clientName?: string | null;
  locationName?: string | null;
  locationAddress?: string | null;
};

type CoverageGapsResponse = {
  jobId: string;
  status: string;
  completedAt: string | null;
  gapCount: number;
  gaps: CoverageGap[];
};

function formatTime(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return String(s);
  }
}

function relAge(s: string | null | undefined): string {
  if (!s) return "—";
  const ms = Date.now() - new Date(s).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function StatusBadge({ status }: { status: BackfillJobRow["status"] }) {
  if (status === "succeeded") {
    return (
      <Badge variant="outline" className="border-green-500 text-green-700" data-testid={`badge-status-${status}`}>
        <CheckCircle2 className="w-3 h-3 mr-1" />Succeeded
      </Badge>
    );
  }
  if (status === "running") {
    return (
      <Badge variant="outline" className="border-blue-500 text-blue-700" data-testid={`badge-status-${status}`}>
        <Loader2 className="w-3 h-3 mr-1 animate-spin" />Running
      </Badge>
    );
  }
  if (status === "queued") {
    return (
      <Badge variant="outline" className="border-border text-muted-foreground" data-testid={`badge-status-${status}`}>
        <Clock className="w-3 h-3 mr-1" />Queued
      </Badge>
    );
  }
  if (status === "partial") {
    return (
      <Badge variant="outline" className="border-amber-500 text-amber-700" data-testid={`badge-status-${status}`}>
        <AlertTriangle className="w-3 h-3 mr-1" />Partial
      </Badge>
    );
  }
  if (status === "cancelled") {
    return (
      <Badge variant="outline" className="border-border text-muted-foreground" data-testid={`badge-status-${status}`}>
        Cancelled
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-red-500 text-red-700 dark:text-red-400" data-testid={`badge-status-${status}`}>
      <XCircle className="w-3 h-3 mr-1" />Failed
    </Badge>
  );
}

function progressPercent(row: BackfillJobRow): number | null {
  if (row.totalUnits <= 0) return null;
  const pct = Math.round((row.processedUnits / row.totalUnits) * 100);
  return Math.max(0, Math.min(100, pct));
}

function jobTypeLabel(t: string): string {
  if (t === "semrush_heatmap_backfill") return "SEMrush heatmap";
  if (t === "zoom_review_signals_backfill") return "Zoom review signals";
  return t;
}

type PostDrainCoverageCheck = {
  checkedAt: string;
  attempt: number;
  refreshJobsStillPending: number;
  refreshJobsTotal: number;
  drained: boolean;
  scopeUnits: number;
  gapUnits: number;
  gaps: CoverageGap[];
  reportFiles: { json: string; markdown: string };
  alertSent: boolean;
  alertChannel: string | null;
  alertSkippedReason: string | null;
  computeError: string | null;
};

type CoverageCheckResponse = {
  jobId: string;
  status: string;
  completedAt: string | null;
  check: PostDrainCoverageCheck | null;
  reportDownloadUrl: string | null;
};

function CoverageCheckPanel({ jobId }: { jobId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showGaps, setShowGaps] = useState(false);

  const { data, isLoading, isError, error } = useQuery<CoverageCheckResponse>({
    queryKey: ["/api/backfill-jobs", jobId, "coverage-check"],
    queryFn: async () => {
      const res = await fetch(`/api/backfill-jobs/${jobId}/coverage-check`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load coverage check");
      }
      return res.json();
    },
    meta: { silent: true },
  });

  const rerunMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch(
        `/api/backfill-jobs/${jobId}/coverage-check/rerun`,
        { method: "POST", credentials: "include" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to enqueue re-run");
      return body as { scheduled: boolean; jobId: string; runAt: string };
    },
    onSuccess: () => {
      toast({
        title: "Coverage check enqueued",
        description: "A fresh check will run shortly. Refresh this panel in a minute.",
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/backfill-jobs", jobId, "coverage-check"],
      }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({
        title: "Re-run failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid={`coverage-check-loading-${jobId}`}
      >
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading post-drain coverage check…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="text-sm text-red-700 dark:text-red-400" data-testid={`coverage-check-error-${jobId}`}>
        Failed to load coverage check: {(error as Error)?.message ?? "unknown error"}
      </div>
    );
  }

  const rawCheck = data?.check ?? null;
  const check: PostDrainCoverageCheck | null = rawCheck
    ? {
        ...rawCheck,
        gaps: Array.isArray(rawCheck.gaps) ? rawCheck.gaps : [],
        reportFiles: rawCheck.reportFiles ?? { json: "", markdown: "" },
        scopeUnits: Number(rawCheck.scopeUnits) || 0,
        gapUnits: Number(rawCheck.gapUnits) || 0,
        refreshJobsStillPending: Number(rawCheck.refreshJobsStillPending) || 0,
        refreshJobsTotal: Number(rawCheck.refreshJobsTotal) || 0,
        attempt: Number(rawCheck.attempt) || 1,
      }
    : null;
  const inconclusive = !!check?.computeError;
  let statusBadge;
  if (!check) {
    statusBadge = (
      <Badge
        variant="outline"
        className="border-border text-muted-foreground"
        data-testid={`badge-coverage-check-status-${jobId}`}
      >
        <Clock className="w-3 h-3 mr-1" />
        Not yet run
      </Badge>
    );
  } else if (inconclusive) {
    statusBadge = (
      <Badge
        variant="outline"
        className="border-border text-muted-foreground"
        data-testid={`badge-coverage-check-status-${jobId}`}
      >
        <HelpCircle className="w-3 h-3 mr-1" />
        Inconclusive
      </Badge>
    );
  } else if (check.gapUnits === 0) {
    statusBadge = (
      <Badge
        variant="outline"
        className="border-green-500 text-green-700"
        data-testid={`badge-coverage-check-status-${jobId}`}
      >
        <CheckCircle2 className="w-3 h-3 mr-1" />
        Clean
      </Badge>
    );
  } else {
    statusBadge = (
      <Badge
        variant="outline"
        className="border-amber-500 text-amber-700"
        data-testid={`badge-coverage-check-status-${jobId}`}
      >
        <AlertTriangle className="w-3 h-3 mr-1" />
        {check.gapUnits} gap{check.gapUnits === 1 ? "" : "s"}
      </Badge>
    );
  }

  return (
    <div
      className="border border-border rounded-md bg-card p-3 space-y-3"
      data-testid={`coverage-check-panel-${jobId}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">Post-drain coverage check</span>
          {statusBadge}
        </div>
        <div className="flex items-center gap-2">
          {data?.reportDownloadUrl && (
            <a
              href={data.reportDownloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`link-coverage-report-${jobId}`}
            >
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
              >
                <FileText className="w-3 h-3 mr-1" />
                Report
              </Button>
            </a>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={rerunMutation.isPending}
            onClick={() => rerunMutation.mutate()}
            data-testid={`button-coverage-rerun-${jobId}`}
          >
            {rerunMutation.isPending ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3 mr-1" />
            )}
            Re-run check now
          </Button>
        </div>
      </div>

      {!check ? (
        <p
          className="text-xs text-muted-foreground italic"
          data-testid={`coverage-check-empty-${jobId}`}
        >
          The automatic post-drain check hasn't recorded a result for this backfill yet.
          It runs ~1 hour after a backfill finishes (or whenever the SEMrush refresh
          queue drains). You can also kick one off manually with the button above.
        </p>
      ) : (
        <Fragment>
          {inconclusive && (
            <div
              className="text-xs text-foreground bg-muted/50 border border-border rounded px-2 py-1.5"
              data-testid={`text-coverage-compute-error-${jobId}`}
            >
              <strong>Inconclusive:</strong> coverage computation failed —
              <code className="ml-1">{check.computeError}</code>. Treat the gap count
              below as "unknown", not "clean".
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground">Drained?</div>
              <div
                className={`text-sm font-semibold ${check.drained ? "text-green-700" : "text-amber-700"}`}
                data-testid={`text-coverage-drained-${jobId}`}
              >
                {check.drained ? "Yes" : "No"}
              </div>
              <div className="text-xs text-muted-foreground">
                {check.refreshJobsStillPending}/{check.refreshJobsTotal} refresh jobs pending
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Scope tuples</div>
              <div
                className="text-sm font-semibold text-foreground"
                data-testid={`text-coverage-scope-${jobId}`}
              >
                {check.scopeUnits}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Gap tuples</div>
              <div
                className={`text-sm font-semibold ${check.gapUnits > 0 ? "text-amber-700" : "text-green-700"}`}
                data-testid={`text-coverage-gaps-${jobId}`}
              >
                {check.gapUnits}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Attempt</div>
              <div
                className="text-sm font-semibold text-foreground"
                data-testid={`text-coverage-attempt-${jobId}`}
              >
                {check.attempt}
              </div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground" title={formatTime(check.checkedAt)}>
            Last checked {relAge(check.checkedAt)} · {formatTime(check.checkedAt)}
            {check.alertChannel && (
              <span className="ml-2">
                · Slack alert {check.alertSent ? "sent" : `skipped (${check.alertSkippedReason ?? "n/a"})`}
              </span>
            )}
          </div>
          {check.gaps.length > 0 && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-primary-ink hover:bg-muted"
                onClick={() => setShowGaps((s) => !s)}
                data-testid={`button-coverage-toggle-gaps-${jobId}`}
              >
                {showGaps ? (
                  <ChevronDown className="w-3 h-3 mr-1" />
                ) : (
                  <ChevronRight className="w-3 h-3 mr-1" />
                )}
                {showGaps ? "Hide" : "Show"} gap tuples ({check.gaps.length})
              </Button>
              {showGaps && (
                <div
                  className="mt-2 border border-border rounded-md bg-card overflow-x-auto"
                  data-testid={`coverage-check-gaps-${jobId}`}
                >
                  <table className="w-full text-xs min-w-[640px]">
                    <thead className="text-muted-foreground bg-muted/50">
                      <tr className="text-left">
                        <th className="px-3 py-2">Client / location</th>
                        <th className="px-3 py-2">Report date</th>
                        <th className="px-3 py-2">Coverage</th>
                        <th className="px-3 py-2">Missing keywords</th>
                      </tr>
                    </thead>
                    <tbody>
                      {check.gaps.slice(0, 50).map((g, idx) => {
                        const visible = g.missingKeywords.slice(0, 5);
                        const overflow = g.missingKeywords.length - visible.length;
                        return (
                          <tr
                            key={`${g.clientId}-${g.locationId}-${g.campaignId}-${g.reportDate}-${idx}`}
                            className="border-t border-border/60 align-top"
                            data-testid={`row-coverage-gap-${jobId}-${idx}`}
                          >
                            <td className="px-3 py-2">
                              <Link
                                href={`/clients/${g.clientId}`}
                                className="text-primary-ink hover:underline font-medium"
                              >
                                {g.clientId}
                              </Link>
                              <div
                                className="text-xs text-muted-foreground font-mono truncate"
                                title={g.locationId}
                              >
                                loc · {g.locationId}
                              </div>
                              <div
                                className="text-xs text-muted-foreground font-mono truncate"
                                title={g.campaignId}
                              >
                                campaign · {g.campaignId}
                              </div>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-foreground">
                              {g.reportDate}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <span
                                className={g.observed === 0 ? "text-red-700 dark:text-red-400" : "text-amber-700"}
                              >
                                {g.observed}/{g.expected}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-foreground">
                              <div className="flex flex-wrap gap-1">
                                {visible.map((k) => (
                                  <Badge
                                    key={k}
                                    variant="outline"
                                    className="border-border text-muted-foreground text-xs font-normal"
                                  >
                                    {k}
                                  </Badge>
                                ))}
                                {overflow > 0 && (
                                  <span className="text-xs text-muted-foreground">
                                    +{overflow} more
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {check.gaps.length > 50 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      Showing first 50 of {check.gaps.length}. Open the report for the
                      full list.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Fragment>
      )}
    </div>
  );
}

function buildRerunHref(params: {
  clientIds: string[];
  locationIds: string[];
  campaignIds: string[];
  sinceDate: string;
  untilDate: string;
}): string {
  const sp = new URLSearchParams();
  const uniq = (arr: string[]) => Array.from(new Set(arr.filter(Boolean)));
  const c = uniq(params.clientIds);
  const l = uniq(params.locationIds);
  const ca = uniq(params.campaignIds);
  if (c.length) sp.set("prefillClientIds", c.join(","));
  if (l.length) sp.set("prefillLocationIds", l.join(","));
  if (ca.length) sp.set("prefillCampaignIds", ca.join(","));
  if (params.sinceDate) sp.set("prefillSinceDate", params.sinceDate);
  if (params.untilDate) sp.set("prefillUntilDate", params.untilDate);
  const qs = sp.toString();
  return `/admin/integrations/semrush${qs ? `?${qs}` : ""}`;
}

function CoverageGapsList({ jobId }: { jobId: string }) {
  const [, setLocation] = useLocation();
  const { data, isLoading, isError, error } = useQuery<CoverageGapsResponse>({
    queryKey: ["/api/backfill-jobs", jobId, "coverage-gaps"],
    queryFn: async () => {
      const res = await fetch(`/api/backfill-jobs/${jobId}/coverage-gaps`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load coverage gaps");
      }
      return res.json();
    },
    meta: { silent: true },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`gaps-loading-${jobId}`}>
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading coverage gaps…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="text-sm text-red-700 dark:text-red-400" data-testid={`gaps-error-${jobId}`}>
        Failed to load coverage gaps: {(error as Error)?.message ?? "unknown error"}
      </div>
    );
  }
  if (!data || data.gapCount === 0) {
    return (
      <div className="text-sm text-green-700 italic" data-testid={`gaps-empty-${jobId}`}>
        No coverage gaps — every (location, keyword, report date) in scope was covered.
      </div>
    );
  }

  // Aggregate every gap's identifiers into a single set of filters for the
  // "Re-run all gaps" shortcut. SinceDate / untilDate span the min..max
  // report date across all gap rows so a single backfill scope covers them.
  const allGapsHref = (() => {
    const clientIds = data.gaps.map((g) => g.clientId);
    const locationIds = data.gaps.map((g) => g.locationId);
    const campaignIds = data.gaps.map((g) => g.campaignId);
    const dates = data.gaps.map((g) => g.reportDate).filter(Boolean).sort();
    const sinceDate = dates[0] ?? "";
    const untilDate = dates[dates.length - 1] ?? "";
    return buildRerunHref({
      clientIds,
      locationIds,
      campaignIds,
      sinceDate,
      untilDate,
    });
  })();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setLocation(allGapsHref)}
          data-testid={`button-rerun-all-gaps-${jobId}`}
          title="Open the SEMrush backfill form pre-filled with every gap in this job"
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          Re-run all gaps ({data.gapCount})
        </Button>
      </div>
      <div className="border border-border rounded-md bg-card overflow-x-auto">
        <table className="w-full text-xs sm:text-sm min-w-[820px]">
          <thead className="text-muted-foreground bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2">Client / location</th>
              <th className="px-3 py-2">Report date</th>
              <th className="px-3 py-2">Coverage</th>
              <th className="px-3 py-2">Missing keywords</th>
              <th className="px-3 py-2 w-24">Re-run</th>
            </tr>
          </thead>
          <tbody>
            {data.gaps.map((g, idx) => {
              const key = `${g.clientId}-${g.locationId}-${g.campaignId}-${g.reportDate}-${idx}`;
              const visible = g.missingKeywords.slice(0, 6);
              const overflow = g.missingKeywords.length - visible.length;
              const rowRerunHref = buildRerunHref({
                clientIds: [g.clientId],
                locationIds: [g.locationId],
                campaignIds: [g.campaignId],
                sinceDate: g.reportDate,
                untilDate: g.reportDate,
              });
              return (
                <tr key={key} className="border-t border-border/60 align-top" data-testid={`row-gap-${jobId}-${idx}`}>
                  <td className="px-3 py-2">
                    <Link
                      href={`/clients/${g.clientId}`}
                      className="text-primary-ink hover:underline font-medium"
                      title={g.clientId}
                      data-testid={`link-gap-client-${jobId}-${idx}`}
                    >
                      {g.clientName ?? g.clientId}
                    </Link>
                    <div className="text-xs text-muted-foreground truncate">
                      loc ·{" "}
                      <a
                        href={`/admin/integrations/semrush#coverage-row-${g.clientId}-${g.locationId}`}
                        className="text-primary-ink hover:underline"
                        title={
                          g.locationAddress
                            ? `${g.locationAddress} · ${g.locationId}`
                            : g.locationId
                        }
                        data-testid={`link-gap-location-${jobId}-${idx}`}
                      >
                        {g.locationName ?? g.locationId}
                      </a>
                      {g.locationAddress && (
                        <span
                          className="ml-1 text-xs text-muted-foreground"
                          data-testid={`text-gap-location-address-${jobId}-${idx}`}
                        >
                          — {g.locationAddress}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate" title={g.campaignId}>
                      campaign · {g.campaignId}
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-foreground">{g.reportDate}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      className={g.observed === 0 ? "text-red-700 dark:text-red-400" : "text-amber-700"}
                      data-testid={`text-gap-coverage-${jobId}-${idx}`}
                    >
                      {g.observed}/{g.expected}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    <div className="flex flex-wrap gap-1">
                      {visible.map((k) => (
                        <Badge
                          key={k}
                          variant="outline"
                          className="border-border text-muted-foreground text-xs font-normal"
                        >
                          {k}
                        </Badge>
                      ))}
                      {overflow > 0 && (
                        <span className="text-xs text-muted-foreground" data-testid={`text-gap-overflow-${jobId}-${idx}`}>
                          +{overflow} more
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-primary-ink hover:bg-muted"
                      onClick={() => setLocation(rowRerunHref)}
                      data-testid={`button-rerun-gap-${jobId}-${idx}`}
                      title="Open the SEMrush backfill form pre-filled with this gap"
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Re-run
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const ALL = "__all__";

const JOB_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "semrush_heatmap_backfill", label: "SEMrush heatmap" },
  { value: "zoom_review_signals_backfill", label: "Zoom review signals" },
];

const STATUS_OPTIONS: { value: BackfillJobRow["status"]; label: string }[] = [
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

export function BackfillJobsPanel() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [jobTypeFilter, setJobTypeFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [triggeredByFilter, setTriggeredByFilter] = useState<string>(ALL);

  const { data, isLoading, isError, error } = useQuery<{ rows: BackfillJobRow[] }>({
    queryKey: ["/api/backfill-jobs", { jobType: jobTypeFilter, status: statusFilter }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (jobTypeFilter !== ALL) params.set("jobType", jobTypeFilter);
      if (statusFilter !== ALL) params.set("status", statusFilter);
      const res = await fetch(`/api/backfill-jobs?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load backfill jobs");
      }
      return res.json();
    },
    refetchInterval: (q) => {
      const rows = (q.state.data as { rows: BackfillJobRow[] } | undefined)?.rows;
      const active = rows?.some((r) => r.status === "queued" || r.status === "running");
      return active ? 5_000 : 30_000;
    },
    meta: { silent: true },
  });

  const serverRows = useMemo(() => data?.rows ?? [], [data]);

  const triggeredByOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of serverRows) {
      if (r.triggeredBy) seen.add(r.triggeredBy);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [serverRows]);

  const rows = useMemo(() => {
    if (triggeredByFilter === ALL) return serverRows;
    return serverRows.filter((r) => (r.triggeredBy ?? "") === triggeredByFilter);
  }, [serverRows, triggeredByFilter]);

  const filtersActive =
    jobTypeFilter !== ALL || statusFilter !== ALL || triggeredByFilter !== ALL;

  return (
    <Card className="bg-card" data-testid="card-backfill-jobs">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="w-5 h-5 text-foreground" />
          Backfill Jobs
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Recent SEMrush heatmap and Zoom review-signal backfill runs. Expand a row to see what
          finished, what failed, and which (location, keyword, report date) tuples are still missing.
        </p>
      </CardHeader>
      <CardContent>
        <div
          className="flex flex-wrap items-end gap-2 mb-3"
          data-testid="backfill-jobs-filters"
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            <Select value={jobTypeFilter} onValueChange={setJobTypeFilter}>
              <SelectTrigger
                className="h-8 w-[180px] text-xs"
                data-testid="select-filter-job-type"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} data-testid="option-filter-job-type-all">
                  All types
                </SelectItem>
                {JOB_TYPE_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    data-testid={`option-filter-job-type-${opt.value}`}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger
                className="h-8 w-[140px] text-xs"
                data-testid="select-filter-status"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} data-testid="option-filter-status-all">
                  All statuses
                </SelectItem>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    data-testid={`option-filter-status-${opt.value}`}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Triggered by
            </label>
            <Select
              value={triggeredByFilter}
              onValueChange={setTriggeredByFilter}
              disabled={triggeredByOptions.length === 0}
            >
              <SelectTrigger
                className="h-8 w-[180px] text-xs"
                data-testid="select-filter-triggered-by"
              >
                <SelectValue placeholder="Anyone" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value={ALL}
                  data-testid="option-filter-triggered-by-all"
                >
                  Anyone
                </SelectItem>
                {triggeredByOptions.map((opt) => (
                  <SelectItem
                    key={opt}
                    value={opt}
                    data-testid={`option-filter-triggered-by-${opt}`}
                  >
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setJobTypeFilter(ALL);
                setStatusFilter(ALL);
                setTriggeredByFilter(ALL);
              }}
              data-testid="button-filters-clear"
            >
              Clear filters
            </Button>
          )}
        </div>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="backfill-jobs-loading">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading backfill jobs…
          </div>
        )}
        {isError && (
          <div className="text-sm text-red-700 dark:text-red-400" data-testid="backfill-jobs-error">
            Failed to load backfill jobs: {(error as Error)?.message ?? "unknown error"}
          </div>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <p className="text-sm text-muted-foreground italic" data-testid="backfill-jobs-empty">
            {filtersActive
              ? "No backfill jobs match the current filters."
              : "No backfill jobs have been recorded yet."}
          </p>
        )}
        {rows.length > 0 && (
          <div className="border border-border rounded-md bg-card overflow-x-auto">
            <table className="w-full text-xs sm:text-sm min-w-[860px]">
              <thead className="text-muted-foreground bg-muted/50">
                <tr className="text-left">
                  <th className="px-3 py-2 w-8" />
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Progress</th>
                  <th className="px-3 py-2">Triggered by</th>
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">Completed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = !!expanded[r.id];
                  const pct = progressPercent(r);
                  const gapsArr = Array.isArray(r.coverageGapsJson)
                    ? (r.coverageGapsJson as unknown[])
                    : [];
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className="border-t border-border/60 align-top hover:bg-muted/50 cursor-pointer"
                        onClick={() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))}
                        data-testid={`row-backfill-job-${r.id}`}
                      >
                        <td className="px-3 py-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            aria-label={isOpen ? "Collapse" : "Expand"}
                            data-testid={`button-toggle-job-${r.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpanded((s) => ({ ...s, [r.id]: !s[r.id] }));
                            }}
                          >
                            {isOpen ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </Button>
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-foreground">{jobTypeLabel(r.jobType)}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate" title={r.id}>
                            {r.id.slice(0, 8)}…
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-3 py-2 min-w-[160px]">
                          {pct === null ? (
                            <span className="text-xs text-muted-foreground">
                              {r.processedUnits} processed
                            </span>
                          ) : (
                            <div className="space-y-1" data-testid={`progress-${r.id}`}>
                              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                                <div
                                  className={
                                    r.status === "failed"
                                      ? "h-full bg-red-500"
                                      : r.status === "partial"
                                      ? "h-full bg-amber-500"
                                      : "h-full bg-green-500"
                                  }
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {pct}% · {r.processedUnits}/{r.totalUnits}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                          {r.triggeredBy ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td
                          className="px-3 py-2 text-muted-foreground whitespace-nowrap"
                          title={formatTime(r.startedAt)}
                        >
                          {relAge(r.startedAt)}
                        </td>
                        <td
                          className="px-3 py-2 text-muted-foreground whitespace-nowrap"
                          title={formatTime(r.completedAt)}
                        >
                          {relAge(r.completedAt)}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-muted/50 border-t border-border/60">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="space-y-3" data-testid={`detail-job-${r.id}`}>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                                <div>
                                  <div className="text-muted-foreground">Succeeded</div>
                                  <div
                                    className="text-base font-semibold text-green-700"
                                    data-testid={`text-succeeded-${r.id}`}
                                  >
                                    {r.succeededUnits}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground">Failed</div>
                                  <div
                                    className={`text-base font-semibold ${r.failedUnits > 0 ? "text-red-700 dark:text-red-400" : "text-foreground"}`}
                                    data-testid={`text-failed-${r.id}`}
                                  >
                                    {r.failedUnits}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground">Already current</div>
                                  <div
                                    className="text-base font-semibold text-foreground"
                                    data-testid={`text-already-current-${r.id}`}
                                  >
                                    {r.alreadyCurrentUnits}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground">Total scope</div>
                                  <div className="text-base font-semibold text-foreground">
                                    {r.totalUnits}
                                  </div>
                                </div>
                              </div>
                              {r.errorMessage && (
                                <div
                                  className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5"
                                  data-testid={`text-error-${r.id}`}
                                >
                                  {r.errorMessage}
                                </div>
                              )}
                              {r.jobType === "semrush_heatmap_backfill" && (
                                <CoverageCheckPanel jobId={r.id} />
                              )}
                              <div>
                                <div className="text-xs font-medium text-foreground mb-1.5">
                                  Coverage gaps
                                  {gapsArr.length > 0 && (
                                    <span className="ml-2 text-amber-700">
                                      {gapsArr.length} location/date {gapsArr.length === 1 ? "tuple" : "tuples"} still missing data
                                    </span>
                                  )}
                                </div>
                                <CoverageGapsList jobId={r.id} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
