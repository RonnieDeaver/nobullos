import { useAuth } from "@/hooks/use-auth";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/kit/StatusPill";
import { EmptyState } from "@/components/kit/EmptyState";
import { Link } from "wouter";
import { ArrowLeft, Phone, RefreshCw, RotateCcw, Copy, Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { partitionStaleFailures, STALE_FAILURE_DAYS } from "@/lib/callAnalysisStaleFailures";

// Task #1077: when the operational health failure-mix drill-down opens
// a job here it passes ?analysisId=<id>; we scroll to and highlight
// that row so the operator lands on the exact broken call.
function useAnalysisIdFromQuery(): string | null {
  const [id, setId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("analysisId");
  });
  useEffect(() => {
    const onPop = () => {
      setId(new URLSearchParams(window.location.search).get("analysisId"));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return id;
}

type CallAnalysisJob = {
  analysis_id: string;
  external_id: string;
  audio_url: string | null;
  rev_transcript_json: any | null;
  max_listen_seconds: number | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  result: {
    pickupTimeSeconds: number | null;
    timeToHumanSeconds: number | null;
    finalClassification: string;
    confidence: number;
    evidence: string;
    detectedLanguage?: string;
    callDurationSeconds?: number | null;
  } | null;
  error_message: string | null;
};

export default function CallAnalysis() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Call Analysis");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const highlightAnalysisId = useAnalysisIdFromQuery();
  const highlightRowRef = useRef<HTMLTableRowElement | null>(null);

  const copyJobInputs = async (job: CallAnalysisJob) => {
    const inputs: Record<string, any> = {
      analysis_id: job.analysis_id,
      external_id: job.external_id,
      status: job.status,
    };
    if (job.audio_url) inputs.audio_url = job.audio_url;
    if (job.rev_transcript_json) inputs.rev_transcript_json = job.rev_transcript_json;
    if (job.max_listen_seconds != null) inputs.max_listen_seconds = job.max_listen_seconds;
    if (job.result) inputs.result = job.result;
    if (job.error_message) inputs.error_message = job.error_message;

    await navigator.clipboard.writeText(JSON.stringify(inputs, null, 2));
    setCopiedId(job.analysis_id);
    toast({ title: "Job data copied to clipboard" });
    setTimeout(() => setCopiedId(null), 2000);
  };

  const { data: jobsData, isLoading } = useQuery<{ data: CallAnalysisJob[], page: number, limit: number }>({
    queryKey: ["/api/ceo-tools/call-analysis"],
    refetchInterval: 5000,
  });

  // Memoized so the `jobs` useMemo below doesn't see a fresh array identity
  // on every render while the query has no data yet.
  const pageJobs = useMemo(() => jobsData?.data || [], [jobsData?.data]);

  // Task #1093: when the deep-linked job isn't on the currently loaded page,
  // fetch it by id so we can still render and highlight the row.
  const isOnPage = highlightAnalysisId
    ? pageJobs.some((j) => j.analysis_id === highlightAnalysisId)
    : true;
  const { data: deepLinkedJob } = useQuery<CallAnalysisJob>({
    queryKey: ["/api/ceo-tools/call-analysis", highlightAnalysisId],
    enabled: !!highlightAnalysisId && !isOnPage && !isLoading,
    refetchInterval: 5000,
  });

  const jobs: CallAnalysisJob[] = useMemo(
    () =>
      highlightAnalysisId && !isOnPage && deepLinkedJob
        ? [deepLinkedJob, ...pageJobs]
        : pageJobs,
    [highlightAnalysisId, isOnPage, deepLinkedJob, pageJobs],
  );

  // Task #4466: collapse stale failures (older than STALE_FAILURE_DAYS or
  // superseded by a later successful run) so months-old red rows don't bury
  // fresh results. Operators can expand them on demand; a deep-linked job
  // that lives in the collapsed group auto-expands it.
  const [showStaleFailures, setShowStaleFailures] = useState(false);
  const { fresh: freshJobs, staleFailures } = useMemo(
    () => partitionStaleFailures(jobs),
    [jobs],
  );
  const highlightIsStale =
    !!highlightAnalysisId &&
    staleFailures.some((j) => j.analysis_id === highlightAnalysisId);
  useEffect(() => {
    if (highlightIsStale) setShowStaleFailures(true);
  }, [highlightIsStale]);

  // Task #1077: scroll the highlighted row into view once it renders.
  useEffect(() => {
    if (!highlightAnalysisId) return;
    if (!jobs.some((j) => j.analysis_id === highlightAnalysisId)) return;
    const node = highlightRowRef.current;
    if (node) {
      node.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
    }
  }, [highlightAnalysisId, jobs]);

  const hasMissingDurations = jobs.some(j => j.status === "complete" && j.result && j.result.callDurationSeconds == null);

  const rerunMutation = useMutation({
    mutationFn: async (analysisId: string) => {
      const res = await fetch(`/api/ceo-tools/call-analysis/${analysisId}/rerun`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Rerun failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Job queued for re-analysis" });
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-tools/call-analysis"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to rerun job", variant: "destructive" });
    },
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ceo-tools/call-analysis/backfill-duration", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error("Backfill failed");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: data.message });
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-tools/call-analysis"] }); // fire-and-forget: cache refresh only
    },
    onError: () => {
      toast({ title: "Failed to backfill durations", variant: "destructive" });
    },
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "queued":
        return <StatusPill>Queued</StatusPill>;
      case "processing":
        return <StatusPill tone="info" dot>Processing</StatusPill>;
      case "complete":
        return <StatusPill>Complete</StatusPill>;
      case "failed":
        return <StatusPill tone="critical">Failed</StatusPill>;
      default:
        return <StatusPill>{status}</StatusPill>;
    }
  };

  const getClassificationBadge = (classification: string, result?: any) => {
    // At-rest classifications stay neutral; only review-required rows carry a warn accent.
    const tone: "warn" | "neutral" = result?.reviewRequired ? "warn" : "neutral";
    const dot = !!result?.reviewRequired;
    const pill = (text: string) => (
      <StatusPill tone={tone} dot={dot} title={dot ? "Review required" : undefined}>
        {text}
      </StatusPill>
    );
    switch (classification) {
      case "human":
        return pill("Human Answered");
      case "system_message_then_human":
        return pill("Human (Sys Msg)");
      case "voicemail":
        return pill("Voicemail");
      case "ivr_menu":
        return pill("IVR Menu");
      case "ivr_queue":
        return pill("IVR Queue");
      case "ivr_no_human":
        return pill("IVR Menu");
      default:
        return pill("Unknown");
    }
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100dvh-var(--nav-height))]">
        <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100dvh-var(--nav-height))]">
        <p className="text-muted-foreground">Access denied. CEO or Team Lead role required.</p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <header className="bg-card border-b border-border sticky top-14 z-10">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-3 sm:py-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <Button asChild variant="ghost" size="sm" className="shrink-0" data-testid="button-back">
              <Link href="/">
                <ArrowLeft className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
            </Button>
            <h1 className="text-base sm:text-xl font-semibold text-foreground truncate">Call Answer Time Analyzer</h1>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
        <Card data-testid="card-call-analysis">
          <CardHeader>
            {/* The backfill button sits beside (not inside) CardDescription:
                CardDescription renders a <p>, and nesting a <button> in it is
                invalid DOM that browsers may re-parent. */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <CardTitle className="flex items-center gap-2">
                  <Phone className="w-5 h-5 text-primary" />
                  Call Analysis Jobs
                </CardTitle>
                <CardDescription>
                  Track how quickly calls are answered and classified (human, voicemail, IVR)
                </CardDescription>
              </div>
              {hasMissingDurations && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => backfillMutation.mutate()}
                  disabled={backfillMutation.isPending}
                  data-testid="button-backfill-durations"
                >
                  {backfillMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : null}
                  Fill Missing Call Lengths
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8" data-testid="loading-call-analysis">
                <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : jobs.length === 0 ? (
              <EmptyState
                icon={<Phone />}
                title="No call analysis jobs yet"
                description="Jobs are created via the CEO Tools API"
                testId="empty-call-analysis"
              />
            ) : (
              <div className="max-h-[65vh] overflow-auto" data-testid="table-call-analysis">
                {/* Bounded viewport with a sticky header so long job lists scroll
                    inside the card instead of stretching the page. */}
                <table className="w-full text-sm">
                  {/* No z-index needed: rows contain only static content, and a
                      positioned (sticky) thead paints above static cells by default. */}
                  <thead className="sticky top-0 bg-card shadow-[inset_0_-1px_0_hsl(var(--border))]">
                    <tr>
                      <th className="text-left py-2 px-2 font-medium">External ID</th>
                      <th className="text-center py-2 px-2 font-medium">Status</th>
                      <th className="text-center py-2 px-2 font-medium">Classification</th>
                      <th className="text-center py-2 px-2 font-medium">Call Length</th>
                      <th className="text-center py-2 px-2 font-medium">Time to Human</th>
                      <th className="text-center py-2 px-2 font-medium">Language</th>
                      <th className="text-center py-2 px-2 font-medium">Confidence</th>
                      <th className="text-left py-2 px-2 font-medium">Created</th>
                      <th className="text-center py-2 px-2 font-medium">Copy</th>
                      <th className="text-center py-2 px-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ...freshJobs,
                      ...(showStaleFailures ? staleFailures : []),
                    ].map((job) => {
                      const isHighlighted = highlightAnalysisId === job.analysis_id;
                      return (
                      <tr
                        key={job.analysis_id}
                        ref={isHighlighted ? highlightRowRef : undefined}
                        className={`border-b hover:bg-muted/50 ${isHighlighted ? "bg-status-warn/10 ring-2 ring-status-warn/40" : ""}`}
                        data-testid={`row-call-analysis-${job.analysis_id}`}
                        data-highlighted={isHighlighted ? "true" : undefined}
                      >
                        <td className="py-2 px-2 font-mono text-xs truncate max-w-[120px]" data-testid={`text-external-id-${job.analysis_id}`}>
                          {job.external_id}
                        </td>
                        <td className="text-center py-2 px-2" data-testid={`status-call-${job.analysis_id}`}>
                          {getStatusBadge(job.status)}
                        </td>
                        <td className="text-center py-2 px-2" data-testid={`classification-call-${job.analysis_id}`}>
                          {job.result ? getClassificationBadge(job.result.finalClassification, job.result) : "-"}
                        </td>
                        <td className="text-center py-2 px-2" data-testid={`call-length-${job.analysis_id}`}>
                          {job.result?.callDurationSeconds != null
                            ? `${Math.floor(job.result.callDurationSeconds / 60)}m ${Math.round(job.result.callDurationSeconds % 60)}s`
                            : "-"}
                        </td>
                        <td className="text-center py-2 px-2" data-testid={`time-to-human-${job.analysis_id}`}>
                          {job.result?.timeToHumanSeconds !== null && job.result?.timeToHumanSeconds !== undefined
                            ? `${job.result.timeToHumanSeconds.toFixed(1)}s`
                            : "-"}
                        </td>
                        <td className="text-center py-2 px-2 capitalize" data-testid={`language-${job.analysis_id}`}>
                          {job.result?.detectedLanguage || "-"}
                        </td>
                        <td className="text-center py-2 px-2" data-testid={`confidence-${job.analysis_id}`}>
                          {job.result
                            ? `${(job.result.confidence * 100).toFixed(0)}%`
                            : "-"}
                        </td>
                        <td className="py-2 px-2 text-muted-foreground text-xs" data-testid={`created-at-${job.analysis_id}`}>
                          {job.created_at
                            ? new Date(job.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                            : "-"}
                        </td>
                        <td className="text-center py-2 px-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => copyJobInputs(job)}
                            data-testid={`button-copy-${job.analysis_id}`}
                            title="Copy all job data to clipboard"
                            aria-label="Copy all job data to clipboard"
                          >
                            {copiedId === job.analysis_id
                              ? <Check className="w-3.5 h-3.5 text-status-ok" />
                              : <Copy className="w-3.5 h-3.5" />}
                          </Button>
                        </td>
                        <td className="text-center py-2 px-2">
                          {job.status === "complete" || job.status === "failed" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => rerunMutation.mutate(job.analysis_id)}
                              disabled={rerunMutation.isPending}
                              data-testid={`button-rerun-${job.analysis_id}`}
                              title="Re-analyze this call"
                              aria-label="Re-analyze this call"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                      );
                    })}
                    {staleFailures.length > 0 && (
                      <tr className="border-b" data-testid="row-stale-failures-toggle">
                        <td colSpan={10} className="py-2 px-2 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground"
                            onClick={() => setShowStaleFailures((v) => !v)}
                            data-testid="button-toggle-stale-failures"
                            title={`Failed jobs older than ${STALE_FAILURE_DAYS} days or superseded by a later successful run`}
                          >
                            {showStaleFailures
                              ? `Hide ${staleFailures.length} older failure${staleFailures.length === 1 ? "" : "s"}`
                              : `Show ${staleFailures.length} older failure${staleFailures.length === 1 ? "" : "s"}`}
                          </Button>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-6 p-4 bg-muted/40 space-y-4">
              <h4 className="font-medium">API Usage</h4>
              
              <div>
                <p className="text-sm text-muted-foreground mb-2">Endpoint:</p>
                <code className="block bg-muted p-2 rounded text-xs">POST /api/ceo-tools/call-analysis</code>
              </div>
              
              <div>
                <p className="text-sm text-muted-foreground mb-2">Request Body (with transcript URL only):</p>
                <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
{`{
  "external_id": "call_123",
  "rev_transcript_url": "https://drive.google.com/uc?id=xxx&export=download"
}`}
                </pre>
              </div>
              
              <div className="text-sm text-muted-foreground space-y-1">
                <p><strong>external_id</strong>: Required - your unique ID for this call</p>
                <p><strong>rev_transcript_url</strong>: URL to Rev.com transcript JSON (Google Drive supported)</p>
                <p><strong>rev_transcript_json</strong>: Or pass the transcript JSON directly</p>
                <p><strong>audio_url</strong>: Optional - only needed if no transcript provided (for Whisper transcription)</p>
                <p><strong>max_listen_seconds</strong>: Optional - limit analysis to first N seconds</p>
              </div>
              
              <div className="text-sm text-muted-foreground border-t pt-3">
                <p><strong>Google Drive:</strong> Files must be shared as "Anyone with the link can view"</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
