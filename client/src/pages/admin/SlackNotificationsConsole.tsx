import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/admin/PageHeader";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Bell,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle,
  Clock,
  Zap,
  Eye,
  EyeOff,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

type SummaryCard = {
  total: number;
  implemented: number;
  enabled: number;
  configured: number;
  missingChannel: number;
  failed24h: number;
  slackConnected: boolean;
};

type NotificationRow = {
  id: string;
  label: string;
  description: string;
  category: string;
  implemented: boolean;
  supportsTest: boolean;
  ownerService: string | null;
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  source: "notification_settings" | "legacy_migrated" | "env_override" | "default" | "none";
  envOverrideActive: boolean;
  envChannelId: string | null;
  envOverrideKeys: string[];
  legacySettingKeys: string[];
  legacyChannelId: string | null;
  lastEditedAt: string | null;
  lastEditedBy: string | null;
  deliveryStats24h: { total: number; success: number; failed: number; skipped: number };
  lastDelivery: {
    createdAt: string;
    status: string;
    channelId: string | null;
    channelName: string | null;
    errorMessage: string | null;
  } | null;
};

type CategoryBlock = {
  id: string;
  label: string;
  description: string;
  notifications: NotificationRow[];
};

/** Task #4645 — sustained Slack-outage state (server-computed, durable). */
type SlackOutageStatus = {
  active: boolean;
  openedAt: string | null;
  failingSince: string | null;
  dayCount: number | null;
  dayCountLabel: string | null;
  windowAttempts: number;
  windowFailures: number;
  windowSuccesses: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastErrorMessage: string | null;
  topFailing: { notificationId: string; channelId: string | null; failures: number }[];
  lastEscalatedAt: string | null;
};

type ConsoleResponse = {
  summary: SummaryCard;
  categories: CategoryBlock[];
  slackOutage?: SlackOutageStatus | null;
};

type SlackChannelOption = { id: string; name: string; isPrivate: boolean };

type DeliveryRow = {
  id: string;
  createdAt: string;
  channelId: string | null;
  channelName: string | null;
  status: string;
  errorMessage: string | null;
  errorCode: string | null;
  slackTs: string | null;
  payloadPreview: string | null;
  triggerSource: string | null;
  triggerActorId: string | null;
  dedupeKey: string | null;
};

type KillSwitchResponse = { enabled: boolean; updatedAt?: string | null; updatedBy?: string | null };

class TestSendError extends Error {
  readonly notificationId: string;
  readonly channelId: string | null;
  constructor(message: string, notificationId: string, channelId: string | null) {
    super(message);
    this.name = "TestSendError";
    this.notificationId = notificationId;
    this.channelId = channelId;
  }
}

const STATUS_LABEL: Record<string, string> = {
  success: "Delivered",
  failed: "Failed",
  skipped_disabled: "Skipped — disabled",
  skipped_no_channel: "Skipped — no channel",
  skipped_deduped: "Skipped — deduped",
  skipped_unknown_id: "Skipped — unknown id",
  skipped_slack_disconnected: "Skipped — Slack disconnected",
  skipped_killswitch: "Skipped — kill switch",
};

function statusBadge(status: string) {
  if (status === "success") {
    return <Badge className="bg-green-100 text-green-800 border border-green-200">Delivered</Badge>;
  }
  if (status === "failed") {
    return <Badge className="bg-red-100 text-red-800 border border-red-200">Failed</Badge>;
  }
  return (
    <Badge className="bg-amber-50 text-amber-800 border border-amber-200">
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

function sourceBadge(row: NotificationRow) {
  const map: Record<string, { label: string; cls: string }> = {
    notification_settings: { label: "Saved", cls: "bg-blue-50 text-blue-800 border-blue-200" },
    legacy_migrated: { label: "Legacy", cls: "bg-purple-50 text-purple-800 border-purple-200" },
    env_override: { label: "Env override", cls: "bg-amber-50 text-amber-800 border-amber-200" },
    default: { label: "Default", cls: "bg-muted/50 text-foreground border-border" },
    none: { label: "Unconfigured", cls: "bg-muted text-muted-foreground border-border" },
  };
  const m = map[row.source] ?? map.default;
  return (
    <Badge variant="outline" className={`text-xs ${m.cls}`} data-testid={`badge-source-${row.id}`}>
      {m.label}
    </Badge>
  );
}

export default function SlackNotificationsConsole() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showPlanned, setShowPlanned] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string; channelId: string | null; at: number }>
  >({});

  const consoleQuery = useQuery<ConsoleResponse>({
    queryKey: ["/api/admin/notifications"],
  });
  const channelsQuery = useQuery<{ channels: SlackChannelOption[] }>({
    queryKey: ["/api/integrations/slack/channels"],
    enabled: consoleQuery.data?.summary.slackConnected ?? false,
  });
  const killQuery = useQuery<KillSwitchResponse>({
    queryKey: ["/api/admin/notifications/kill-switch"],
  });

  const channels = channelsQuery.data?.channels ?? [];
  const channelLabel = (id: string | null) => {
    if (!id) return "—";
    const c = channels.find((x) => x.id === id);
    return c ? `#${c.name}` : id;
  };

  const updateMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (input: { id: string; enabled?: boolean; channelId?: string | null }) => {
      const res = await apiRequest("PUT", `/api/admin/notifications/${input.id}`, {
        enabled: input.enabled,
        channelId: input.channelId,
      });
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/admin/notifications"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Update failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const testMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (input: { id: string; channelId: string | null }) => {
      const res = await fetch(`/api/admin/notifications/${input.id}/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: input.channelId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new TestSendError(
          data?.error ?? `Request failed (${res.status})`,
          input.id,
          typeof data?.channelId === "string" ? data.channelId : null,
        );
      }
      return { ...(data as { ok: true; channelId: string | null }), notificationId: input.id };
    },
    onSuccess: (data) => {
      toast({ title: "Test sent", description: `Posted to ${channelLabel(data.channelId)}` });
      setTestResults((s) => ({
        ...s,
        [data.notificationId]: {
          ok: true,
          message: `Delivered to ${channelLabel(data.channelId)}`,
          channelId: data.channelId,
          at: Date.now(),
        },
      }));
      void qc.invalidateQueries({ queryKey: ["/api/admin/notifications"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Test failed", description: err.message, variant: "destructive" });
      if (err instanceof TestSendError) {
        setTestResults((s) => ({
          ...s,
          [err.notificationId]: {
            ok: false,
            message: err.message,
            channelId: err.channelId,
            at: Date.now(),
          },
        }));
      }
    },
  });

  const killMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/admin/notifications/kill-switch", { enabled });
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/admin/notifications/kill-switch"] }); // fire-and-forget: cache refresh only
    },
  });

  const summary = consoleQuery.data?.summary;
  const outage = consoleQuery.data?.slackOutage ?? null;
  const categories = useMemo(
    () => consoleQuery.data?.categories ?? [],
    [consoleQuery.data?.categories],
  );

  const visibleCategories = useMemo(
    () =>
      categories.map((c) => ({
        ...c,
        notifications: c.notifications.filter((n) => showPlanned || n.implemented),
      })),
    [categories, showPlanned],
  );

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-muted/50 p-6" data-testid="page-slack-notifications-console">
      <div className="max-w-6xl mx-auto space-y-6">
        <PageHeader
          title="Slack Notifications Console"
          icon={Bell}
          backHref="/admin/integrations"
          backTestId="button-back-integrations"
          titleTestId="title-console"
          subtitle="System-wide control of Slack alerts. Adjust channel routing, toggle alerts on/off, and inspect recent deliveries."
        />

        {/* Task #4645 — persistent sustained-outage banner. Driven by the
            durable detector state; clears automatically once a Slack
            delivery succeeds again. Built on the shared Alert primitive so
            no new radius utilities enter the design-ratchet baseline — do
            not swap back to a raw div carrying its own corner radius. */}
        {outage?.active && (
          <Alert
            variant="destructive"
            className="border-2 border-red-400 bg-red-50 p-4 text-sm text-red-900"
            data-testid="banner-slack-outage"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="w-6 h-6 text-red-600 shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <div className="text-base font-semibold" data-testid="text-outage-title">
                  Slack alerting is down — day {outage.dayCountLabel ?? "?"} of an ongoing outage
                </div>
                <p data-testid="text-outage-stats">
                  {outage.windowFailures} of {outage.windowAttempts} Slack deliveries failed in
                  the last 24 hours
                  {outage.failingSince
                    ? ` — failing since ${format(new Date(outage.failingSince), "MMM d, yyyy")}`
                    : ""}
                  .
                  {outage.lastErrorMessage ? ` Latest error: ${outage.lastErrorMessage}` : ""}
                </p>
                {outage.topFailing?.[0]?.channelId && (
                  <p>
                    Failing deliveries target channel{" "}
                    <code className="px-1 py-0.5 bg-red-100 font-mono text-xs">
                      {outage.topFailing[0].channelId}
                    </code>
                    , which Slack rejects.
                  </p>
                )}
                <p className="font-medium">
                  Fix: pick a channel the NoBull bot is a member of below, save it, then press
                  {' "Send test"'} — a successful delivery clears this banner automatically.
                  Admins are re-alerted in-app daily until then.
                </p>
              </div>
            </div>
          </Alert>
        )}

        {!summary?.slackConnected && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-center gap-2" data-testid="alert-slack-disconnected">
            <AlertCircle className="w-4 h-4" />
            <span>
              Connect Slack before configuring notification channels.{" "}
              <a className="underline" href="/admin/slack">Manage Slack →</a>
            </span>
          </div>
        )}

        {/* Task #1687 — per-user Slack DM oversight panel. */}
        <UserSlackDmOversightPanel />

        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="summary-cards">
            <SummaryStat label="Notification types" value={summary.total} testId="summary-total" />
            <SummaryStat label="Enabled" value={summary.enabled} testId="summary-enabled" />
            <SummaryStat label="Configured" value={summary.configured} testId="summary-configured" />
            <SummaryStat
              label="Missing channel"
              value={summary.missingChannel}
              tone={summary.missingChannel > 0 ? "warn" : "neutral"}
              testId="summary-missing-channel"
            />
            <SummaryStat
              label="Failed (24h)"
              value={summary.failed24h}
              tone={summary.failed24h > 0 ? "bad" : "good"}
              testId="summary-failed-24h"
            />
          </div>
        )}

        <Card>
          <CardContent className="py-3 flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Switch
                checked={showPlanned}
                onCheckedChange={setShowPlanned}
                aria-label="Show planned notification types"
                data-testid="switch-show-planned"
              />
              <span className="text-sm flex items-center gap-1">
                {showPlanned ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                Show planned notification types
              </span>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Zap className="w-4 h-4 text-amber-600" />
              <span className="text-sm">Watcher kill switch</span>
              <Switch
                checked={killQuery.data?.enabled ?? true}
                onCheckedChange={(v) => killMutation.mutate(v)}
                disabled={killMutation.isPending}
                aria-label="Watcher kill switch"
                data-testid="switch-kill-switch"
              />
              <span className="text-xs text-muted-foreground">
                {killQuery.data?.enabled === false ? "Watchers paused" : "Watchers active"}
              </span>
            </div>
          </CardContent>
        </Card>

        <CallArchiveThresholdsPanel />

        {consoleQuery.isLoading && (
          <div className="text-center py-12 text-muted-foreground" data-testid="loading-console">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
            Loading notifications…
          </div>
        )}

        {visibleCategories.map((cat) => {
          const collapsed = collapsedCats[cat.id];
          if (cat.notifications.length === 0) return null;
          return (
            <Card key={cat.id} data-testid={`category-${cat.id}`}>
              <CardHeader
                className="cursor-pointer"
                onClick={() => setCollapsedCats((s) => ({ ...s, [cat.id]: !collapsed }))}
              >
                <CardTitle className="flex items-center gap-2 text-base">
                  {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  {cat.label}
                  <Badge variant="outline" className="ml-2 text-xs">
                    {cat.notifications.length}
                  </Badge>
                </CardTitle>
                <p className="text-xs text-muted-foreground ml-6">{cat.description}</p>
              </CardHeader>
              {!collapsed && (
                <CardContent className="space-y-2">
                  {cat.notifications.map((n) => {
                    const isExpanded = expanded[n.id];
                    const draft = drafts[n.id] ?? n.channelId ?? "__none__";
                    const dirty = (drafts[n.id] ?? null) !== null && drafts[n.id] !== (n.channelId ?? "__none__");
                    return (
                      <div
                        key={n.id}
                        className={`rounded-lg border p-3 ${
                          n.implemented ? "bg-card" : "bg-muted/50 border-dashed"
                        }`}
                        data-testid={`row-notification-${n.id}`}
                      >
                        <div className="flex items-start gap-3 flex-wrap">
                          <div className="flex-1 min-w-[220px]">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm" data-testid={`text-notif-label-${n.id}`}>
                                {n.label}
                              </span>
                              {!n.implemented && (
                                <Badge variant="outline" className="text-xs uppercase tracking-wide">
                                  Planned
                                </Badge>
                              )}
                              {sourceBadge(n)}
                              {n.envOverrideActive && (
                                <Badge className="bg-amber-100 text-amber-900 border border-amber-300 text-xs" data-testid={`badge-env-${n.id}`}>
                                  Env override active
                                </Badge>
                              )}
                              {n.enabled && !n.channelId && n.implemented && (
                                <Badge className="bg-amber-100 text-amber-900 border border-amber-300 text-xs">
                                  No Slack channel
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">{n.description}</p>
                            <p className="text-xs text-muted-foreground mt-1 font-mono break-all">{n.id}</p>
                            {n.lastEditedAt && (
                              <p className="text-xs text-muted-foreground mt-1">
                                Last edited {formatDistanceToNow(new Date(n.lastEditedAt), { addSuffix: true })}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={n.enabled}
                              onCheckedChange={(v) =>
                                updateMutation.mutate({ id: n.id, enabled: v })
                              }
                              disabled={!n.implemented || updateMutation.isPending}
                              aria-label={`Enable ${n.label}`}
                              data-testid={`switch-enabled-${n.id}`}
                            />
                            <span className="text-xs text-muted-foreground">{n.enabled ? "On" : "Off"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Select
                              value={draft}
                              onValueChange={(v) => setDrafts((s) => ({ ...s, [n.id]: v }))}
                              disabled={!summary?.slackConnected || n.envOverrideActive}
                            >
                              <SelectTrigger className="w-56" aria-label={`Slack channel for ${n.label}`} data-testid={`select-channel-${n.id}`}>
                                <SelectValue placeholder="Pick a channel…" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">— None —</SelectItem>
                                {channels.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    #{c.name}
                                    {c.isPrivate ? " (private)" : ""}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!dirty || updateMutation.isPending || n.envOverrideActive}
                              onClick={() =>
                                updateMutation.mutate({
                                  id: n.id,
                                  channelId: draft === "__none__" ? null : draft,
                                })
                              }
                              data-testid={`button-save-${n.id}`}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={
                                testMutation.isPending ||
                                !summary?.slackConnected ||
                                !n.supportsTest ||
                                (!n.channelId && draft === "__none__")
                              }
                              onClick={() =>
                                testMutation.mutate({
                                  id: n.id,
                                  channelId: dirty ? (draft === "__none__" ? null : draft) : null,
                                })
                              }
                              data-testid={`button-test-${n.id}`}
                            >
                              Send test
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setExpanded((s) => ({ ...s, [n.id]: !s[n.id] }))
                              }
                              data-testid={`button-expand-${n.id}`}
                            >
                              {isExpanded ? "Hide history" : "History"}
                            </Button>
                          </div>
                        </div>

                        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          <span>
                            Channel: <span className="font-mono">{channelLabel(n.channelId)}</span>
                          </span>
                          <span>
                            24h: {n.deliveryStats24h.success} ok / {n.deliveryStats24h.failed} failed / {n.deliveryStats24h.skipped} skipped
                          </span>
                          {n.lastDelivery && (
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              Last: {format(new Date(n.lastDelivery.createdAt), "MMM d HH:mm")}
                              {" "}
                              {statusBadge(n.lastDelivery.status)}
                            </span>
                          )}
                          {n.envOverrideActive && (
                            <span className="text-amber-700">
                              Env override (`{n.envOverrideKeys.join(", ")}`) is active.
                              Saved channel preserved but inactive until override is removed.
                            </span>
                          )}
                          {!n.implemented && (
                            <span className="text-muted-foreground italic">
                              Registered but not yet wired to a live signal.
                            </span>
                          )}
                        </div>

                        {testResults[n.id] && (
                          <div
                            className={`mt-2 rounded-md border px-2 py-1 text-xs flex items-start gap-2 ${
                              testResults[n.id].ok
                                ? "border-green-200 bg-green-50 text-green-800"
                                : "border-red-200 bg-red-50 text-red-800"
                            }`}
                            data-testid={`test-result-${n.id}`}
                          >
                            {testResults[n.id].ok ? (
                              <CheckCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                            ) : (
                              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                            )}
                            <span className="flex-1">
                              <span className="font-medium">
                                {testResults[n.id].ok ? "Test delivered" : "Test not delivered"}
                              </span>
                              {": "}
                              {testResults[n.id].message}
                            </span>
                            <button
                              type="button"
                              className="text-xs underline opacity-70 hover:opacity-100"
                              onClick={() =>
                                setTestResults((s) => {
                                  const next = { ...s };
                                  delete next[n.id];
                                  return next;
                                })
                              }
                              data-testid={`button-dismiss-test-result-${n.id}`}
                            >
                              dismiss
                            </button>
                          </div>
                        )}

                        {isExpanded && <DeliveryExpander notificationId={n.id} channels={channels} />}
                      </div>
                    );
                  })}
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone = "neutral",
  testId,
}: {
  label: string;
  value: number;
  tone?: "neutral" | "good" | "warn" | "bad";
  testId?: string;
}) {
  const cls =
    tone === "bad"
      ? "text-red-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "good"
          ? "text-green-700"
          : "text-foreground";
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className={`text-2xl font-semibold mt-1 ${cls}`} data-testid={testId}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function DeliveryExpander({
  notificationId,
  channels,
}: {
  notificationId: string;
  channels: SlackChannelOption[];
}) {
  const { data, isLoading } = useQuery<{ deliveries: DeliveryRow[] }>({
    queryKey: [`/api/admin/notifications/${notificationId}/deliveries`],
  });
  const channelLabel = (id: string | null) => {
    if (!id) return "—";
    const c = channels.find((x) => x.id === id);
    return c ? `#${c.name}` : id;
  };
  if (isLoading) {
    return (
      <div className="mt-3 text-xs text-muted-foreground" data-testid={`history-loading-${notificationId}`}>
        Loading delivery history…
      </div>
    );
  }
  const rows = data?.deliveries ?? [];
  if (rows.length === 0) {
    return (
      <div className="mt-3 text-xs text-muted-foreground" data-testid={`history-empty-${notificationId}`}>
        No delivery attempts recorded yet.
      </div>
    );
  }
  return (
    <div className="mt-3 border-t pt-2 overflow-x-auto" data-testid={`history-table-${notificationId}`}>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="text-left py-1 pr-2">When</th>
            <th className="text-left py-1 pr-2">Channel</th>
            <th className="text-left py-1 pr-2">Status</th>
            <th className="text-left py-1 pr-2">Trigger</th>
            <th className="text-left py-1 pr-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b last:border-b-0 align-top">
              <td className="py-1 pr-2 whitespace-nowrap">
                {format(new Date(r.createdAt), "MMM d HH:mm:ss")}
              </td>
              <td className="py-1 pr-2 font-mono">{channelLabel(r.channelId)}</td>
              <td className="py-1 pr-2">{statusBadge(r.status)}</td>
              <td className="py-1 pr-2">{r.triggerSource ?? "—"}</td>
              <td className="py-1 pr-2 text-muted-foreground break-words max-w-[420px]">
                {r.errorMessage ? (
                  <span className="text-red-700 font-mono">{r.errorMessage}</span>
                ) : r.payloadPreview ? (
                  <span className="font-mono text-muted-foreground">{r.payloadPreview}</span>
                ) : r.slackTs ? (
                  <span className="font-mono text-green-700">ts {r.slackTs}</span>
                ) : (
                  "—"
                )}
                {r.dedupeKey ? <div className="text-xs text-muted-foreground mt-1">dedupe: {r.dedupeKey}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Task #1687: per-user Slack DM oversight ───────────────────────────

type UserSlackIdentityRow = {
  id: string;
  userId: string;
  slackUserId: string;
  slackTeamId: string | null;
  slackEmail: string | null;
  connectedAt: string;
  disconnectedAt: string | null;
  lastDmStatus: string | null;
  lastDmError: string | null;
  lastDmAt: string | null;
};

function UserSlackDmOversightPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const identitiesQuery = useQuery<{ identities: UserSlackIdentityRow[] }>({
    queryKey: ["/api/admin/notifications/user-slack-identities"],
    queryFn: async () => {
      const res = await fetch("/api/admin/notifications/user-slack-identities");
      if (!res.ok) throw new Error("Failed to load user Slack identities");
      return res.json();
    },
  });

  const killSwitchQuery = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/admin/notifications/user-slack-dm-enabled"],
    queryFn: async () => {
      const res = await fetch("/api/admin/notifications/user-slack-dm-enabled");
      if (!res.ok) throw new Error("Failed to load kill switch");
      return res.json();
    },
  });

  const setKillSwitchMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/admin/notifications/user-slack-dm-enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Failed to update kill switch");
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/notifications/user-slack-dm-enabled"],
      });
    },
    onError: (err: any) => {
      toast({
        title: "Kill switch update failed",
        description: err?.message,
        variant: "destructive",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(
        `/api/admin/notifications/user-slack-identities/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to disconnect user");
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/notifications/user-slack-identities"],
      });
      toast({ title: "User Slack DM disconnected" });
    },
  });

  const rows = identitiesQuery.data?.identities ?? [];
  const enabled = killSwitchQuery.data?.enabled ?? true;

  return (
    <Card data-testid="card-user-slack-dm-oversight">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="w-4 h-4" />
            Per-user Slack DM forwarding (Task #1687)
          </CardTitle>
          <CardDescription>
            Global kill switch and identity oversight for the user-scoped
            Slack DM sender. In-app notifications are never affected by
            anything here.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {enabled ? "Enabled" : "Disabled"}
          </span>
          <Switch
            checked={enabled}
            disabled={setKillSwitchMutation.isPending || killSwitchQuery.isLoading}
            onCheckedChange={(v) => setKillSwitchMutation.mutate(!!v)}
            aria-label="User Slack DM kill switch"
            data-testid="switch-user-slack-dm-killswitch"
          />
        </div>
      </CardHeader>
      <CardContent>
        {identitiesQuery.isLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="text-no-user-identities">
            No users have linked their Slack account yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="table-user-slack-identities">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="text-left py-1 pr-2">User</th>
                  <th className="text-left py-1 pr-2">Slack user id</th>
                  <th className="text-left py-1 pr-2">Email</th>
                  <th className="text-left py-1 pr-2">Connected</th>
                  <th className="text-left py-1 pr-2">Last DM</th>
                  <th className="text-left py-1 pr-2">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isDisconnected = !!r.disconnectedAt;
                  return (
                    <tr
                      key={r.id}
                      className="border-b last:border-b-0 align-top"
                      data-testid={`row-user-identity-${r.userId}`}
                    >
                      <td className="py-1 pr-2 font-mono">{r.userId}</td>
                      <td className="py-1 pr-2 font-mono">{r.slackUserId}</td>
                      <td className="py-1 pr-2">{r.slackEmail ?? "—"}</td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {isDisconnected
                          ? "disconnected"
                          : formatDistanceToNow(new Date(r.connectedAt), {
                              addSuffix: true,
                            })}
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {r.lastDmAt
                          ? formatDistanceToNow(new Date(r.lastDmAt), {
                              addSuffix: true,
                            })
                          : "never"}
                      </td>
                      <td className="py-1 pr-2">
                        {r.lastDmStatus ? (
                          <span
                            className={
                              r.lastDmStatus === "success"
                                ? "text-green-700"
                                : r.lastDmStatus.startsWith("failed")
                                ? "text-red-700"
                                : "text-muted-foreground"
                            }
                          >
                            {r.lastDmStatus}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-1 pr-2 text-right">
                        {!isDisconnected && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disconnectMutation.isPending}
                            onClick={() => disconnectMutation.mutate(r.userId)}
                            data-testid={`button-admin-disconnect-${r.userId}`}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Disconnect
                          </Button>
                        )}
                      </td>
                    </tr>
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

type CallArchiveAuditUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};
type CallArchiveAuditEntry = {
  settingKey: string;
  updatedAt: string | null;
  updatedBy: CallArchiveAuditUser | null;
};
type CallArchiveThresholds = {
  enabled: boolean;
  pendingHours: number;
  pendingCount: number;
  failedLookbackHours: number;
  failedCount: number;
  cooldownMinutes: number;
  audit?: Record<string, CallArchiveAuditEntry>;
};

function formatAuditUser(user: CallArchiveAuditUser | null): string {
  if (!user) return "system";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email || user.id;
}

const CALL_ARCHIVE_NOTIF_ID = "queue.call_recording_archive.backlog_or_failures";

type CallArchiveLiveCounts = {
  pendingStuck: number;
  recentFailures: number;
  pendingHours: number;
  failedLookbackHours: number;
  evaluatedAt: string;
};

function CallArchiveThresholdsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CallArchiveThresholds | null>(null);

  const cfgQuery = useQuery<CallArchiveThresholds>({
    queryKey: ["/api/admin/notifications/call-archive-thresholds"],
  });

  const liveCountsQuery = useQuery<CallArchiveLiveCounts>({
    queryKey: ["/api/admin/notifications/call-archive-thresholds/live-counts"],
  });

  const current = cfgQuery.data ?? null;
  const view = draft ?? current;

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: CallArchiveThresholds) => {
      const res = await apiRequest(
        "PUT",
        "/api/admin/notifications/call-archive-thresholds",
        payload,
      );
      return (await res.json()) as CallArchiveThresholds;
    },
    onSuccess: (data) => {
      qc.setQueryData(["/api/admin/notifications/call-archive-thresholds"], data);
      void qc.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/notifications/call-archive-thresholds/live-counts"],
      });
      setDraft(null);
      toast({ title: "Thresholds saved", description: "Watcher will pick up new values on the next tick." });
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch(`/api/admin/notifications/${CALL_ARCHIVE_NOTIF_ID}/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error ?? `Request failed (${res.status})`);
      }
      return data;
    },
    onSuccess: () => {
      toast({ title: "Test alert sent", description: "Posted to the configured Slack channel." });
    },
    onError: (err: any) => {
      toast({ title: "Test failed", description: err.message, variant: "destructive" });
    },
  });

  const dirty = !!(draft && current && (
    draft.enabled !== current.enabled ||
    draft.pendingHours !== current.pendingHours ||
    draft.pendingCount !== current.pendingCount ||
    draft.failedLookbackHours !== current.failedLookbackHours ||
    draft.failedCount !== current.failedCount ||
    draft.cooldownMinutes !== current.cooldownMinutes
  ));

  function patch(field: keyof CallArchiveThresholds, value: number | boolean) {
    setDraft((prev) => {
      const base = prev ?? current;
      if (!base) return prev;
      return { ...base, [field]: value } as CallArchiveThresholds;
    });
  }

  function auditLine(field: string, testId: string) {
    const entry = current?.audit?.[field];
    if (!entry || !entry.updatedAt) {
      return (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`${testId}-audit`}
        >
          Never edited (using default).
        </p>
      );
    }
    const when = formatDistanceToNow(new Date(entry.updatedAt), { addSuffix: true });
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid={`${testId}-audit`}
        title={`${entry.settingKey} · ${entry.updatedAt}`}
      >
        Edited {when} by {formatAuditUser(entry.updatedBy)}
      </p>
    );
  }

  function intInput(
    field: keyof CallArchiveThresholds,
    label: string,
    helper: string,
    testId: string,
  ) {
    const v = view ? (view[field] as number) : 0;
    return (
      <div className="space-y-1">
        <Label htmlFor={testId} className="text-xs font-medium">{label}</Label>
        <Input
          id={testId}
          type="number"
          min={1}
          step={1}
          value={Number.isFinite(v) ? v : ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) patch(field, n);
          }}
          disabled={!view || saveMutation.isPending}
          data-testid={testId}
          className="h-8"
        />
        <p className="text-xs text-muted-foreground">{helper}</p>
        {auditLine(field as string, testId)}
      </div>
    );
  }

  return (
    <Card data-testid="card-call-archive-thresholds">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600" />
          Call recording archive — alert thresholds
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Tune the call-archive backlog watcher without a deploy. Changes are picked up on the next watcher tick (every 15&nbsp;min).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {cfgQuery.isLoading && (
          <div className="text-sm text-muted-foreground" data-testid="loading-call-archive-thresholds">
            <Loader2 className="w-4 h-4 animate-spin inline mr-1" />
            Loading thresholds…
          </div>
        )}
        {cfgQuery.error && (
          <div className="text-sm text-red-700" data-testid="error-call-archive-thresholds">
            Failed to load thresholds.
          </div>
        )}
        {view && (
          <>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <Switch
                  checked={view.enabled}
                  onCheckedChange={(v) => patch("enabled", v)}
                  disabled={saveMutation.isPending}
                  aria-label="Enable call archive alerting"
                  data-testid="switch-call-archive-alert-enabled"
                />
                <span className="text-sm">
                  Alerting {view.enabled ? "enabled" : "disabled"}
                </span>
                <span className="text-xs text-muted-foreground ml-auto font-mono">
                  {CALL_ARCHIVE_NOTIF_ID}
                </span>
              </div>
              {auditLine("enabled", "switch-call-archive-alert-enabled")}
            </div>

            <div
              className="rounded-md border bg-muted/50 p-3 flex items-center gap-3 flex-wrap"
              data-testid="panel-call-archive-live-counts"
            >
              <Badge
                variant="outline"
                className="bg-card text-sm font-mono"
                data-testid="badge-call-archive-pending-stuck"
              >
                Pending stuck right now:{" "}
                {liveCountsQuery.isLoading
                  ? "…"
                  : liveCountsQuery.error
                    ? "?"
                    : liveCountsQuery.data?.pendingStuck ?? 0}
              </Badge>
              <Badge
                variant="outline"
                className="bg-card text-sm font-mono"
                data-testid="badge-call-archive-recent-failures"
              >
                Recent failures ({liveCountsQuery.data?.failedLookbackHours ?? view.failedLookbackHours}h):{" "}
                {liveCountsQuery.isLoading
                  ? "…"
                  : liveCountsQuery.error
                    ? "?"
                    : liveCountsQuery.data?.recentFailures ?? 0}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Same SQL the watcher uses (pending older than{" "}
                {liveCountsQuery.data?.pendingHours ?? view.pendingHours}h, no recording metadata).
                {liveCountsQuery.data?.evaluatedAt && (
                  <>
                    {" "}As of {format(new Date(liveCountsQuery.data.evaluatedAt), "HH:mm:ss")}.
                  </>
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() =>
                  qc.invalidateQueries({
                    queryKey: ["/api/admin/notifications/call-archive-thresholds/live-counts"],
                  })
                }
                disabled={liveCountsQuery.isFetching}
                data-testid="button-refresh-call-archive-live-counts"
              >
                {liveCountsQuery.isFetching ? (
                  <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Refreshing…</>
                ) : (
                  "Refresh"
                )}
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {intInput(
                "pendingHours",
                "Pending age (hours)",
                "Rows in archive_status='pending' older than this count toward the pending bucket.",
                "input-call-archive-pending-hours",
              )}
              {intInput(
                "pendingCount",
                "Pending count threshold",
                "Fire alert when ≥ this many rows breach the pending age above.",
                "input-call-archive-pending-count",
              )}
              {intInput(
                "failedLookbackHours",
                "Failed lookback (hours)",
                "Window for counting recently-failed (attempts ≥ MAX_ATTEMPTS) rows.",
                "input-call-archive-failed-lookback-hours",
              )}
              {intInput(
                "failedCount",
                "Failed count threshold",
                "Fire alert when ≥ this many rows failed within the lookback above.",
                "input-call-archive-failed-count",
              )}
              {intInput(
                "cooldownMinutes",
                "Cooldown (minutes)",
                "Per-bucket cooldown between alerts; re-alerts early only on a full-threshold growth.",
                "input-call-archive-cooldown-minutes",
              )}
            </div>

            <div className="flex items-center gap-2 pt-2 border-t">
              <Button
                size="sm"
                onClick={() => view && saveMutation.mutate(view)}
                disabled={!dirty || saveMutation.isPending}
                data-testid="button-save-call-archive-thresholds"
              >
                {saveMutation.isPending ? (
                  <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Saving…</>
                ) : (
                  "Save thresholds"
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(null)}
                disabled={!dirty || saveMutation.isPending}
                data-testid="button-reset-call-archive-thresholds"
              >
                Reset
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
                data-testid="button-test-call-archive-alert"
              >
                {testMutation.isPending ? (
                  <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Sending…</>
                ) : (
                  "Send test alert"
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
