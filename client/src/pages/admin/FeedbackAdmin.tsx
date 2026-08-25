import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RefreshCw, Send, Play, Save } from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { format } from "date-fns";
import { useEffect, useState } from "react";
import { isVideoAttachmentPath } from "@shared/attachments";

// Parse a feedback row's stored `screenshots` JSON (a list of `/objects/...`
// paths). Returns [] for null / malformed values so the card still renders.
function parseAttachmentPaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is string => typeof p === "string");
    }
  } catch {
    /* malformed — treat as no attachments */
  }
  return [];
}

interface FeedbackRetryAttempt {
  feedbackId: number;
  outcome: string;
  reason: string | null;
}

interface FeedbackRetryLastRun {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  connected: boolean;
  maxPerTick: number;
  backoffMinutes: number;
  candidates: number;
  attempted: FeedbackRetryAttempt[];
  delivered: number;
  stillFailed: number;
  errors: number;
  reason?: string;
}

interface FeedbackRetryConfig {
  enabled: boolean;
  maxPerTick: number;
  backoffMinutes: number;
  tickIntervalMinutes: number;
}

interface FeedbackRetryCaps {
  maxPerTick: number;
  backoffMinutes: number;
}

interface FeedbackRetryStatus {
  config: FeedbackRetryConfig;
  caps?: FeedbackRetryCaps;
  lastRun: FeedbackRetryLastRun | null;
  // Task #2198 — readable-vs-corrupt signal for the stored last-run summary.
  lastRunStatus?: "ok" | "never_run" | "unreadable";
  lastRunError?: string;
}

interface FeedbackRow {
  id: number;
  user_id: string;
  user_name: string;
  topic: string;
  feedback_text: string;
  current_page: string | null;
  screenshots: string | null;
  status: string | null;
  slack_status: string | null;
  slack_reason: string | null;
  slack_updated_at: string | null;
  slack_attempts: number | null;
  // Task #2409 — TwelveLabs-derived transcript + key-moment frames for any
  // uploaded feedback video (jsonb, parsed by pg into an object).
  video_analysis: FeedbackVideoAnalysis | null;
  created_at: string | null;
}

interface FeedbackVideoFrame {
  timestamp: string;
  description: string;
  url: string;
}

interface FeedbackVideoResult {
  sourcePath: string;
  status: "ready" | "failed";
  transcript: string | null;
  summary: string | null;
  frames: FeedbackVideoFrame[];
  error?: string;
}

interface FeedbackVideoAnalysis {
  status: "processing" | "ready" | "failed";
  startedAt: string;
  completedAt?: string;
  videos: FeedbackVideoResult[];
}

const TOPIC_LABELS: Record<string, string> = {
  BUG_REPORT: "Bug Report",
  FEATURE_REQUEST: "Feature Request",
  DESIGN: "Design Feedback",
  CONTENT: "Content Issue",
  OTHER: "Other",
};

// ── System-filed items (Task #4364, audit §6.1-D) ──────────────────────────
// The nightly regression sweep files feedback rows under a reserved
// `system:` submitter id (server/services/regressionSweepFeedback.ts). Those
// rows carry raw test file paths and runner output — engineer artifacts that
// shouldn't lead the card. This is DISPLAY-ONLY reframing: the pipeline
// (sentinel user_id, current_page dedupe key, auto-resolve notes appended to
// feedback_text) is untouched; the raw record stays available under a
// "Technical details" disclosure.
function isSystemFiled(row: FeedbackRow): boolean {
  return typeof row.user_id === "string" && row.user_id.startsWith("system:");
}

interface SystemItemView {
  /** Descriptive check name parsed from the sweep's first line, if present. */
  checkName: string | null;
  /** True when the item has auto-resolved (recovery note or resolved status). */
  resolved: boolean;
  /** The appended [Auto-resolved] note, without its marker prefix. */
  resolvedNote: string | null;
}

function parseSystemItem(row: FeedbackRow): SystemItemView {
  const text = row.feedback_text ?? "";
  const firstLine = text.split("\n", 1)[0] ?? "";
  const nameMatch = firstLine.match(/^Nightly regression sweep failure:\s*(.+)$/);
  const resolvedIdx = text.indexOf("[Auto-resolved]");
  return {
    checkName: nameMatch ? nameMatch[1].trim() : null,
    resolved: resolvedIdx !== -1 || row.status === "resolved",
    resolvedNote:
      resolvedIdx === -1
        ? null
        : text.slice(resolvedIdx).replace(/^\[Auto-resolved\]\s*/, "").trim() || null,
  };
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  try {
    return format(new Date(value), "yyyy-MM-dd HH:mm");
  } catch {
    return value;
  }
}

function SlackStatusBadge({ status }: { status: string | null }) {
  const s = status || "pending";
  const map: Record<string, { label: string; className: string }> = {
    delivered: { label: "Delivered to Slack", className: "bg-green-100 text-green-800 border-green-200" },
    not_connected: { label: "Slack not connected", className: "bg-red-100 text-red-800 border-red-200" },
    failed: { label: "Slack failed", className: "bg-amber-100 text-amber-800 border-amber-200" },
    undeliverable: { label: "Gave up — undeliverable", className: "bg-red-600 text-white border-red-700" },
    pending: { label: "Not yet relayed", className: "bg-gray-100 text-gray-700 border-gray-200" },
  };
  const entry = map[s] ?? map.pending;
  return (
    <Badge
      variant="outline"
      className={entry.className}
      data-testid={`badge-slack-status-${s}`}
    >
      {entry.label}
    </Badge>
  );
}

export default function FeedbackAdmin() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isFetching, refetch, error } = useQuery<FeedbackRow[]>({
    queryKey: ["/api/feedback"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/feedback");
      return res.json();
    },
  });

  const { data: retryStatus, refetch: refetchRetryStatus } =
    useQuery<FeedbackRetryStatus>({
      queryKey: ["/api/feedback/slack-retry/status"],
      queryFn: async () => {
        const res = await apiRequest("GET", "/api/feedback/slack-retry/status");
        return res.json();
      },
    });

  const [maxPerTickInput, setMaxPerTickInput] = useState<string>("");
  const [backoffInput, setBackoffInput] = useState<string>("");
  // Task #4346 — field validation is inline (FormField), never a toast.
  const [tuningErrors, setTuningErrors] = useState<{
    maxPerTick?: string;
    backoffMinutes?: string;
  }>({});

  // Read the two config primitives out first so the dependency list is
  // exact (depending on the whole `config` object would reseed the inputs
  // on every refetch even when the values are unchanged).
  const retryMaxPerTick = retryStatus?.config?.maxPerTick;
  const retryBackoffMinutes = retryStatus?.config?.backoffMinutes;
  useEffect(() => {
    if (retryMaxPerTick != null && retryBackoffMinutes != null) {
      setMaxPerTickInput(String(retryMaxPerTick));
      setBackoffInput(String(retryBackoffMinutes));
    }
  }, [retryMaxPerTick, retryBackoffMinutes]);

  const maxPerTickCap = retryStatus?.caps?.maxPerTick ?? 200;
  const backoffCap = retryStatus?.caps?.backoffMinutes ?? 24 * 60;

  const configMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (
      body: Partial<{
        enabled: boolean;
        maxPerTick: number;
        backoffMinutes: number;
      }>,
    ) => {
      const res = await apiRequest(
        "PUT",
        "/api/feedback/slack-retry/config",
        body,
      );
      return res.json() as Promise<{ ok: boolean; config: FeedbackRetryConfig }>;
    },
    onSuccess: () => {
      void refetchRetryStatus(); // fire-and-forget: refetch only
    },
    onError: (err: any) => {
      toast({
        title: "Update failed",
        description: err?.message || "Could not save the settings.",
        variant: "destructive",
      });
      void refetchRetryStatus(); // fire-and-forget: refetch only
    },
  });

  const toggleEnabled = (enabled: boolean) => {
    configMutation.mutate(
      { enabled },
      {
        onSuccess: () => {
          toast({
            title: enabled ? "Auto-resend enabled" : "Auto-resend disabled",
            description: enabled
              ? "The scheduler will re-send failed feedback to Slack."
              : "The scheduler will no longer auto-resend feedback.",
          });
        },
      },
    );
  };

  const saveTuning = () => {
    const maxPerTick = Number(maxPerTickInput);
    const backoffMinutes = Number(backoffInput);
    const nextErrors: { maxPerTick?: string; backoffMinutes?: string } = {};
    if (
      !Number.isInteger(maxPerTick) ||
      maxPerTick < 1 ||
      maxPerTick > maxPerTickCap
    ) {
      nextErrors.maxPerTick = `Enter a whole number between 1 and ${maxPerTickCap}.`;
    }
    if (
      !Number.isInteger(backoffMinutes) ||
      backoffMinutes < 0 ||
      backoffMinutes > backoffCap
    ) {
      nextErrors.backoffMinutes = `Enter a whole number between 0 and ${backoffCap}.`;
    }
    setTuningErrors(nextErrors);
    if (nextErrors.maxPerTick || nextErrors.backoffMinutes) return;
    configMutation.mutate(
      { maxPerTick, backoffMinutes },
      {
        onSuccess: () => {
          toast({
            title: "Settings saved",
            description: `Up to ${maxPerTick} per tick · ${backoffMinutes}-min backoff.`,
          });
        },
      },
    );
  };

  const tuningDirty =
    retryStatus != null &&
    (maxPerTickInput !== String(retryStatus.config.maxPerTick) ||
      backoffInput !== String(retryStatus.config.backoffMinutes));

  const runRetryMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/feedback/slack-retry/run");
      return res.json() as Promise<{ ok: boolean; result: FeedbackRetryLastRun }>;
    },
    onSuccess: (data) => {
      const r = data?.result;
      if (r && (r.delivered > 0 || r.candidates > 0)) {
        toast({
          title: "Retry tick complete",
          description: `${r.delivered} delivered, ${r.stillFailed} still failed, ${r.errors} errors (of ${r.candidates} candidates).`,
        });
      } else {
        toast({
          title: "Retry tick complete",
          description: r?.reason || "Nothing to do on this tick.",
        });
      }
      void refetchRetryStatus(); // fire-and-forget: refetch only
      void qc.invalidateQueries({ queryKey: ["/api/feedback"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Run failed",
        description: err?.message || "Could not run the retry tick.",
        variant: "destructive",
      });
    },
  });

  const retryMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/feedback/${id}/retry-slack`);
      return res.json() as Promise<{ success: boolean; slackStatus?: string; slackReason?: string | null }>;
    },
    onSuccess: (result) => {
      if (result?.slackStatus === "delivered") {
        toast({ title: "Relayed to Slack", description: "The feedback was posted to Slack." });
      } else {
        toast({
          title: "Still not relayed",
          description: result?.slackReason || "Slack did not accept the message.",
          variant: "destructive",
        });
      }
      void qc.invalidateQueries({ queryKey: ["/api/feedback"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Retry failed",
        description: err?.message || "Could not retry the Slack relay.",
        variant: "destructive",
      });
      void qc.invalidateQueries({ queryKey: ["/api/feedback"] }); // fire-and-forget: cache refresh only
    },
  });

  // Task #2206 — re-queue a single undeliverable row (reset to retryable so
  // the auto-resend scheduler picks it up again).
  const requeueMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/feedback/${id}/requeue-slack`);
      return res.json() as Promise<{ success: boolean; revived?: number }>;
    },
    onSuccess: () => {
      toast({
        title: "Re-queued",
        description: "It will be retried on the next auto-resend tick.",
      });
      void qc.invalidateQueries({ queryKey: ["/api/feedback"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Re-queue failed",
        description: err?.message || "Could not re-queue the feedback.",
        variant: "destructive",
      });
      void qc.invalidateQueries({ queryKey: ["/api/feedback"] }); // fire-and-forget: cache refresh only
    },
  });

  // Task #2206 — bulk re-queue every undeliverable row at once.
  const requeueAllMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/feedback/requeue-undeliverable");
      return res.json() as Promise<{ success: boolean; revived?: number }>;
    },
    onSuccess: (result) => {
      const n = result?.revived ?? 0;
      toast({
        title: n > 0 ? "Re-queued all" : "Nothing to re-queue",
        description:
          n > 0
            ? `${n} item${n > 1 ? "s" : ""} will be retried on the next auto-resend tick.`
            : "No undeliverable feedback found.",
      });
      void qc.invalidateQueries({ queryKey: ["/api/feedback"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Re-queue failed",
        description: err?.message || "Could not re-queue undeliverable feedback.",
        variant: "destructive",
      });
      void qc.invalidateQueries({ queryKey: ["/api/feedback"] }); // fire-and-forget: cache refresh only
    },
  });

  const allRows = data ?? [];

  // Status filter — let an operator isolate `undeliverable` (gave-up) rows
  // from failed / pending / delivered without scrolling the whole list.
  type StatusFilter = "all" | "undeliverable" | "failed" | "not_connected" | "pending" | "delivered";
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const counts = allRows.reduce(
    (acc, r) => {
      const s = (r.slack_status || "pending") as string;
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const undeliverableCount = counts.undeliverable ?? 0;

  const filterChips: { key: StatusFilter; label: string }[] = [
    { key: "all", label: `All (${allRows.length})` },
    { key: "undeliverable", label: `Undeliverable (${undeliverableCount})` },
    { key: "failed", label: `Failed (${counts.failed ?? 0})` },
    { key: "not_connected", label: `Not connected (${counts.not_connected ?? 0})` },
    { key: "pending", label: `Pending (${counts.pending ?? 0})` },
    { key: "delivered", label: `Delivered (${counts.delivered ?? 0})` },
  ];

  const rows =
    statusFilter === "all"
      ? allRows
      : allRows.filter((r) => (r.slack_status || "pending") === statusFilter);

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
      <PageHeader
        title="User Feedback"
        backHref="/"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh"
          >
            {isFetching ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1.5" />}
            Refresh
          </Button>
        }
      />

      {retryStatus && (
        <Card data-testid="card-retry-status">
          <CardContent className="py-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold" data-testid="text-retry-title">
                  Auto-resend to Slack
                </h2>
                <Badge
                  variant="outline"
                  className={
                    retryStatus.config.enabled
                      ? "bg-green-100 text-green-800 border-green-200"
                      : "bg-gray-100 text-gray-700 border-gray-200"
                  }
                  data-testid="badge-retry-enabled"
                >
                  {retryStatus.config.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={retryStatus.config.enabled}
                    onCheckedChange={toggleEnabled}
                    disabled={configMutation.isPending}
                    data-testid="switch-retry-enabled"
                  />
                  <span className="text-xs text-gray-600">
                    {retryStatus.config.enabled ? "On" : "Off"}
                  </span>
                </div>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => runRetryMutation.mutate()}
                  disabled={runRetryMutation.isPending}
                  data-testid="button-run-retry"
                >
                  {runRetryMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-1.5" />
                  )}
                  Run now
                </Button>
              </div>
            </div>

            <p className="text-xs text-gray-500" data-testid="text-retry-config">
              Runs every {retryStatus.config.tickIntervalMinutes} min · up to{" "}
              {retryStatus.config.maxPerTick} per tick · {retryStatus.config.backoffMinutes}
              -min backoff between attempts.
            </p>

            <div className="flex flex-wrap items-end gap-3 pt-1">
              <FormField
                label={`Per-tick budget (1–${maxPerTickCap})`}
                htmlFor="input-max-per-tick"
                labelClassName="text-xs text-gray-600"
                error={tuningErrors.maxPerTick}
                className="space-y-1"
              >
                <Input
                  id="input-max-per-tick"
                  type="number"
                  min={1}
                  max={maxPerTickCap}
                  step={1}
                  value={maxPerTickInput}
                  onChange={(e) => {
                    setMaxPerTickInput(e.target.value);
                    setTuningErrors((prev) =>
                      prev.maxPerTick ? { ...prev, maxPerTick: undefined } : prev,
                    );
                  }}
                  disabled={configMutation.isPending}
                  className="h-8 w-28"
                  data-testid="input-max-per-tick"
                />
              </FormField>
              <FormField
                label={`Backoff minutes (0–${backoffCap})`}
                htmlFor="input-backoff-minutes"
                labelClassName="text-xs text-gray-600"
                error={tuningErrors.backoffMinutes}
                className="space-y-1"
              >
                <Input
                  id="input-backoff-minutes"
                  type="number"
                  min={0}
                  max={backoffCap}
                  step={1}
                  value={backoffInput}
                  onChange={(e) => {
                    setBackoffInput(e.target.value);
                    setTuningErrors((prev) =>
                      prev.backoffMinutes
                        ? { ...prev, backoffMinutes: undefined }
                        : prev,
                    );
                  }}
                  disabled={configMutation.isPending}
                  className="h-8 w-28"
                  data-testid="input-backoff-minutes"
                />
              </FormField>
              <Button
                variant="outline"
                size="sm"
                onClick={saveTuning}
                disabled={configMutation.isPending || !tuningDirty}
                data-testid="button-save-tuning"
              >
                {configMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-1.5" />
                )}
                Save
              </Button>
            </div>

            {retryStatus.lastRun ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
                  <span data-testid="text-retry-last-ran">
                    Last run: {fmtDate(retryStatus.lastRun.ranAt)}
                  </span>
                  <span
                    className={
                      retryStatus.lastRun.connected
                        ? "text-green-700"
                        : "text-amber-700"
                    }
                    data-testid="text-retry-connected"
                  >
                    Slack {retryStatus.lastRun.connected ? "connected" : "not reachable"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700">
                  <span data-testid="text-retry-candidates">
                    {retryStatus.lastRun.candidates} candidate(s)
                  </span>
                  <span className="text-green-700" data-testid="text-retry-delivered">
                    {retryStatus.lastRun.delivered} delivered
                  </span>
                  <span className="text-amber-700" data-testid="text-retry-still-failed">
                    {retryStatus.lastRun.stillFailed} still failed
                  </span>
                  <span className="text-red-700" data-testid="text-retry-errors">
                    {retryStatus.lastRun.errors} errors
                  </span>
                </div>
                {retryStatus.lastRun.reason && (
                  <p className="text-xs text-gray-500" data-testid="text-retry-reason">
                    {retryStatus.lastRun.reason}
                  </p>
                )}
              </div>
            ) : retryStatus.lastRunStatus === "unreadable" ? (
              /* Task #2245 — a corrupt stored last-run record must read as a
                 warning, not the calm "never run" state, so a persistence bug
                 isn't mistaken for an idle job. */
              <div
                className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
                data-testid="text-retry-last-run-unreadable"
              >
                ⚠ The stored last-run record could not be read — this usually
                means the saved value is corrupt (a persistence bug), not that
                the resend has never run. Check the server logs.
                {typeof retryStatus.lastRunError === "string" ? (
                  <span className="mt-0.5 block font-mono text-[10px] text-amber-700">
                    {retryStatus.lastRunError}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-gray-500" data-testid="text-retry-never-run">
                Has not run yet.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && allRows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-slack-status">
            {filterChips.map((chip) => (
              <Button
                key={chip.key}
                variant={statusFilter === chip.key ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setStatusFilter(chip.key)}
                data-testid={`filter-${chip.key}`}
              >
                {chip.label}
              </Button>
            ))}
          </div>
          {undeliverableCount > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => requeueAllMutation.mutate()}
              disabled={requeueAllMutation.isPending}
              data-testid="button-requeue-all"
            >
              {requeueAllMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-1.5" />
              )}
              Re-queue all undeliverable ({undeliverableCount})
            </Button>
          )}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500" data-testid="status-loading">
          <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading feedback…
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="py-6 text-red-700" data-testid="status-error">
            Could not load feedback. Please try again.
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-gray-500" data-testid="status-empty">
            No feedback yet.
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {rows.map((row) => {
          const slackStatus = row.slack_status || "pending";
          const needsRetry = slackStatus !== "delivered";
          return (
            <Card key={row.id} data-testid={`card-feedback-${row.id}`}>
              <CardContent className="py-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" data-testid={`badge-topic-${row.id}`}>
                    {TOPIC_LABELS[row.topic] || row.topic}
                  </Badge>
                  {isSystemFiled(row) && (
                    <Badge variant="outline" data-testid={`badge-system-${row.id}`}>
                      Automated
                    </Badge>
                  )}
                  <span className="text-sm font-medium" data-testid={`text-user-${row.id}`}>
                    {row.user_name}
                  </span>
                  <span className="text-xs text-gray-400">
                    {fmtDate(row.created_at)}
                  </span>
                  {/* The where-it-came-from column is a test file path on
                      system rows — engineer detail, kept under the
                      disclosure below instead of the header. */}
                  {row.current_page && !isSystemFiled(row) && (
                    <span className="text-xs text-gray-400 font-mono">{row.current_page}</span>
                  )}
                </div>

                {isSystemFiled(row) ? (
                  (() => {
                    const sys = parseSystemItem(row);
                    return (
                      <div className="space-y-1" data-testid={`system-summary-${row.id}`}>
                        <p className="text-sm text-gray-800">
                          {sys.checkName ? (
                            <>
                              The automated check{" "}
                              <span className="font-medium">&ldquo;{sys.checkName}&rdquo;</span>{" "}
                              {sys.resolved
                                ? "failed on a recent nightly run and has since recovered."
                                : "is failing its nightly run."}
                            </>
                          ) : sys.resolved ? (
                            "An automated nightly check failed and has since recovered."
                          ) : (
                            "An automated nightly check is failing."
                          )}
                        </p>
                        <p className="text-xs text-gray-500">
                          {sys.resolved
                            ? sys.resolvedNote ||
                              "Resolved automatically once the check passed again."
                            : "Filed by the nightly test sweep. It stays open while the check keeps failing and clears itself once the check passes again."}
                        </p>
                        <details className="pt-1" data-testid={`details-technical-${row.id}`}>
                          <summary className="cursor-pointer text-xs font-medium text-gray-600">
                            Technical details
                          </summary>
                          <p
                            className="mt-1 whitespace-pre-wrap font-mono text-xs text-gray-600"
                            data-testid={`text-feedback-${row.id}`}
                          >
                            {row.feedback_text}
                          </p>
                        </details>
                      </div>
                    );
                  })()
                ) : (
                  <p className="text-sm text-gray-800 whitespace-pre-wrap" data-testid={`text-feedback-${row.id}`}>
                    {row.feedback_text}
                  </p>
                )}

                {(() => {
                  const attachments = parseAttachmentPaths(row.screenshots);
                  if (attachments.length === 0) return null;
                  return (
                    <div
                      className="flex flex-wrap gap-2 pt-1"
                      data-testid={`attachments-${row.id}`}
                    >
                      {attachments.map((path, i) => {
                        // Stream through the admin-gated endpoint (feedback
                        // uploads carry no object ACL, so the generic
                        // /objects route would 403). The path is validated
                        // server-side against this row's attachment list.
                        const src = `/api/feedback/${row.id}/attachment?path=${encodeURIComponent(path)}`;
                        if (isVideoAttachmentPath(path)) {
                          return (
                            <video
                              key={i}
                              src={src}
                              controls
                              preload="metadata"
                              className="h-40 max-w-full rounded border bg-black"
                              data-testid={`video-attachment-${row.id}-${i}`}
                            />
                          );
                        }
                        return (
                          <a
                            key={i}
                            href={src}
                            target="_blank"
                            rel="noreferrer"
                            className="block h-24 w-24 overflow-hidden rounded border"
                            data-testid={`image-attachment-${row.id}-${i}`}
                          >
                            <img
                              src={src}
                              alt="feedback attachment"
                              className="h-full w-full object-cover"
                            />
                          </a>
                        );
                      })}
                    </div>
                  );
                })()}

                {(() => {
                  // Task #2409 — auto-extracted transcript + key-moment frames
                  // for any uploaded video, so a reviewer (or the planning
                  // agent reading this record) can act on the video without
                  // replaying it.
                  const va = row.video_analysis;
                  if (!va) return null;
                  return (
                    <div
                      className="space-y-3 rounded border bg-muted/30 p-3"
                      data-testid={`video-analysis-${row.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                          Video analysis
                        </span>
                        <span
                          className="text-[11px] text-gray-500"
                          data-testid={`video-analysis-status-${row.id}`}
                        >
                          {va.status === "processing"
                            ? "Processing…"
                            : va.status === "ready"
                              ? "Ready"
                              : "Failed"}
                        </span>
                      </div>
                      {va.videos.map((video, vi) => (
                        <div key={vi} className="space-y-2 border-t pt-2 first:border-t-0 first:pt-0">
                          {video.status === "failed" && (
                            <p
                              className="text-xs text-red-600"
                              data-testid={`video-analysis-error-${row.id}-${vi}`}
                            >
                              {video.error || "Processing failed"}
                            </p>
                          )}
                          {video.summary && (
                            <p
                              className="text-xs text-gray-700"
                              data-testid={`video-summary-${row.id}-${vi}`}
                            >
                              {video.summary}
                            </p>
                          )}
                          {video.transcript && (
                            <details data-testid={`video-transcript-${row.id}-${vi}`}>
                              <summary className="cursor-pointer text-xs font-medium text-gray-600">
                                Transcript
                              </summary>
                              <p className="mt-1 whitespace-pre-wrap text-xs text-gray-600">
                                {video.transcript}
                              </p>
                            </details>
                          )}
                          {video.frames.length > 0 && (
                            <div
                              className="flex flex-wrap gap-2"
                              data-testid={`video-frames-${row.id}-${vi}`}
                            >
                              {video.frames.map((frame, fi) => (
                                <a
                                  key={fi}
                                  href={frame.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={`${frame.timestamp} — ${frame.description}`}
                                  className="block h-20 w-20 overflow-hidden rounded border"
                                  data-testid={`video-frame-${row.id}-${vi}-${fi}`}
                                >
                                  <img
                                    src={frame.url}
                                    alt={frame.description || "video frame"}
                                    className="h-full w-full object-cover"
                                  />
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })()}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex flex-col gap-0.5">
                    <SlackStatusBadge status={slackStatus} />
                    {row.slack_reason && slackStatus !== "delivered" && (
                      <span className="text-xs text-gray-500" data-testid={`text-slack-reason-${row.id}`}>
                        {row.slack_reason}
                      </span>
                    )}
                    {slackStatus !== "delivered" && (row.slack_attempts ?? 0) > 0 && (
                      <span className="text-[11px] text-gray-400" data-testid={`text-slack-attempts-${row.id}`}>
                        {row.slack_attempts} failed attempt{(row.slack_attempts ?? 0) > 1 ? "s" : ""}
                      </span>
                    )}
                    {row.slack_updated_at && (
                      <span className="text-[11px] text-gray-400">
                        Last attempt: {fmtDate(row.slack_updated_at)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {slackStatus === "undeliverable" && (
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => requeueMutation.mutate(row.id)}
                        disabled={requeueMutation.isPending}
                        data-testid={`button-requeue-slack-${row.id}`}
                      >
                        {requeueMutation.isPending && requeueMutation.variables === row.id ? (
                          <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4 mr-1.5" />
                        )}
                        Re-queue
                      </Button>
                    )}
                    <Button
                      variant={needsRetry && slackStatus !== "undeliverable" ? "default" : "outline"}
                      size="sm"
                      onClick={() => retryMutation.mutate(row.id)}
                      disabled={retryMutation.isPending}
                      data-testid={`button-retry-slack-${row.id}`}
                    >
                      {retryMutation.isPending && retryMutation.variables === row.id ? (
                        <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4 mr-1.5" />
                      )}
                      {needsRetry ? "Retry Slack" : "Re-send to Slack"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
