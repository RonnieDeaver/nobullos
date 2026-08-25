// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Queue-drain control health domain: per-queue drain state (pause/resume/
// rate-limit/cancel), drain action history, and paused-queue backlog alerts.
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DangerZone } from "@/components/kit/DangerZone";
import { RefreshCw, Save } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { QueueDrainQuickAdd } from "./QueueDrainQuickAdd";

  // Task #987: per-queue drain control (pause/resume/rate-limit/cancel).
  type QueueDrainEntry = {
    queueName: string;
    paused: boolean;
    ratePerMinute: number | null;
    updatedAt: string;
    updatedBy: string | null;
    pendingJobs: number;
    recentDispatches: number;
    // Task #998 / #1012 — pause-time baseline used by the backlog-growth
    // alert watcher. Null on queues paused before #998 or running queues.
    pausedAt: string | null;
    pausedAtBacklog: number | null;
    // Task #1784 — operator-provided free-form note explaining *why* the
    // queue is paused. Cleared on resume.
    pauseNote: string | null;
  };

  // Task #997: drain action history with queue + action filters.
  type QueueDrainHistoryAction =
    | "queue_paused"
    | "queue_resumed"
    | "queue_rate_limit_set"
    | "queue_pending_cancelled";
  type QueueDrainHistoryDetails =
    | { paused: { before: boolean; after: boolean }; pausedAtBacklog?: number }
    | { ratePerMinute: { before: number | null; after: number | null } }
    | { cancelled: number; limit: number };
  type QueueDrainHistoryEntry = {
    id: string;
    queueName: string;
    action: QueueDrainHistoryAction;
    actor: string | null;
    at: string;
    details: QueueDrainHistoryDetails;
  };

  // Task #1012: paused-queue backlog alert config + recent alert history.
  type BacklogAlertConfig = {
    enabled: boolean;
    hoursThreshold: number;
    growthThreshold: number;
    cooldownMinutes: number;
  };
  type BacklogAlertEvent = {
    id: string;
    createdAt: string;
    status: string;
    channelName: string | null;
    errorMessage: string | null;
    queueName: string | null;
    pausedAt: string | null;
    pausedAtBacklog: number | null;
    currentPending: number | null;
    growth: number | null;
    hoursPaused: number | null;
  };

// All queries/mutations/state for the queue-drain domain. Called
// unconditionally by HealthDashboardSection in the same hook-sequence
// position as the original inline block, so query mounting, polling, and
// refetch behavior are unchanged by the F11D split.
export function useQueueDrainDomain({
  isAdmin,
  isTabVisible,
  pollingInterval,
}: {
  isAdmin: boolean;
  isTabVisible: boolean;
  pollingInterval: number;
}) {
  const { toast } = useToast();

  const {
    data: queueDrainData,
    refetch: refetchQueueDrain,
  } = useQuery<{ queues: QueueDrainEntry[] }>({
    queryKey: ["/api/admin/queue-control"],
    enabled: isAdmin,
    refetchInterval: isTabVisible ? pollingInterval : false,
  });

  const [rateInputs, setRateInputs] = useState<Record<string, string>>({});
  const [cancelInputs, setCancelInputs] = useState<Record<string, string>>({});

  const [historyQueueFilter, setHistoryQueueFilter] = useState<string>("");
  const [historyActionFilter, setHistoryActionFilter] = useState<string>("");
  const historyQueryParams = new URLSearchParams();
  if (historyQueueFilter) historyQueryParams.set("queueName", historyQueueFilter);
  if (historyActionFilter) historyQueryParams.set("action", historyActionFilter);
  historyQueryParams.set("limit", "50");
  const historyQs = historyQueryParams.toString();
  const {
    data: queueDrainHistoryData,
    refetch: refetchQueueDrainHistory,
  } = useQuery<{ entries: QueueDrainHistoryEntry[] }>({
    queryKey: ["/api/admin/queue-control/history", historyQs],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/queue-control/history?${historyQs}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: isAdmin,
    refetchInterval: isTabVisible ? pollingInterval : false,
  });

  // Task #1784: per-queue optional pause-note input. The note is sent
  // with the pause request and rendered next to the queue's pause
  // badge so operators can see *why* it was paused.
  const [pauseNoteInputs, setPauseNoteInputs] = useState<Record<string, string>>({});

  const setQueuePauseMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: {
      queueName: string;
      paused: boolean;
      note?: string | null;
    }) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/queue-control/${encodeURIComponent(payload.queueName)}/${payload.paused ? "pause" : "resume"}`,
        payload.paused && payload.note ? { note: payload.note } : undefined,
      );
      return res.json();
    },
    onSuccess: (_data, vars) => {
      void refetchQueueDrain();
      void refetchQueueDrainHistory();
      if (vars.paused) {
        setPauseNoteInputs((prev) => {
          const next = { ...prev };
          delete next[vars.queueName];
          return next;
        });
      }
      toast({ title: `Queue ${vars.paused ? "paused" : "resumed"}`, description: vars.queueName });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update queue", description: err.message, variant: "destructive" });
    },
  });

  const setRateLimitMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: { queueName: string; jobsPerMinute: number | null }) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/queue-control/${encodeURIComponent(payload.queueName)}/rate-limit`,
        { jobsPerMinute: payload.jobsPerMinute },
      );
      return res.json();
    },
    onSuccess: (_data, vars) => {
      void refetchQueueDrain();
      void refetchQueueDrainHistory();
      toast({
        title: vars.jobsPerMinute === null ? "Rate limit cleared" : "Rate limit updated",
        description: `${vars.queueName}${vars.jobsPerMinute !== null ? ` → ${vars.jobsPerMinute}/min` : ""}`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to set rate limit", description: err.message, variant: "destructive" });
    },
  });

  const cancelPendingMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: { queueName: string; limit: number }) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/queue-control/${encodeURIComponent(payload.queueName)}/cancel-pending`,
        { limit: payload.limit },
      );
      return res.json();
    },
    onSuccess: (data, vars) => {
      void refetchQueueDrain();
      void refetchQueueDrainHistory();
      toast({
        title: "Pending jobs cancelled",
        description: `${vars.queueName}: ${data?.cancelled ?? 0} cancelled`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to cancel pending", description: err.message, variant: "destructive" });
    },
  });

  const {
    data: backlogAlertData,
    refetch: refetchBacklogAlerts,
  } = useQuery<{ config: BacklogAlertConfig; recent: BacklogAlertEvent[] }>({
    queryKey: ["/api/admin/queue-control/backlog-alerts"],
    enabled: isAdmin,
    refetchInterval: isTabVisible ? pollingInterval : false,
  });

  const [backlogAlertForm, setBacklogAlertForm] = useState<{
    enabled: boolean;
    hoursThreshold: string;
    growthThreshold: string;
    cooldownMinutes: string;
  } | null>(null);
  // Sync the form with the loaded config the first time, and whenever the
  // server-side config changes outside this card (e.g. via system_settings
  // edit). Operator edits don't get clobbered because we only reset when
  // the deep-equal config differs from what the form was initialized with.
  const lastSyncedConfigRef = useRef<BacklogAlertConfig | null>(null);
  useEffect(() => {
    const cfg = backlogAlertData?.config;
    if (!cfg) return;
    const prev = lastSyncedConfigRef.current;
    const changed =
      !prev ||
      prev.enabled !== cfg.enabled ||
      prev.hoursThreshold !== cfg.hoursThreshold ||
      prev.growthThreshold !== cfg.growthThreshold ||
      prev.cooldownMinutes !== cfg.cooldownMinutes;
    if (changed) {
      lastSyncedConfigRef.current = cfg;
      setBacklogAlertForm({
        enabled: cfg.enabled,
        hoursThreshold: String(cfg.hoursThreshold),
        growthThreshold: String(cfg.growthThreshold),
        cooldownMinutes: String(cfg.cooldownMinutes),
      });
    }
  }, [backlogAlertData?.config, lastSyncedConfigRef]);

  const updateBacklogAlertConfigMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: {
      enabled: boolean;
      hoursThreshold: number;
      growthThreshold: number;
      cooldownMinutes: number;
    }) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/queue-control/backlog-alerts/config",
        payload,
      );
      return res.json();
    },
    onSuccess: () => {
      void refetchBacklogAlerts();
      toast({ title: "Backlog alert thresholds saved" });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to save backlog alert thresholds",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Task #1013: send a sample paused-queue backlog alert through the
  // unified Slack dispatcher so admins can verify the channel + format
  // without waiting for a real incident.
  const sendBacklogAlertTestMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/queue-control/backlog-alerts/test",
        {},
      );
      return res.json() as Promise<{
        ok: boolean;
        channelId?: string | null;
        deliveryId?: string | null;
        error?: string;
        status?: string;
      }>;
    },
    onSuccess: (data) => {
      void refetchBacklogAlerts();
      if (data?.ok) {
        toast({
          title: "Test alert sent",
          description: data.channelId
            ? `Delivered to channel ${data.channelId}. Check Slack.`
            : "Delivered. Check Slack.",
        });
      } else {
        toast({
          title: "Test alert not delivered",
          description: data?.error ?? data?.status ?? "Dispatcher skipped the send.",
          variant: "destructive",
        });
      }
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to send test alert",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return {
    queueDrainData,
    refetchQueueDrain,
    rateInputs,
    setRateInputs,
    cancelInputs,
    setCancelInputs,
    historyQueueFilter,
    setHistoryQueueFilter,
    historyActionFilter,
    setHistoryActionFilter,
    queueDrainHistoryData,
    refetchQueueDrainHistory,
    pauseNoteInputs,
    setPauseNoteInputs,
    setQueuePauseMutation,
    setRateLimitMutation,
    cancelPendingMutation,
    backlogAlertData,
    refetchBacklogAlerts,
    backlogAlertForm,
    setBacklogAlertForm,
    updateBacklogAlertConfigMutation,
    sendBacklogAlertTestMutation,
  };
}

export type QueueDrainDomain = ReturnType<typeof useQueueDrainDomain>;

export function QueueDrainControlCard({ domain }: { domain: QueueDrainDomain }) {
  // Task #4357: bulk-cancel moved out of the per-queue rows into a
  // DangerZone below the table — the cancel input+button cell was visually
  // identical to the routine rate-cap cell right beside it (misclick
  // hazard). Local form state for that zone lives here, not in the domain
  // hook, so the domain contract (query mount order) is unchanged.
  const [cancelQueue, setCancelQueue] = useState("");
  const [cancelLimitInput, setCancelLimitInput] = useState("");
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  // Task #4420 — field validation is inline (FormField), never a toast.
  const [rateErrors, setRateErrors] = useState<Record<string, string | undefined>>({});
  const [cancelLimitError, setCancelLimitError] = useState<string | null>(null);
  const [backlogAlertErrors, setBacklogAlertErrors] = useState<{
    hours?: string;
    growth?: string;
    cooldown?: string;
  }>({});
  const {
    queueDrainData,
    refetchQueueDrain,
    rateInputs,
    setRateInputs,
    historyQueueFilter,
    setHistoryQueueFilter,
    historyActionFilter,
    setHistoryActionFilter,
    queueDrainHistoryData,
    refetchQueueDrainHistory,
    pauseNoteInputs,
    setPauseNoteInputs,
    setQueuePauseMutation,
    setRateLimitMutation,
    cancelPendingMutation,
    backlogAlertData,
    refetchBacklogAlerts,
    backlogAlertForm,
    setBacklogAlertForm,
    updateBacklogAlertConfigMutation,
    sendBacklogAlertTestMutation,
  } = domain;
  return (
            <Card data-testid="card-queue-drain-control">
              <CardHeader>
                <CardTitle className="text-foreground">Queue Drain Control</CardTitle>
                <CardDescription>
                  Pause, resume, rate-limit, or bulk-cancel pending jobs in a single queue without
                  affecting the rest of its workload class. State persists across restarts and every
                  change is recorded in the worker audit log.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    Queues with state currently configured. Other queues run normally.
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchQueueDrain()}
                    data-testid="button-refresh-queue-drain"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />
                    Refresh
                  </Button>
                </div>

                {/* Quick-add row so operators can create state for a queue
                    that has none yet (e.g. retroactive_reprocess on a fresh deploy). */}
                <QueueDrainQuickAdd
                  onPause={(queueName) =>
                    setQueuePauseMutation.mutate({ queueName, paused: true })
                  }
                  onSetRate={(queueName, jobsPerMinute) =>
                    setRateLimitMutation.mutate({ queueName, jobsPerMinute })
                  }
                  pending={setQueuePauseMutation.isPending || setRateLimitMutation.isPending}
                />

                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-queue-drain">
                    <thead className="text-muted-foreground">
                      <tr className="text-left">
                        <th className="px-2 py-1">Queue</th>
                        <th className="px-2 py-1">State</th>
                        <th className="px-2 py-1 text-right">Pending</th>
                        <th className="px-2 py-1 text-right">Last 60s</th>
                        <th className="px-2 py-1">Rate cap (jobs/min)</th>
                        <th className="px-2 py-1">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(queueDrainData?.queues ?? []).length === 0 ? (
                        <tr>
                          <td className="px-2 py-2 text-muted-foreground" colSpan={6} data-testid="row-queue-drain-empty">
                            No queues have drain state configured yet.
                          </td>
                        </tr>
                      ) : (
                        queueDrainData!.queues.map((q) => (
                          <tr key={q.queueName} className="border-t" data-testid={`row-queue-drain-${q.queueName}`}>
                            <td className="px-2 py-1 font-mono">{q.queueName}</td>
                            <td className="px-2 py-1">
                              <Badge
                                className={q.paused ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}
                                data-testid={`badge-queue-state-${q.queueName}`}
                              >
                                {q.paused ? "PAUSED" : "running"}
                              </Badge>
                              <Button
                                size="sm"
                                variant={q.paused ? "outline" : "destructive"}
                                className="ml-2"
                                disabled={setQueuePauseMutation.isPending}
                                onClick={() => {
                                  const noteFromInput = pauseNoteInputs[q.queueName];
                                  setQueuePauseMutation.mutate({
                                    queueName: q.queueName,
                                    paused: !q.paused,
                                    note:
                                      !q.paused &&
                                      typeof noteFromInput === "string" &&
                                      noteFromInput.trim().length > 0
                                        ? noteFromInput.trim()
                                        : null,
                                  });
                                }}
                                data-testid={`button-toggle-queue-${q.queueName}`}
                              >
                                {q.paused ? "Resume" : "Pause"}
                              </Button>
                              {/* Task #1012: pause-time baseline used by the
                                  backlog-growth alert watcher. */}
                              {q.paused && q.pausedAt && (
                                <div
                                  className="mt-1 text-caption text-muted-foreground"
                                  data-testid={`text-queue-paused-since-${q.queueName}`}
                                >
                                  since {new Date(q.pausedAt).toLocaleString()}
                                  {(() => {
                                    const hrs =
                                      (Date.now() - Date.parse(q.pausedAt!)) /
                                      3_600_000;
                                    if (!Number.isFinite(hrs)) return null;
                                    return ` · ${hrs >= 24 ? `${(hrs / 24).toFixed(1)}d` : `${hrs.toFixed(1)}h`} ago`;
                                  })()}
                                </div>
                              )}
                              {q.paused && !q.pausedAt && (
                                <div
                                  className="mt-1 text-caption text-muted-foreground"
                                  data-testid={`text-queue-paused-no-baseline-${q.queueName}`}
                                >
                                  no baseline (paused before #998)
                                </div>
                              )}
                              {/* Task #1784: operator-visible pause note. */}
                              {q.paused && q.pauseNote && (
                                <div
                                  className="mt-1 text-caption italic text-muted-foreground"
                                  data-testid={`text-queue-pause-note-${q.queueName}`}
                                >
                                  note: {q.pauseNote}
                                </div>
                              )}
                              {!q.paused && (
                                <Input
                                  className="mt-1 h-6 text-caption"
                                  placeholder="pause note (optional)"
                                  value={pauseNoteInputs[q.queueName] ?? ""}
                                  onChange={(e) =>
                                    setPauseNoteInputs((prev) => ({
                                      ...prev,
                                      [q.queueName]: e.target.value,
                                    }))
                                  }
                                  data-testid={`input-queue-pause-note-${q.queueName}`}
                                />
                              )}
                            </td>
                            <td className="px-2 py-1 text-right" data-testid={`text-queue-pending-${q.queueName}`}>
                              {q.pendingJobs}
                              {q.paused && q.pausedAtBacklog != null && (
                                <div
                                  className="text-caption text-muted-foreground"
                                  data-testid={`text-queue-pending-baseline-${q.queueName}`}
                                >
                                  {(() => {
                                    const growth = q.pendingJobs - q.pausedAtBacklog;
                                    const sign = growth > 0 ? "+" : "";
                                    const cls =
                                      growth > 0
                                        ? "text-amber-700"
                                        : growth < 0
                                        ? "text-emerald-700"
                                        : "";
                                    return (
                                      <>
                                        baseline {q.pausedAtBacklog} ·{" "}
                                        <span className={cls}>
                                          {sign}
                                          {growth}
                                        </span>
                                      </>
                                    );
                                  })()}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1 text-right" data-testid={`text-queue-recent-${q.queueName}`}>
                              {q.recentDispatches}
                              {q.ratePerMinute ? ` / ${q.ratePerMinute}` : ""}
                            </td>
                            <td className="px-2 py-1">
                              <div className="flex items-start gap-1">
                                <FormField
                                  label="Rate cap (jobs/min)"
                                  htmlFor={`input-rate-${q.queueName}`}
                                  labelClassName="sr-only"
                                  error={rateErrors[q.queueName]}
                                  errorTestId={`error-input-rate-${q.queueName}`}
                                  className="space-y-0.5"
                                >
                                  <Input
                                    className="h-7 w-20"
                                    type="number"
                                    min={1}
                                    placeholder={q.ratePerMinute?.toString() ?? "none"}
                                    value={rateInputs[q.queueName] ?? ""}
                                    onChange={(e) => {
                                      setRateInputs((prev) => ({ ...prev, [q.queueName]: e.target.value }));
                                      setRateErrors((prev) => ({ ...prev, [q.queueName]: undefined }));
                                    }}
                                    data-testid={`input-rate-${q.queueName}`}
                                  />
                                </FormField>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={setRateLimitMutation.isPending}
                                  onClick={() => {
                                    const raw = rateInputs[q.queueName] ?? "";
                                    const n = raw.trim() === "" ? null : Number.parseInt(raw, 10);
                                    if (n !== null && (!Number.isFinite(n) || n <= 0)) {
                                      setRateErrors((prev) => ({
                                        ...prev,
                                        [q.queueName]: "Enter a positive integer or leave blank to clear.",
                                      }));
                                      return;
                                    }
                                    setRateErrors((prev) => ({ ...prev, [q.queueName]: undefined }));
                                    setRateLimitMutation.mutate({ queueName: q.queueName, jobsPerMinute: n });
                                    setRateInputs((prev) => ({ ...prev, [q.queueName]: "" }));
                                  }}
                                  data-testid={`button-set-rate-${q.queueName}`}
                                >
                                  Set
                                </Button>
                                {q.ratePerMinute !== null && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={setRateLimitMutation.isPending}
                                    onClick={() =>
                                      setRateLimitMutation.mutate({
                                        queueName: q.queueName,
                                        jobsPerMinute: null,
                                      })
                                    }
                                    data-testid={`button-clear-rate-${q.queueName}`}
                                  >
                                    Clear
                                  </Button>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-1 text-muted-foreground" data-testid={`text-queue-updated-${q.queueName}`}>
                              {new Date(q.updatedAt).toLocaleString()}
                              {q.updatedBy ? ` · ${q.updatedBy}` : ""}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Task #4357: bulk-cancel is irreversible, so it lives in a
                    DangerZone instead of sitting in each row next to the
                    routine rate-cap controls. Zone reveal + AlertDialog =
                    two deliberate steps before anything destructive fires. */}
                <DangerZone
                  title="Bulk-cancel pending jobs"
                  description="Permanently cancels up to the chosen number of pending jobs in one queue. Cancelled jobs are removed and never run — this cannot be undone."
                  testId="danger-zone-queue-cancel"
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <Label
                        htmlFor="queue-cancel-queue"
                        className="text-caption text-muted-foreground"
                      >
                        Queue
                      </Label>
                      <select
                        id="queue-cancel-queue"
                        className="block h-8 text-xs border rounded px-2 w-56 bg-background"
                        value={cancelQueue}
                        onChange={(e) => setCancelQueue(e.target.value)}
                        data-testid="select-cancel-queue"
                      >
                        <option value="">Select queue…</option>
                        {(queueDrainData?.queues ?? []).map((q) => (
                          <option key={q.queueName} value={q.queueName}>
                            {q.queueName} ({q.pendingJobs} pending)
                          </option>
                        ))}
                      </select>
                    </div>
                    <FormField
                      label="Max jobs to cancel"
                      htmlFor="queue-cancel-limit"
                      labelClassName="text-caption text-muted-foreground"
                      error={cancelLimitError}
                      className="space-y-0.5"
                    >
                      <Input
                        className="block h-8 w-28 text-xs"
                        type="number"
                        min={1}
                        max={10000}
                        placeholder="100"
                        value={cancelLimitInput}
                        onChange={(e) => {
                          setCancelLimitInput(e.target.value);
                          setCancelLimitError(null);
                        }}
                        data-testid="input-cancel-limit"
                      />
                    </FormField>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={cancelPendingMutation.isPending || !cancelQueue}
                      onClick={() => {
                        const raw = cancelLimitInput;
                        const n = raw.trim() === "" ? 100 : Number.parseInt(raw, 10);
                        if (!Number.isFinite(n) || n <= 0 || n > 10_000) {
                          setCancelLimitError("Enter a positive integer up to 10000.");
                          return;
                        }
                        setCancelLimitError(null);
                        setConfirmCancelOpen(true);
                      }}
                      data-testid="button-cancel-pending"
                    >
                      Cancel pending…
                    </Button>
                  </div>
                </DangerZone>

                <AlertDialog open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
                  <AlertDialogContent data-testid="dialog-confirm-cancel-pending">
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Cancel up to{" "}
                        {cancelLimitInput.trim() === ""
                          ? 100
                          : Number.parseInt(cancelLimitInput, 10)}{" "}
                        pending {cancelQueue} jobs?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Cancelled jobs are removed from the queue and will not
                        run. This cannot be undone. The action is recorded in
                        the drain history below.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel data-testid="button-cancel-pending-abort">
                        Keep jobs
                      </AlertDialogCancel>
                      <AlertDialogAction
                        data-testid="button-cancel-pending-confirm"
                        onClick={() => {
                          setConfirmCancelOpen(false);
                          const raw = cancelLimitInput;
                          const n = raw.trim() === "" ? 100 : Number.parseInt(raw, 10);
                          if (!cancelQueue || !Number.isFinite(n) || n <= 0 || n > 10_000) return;
                          cancelPendingMutation.mutate({ queueName: cancelQueue, limit: n });
                          setCancelLimitInput("");
                        }}
                      >
                        Cancel jobs
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                {/* Task #997: drain action history (pause/resume/rate-limit/cancel). */}
                <div
                  className="mt-4 rounded-md border bg-muted/30 p-3 space-y-3"
                  data-testid="section-queue-drain-history"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-foreground">
                        Recent drain actions
                      </div>
                      <div className="text-caption text-muted-foreground">
                        Last 50 pause / resume / rate-limit / cancel actions
                        for any queue. Persisted alongside the live state so
                        it survives restarts.
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refetchQueueDrainHistory()}
                      data-testid="button-refresh-queue-drain-history"
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Refresh
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <Label
                        htmlFor="queue-drain-history-queue-filter"
                        className="text-caption text-muted-foreground"
                      >
                        Queue
                      </Label>
                      <select
                        id="queue-drain-history-queue-filter"
                        className="h-8 text-xs border rounded px-2 w-56 bg-background"
                        value={historyQueueFilter}
                        onChange={(e) => setHistoryQueueFilter(e.target.value)}
                        data-testid="select-queue-drain-history-queue"
                      >
                        <option value="">All queues</option>
                        {/* Filter options come from the live snapshot's
                            queues plus any extra queue names that show up
                            in the history (e.g. for a queue that was
                            cancelled and never had drain state). */}
                        {Array.from(
                          new Set([
                            ...(queueDrainData?.queues ?? []).map((q) => q.queueName),
                            ...(queueDrainHistoryData?.entries ?? []).map(
                              (e) => e.queueName,
                            ),
                          ]),
                        )
                          .sort()
                          .map((q) => (
                            <option key={q} value={q}>
                              {q}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div>
                      <Label
                        htmlFor="queue-drain-history-action-filter"
                        className="text-caption text-muted-foreground"
                      >
                        Action
                      </Label>
                      <select
                        id="queue-drain-history-action-filter"
                        className="h-8 text-xs border rounded px-2 w-48 bg-background"
                        value={historyActionFilter}
                        onChange={(e) => setHistoryActionFilter(e.target.value)}
                        data-testid="select-queue-drain-history-action"
                      >
                        <option value="">All actions</option>
                        <option value="queue_paused">Paused</option>
                        <option value="queue_resumed">Resumed</option>
                        <option value="queue_rate_limit_set">Rate limit set</option>
                        <option value="queue_pending_cancelled">Pending cancelled</option>
                      </select>
                    </div>
                    {(historyQueueFilter || historyActionFilter) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setHistoryQueueFilter("");
                          setHistoryActionFilter("");
                        }}
                        data-testid="button-clear-queue-drain-history-filters"
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table
                      className="w-full text-xs"
                      data-testid="table-queue-drain-history"
                    >
                      <thead className="text-muted-foreground">
                        <tr className="text-left">
                          <th className="px-2 py-1">When</th>
                          <th className="px-2 py-1">Queue</th>
                          <th className="px-2 py-1">Action</th>
                          <th className="px-2 py-1">Actor</th>
                          <th className="px-2 py-1">Before → After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(queueDrainHistoryData?.entries ?? []).length === 0 ? (
                          <tr>
                            <td
                              className="px-2 py-2 text-muted-foreground"
                              colSpan={5}
                              data-testid="row-queue-drain-history-empty"
                            >
                              No drain actions recorded
                              {historyQueueFilter || historyActionFilter
                                ? " for the current filters"
                                : " yet"}.
                            </td>
                          </tr>
                        ) : (
                          queueDrainHistoryData!.entries.map((entry) => {
                            const actionLabel =
                              entry.action === "queue_paused"
                                ? "Paused"
                                : entry.action === "queue_resumed"
                                ? "Resumed"
                                : entry.action === "queue_rate_limit_set"
                                ? "Rate limit set"
                                : "Pending cancelled";
                            const actionClass =
                              entry.action === "queue_paused"
                                ? "bg-red-100 text-red-700"
                                : entry.action === "queue_resumed"
                                ? "bg-green-100 text-green-700"
                                : entry.action === "queue_rate_limit_set"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-amber-100 text-amber-700";
                            let summary = "";
                            if (
                              entry.action === "queue_paused" ||
                              entry.action === "queue_resumed"
                            ) {
                              if ("paused" in entry.details) {
                                const p = entry.details.paused;
                                summary = `${p.before ? "paused" : "running"} → ${
                                  p.after ? "paused" : "running"
                                }`;
                                if (typeof entry.details.pausedAtBacklog === "number") {
                                  summary += ` (baseline ${entry.details.pausedAtBacklog})`;
                                }
                              }
                            } else if (entry.action === "queue_rate_limit_set") {
                              if ("ratePerMinute" in entry.details) {
                                const r = entry.details.ratePerMinute;
                                summary = `${r.before ?? "none"} → ${
                                  r.after ?? "none"
                                } /min`;
                              }
                            } else if (entry.action === "queue_pending_cancelled") {
                              if ("cancelled" in entry.details) {
                                summary = `cancelled ${entry.details.cancelled}${
                                  typeof entry.details.limit === "number"
                                    ? ` (limit ${entry.details.limit})`
                                    : ""
                                }`;
                              }
                            }
                            return (
                              <tr
                                key={entry.id}
                                className="border-t"
                                data-testid={`row-queue-drain-history-${entry.id}`}
                              >
                                <td
                                  className="px-2 py-1 text-muted-foreground whitespace-nowrap"
                                  data-testid={`text-queue-drain-history-when-${entry.id}`}
                                >
                                  {new Date(entry.at).toLocaleString()}
                                </td>
                                <td
                                  className="px-2 py-1 font-mono"
                                  data-testid={`text-queue-drain-history-queue-${entry.id}`}
                                >
                                  {entry.queueName}
                                </td>
                                <td className="px-2 py-1">
                                  <Badge
                                    className={actionClass}
                                    data-testid={`badge-queue-drain-history-action-${entry.id}`}
                                  >
                                    {actionLabel}
                                  </Badge>
                                </td>
                                <td
                                  className="px-2 py-1 text-muted-foreground"
                                  data-testid={`text-queue-drain-history-actor-${entry.id}`}
                                >
                                  {entry.actor ?? "system"}
                                </td>
                                <td
                                  className="px-2 py-1"
                                  data-testid={`text-queue-drain-history-summary-${entry.id}`}
                                >
                                  {summary || "—"}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Task #1012: paused-queue backlog alert thresholds + recent alerts. */}
                <div
                  className="mt-4 rounded-md border bg-muted/30 p-3 space-y-3"
                  data-testid="section-backlog-alert-config"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-foreground">
                        Paused-queue backlog alert
                      </div>
                      <div className="text-caption text-muted-foreground">
                        Slack-pings <code className="break-all">queue.drain_control.paused_backlog_growing</code>{" "}
                        when a paused queue has been paused at least N hours AND
                        its pending count grew by ≥ M jobs since pause. Per-queue
                        cooldown silences repeats.
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={sendBacklogAlertTestMutation.isPending}
                        onClick={() => sendBacklogAlertTestMutation.mutate()}
                        data-testid="button-send-test-backlog-alert"
                        title="Send a sample alert through the unified Slack dispatcher to verify channel + format."
                      >
                        {sendBacklogAlertTestMutation.isPending
                          ? "Sending…"
                          : "Send test alert"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => refetchBacklogAlerts()}
                        data-testid="button-refresh-backlog-alerts"
                      >
                        <RefreshCw className="w-3 h-3 mr-1" />
                        Refresh
                      </Button>
                    </div>
                  </div>

                  {!backlogAlertForm ? (
                    <div className="text-xs text-muted-foreground">Loading…</div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="backlog-alert-enabled"
                          checked={backlogAlertForm.enabled}
                          onChange={(e) =>
                            setBacklogAlertForm({
                              ...backlogAlertForm,
                              enabled: e.target.checked,
                            })
                          }
                          data-testid="checkbox-backlog-alert-enabled"
                        />
                        <Label htmlFor="backlog-alert-enabled" className="text-xs">
                          Enabled
                        </Label>
                      </div>
                      <FormField
                        label="Hours paused before alerting"
                        htmlFor="backlog-alert-hours"
                        labelClassName="text-caption text-muted-foreground"
                        error={backlogAlertErrors.hours}
                        className="space-y-0.5"
                      >
                        <Input
                          className="h-8 text-xs"
                          type="number"
                          min={1}
                          value={backlogAlertForm.hoursThreshold}
                          onChange={(e) => {
                            setBacklogAlertForm({
                              ...backlogAlertForm,
                              hoursThreshold: e.target.value,
                            });
                            setBacklogAlertErrors((prev) => ({ ...prev, hours: undefined }));
                          }}
                          data-testid="input-backlog-alert-hours"
                        />
                      </FormField>
                      <FormField
                        label="Growth threshold (jobs)"
                        htmlFor="backlog-alert-growth"
                        labelClassName="text-caption text-muted-foreground"
                        error={backlogAlertErrors.growth}
                        className="space-y-0.5"
                      >
                        <Input
                          className="h-8 text-xs"
                          type="number"
                          min={1}
                          value={backlogAlertForm.growthThreshold}
                          onChange={(e) => {
                            setBacklogAlertForm({
                              ...backlogAlertForm,
                              growthThreshold: e.target.value,
                            });
                            setBacklogAlertErrors((prev) => ({ ...prev, growth: undefined }));
                          }}
                          data-testid="input-backlog-alert-growth"
                        />
                      </FormField>
                      <FormField
                        label="Cooldown (minutes)"
                        htmlFor="backlog-alert-cooldown"
                        labelClassName="text-caption text-muted-foreground"
                        error={backlogAlertErrors.cooldown}
                        className="space-y-0.5"
                      >
                        <Input
                          className="h-8 text-xs"
                          type="number"
                          min={1}
                          value={backlogAlertForm.cooldownMinutes}
                          onChange={(e) => {
                            setBacklogAlertForm({
                              ...backlogAlertForm,
                              cooldownMinutes: e.target.value,
                            });
                            setBacklogAlertErrors((prev) => ({ ...prev, cooldown: undefined }));
                          }}
                          data-testid="input-backlog-alert-cooldown"
                        />
                      </FormField>
                    </div>
                  )}

                  {backlogAlertForm && (
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!backlogAlertData?.config}
                        onClick={() => {
                          const cfg = backlogAlertData?.config;
                          if (!cfg) return;
                          setBacklogAlertForm({
                            enabled: cfg.enabled,
                            hoursThreshold: String(cfg.hoursThreshold),
                            growthThreshold: String(cfg.growthThreshold),
                            cooldownMinutes: String(cfg.cooldownMinutes),
                          });
                        }}
                        data-testid="button-backlog-alert-revert"
                      >
                        Revert
                      </Button>
                      <Button
                        size="sm"
                        disabled={updateBacklogAlertConfigMutation.isPending}
                        onClick={() => {
                          const hours = Number.parseInt(
                            backlogAlertForm.hoursThreshold,
                            10,
                          );
                          const growth = Number.parseInt(
                            backlogAlertForm.growthThreshold,
                            10,
                          );
                          const cooldown = Number.parseInt(
                            backlogAlertForm.cooldownMinutes,
                            10,
                          );
                          const nextErrors: typeof backlogAlertErrors = {};
                          if (!Number.isFinite(hours) || hours <= 0) {
                            nextErrors.hours = "Enter a positive whole number.";
                          }
                          if (!Number.isFinite(growth) || growth <= 0) {
                            nextErrors.growth = "Enter a positive whole number.";
                          }
                          if (!Number.isFinite(cooldown) || cooldown <= 0) {
                            nextErrors.cooldown = "Enter a positive whole number.";
                          }
                          setBacklogAlertErrors(nextErrors);
                          if (nextErrors.hours || nextErrors.growth || nextErrors.cooldown) {
                            return;
                          }
                          updateBacklogAlertConfigMutation.mutate({
                            enabled: backlogAlertForm.enabled,
                            hoursThreshold: hours,
                            growthThreshold: growth,
                            cooldownMinutes: cooldown,
                          });
                        }}
                        data-testid="button-backlog-alert-save"
                      >
                        <Save className="w-3 h-3 mr-1" />
                        Save thresholds
                      </Button>
                    </div>
                  )}

                  <div>
                    <div className="text-xs font-semibold text-foreground mb-1">
                      Recent alert events
                    </div>
                    <div className="overflow-x-auto">
                      <table
                        className="w-full text-xs"
                        data-testid="table-backlog-alert-history"
                      >
                        <thead className="text-muted-foreground">
                          <tr className="text-left">
                            <th className="px-2 py-1">Sent</th>
                            <th className="px-2 py-1">Queue</th>
                            <th className="px-2 py-1">Status</th>
                            <th className="px-2 py-1 text-right">Pending</th>
                            <th className="px-2 py-1 text-right">Growth</th>
                            <th className="px-2 py-1 text-right">Paused for</th>
                            <th className="px-2 py-1">Channel</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(backlogAlertData?.recent ?? []).length === 0 ? (
                            <tr>
                              <td
                                className="px-2 py-2 text-muted-foreground"
                                colSpan={7}
                                data-testid="row-backlog-alert-empty"
                              >
                                No backlog-alert events recorded yet.
                              </td>
                            </tr>
                          ) : (
                            backlogAlertData!.recent.map((ev) => (
                              <tr
                                key={ev.id}
                                className="border-t"
                                data-testid={`row-backlog-alert-${ev.id}`}
                              >
                                <td
                                  className="px-2 py-1 text-muted-foreground"
                                  data-testid={`text-backlog-alert-sent-${ev.id}`}
                                >
                                  {new Date(ev.createdAt).toLocaleString()}
                                </td>
                                <td
                                  className="px-2 py-1 font-mono"
                                  data-testid={`text-backlog-alert-queue-${ev.id}`}
                                >
                                  {ev.queueName ?? "—"}
                                </td>
                                <td className="px-2 py-1">
                                  <Badge
                                    className={
                                      ev.status === "success"
                                        ? "bg-green-100 text-green-700"
                                        : "bg-amber-100 text-amber-700"
                                    }
                                    data-testid={`badge-backlog-alert-status-${ev.id}`}
                                  >
                                    {ev.status}
                                  </Badge>
                                  {ev.errorMessage && (
                                    <div className="text-caption text-muted-foreground mt-0.5">
                                      {ev.errorMessage}
                                    </div>
                                  )}
                                </td>
                                <td
                                  className="px-2 py-1 text-right"
                                  data-testid={`text-backlog-alert-pending-${ev.id}`}
                                >
                                  {ev.currentPending ?? "—"}
                                  {ev.pausedAtBacklog != null && (
                                    <div className="text-caption text-muted-foreground">
                                      from {ev.pausedAtBacklog}
                                    </div>
                                  )}
                                </td>
                                <td
                                  className="px-2 py-1 text-right"
                                  data-testid={`text-backlog-alert-growth-${ev.id}`}
                                >
                                  {ev.growth != null
                                    ? `${ev.growth > 0 ? "+" : ""}${ev.growth}`
                                    : "—"}
                                </td>
                                <td
                                  className="px-2 py-1 text-right text-muted-foreground"
                                  data-testid={`text-backlog-alert-hours-${ev.id}`}
                                >
                                  {ev.hoursPaused != null
                                    ? ev.hoursPaused >= 24
                                      ? `${(ev.hoursPaused / 24).toFixed(1)}d`
                                      : `${ev.hoursPaused.toFixed(1)}h`
                                    : "—"}
                                </td>
                                <td className="px-2 py-1 text-muted-foreground">
                                  {ev.channelName ?? "—"}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
  );
}
