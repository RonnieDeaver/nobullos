// Rate Limits admin — warning notification (Slack/email, cadence, digest) config editor.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Clock, X, Check, History, ArrowRight, Send, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { format } from "date-fns";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { formatDigestCountdown } from "./shared";

type AlertCadence = "realtime" | "hourly" | "daily";

type NotifyConfig = {
  slackChannelId: string | null;
  email: string | null;
  disabledCategories: string[];
  cadence: AlertCadence;
  lastEdited?: {
    slackChannelId?: LastEditedInfo;
    email?: LastEditedInfo;
    disabledCategories?: LastEditedInfo;
    cadence?: LastEditedInfo;
  };
};

const CADENCE_OPTIONS: { value: AlertCadence; label: string; hint: string }[] = [
  { value: "realtime", label: "Real-time", hint: "Send each warning immediately." },
  { value: "hourly", label: "Hourly digest", hint: "Group warnings and send a summary every hour." },
  { value: "daily", label: "Daily digest", hint: "Group warnings and send one summary per day." },
];

function DeliveryStatusBadge({
  channel,
  status,
  reason,
  testId,
}: {
  channel: "Slack" | "Email";
  status: "sent" | "failed" | "skipped";
  reason: string | null;
  testId: string;
}) {
  const className =
    status === "sent"
      ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800"
      : status === "failed"
      ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800"
      : "bg-muted text-muted-foreground border-border dark:bg-gray-800/60 dark:text-gray-300 dark:border-gray-700";
  const symbol = status === "sent" ? "✓" : status === "failed" ? "✕" : "–";
  const tooltip =
    reason && reason.trim().length > 0
      ? `${channel} ${status}: ${reason}`
      : `${channel} ${status}`;
  return (
    <Badge
      variant="outline"
      className={`text-xs px-1.5 py-0 ${className}`}
      title={tooltip}
      data-testid={testId}
    >
      {symbol} {channel} {status}
    </Badge>
  );
}

export function NotifyConfigEditor() {
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery<NotifyConfig>({
    queryKey: ["/api/health/rate-limits/notify-config"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/notify-config", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch notification config");
      return res.json();
    },
  });

  const { data: percentsData } = useQuery<{ percents: Record<string, number> }>({
    queryKey: ["/api/health/rate-limits/warning-percents"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/warning-percents", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch warning percents");
      return res.json();
    },
  });
  const percents = percentsData?.percents;

  const [slackChannelId, setSlackChannelId] = useState("");
  const [email, setEmail] = useState("");
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [cadence, setCadence] = useState<AlertCadence>("realtime");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!data) return;
    setSlackChannelId(data.slackChannelId ?? "");
    setEmail(data.email ?? "");
    setDisabled(new Set(data.disabledCategories ?? []));
    setCadence(data.cadence ?? "realtime");
  }, [data]);

  const allCategories = percents ? Object.keys(percents).sort() : [];

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/health/rate-limits/notify-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          slackChannelId: slackChannelId.trim(),
          email: email.trim(),
          disabledCategories: Array.from(disabled),
          cadence,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");
      return json as NotifyConfig;
    },
    onSuccess: () => {
      setSaveError(null);
      setSavedAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/notify-config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/notify-config/history"] }); // fire-and-forget: cache refresh only
      // The Slack/email config-change alert is dispatched async (fire-and-forget)
      // after the audit row is written, so the delivery status arrives a beat
      // later. Re-pull the history a few seconds after the save lands so the
      // sent/failed badges show up without waiting for the 60s refetch tick.
      window.setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: ["/api/health/rate-limits/notify-config/history"],
        }); // fire-and-forget: cache refresh only
      }, 3000);
    },
    onError: (err: Error) => {
      setSaveError(err.message);
    },
  });

  type NotifyConfigHistoryEntry = {
    id: string;
    settingKey: string;
    field: "slackChannelId" | "email" | "disabledCategories" | "cadence" | string;
    changedBy: string | null;
    changedByName: string | null;
    changedByEmail: string | null;
    oldValues: Record<string, unknown> | null;
    newValues: Record<string, unknown> | null;
    changedAt: string;
    slackStatus: "sent" | "failed" | "skipped" | null;
    emailStatus: "sent" | "failed" | "skipped" | null;
    slackFailureReason: string | null;
    emailFailureReason: string | null;
    lastResendAt?: string | null;
    lastResendBy?: string | null;
    lastResendSource?: string | null;
  };

  const [resendingIds, setResendingIds] = useState<Set<string>>(new Set());
  const [resendErrors, setResendErrors] = useState<Record<string, string>>({});

  const resendMutation = useMutation<
    { ok: boolean; entry: NotifyConfigHistoryEntry | null },
    Error,
    string
  >({
    meta: { silent: true },
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/health/rate-limits/notify-config/history/${id}/resend`,
        { method: "POST", credentials: "include" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to resend");
      return json;
    },
    onMutate: (id) => {
      setResendingIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setResendErrors((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    onSuccess: (data, id) => {
      if (data.entry) {
        queryClient.setQueryData<{ history: NotifyConfigHistoryEntry[] }>(
          ["/api/health/rate-limits/notify-config/history"],
          (prev) => {
            if (!prev) return prev;
            return {
              history: prev.history.map((h) => (h.id === id ? data.entry! : h)),
            };
          },
        );
      }
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/rate-limits/notify-config/history"],
      }); // fire-and-forget: cache refresh only
    },
    onError: (err, id) => {
      setResendErrors((prev) => ({ ...prev, [id]: err.message }));
    },
    onSettled: (_data, _err, id) => {
      setResendingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
  });

  const { data: historyData, error: historyError } = useQuery<{
    history: NotifyConfigHistoryEntry[];
  }>({
    queryKey: ["/api/health/rate-limits/notify-config/history"],
    queryFn: async () => {
      const res = await fetch(
        "/api/health/rate-limits/notify-config/history?limit=25",
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch notification config history");
      return res.json();
    },
    refetchInterval: 60_000,
  });
  const history = historyData?.history ?? [];

  const FIELD_LABELS: Record<string, string> = {
    slackChannelId: "Slack channel",
    email: "Email recipient",
    disabledCategories: "Notify on categories",
    cadence: "Delivery cadence",
  };

  const formatHistoryValue = (
    field: string,
    values: Record<string, unknown> | null,
  ): string => {
    if (!values) return "—";
    const v = values[field];
    if (field === "disabledCategories") {
      const arr = Array.isArray(v) ? (v as string[]) : [];
      return arr.length === 0 ? "none disabled" : `disabled: ${arr.join(", ")}`;
    }
    if (v === null || v === undefined || v === "") return "—";
    return String(v);
  };

  const recentlySaved = savedAt && Date.now() - savedAt < 3000;

  const savedCadence = data?.cadence ?? "realtime";
  const isDigestActive = savedCadence === "hourly" || savedCadence === "daily";
  const isTabVisibleForDigest = useTabVisibility();
  const { data: digestStatus, refetch: refetchDigestStatus } = useQuery<{
    pending: number;
    lastFlushAt: number | null;
    cadence: AlertCadence;
    intervalMs: number;
    nextFlushAt: number | null;
  }>({
    queryKey: ["/api/health/rate-limits/digest-status"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/digest-status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch digest status");
      return res.json();
    },
    enabled: isDigestActive,
    refetchInterval: isDigestActive && isTabVisibleForDigest ? 15000 : false,
    refetchIntervalInBackground: false,
  });

  const [tickNow, setTickNow] = useState(Date.now());
  useEffect(() => {
    if (!isDigestActive) return;
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isDigestActive]);

  const [flushedAt, setFlushedAt] = useState<number | null>(null);
  const [flushError, setFlushError] = useState<string | null>(null);
  const flushMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/health/rate-limits/digest-flush", {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to flush digest");
      return json;
    },
    onSuccess: () => {
      setFlushError(null);
      setFlushedAt(Date.now());
      void refetchDigestStatus(); // fire-and-forget: refetch only
      void queryClient.invalidateQueries({ queryKey: ["/api/health/rate-limits/notifications"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      setFlushError(err.message);
    },
  });
  const recentlyFlushed = flushedAt && Date.now() - flushedAt < 3000;

  const formatCountdown = formatDigestCountdown;

  const toggleCategory = (cat: string) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const dirty =
    !!data &&
    (slackChannelId !== (data.slackChannelId ?? "") ||
      email !== (data.email ?? "") ||
      cadence !== (data.cadence ?? "realtime") ||
      Array.from(disabled).sort().join("|") !== (data.disabledCategories ?? []).slice().sort().join("|"));

  return (
    <Card id="notify-config-card" data-testid="card-notify-config">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Send className="w-4 h-4" />
          Warning Notifications
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Push new rate-limit warnings to Slack and/or email so admins don't have to watch the dashboard.
          Each (user, category, window) is notified once. Critical alerts (user has hit the limit) are
          always sent immediately, even when a digest cadence is selected.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4">Loading notification config…</div>
        ) : loadError ? (
          <div className="text-sm text-red-600 dark:text-red-400 py-4" data-testid="text-notify-config-load-error">
            Failed to load notification config: {(loadError as Error).message}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="input-notify-slack-channel" className="block text-xs font-medium text-muted-foreground mb-1">
                  Slack channel ID
                </label>
                <Input
                  id="input-notify-slack-channel"
                  value={slackChannelId}
                  onChange={(e) => setSlackChannelId(e.target.value)}
                  placeholder="C0123ABCDEF (leave blank to disable)"
                  className="h-8 text-sm font-mono"
                  data-testid="input-notify-slack-channel"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Find the ID in Slack: channel name → About → bottom of pane.
                </p>
                {data?.lastEdited?.slackChannelId && (
                  <LastEditedBadge
                    info={data.lastEdited.slackChannelId}
                    testId="text-last-edited-notify-slack-channel"
                  />
                )}
              </div>
              <div>
                <label htmlFor="input-notify-email" className="block text-xs font-medium text-muted-foreground mb-1">
                  Email recipient
                </label>
                <Input
                  id="input-notify-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alerts@example.com (optional)"
                  className="h-8 text-sm"
                  data-testid="input-notify-email"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Requires SENDGRID_API_KEY and SENDGRID_FROM_EMAIL to actually deliver mail.
                </p>
                {data?.lastEdited?.email && (
                  <LastEditedBadge
                    info={data.lastEdited.email}
                    testId="text-last-edited-notify-email"
                  />
                )}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2">
                <span>Delivery cadence</span>
                {data?.lastEdited?.cadence && (
                  <LastEditedBadge
                    info={data.lastEdited.cadence}
                    testId="text-last-edited-notify-cadence"
                    className="!mt-0"
                  />
                )}
              </div>
              <div className="flex flex-wrap gap-2" data-testid="list-notify-cadence">
                {CADENCE_OPTIONS.map((opt) => {
                  const selected = cadence === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setCadence(opt.value)}
                      data-testid={`button-cadence-${opt.value}`}
                      className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded border text-xs transition-colors text-left ${
                        selected
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-card text-muted-foreground border-primary/20 hover:border-primary/50"
                      }`}
                    >
                      <span className="font-medium flex items-center gap-1">
                        {selected && <Check className="w-3 h-3" />}
                        {opt.label}
                      </span>
                      <span className={`text-xs ${selected ? "text-white/80" : "text-muted-foreground"}`}>
                        {opt.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
              {isDigestActive && (
                <div
                  className="mt-3 rounded border border-primary/15 bg-primary/5 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-2"
                  data-testid="panel-digest-status"
                >
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    {digestStatus ? (
                      digestStatus.nextFlushAt ? (
                        <span data-testid="text-digest-next-flush">
                          Next digest in{" "}
                          <span className="font-semibold">
                            {formatCountdown(digestStatus.nextFlushAt - tickNow)}
                          </span>
                          {" "}({format(new Date(digestStatus.nextFlushAt), "MMM d, h:mm a")})
                        </span>
                      ) : (
                        <span data-testid="text-digest-next-flush">
                          Next digest time not yet scheduled
                        </span>
                      )
                    ) : (
                      <span data-testid="text-digest-next-flush">Loading digest status…</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground" data-testid="text-digest-pending">
                    <span className="font-semibold">{digestStatus?.pending ?? 0}</span>{" "}
                    warning{(digestStatus?.pending ?? 0) === 1 ? "" : "s"} queued
                  </div>
                  {digestStatus?.lastFlushAt && (
                    <div className="text-xs text-muted-foreground" data-testid="text-digest-last-flush">
                      Last sent {format(new Date(digestStatus.lastFlushAt), "MMM d, h:mm a")}
                    </div>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {flushError && (
                      <span className="text-xs text-red-600 dark:text-red-300" data-testid="text-digest-flush-error">
                        {flushError}
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={flushMutation.isPending || (digestStatus?.pending ?? 0) === 0}
                      onClick={() => flushMutation.mutate()}
                      data-testid="button-flush-digest-now"
                      className="h-7 text-xs"
                    >
                      {recentlyFlushed && !flushMutation.isPending ? (
                        <>
                          <Check className="w-3 h-3 mr-1" />
                          Sent
                        </>
                      ) : flushMutation.isPending ? (
                        "Sending…"
                      ) : (
                        <>
                          <Zap className="w-3 h-3 mr-1" />
                          Send digest now
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2">
                <span>Notify on these categories</span>
                {data?.lastEdited?.disabledCategories && (
                  <LastEditedBadge
                    info={data.lastEdited.disabledCategories}
                    testId="text-last-edited-notify-disabled-categories"
                    className="!mt-0"
                  />
                )}
              </div>
              {allCategories.length === 0 ? (
                <div className="text-xs text-muted-foreground" data-testid="text-no-notify-categories">
                  No categories configured yet.
                </div>
              ) : (
                <div className="flex flex-wrap gap-2" data-testid="list-notify-categories">
                  {allCategories.map((cat) => {
                    const enabled = !disabled.has(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => toggleCategory(cat)}
                        data-testid={`toggle-notify-${cat}`}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                          enabled
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-card text-muted-foreground border-primary/20 hover:border-primary/50"
                        }`}
                      >
                        {enabled ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                        {cat}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant={dirty ? "default" : "outline"}
                disabled={!dirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
                data-testid="button-save-notify-config"
                className="h-8 text-xs"
              >
                {recentlySaved && !dirty ? (
                  <>
                    <Check className="w-3 h-3 mr-1" />
                    Saved
                  </>
                ) : saveMutation.isPending ? (
                  "Saving…"
                ) : (
                  "Save"
                )}
              </Button>
              {saveError && (
                <span className="text-xs text-red-600 dark:text-red-300" data-testid="text-notify-config-save-error">
                  {saveError}
                </span>
              )}
              {!slackChannelId.trim() && !email.trim() && (
                <span className="text-xs text-muted-foreground">
                  No destination configured — warnings will only show in the dashboard.
                </span>
              )}
            </div>

            <div className="mt-2 border-t pt-3" data-testid="notify-config-history">
              <div className="flex items-center gap-1.5 mb-2">
                <History className="w-3.5 h-3.5 text-muted-foreground" />
                <h4 className="text-xs font-semibold text-foreground">
                  Recent notification config changes
                </h4>
              </div>
              {historyError ? (
                <div
                  className="text-xs text-red-600 dark:text-red-300"
                  data-testid="text-notify-config-history-error"
                >
                  Failed to load history: {(historyError as Error).message}
                </div>
              ) : history.length === 0 ? (
                <div
                  className="text-xs text-muted-foreground"
                  data-testid="text-notify-config-history-empty"
                >
                  No changes recorded yet.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {history.map((entry) => {
                    const who = formatEditorAttribution(entry);
                    const fieldLabel = FIELD_LABELS[entry.field] ?? entry.field;
                    const oldStr = formatHistoryValue(entry.field, entry.oldValues);
                    const newStr = formatHistoryValue(entry.field, entry.newValues);
                    return (
                      <div
                        key={entry.id}
                        className="bg-muted/50 rounded px-2.5 py-1.5 text-xs"
                        data-testid={`notify-config-history-${entry.id}`}
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <div className="flex items-center gap-1.5">
                            <Badge
                              className="text-xs px-1.5 py-0 bg-primary/10 text-primary dark:text-foreground border-primary/20"
                              data-testid={`text-notify-config-history-field-${entry.id}`}
                            >
                              {fieldLabel}
                            </Badge>
                            <span
                              className="font-medium text-foreground"
                              data-testid={`text-notify-config-history-user-${entry.id}`}
                            >
                              {who}
                            </span>
                          </div>
                          <span
                            className="text-muted-foreground"
                            data-testid={`text-notify-config-history-time-${entry.id}`}
                          >
                            {new Date(entry.changedAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-muted-foreground flex-wrap">
                          <span
                            className="text-foreground line-through break-all"
                            data-testid={`text-notify-config-history-old-${entry.id}`}
                          >
                            {oldStr}
                          </span>
                          <ArrowRight className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                          <span
                            className="font-semibold text-foreground break-all"
                            data-testid={`text-notify-config-history-new-${entry.id}`}
                          >
                            {newStr}
                          </span>
                        </div>
                        {(entry.slackStatus || entry.emailStatus) && (
                          <div
                            className="flex items-center gap-1 mt-1 flex-wrap"
                            data-testid={`notify-config-history-delivery-${entry.id}`}
                          >
                            {entry.slackStatus && (
                              <DeliveryStatusBadge
                                channel="Slack"
                                status={entry.slackStatus}
                                reason={entry.slackFailureReason}
                                testId={`badge-notify-config-history-slack-${entry.id}`}
                              />
                            )}
                            {entry.emailStatus && (
                              <DeliveryStatusBadge
                                channel="Email"
                                status={entry.emailStatus}
                                reason={entry.emailFailureReason}
                                testId={`badge-notify-config-history-email-${entry.id}`}
                              />
                            )}
                            {(entry.slackStatus === "failed" ||
                              entry.emailStatus === "failed") && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-5 px-1.5 text-xs ml-1"
                                disabled={resendingIds.has(entry.id)}
                                onClick={() => resendMutation.mutate(entry.id)}
                                data-testid={`button-notify-config-history-resend-${entry.id}`}
                              >
                                {resendingIds.has(entry.id) ? "Resending…" : "Resend"}
                              </Button>
                            )}
                            {resendErrors[entry.id] && (
                              <span
                                className="text-xs text-red-600 dark:text-red-300 ml-1"
                                data-testid={`text-notify-config-history-resend-error-${entry.id}`}
                              >
                                {resendErrors[entry.id]}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
