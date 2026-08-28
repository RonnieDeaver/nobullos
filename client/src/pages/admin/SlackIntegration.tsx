import { useState } from "react";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { parseIntegrationStatusUnknownError } from "@shared/integrationStatusUnknown";
import {
  MessageSquare, Loader2, Check, X, RefreshCw, Link2, Unlink,
  AlertCircle, CheckCircle, Radio, User, ExternalLink,
  ChevronDown, ChevronRight, Search, Filter, Hash, Calendar,
  ArrowUpDown, UserPlus, UserMinus, History,
} from "lucide-react";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { matchMethodLabel, matchMethodColor, reviewReasonLabel } from "@/lib/matchMethod";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { BreakerDetailRow } from "@/components/admin/BreakerDetailRow";
import { PageHeader } from "@/components/admin/PageHeader";

// Task #2177 — auth-dead breaker detail forwarded by GET
// /api/integrations/all-status, mirrored here so an operator landing on the
// dedicated Slack console sees the same "Disconnected at / Auto-retry at /
// N trips" detail the Integrations Hub shows.
type SlackBreakerStatus = {
  breakerOpen?: boolean;
  cooldownRemainingMs?: number;
  lastTrippedAt?: string | null;
  cooldownUntil?: string | null;
  tripCount?: number;
};

type SlackStatus = {
  connected: boolean;
  team?: string;
  user?: string;
  valid?: boolean;
  lastEdited?: { botToken?: LastEditedInfo };
};

type SyncHistory = {
  id: string;
  triggeredBy: string | null;
  status: string;
  channelsProcessed: number;
  messagesCreated: number;
  messagesSkipped: number;
  errors: string[] | null;
  startedAt: string;
  completedAt: string | null;
};

type SlackMessageFeed = {
  id: string;
  clientId: string | null;
  clientName: string | null;
  title: string | null;
  contentText: string | null;
  contentPreview: string | null;
  timestamp: string;
  direction: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  externalUrl: string | null;
  sourceSubtype: string | null;
  aiSummary: string | null;
  createdAt: string;
  rawPayload: { channelId?: string; channelName?: string; user?: string } | null;
  participants: Array<{ name?: string; email?: string; role?: string }> | null;
  externalSourceId?: string | null;
  review?: {
    decisionId: string;
    reviewReason: string | null;
    explanationSummary: string | null;
    suggestedClientId: string | null;
    suggestedClientName: string | null;
    suggestedConfidence: number | null;
    priorClientId: string | null;
    priorClientName: string | null;
    candidates: Array<{
      clientId: string | null;
      clientName: string | null;
      confidenceScore: number | null;
      evidenceType: string | null;
      explanationSummary: string | null;
    }>;
  } | null;
  resolved?: {
    decisionId: string;
    resolution: "approved" | "reassigned" | "dismissed";
    reviewedAt: string | null;
    reviewerName: string | null;
    reviewReason: string | null;
    suggestedClientId: string | null;
    suggestedClientName: string | null;
    finalClientId: string | null;
    finalClientName: string | null;
    dismissReason: string | null;
  } | null;
};

type MessageFeedResponse = {
  messages: SlackMessageFeed[];
  stats: {
    total: number;
    matched: number;
    unmatched: number;
    matchRate: number;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

type ClientOption = {
  id: string;
  firmName: string;
};


function MessageRow({
  msg,
  isExpanded,
  onToggle,
  clients,
  onReassign,
  isReassigning,
}: {
  msg: SlackMessageFeed;
  isExpanded: boolean;
  onToggle: () => void;
  clients: ClientOption[];
  onReassign: (messageId: string, clientId: string | null) => void;
  isReassigning: boolean;
}) {
  const [showClientPicker, setShowClientPicker] = useState(false);
  const channelName = msg.rawPayload?.channelName || "unknown";
  const senderName = msg.participants?.[0]?.name || "Unknown";

  return (
    <div className="border rounded-lg overflow-hidden" data-testid={`row-message-${msg.id}`}>
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggle}
        data-testid={`button-expand-${msg.id}`}
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}

        <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
          <Badge variant="outline" className="text-xs font-mono bg-muted/50">
            <Hash className="w-3 h-3 mr-0.5" />
            {channelName}
          </Badge>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate" data-testid={`text-preview-${msg.id}`}>
            {msg.contentPreview || msg.title || "(no content)"}
          </p>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
            <span>{senderName}</span>
            <span>·</span>
            <span>{format(new Date(msg.timestamp), "MMM d, h:mm a")}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {msg.clientId ? (
            <>
              <Badge variant="outline" className={matchMethodColor(msg.matchMethod)} data-testid={`badge-method-${msg.id}`}>
                {matchMethodLabel(msg.matchMethod)}
              </Badge>
              <Badge
                variant="outline"
                className="bg-green-50 text-green-700 border-green-200"
                data-testid={`badge-match-${msg.id}`}
              >
                <User className="w-3 h-3 mr-1" />
                {msg.clientName}
                {msg.matchConfidence != null && (
                  <span className="ml-1 text-green-500 text-[10px]">
                    {Math.round(msg.matchConfidence * 100)}%
                  </span>
                )}
              </Badge>
            </>
          ) : (
            <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border" data-testid={`badge-unmatched-${msg.id}`}>
              Unmatched
            </Badge>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="border-t bg-muted/50 p-4 space-y-3" data-testid={`expanded-${msg.id}`}>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground font-medium mb-1">Channel</p>
              <p className="flex items-center gap-1">
                <Hash className="w-3.5 h-3.5" />
                {channelName}
                {msg.sourceSubtype === "slack_thread" && (
                  <Badge variant="outline" className="text-[10px] ml-1">Thread</Badge>
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Sender</p>
              <p>{senderName}</p>
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Timestamp</p>
              <p>{format(new Date(msg.timestamp), "MMM d, yyyy h:mm:ss a")}</p>
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Match Method</p>
              {msg.matchMethod ? (
                <Badge variant="outline" className={matchMethodColor(msg.matchMethod)}>
                  {matchMethodLabel(msg.matchMethod)}
                  {msg.matchConfidence != null && ` (${Math.round(msg.matchConfidence * 100)}%)`}
                </Badge>
              ) : (
                <span className="text-muted-foreground">No match</span>
              )}
            </div>
          </div>

          <div>
            <p className="text-muted-foreground font-medium mb-1 text-sm">Full Message</p>
            <div className="bg-card border rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
              {msg.contentText || "(no content)"}
            </div>
          </div>

          {msg.resolved && (() => {
            const r = msg.resolved;
            const palette =
              r.resolution === "approved"
                ? { border: "border-emerald-300", bg: "bg-emerald-50", icon: "text-emerald-700", title: "text-emerald-900", body: "text-emerald-800", muted: "text-emerald-600" }
                : r.resolution === "reassigned"
                ? { border: "border-blue-300", bg: "bg-blue-50", icon: "text-blue-700", title: "text-blue-900", body: "text-blue-800", muted: "text-blue-600" }
                : { border: "border-border", bg: "bg-muted/50", icon: "text-foreground", title: "text-foreground", body: "text-foreground", muted: "text-muted-foreground" };
            const Icon = r.resolution === "dismissed" ? X : CheckCircle;
            const headline =
              r.resolution === "approved"
                ? "Approved"
                : r.resolution === "reassigned"
                ? "Reassigned"
                : "Dismissed";
            const reviewedAtLabel = r.reviewedAt
              ? format(new Date(r.reviewedAt), "MMM d, yyyy 'at' h:mm a")
              : null;
            return (
              <div
                className={`border ${palette.border} ${palette.bg} rounded-lg p-3 space-y-2`}
                data-testid={`resolved-panel-${msg.id}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Icon className={`w-4 h-4 ${palette.icon}`} />
                  <p className={`text-sm font-medium ${palette.title}`} data-testid={`resolved-headline-${msg.id}`}>
                    Resolved by reviewer — {headline}
                  </p>
                  {r.reviewReason && (
                    <span className={`text-xs ${palette.muted}`}>
                      · {reviewReasonLabel(r.reviewReason)}
                    </span>
                  )}
                </div>
                <p className={`text-xs ${palette.body}`} data-testid={`resolved-meta-${msg.id}`}>
                  <span className="font-medium">{r.reviewerName || "Unknown reviewer"}</span>
                  {reviewedAtLabel && <span className={`ml-1 ${palette.muted}`}>· {reviewedAtLabel}</span>}
                </p>
                {r.resolution === "dismissed" && r.dismissReason && (
                  <p className={`text-xs ${palette.body}`} data-testid={`resolved-dismiss-reason-${msg.id}`}>
                    <span className="font-medium">Dismiss reason:</span> {r.dismissReason}
                  </p>
                )}
                <div className={`text-xs ${palette.body} space-y-0.5`}>
                  <p data-testid={`resolved-suggested-${msg.id}`}>
                    <span className="font-medium">Original suggestion:</span>{" "}
                    {r.suggestedClientName || <span className={palette.muted}>None</span>}
                  </p>
                  <p data-testid={`resolved-final-${msg.id}`}>
                    <span className="font-medium">Final attribution:</span>{" "}
                    {r.finalClientName ? (
                      r.finalClientName
                    ) : (
                      <span className={palette.muted}>Unattributed</span>
                    )}
                    {r.resolution === "reassigned" && r.finalClientName && r.suggestedClientName && (
                      <span className={`ml-1 ${palette.muted}`}>(corrected from {r.suggestedClientName})</span>
                    )}
                  </p>
                </div>
              </div>
            );
          })()}

          {msg.aiSummary && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-sm">AI Summary</p>
              <p className="text-sm bg-card border rounded p-3">{msg.aiSummary}</p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            {msg.externalUrl && (
              <a
                href={msg.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                data-testid={`link-slack-${msg.id}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View in Slack
              </a>
            )}

            <div className="flex-1" />

            {showClientPicker ? (
              <div className="flex items-center gap-2">
                <Select
                  onValueChange={(value) => {
                    const cId = value === "__unmatched__" ? null : value;
                    onReassign(msg.id, cId);
                    setShowClientPicker(false);
                  }}
                >
                  <SelectTrigger className="w-52 h-8 text-sm" data-testid={`select-client-${msg.id}`}>
                    <SelectValue placeholder="Select client..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unmatched__">Mark as Unmatched</SelectItem>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.firmName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowClientPicker(false)}
                  data-testid={`button-cancel-reassign-${msg.id}`}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowClientPicker(true)}
                disabled={isReassigning}
                data-testid={`button-reassign-${msg.id}`}
              >
                {isReassigning ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : msg.clientId ? (
                  <ArrowUpDown className="w-3.5 h-3.5 mr-1" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5 mr-1" />
                )}
                {msg.clientId ? "Reassign" : "Match to Client"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type AlertChannelTestAttempt = {
  id: string;
  attemptedAt: string;
  channelId: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  success: boolean;
  errorMessage: string | null;
};

type AlertChannelStatus = {
  slackConfigured: boolean;
  slackChannelId: string | null;
  slackSource: "system_setting" | "env" | "none";
  envChannelId: string | null;
  emailConfigured: boolean;
  lastEdited: LastEditedInfo | null;
  lastTest: AlertChannelTestAttempt | null;
};

type SlackChannelOption = { id: string; name: string; isPrivate: boolean };

type AlertChannelHistoryEntry = {
  id: string;
  settingKey: string;
  scope: string | null;
  changedBy: string | null;
  oldValues: { channelId?: string | null } | null;
  newValues: { channelId?: string | null } | null;
  changedAt: string | null;
  changedByName: string | null;
  changedByEmail: string | null;
};

type AlertChannelHistoryResponse = { history: AlertChannelHistoryEntry[] };

type AlertChannelDetailResponse = {
  channelId: string;
  slackConnected: boolean;
  channel: {
    id: string;
    name: string | null;
    isPrivate: boolean;
    isArchived: boolean;
    isMember: boolean;
    numMembers: number | null;
    topic: string | null;
    purpose: string | null;
    teamId: string | null;
  } | null;
  permalink: string | null;
  workspace: { teamId: string | null; teamName: string | null; url: string | null } | null;
};

function ChannelDetailDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<AlertChannelDetailResponse>({
    queryKey: ["/api/admin/match-settings/alert-channel/channel-info", channelId],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/match-settings/alert-channel/channel-info?channelId=${encodeURIComponent(channelId!)}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to load channel details (${res.status})`);
      }
      return res.json();
    },
    enabled: open && !!channelId,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-alert-channel-detail">
        <DialogHeader>
          <DialogTitle>Channel details</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="text-xs text-muted-foreground" data-testid="text-channel-detail-id">
            Channel ID: <span className="font-mono">{channelId ?? "—"}</span>
          </div>
          {isLoading ? (
            <InlineLoadingSkeleton lines={3} />
          ) : isError ? (
            <div
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800"
              data-testid="text-channel-detail-error"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-600" />
              <div className="flex-1">
                <p className="font-medium">Could not load channel details</p>
                <p className="font-mono break-all">
                  {(error as Error | undefined)?.message || "Unknown error"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                data-testid="button-retry-channel-detail"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Retry
              </Button>
            </div>
          ) : !data?.slackConnected ? (
            <div
              className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
              data-testid="text-channel-detail-disconnected"
            >
              Slack is not connected, so we can't look up live channel details. Reconnect Slack from the
              Integrations page to see the channel name, membership, and an Open-in-Slack link.
            </div>
          ) : !data.channel ? (
            <div
              className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 space-y-2"
              data-testid="text-channel-detail-not-found"
            >
              <p>
                Channel no longer accessible. The bot can't see this channel — it may have been
                archived, renamed, deleted, or the bot was removed.
              </p>
              {data.permalink && (
                <a
                  className="inline-flex items-center gap-1 underline"
                  href={data.permalink}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="link-channel-detail-open-slack-fallback"
                >
                  <ExternalLink className="w-3 h-3" />
                  Try opening in Slack
                </a>
              )}
            </div>
          ) : (
            <div className="space-y-2" data-testid="text-channel-detail-info">
              <div className="flex items-center gap-2">
                <Hash className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium" data-testid="text-channel-detail-name">
                  {data.channel.name ? `#${data.channel.name}` : channelId}
                </span>
                <Badge
                  variant="outline"
                  data-testid="badge-channel-detail-visibility"
                >
                  {data.channel.isPrivate ? "Private" : "Public"}
                </Badge>
                {data.channel.isArchived && (
                  <Badge
                    variant="outline"
                    className="border-amber-300 bg-amber-50 text-amber-800"
                    data-testid="badge-channel-detail-archived"
                  >
                    Archived
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={
                    data.channel.isMember
                      ? "border-green-300 bg-green-50 text-green-800"
                      : "border-red-300 bg-red-50 text-red-800"
                  }
                  data-testid="badge-channel-detail-membership"
                >
                  {data.channel.isMember ? "Bot is a member" : "Bot is not a member"}
                </Badge>
              </div>
              {typeof data.channel.numMembers === "number" && (
                <div className="text-xs text-muted-foreground" data-testid="text-channel-detail-members">
                  {data.channel.numMembers} member{data.channel.numMembers === 1 ? "" : "s"}
                </div>
              )}
              {data.channel.topic && (
                <div className="text-xs text-foreground" data-testid="text-channel-detail-topic">
                  <span className="font-medium">Topic:</span> {data.channel.topic}
                </div>
              )}
              {data.channel.purpose && (
                <div className="text-xs text-foreground" data-testid="text-channel-detail-purpose">
                  <span className="font-medium">Purpose:</span> {data.channel.purpose}
                </div>
              )}
              {data.permalink && (
                <a
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs"
                  href={data.permalink}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="link-channel-detail-open-slack"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open in Slack
                </a>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AlertChannelCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draftChannelId, setDraftChannelId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [testHistoryOpen, setTestHistoryOpen] = useState(false);
  const [detailChannelId, setDetailChannelId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    | { status: "success"; channelId: string | null }
    | { status: "error"; message: string }
    | null
  >(null);

  const { data: alertStatus, isLoading: alertLoading } = useQuery<AlertChannelStatus>({
    queryKey: ["/api/admin/match-settings/alert-channel"],
  });

  const { data: channelsData, isLoading: channelsLoading } = useQuery<{ channels: SlackChannelOption[] }>({
    queryKey: ["/api/integrations/slack/channels"],
  });

  const effectiveChannelId = dirty ? draftChannelId : alertStatus?.slackChannelId ?? null;

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (channelId: string | null) => {
      const res = await apiRequest("PUT", "/api/admin/match-settings/alert-channel", { channelId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Alert channel updated" });
      setDirty(false);
      setTestResult(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/match-settings/alert-channel"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (channelId: string | null) => {
      const res = await fetch("/api/admin/match-settings/alert-channel/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ channelId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        const msg = data?.error || `Request failed (${res.status})`;
        throw new Error(msg);
      }
      return data as { ok: true; channelId: string | null };
    },
    onSuccess: (data) => {
      setTestResult({ status: "success", channelId: data.channelId ?? null });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/match-settings/alert-channel"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/match-settings/alert-channel/test-history"],
      });
    },
    onError: (err: any) => {
      setTestResult({ status: "error", message: err?.message || "Failed to send test alert" });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/match-settings/alert-channel"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/match-settings/alert-channel/test-history"],
      });
    },
  });

  const channels = channelsData?.channels || [];

  const {
    data: historyData,
    isLoading: historyLoading,
    isError: historyError,
    error: historyErrorObj,
    refetch: refetchHistory,
  } = useQuery<AlertChannelHistoryResponse>({
    queryKey: ["/api/admin/match-settings/alert-channel/history"],
    queryFn: async () => {
      const res = await fetch("/api/admin/match-settings/alert-channel/history", {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to load history (${res.status})`);
      }
      return res.json();
    },
    enabled: historyOpen,
  });

  const {
    data: testHistoryData,
    isLoading: testHistoryLoading,
    isError: testHistoryError,
    error: testHistoryErrorObj,
    refetch: refetchTestHistory,
  } = useQuery<{ attempts: AlertChannelTestAttempt[] }>({
    queryKey: ["/api/admin/match-settings/alert-channel/test-history"],
    queryFn: async () => {
      const res = await fetch("/api/admin/match-settings/alert-channel/test-history", {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to load test history (${res.status})`);
      }
      return res.json();
    },
    enabled: testHistoryOpen,
  });

  const formatChannel = (channelId: string | null | undefined): string => {
    if (!channelId) return "— none —";
    const ch = channels.find((c) => c.id === channelId);
    return ch ? `#${ch.name}${ch.isPrivate ? " (private)" : ""} (${channelId})` : channelId;
  };

  return (
    <Card className="mb-6" data-testid="card-alert-channel">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-lg">Threshold Alert Channel</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setHistoryOpen(true);
              void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
                queryKey: ["/api/admin/match-settings/alert-channel/history"],
              });
            }}
            data-testid="button-view-alert-channel-history"
          >
            <History className="w-4 h-4 mr-1" />
            View history
          </Button>
        </div>
        {!alertLoading && (
          <LastEditedBadge
            info={alertStatus?.lastEdited ?? null}
            testId="last-edited-alert-channel"
            emptyText="Channel has never been changed from the integrations page"
          />
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Choose the Slack channel that receives matching-threshold change alerts. The bot must be a member of the channel to appear in the list.
        </p>

        {alertLoading || channelsLoading ? (
          <InlineLoadingSkeleton lines={2} />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Select
                value={effectiveChannelId ?? "__none__"}
                onValueChange={(v) => {
                  setDraftChannelId(v === "__none__" ? null : v);
                  setDirty(true);
                }}
              >
                <SelectTrigger className="w-72" data-testid="select-alert-channel">
                  <SelectValue placeholder="Select a channel..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    {alertStatus?.envChannelId
                      ? "— Clear override (use env default) —"
                      : "— None (disable Slack alerts) —"}
                  </SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id} data-testid={`option-channel-${c.id}`}>
                      #{c.name}{c.isPrivate ? " (private)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={() => saveMutation.mutate(draftChannelId)}
                disabled={!dirty || saveMutation.isPending}
                data-testid="button-save-alert-channel"
              >
                {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                Save
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setTestResult(null);
                  testMutation.mutate(dirty ? draftChannelId : null);
                }}
                disabled={
                  testMutation.isPending ||
                  saveMutation.isPending ||
                  !effectiveChannelId
                }
                data-testid="button-test-alert-channel"
              >
                {testMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : null}
                Send test message
              </Button>
            </div>

            {testResult?.status === "success" && (() => {
              const ch = channels.find((c) => c.id === testResult.channelId);
              const label = ch ? `#${ch.name}` : testResult.channelId || "the configured channel";
              return (
                <div
                  className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 p-2 text-xs text-green-800"
                  data-testid="text-test-alert-success"
                >
                  <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-600" />
                  <span>
                    Test alert posted to {label}. Check Slack to confirm it arrived.
                  </span>
                </div>
              );
            })()}
            {testResult?.status === "error" && (
              <div
                className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800"
                data-testid="text-test-alert-error"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-600" />
                <div>
                  <p className="font-medium">Test alert failed</p>
                  <p className="font-mono break-all">{testResult.message}</p>
                </div>
              </div>
            )}
            {dirty && (
              <p className="text-xs text-muted-foreground" data-testid="text-test-alert-draft-note">
                Test will be sent to the channel selected above (no need to save first).
              </p>
            )}

            {alertStatus?.slackSource === "env" && !dirty && (
              <p className="text-xs text-amber-600" data-testid="text-alert-channel-env-note">
                Currently using the MATCH_SETTINGS_SLACK_CHANNEL_ID environment variable
                {alertStatus.envChannelId ? ` (${alertStatus.envChannelId})` : ""}. Selecting a channel here will override it.
              </p>
            )}
            {alertStatus?.slackSource === "none" && !dirty && (
              <p className="text-xs text-muted-foreground" data-testid="text-alert-channel-none">
                No alert channel is configured — Slack threshold-change alerts are disabled.
              </p>
            )}
            {alertStatus?.slackSource === "system_setting" && !dirty && alertStatus.slackChannelId && (
              <p className="text-xs text-green-700" data-testid="text-alert-channel-active">
                Alerts will be posted to{" "}
                {channels.find((c) => c.id === alertStatus.slackChannelId)
                  ? `#${channels.find((c) => c.id === alertStatus.slackChannelId)!.name}`
                  : alertStatus.slackChannelId}
                .
              </p>
            )}

            {alertStatus?.lastTest && (() => {
              const lt = alertStatus.lastTest;
              const ch = channels.find((c) => c.id === lt.channelId);
              const channelLabel = ch ? `#${ch.name}` : lt.channelId;
              const actor = lt.actorName || lt.actorEmail || "Someone";
              let when = lt.attemptedAt;
              try {
                when = format(new Date(lt.attemptedAt), "MMM d, yyyy 'at' h:mm a");
              } catch {
                /* fall back to raw ISO */
              }
              return lt.success ? (
                <div
                  className="rounded-md border border-green-200 bg-green-50 p-2 text-xs text-green-800"
                  data-testid="text-last-test-result"
                >
                  <div className="flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-600" />
                    <div>
                      <p className="font-medium">
                        Last test alert succeeded
                      </p>
                      <p data-testid="text-last-test-meta">
                        {actor} sent a test to {channelLabel} on {when}.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800"
                  data-testid="text-last-test-result"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-600" />
                    <div>
                      <p className="font-medium">
                        Last test alert failed
                      </p>
                      <p data-testid="text-last-test-meta">
                        {actor} attempted a test to {channelLabel} on {when}.
                      </p>
                      {lt.errorMessage && (
                        <p className="font-mono break-all mt-1" data-testid="text-last-test-error">
                          {lt.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="pt-1">
              <button
                type="button"
                onClick={() => {
                  setTestHistoryOpen((prev) => {
                    const next = !prev;
                    if (next) {
                      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
                        queryKey: ["/api/admin/match-settings/alert-channel/test-history"],
                      });
                    }
                    return next;
                  });
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-toggle-test-history"
                aria-expanded={testHistoryOpen}
              >
                {testHistoryOpen ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                {testHistoryOpen ? "Hide recent tests" : "Show recent tests"}
              </button>
              {testHistoryOpen && (
                <div className="mt-2 rounded-md border border-border bg-muted/50 p-2">
                  {testHistoryLoading ? (
                    <InlineLoadingSkeleton lines={2} />
                  ) : testHistoryError ? (
                    <div
                      className="flex items-start gap-2 text-xs text-red-700"
                      data-testid="text-test-history-error"
                    >
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p>
                          {(testHistoryErrorObj as Error | undefined)?.message ||
                            "Failed to load recent tests"}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-1"
                          onClick={() => refetchTestHistory()}
                          data-testid="button-retry-test-history"
                        >
                          Retry
                        </Button>
                      </div>
                    </div>
                  ) : !testHistoryData?.attempts.length ? (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="text-no-test-history"
                    >
                      No test alerts have been sent yet.
                    </p>
                  ) : (
                    <ul
                      className="divide-y divide-border"
                      data-testid="list-test-history"
                    >
                      {testHistoryData.attempts.map((attempt) => {
                        const ch = channels.find((c) => c.id === attempt.channelId);
                        const channelLabel = ch ? `#${ch.name}` : attempt.channelId;
                        const actor =
                          attempt.actorName || attempt.actorEmail || "Someone";
                        let when = attempt.attemptedAt;
                        try {
                          when = format(
                            new Date(attempt.attemptedAt),
                            "MMM d, yyyy 'at' h:mm a",
                          );
                        } catch {
                          /* fall back to raw ISO */
                        }
                        return (
                          <li
                            key={attempt.id}
                            className="py-1.5 text-xs"
                            data-testid={`row-test-history-${attempt.id}`}
                          >
                            <div className="flex items-start gap-2">
                              {attempt.success ? (
                                <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-green-600" />
                              ) : (
                                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-red-600" />
                              )}
                              <div className="flex-1">
                                <p
                                  className="text-foreground"
                                  data-testid={`text-test-history-meta-${attempt.id}`}
                                >
                                  <span className="font-medium">
                                    {attempt.success ? "Success" : "Failed"}
                                  </span>
                                  {" — "}
                                  {actor} → {channelLabel} on {when}
                                </p>
                                {!attempt.success && attempt.errorMessage && (
                                  <p
                                    className="font-mono break-all text-red-700 mt-0.5"
                                    data-testid={`text-test-history-error-${attempt.id}`}
                                  >
                                    {attempt.errorMessage}
                                  </p>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-2xl" data-testid="dialog-alert-channel-history">
          <DialogHeader>
            <DialogTitle>Threshold alert channel — change history</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {historyLoading ? (
              <InlineLoadingSkeleton lines={3} />
            ) : historyError ? (
              <div
                className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800"
                data-testid="text-alert-channel-history-error"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-600" />
                <div className="flex-1">
                  <p className="font-medium">Could not load change history</p>
                  <p className="font-mono break-all">
                    {(historyErrorObj as Error | undefined)?.message || "Unknown error"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchHistory()}
                  data-testid="button-retry-alert-channel-history"
                >
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Retry
                </Button>
              </div>
            ) : !historyData || historyData.history.length === 0 ? (
              <div
                className="text-sm text-muted-foreground py-4 text-center"
                data-testid="text-no-alert-channel-history"
              >
                No channel changes have been recorded yet.
              </div>
            ) : (
              <ul className="divide-y">
                {historyData.history.map((entry) => {
                  const oldCh = entry.oldValues?.channelId ?? null;
                  const newCh = entry.newValues?.channelId ?? null;
                  const who = formatEditorAttribution(entry, "system");
                  const when = entry.changedAt
                    ? new Date(entry.changedAt).toLocaleString()
                    : "—";
                  const rowChannelId = newCh ?? oldCh;
                  const renderChannelLabel = (
                    channelId: string | null,
                    side: "old" | "new",
                  ) => {
                    if (!channelId) {
                      return <span className="font-medium">{formatChannel(channelId)}</span>;
                    }
                    return (
                      <span
                        className="font-medium text-blue-700 underline-offset-2 group-hover:underline"
                        data-testid={`text-alert-channel-history-${side}-${entry.id}`}
                      >
                        {formatChannel(channelId)}
                      </span>
                    );
                  };
                  const isClickable = !!rowChannelId;
                  return (
                    <li
                      key={entry.id}
                      data-testid={`row-alert-channel-history-${entry.id}`}
                    >
                      <button
                        type="button"
                        disabled={!isClickable}
                        onClick={() => {
                          if (rowChannelId) setDetailChannelId(rowChannelId);
                        }}
                        className={`group w-full text-left py-3 text-sm space-y-1 ${
                          isClickable
                            ? "cursor-pointer hover:bg-muted/50 focus:bg-muted/50 focus:outline-none rounded-md px-2"
                            : "cursor-default px-2"
                        }`}
                        data-testid={`button-alert-channel-history-row-${entry.id}`}
                      >
                        <div
                          className="text-foreground"
                          data-testid={`text-alert-channel-history-change-${entry.id}`}
                        >
                          {renderChannelLabel(oldCh, "old")}
                          <span className="mx-2 text-muted-foreground">→</span>
                          {renderChannelLabel(newCh, "new")}
                        </div>
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <User className="w-3 h-3" />
                          <span data-testid={`text-alert-channel-history-user-${entry.id}`}>
                            {who}
                          </span>
                          <span>·</span>
                          <Calendar className="w-3 h-3" />
                          <span data-testid={`text-alert-channel-history-time-${entry.id}`}>
                            {when}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ChannelDetailDialog
        channelId={detailChannelId}
        open={!!detailChannelId}
        onOpenChange={(open) => {
          if (!open) setDetailChannelId(null);
        }}
      />
    </Card>
  );
}

export default function SlackIntegration() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [botToken, setBotToken] = useState("");

  const [page, setPage] = useState(1);
  const [matchFilter, setMatchFilter] = useState<string>("all");
  const [channelFilter, setChannelFilter] = useState("");
  const [clientIdFilter, setClientIdFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reassigningId, setReassigningId] = useState<string | null>(null);

  const { data: status, isLoading: statusLoading, error: statusError } = useQuery<SlackStatus>({
    queryKey: ["/api/integrations/slack/status"],
    // Task #2820 — while the status route reports "status unknown" (transient
    // settings-read blip, Task #2811's 503 contract), keep re-checking so the
    // neutral state resolves itself without a manual reload.
    refetchInterval: (query) =>
      parseIntegrationStatusUnknownError(query.state.error) ? 15_000 : false,
  });
  // Task #2820 — a status-unknown 503 with NO previously-loaded data must
  // render as neutral "checking", never as "Not Connected". When data exists
  // from an earlier success, React Query keeps it across the failed refetch,
  // so the last-known badge continues to render unchanged.
  const statusUnknown = !status && !!parseIntegrationStatusUnknownError(statusError);

  // Task #2177 — pull the Slack auth-dead breaker detail from the shared
  // all-status endpoint so the dedicated console matches the Integrations Hub.
  const { data: allStatus } = useQuery<{ slack?: SlackBreakerStatus }>({
    queryKey: ["/api/integrations/all-status"],
  });
  const slackBreaker = allStatus?.slack;

  const { data: syncHistory = [] } = useQuery<SyncHistory[]>({
    queryKey: ["/api/integrations/slack/sync-history"],
  });

  const feedQueryParams = new URLSearchParams();
  feedQueryParams.set("page", String(page));
  feedQueryParams.set("limit", "25");
  if (matchFilter !== "all") feedQueryParams.set("match", matchFilter);
  if (channelFilter) feedQueryParams.set("channel", channelFilter);
  if (clientIdFilter !== "all") feedQueryParams.set("clientId", clientIdFilter);
  if (dateFrom) feedQueryParams.set("dateFrom", dateFrom);
  if (dateTo) feedQueryParams.set("dateTo", dateTo);

  const { data: feedData, isLoading: feedLoading } = useQuery<MessageFeedResponse>({
    queryKey: ["/api/integrations/slack/messages", feedQueryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/integrations/slack/messages?${feedQueryParams.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch messages");
      return res.json();
    },
    enabled: !!status?.connected,
  });

  const { data: clientsList = [] } = useQuery<ClientOption[]>({
    queryKey: ["/api/clients-list"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) return [];
      const data: { data?: Array<{ id: string; firmName: string }>; } | Array<{ id: string; firmName: string }> = await res.json();
      const list: Array<{ id: string; firmName: string }> = Array.isArray(data) ? data : (data.data || []);
      return list.map((c) => ({ id: c.id, firmName: c.firmName }));
    },
    enabled: !!status?.connected,
  });

  const connectMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (token: string) => {
      const res = await apiRequest("POST", "/api/integrations/slack/connect", { token });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Slack connected successfully" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/status"] }); // fire-and-forget: cache refresh only
      setShowConnectDialog(false);
      setBotToken("");
    },
    onError: (err: any) => {
      toast({ title: "Connection failed", description: err.message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/slack/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Slack disconnected" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/status"] }); // fire-and-forget: cache refresh only
      // Also drop feed/sync-history/channel caches — otherwise a stale
      // "connected" snapshot of the feed keeps rendering after disconnect
      // until an unrelated refetch happens to clear it.
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/sync-history"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/messages"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/channels"] }); // fire-and-forget: cache refresh only
    },
  });

  const syncMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/slack/sync");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sync completed",
        description: `${data.messagesCreated} new messages, ${data.messagesSkipped} skipped${data.errors?.length ? `, ${data.errors.length} errors` : ""}`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/sync-history"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/messages"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/sync-history"] }); // fire-and-forget: cache refresh only
    },
  });

  const reassignMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ messageId, clientId }: { messageId: string; clientId: string | null }) => {
      setReassigningId(messageId);
      const res = await apiRequest("PATCH", `/api/integrations/slack/messages/${messageId}/reassign`, { clientId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Message reassigned" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/messages"] }); // fire-and-forget: cache refresh only
      setReassigningId(null);
    },
    onError: (err: any) => {
      toast({ title: "Reassignment failed", description: err.message, variant: "destructive" });
      setReassigningId(null);
    },
  });

  const statusColor = statusUnknown
    ? "bg-muted text-muted-foreground"
    : status?.connected && status?.valid
    ? "bg-green-100 text-green-700"
    : status?.connected
    ? "bg-amber-100 text-amber-700"
    : "bg-muted text-muted-foreground";

  const statusLabel = statusUnknown
    ? "Checking…"
    : status?.connected && status?.valid
    ? "Connected"
    : status?.connected
    ? "Token Invalid"
    : "Not Connected";

  const stats = feedData?.stats;
  const messages = feedData?.messages || [];
  const pagination = feedData?.pagination;

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-2">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader
          className="mb-8"
          title="Slack Integration"
          icon={MessageSquare}
          backHref="/"
          backLabel="Dashboard"
          backTestId="button-back-dashboard"
          subtitle="Connect Slack to automatically ingest channel messages"
          actions={
            <Badge className={statusColor} data-testid="badge-connection-status">{statusLabel}</Badge>
          }
        />

        <Card className="mb-6" data-testid="card-connection-status">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-lg">Connection</CardTitle>
              <LastEditedBadge info={status?.lastEdited?.botToken} testId="badge-last-edited-slack-bot-token" />
            </div>
          </CardHeader>
          <CardContent>
            {statusLoading ? (
              <InlineLoadingSkeleton lines={2} />
            ) : statusUnknown ? (
              <div className="flex items-center gap-3" data-testid="text-slack-status-unknown">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                <p className="text-muted-foreground">
                  Status check temporarily unavailable — retrying. This is not a disconnect.
                </p>
              </div>
            ) : status?.connected && status?.valid ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <div>
                    <p className="font-medium" data-testid="text-team-name">Connected to {status.team}</p>
                    <p className="text-sm text-muted-foreground">Bot user: {status.user}</p>
                  </div>
                </div>
                {/* Task #4357: disconnect drops the stored bot token for the
                    whole workspace — confirm before firing. */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disconnectMutation.isPending}
                      data-testid="button-disconnect"
                    >
                      <Unlink className="w-4 h-4 mr-1" />
                      Disconnect
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent data-testid="dialog-confirm-slack-disconnect">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect Slack?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Removes the stored bot token. Slack alerts, channel
                        lookups, and message sync stop for everyone until a new
                        token is connected.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel data-testid="button-slack-disconnect-abort">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        data-testid="button-slack-disconnect-confirm"
                        onClick={() => disconnectMutation.mutate()}
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground">
                  Connect a Slack workspace by providing a Bot User OAuth Token.
                </p>
                <Button
                  onClick={() => setShowConnectDialog(true)}
                  data-testid="button-connect-slack"
                >
                  <Link2 className="w-4 h-4 mr-1" />
                  Connect Slack
                </Button>
              </div>
            )}
            {slackBreaker?.breakerOpen && (
              <div className="mt-3">
                <BreakerDetailRow
                  lastTrippedAt={slackBreaker.lastTrippedAt}
                  cooldownUntil={slackBreaker.cooldownUntil}
                  tripCount={slackBreaker.tripCount}
                  testIdPrefix="slack"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {status?.connected && (
          <>
            <Card className="mb-6" data-testid="card-notifications-console-link">
              <CardContent className="py-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">Slack Notifications Console</p>
                  <p className="text-xs text-muted-foreground">
                    System-wide control of Slack alerts: routing, on/off, kill switch, delivery history.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => navigate("/admin/slack/notifications")}
                  data-testid="button-open-notifications-console"
                >
                  Open console
                </Button>
              </CardContent>
            </Card>
            <AlertChannelCard />

            <Card className="mb-6" data-testid="card-sync-control">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Sync Messages</CardTitle>
                  <Button
                    onClick={() => syncMutation.mutate()}
                    disabled={syncMutation.isPending}
                    data-testid="button-trigger-sync"
                  >
                    {syncMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4 mr-1" />
                    )}
                    {syncMutation.isPending ? "Syncing..." : "Sync Now"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-lg" data-testid="info-auto-sync">
                  <Radio className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-blue-800">
                    <p className="font-medium mb-1">Automatic channel discovery</p>
                    <p className="text-blue-700">
                      Sync automatically pulls messages from all channels the bot has access to.
                      Each message is matched to a client using firm name, client code, contact name,
                      and content analysis. Unmatched messages are saved for manual review.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {stats && (
              <div className="grid grid-cols-4 gap-4 mb-6" data-testid="stats-summary">
                <Card>
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold" data-testid="stat-total">{stats.total}</p>
                    <p className="text-xs text-muted-foreground">Total Messages</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold text-green-600" data-testid="stat-matched">{stats.matched}</p>
                    <p className="text-xs text-muted-foreground">Matched</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold text-muted-foreground" data-testid="stat-unmatched">{stats.unmatched}</p>
                    <p className="text-xs text-muted-foreground">Unmatched</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold text-blue-600" data-testid="stat-match-rate">{stats.matchRate}%</p>
                    <p className="text-xs text-muted-foreground">Match Rate</p>
                  </CardContent>
                </Card>
              </div>
            )}

            <Card className="mb-6" data-testid="card-message-feed">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Message Review Feed</CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/integrations/slack/messages"] })}
                    data-testid="button-refresh-feed"
                  >
                    <RefreshCw className="w-4 h-4 mr-1" />
                    Refresh
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-3 mb-4 p-3 bg-muted/50 rounded-lg" data-testid="filters-bar">
                  <div className="flex items-center gap-1">
                    <Filter className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Filters:</span>
                  </div>

                  <Select
                    value={matchFilter}
                    onValueChange={(v) => { setMatchFilter(v); setPage(1); }}
                  >
                    <SelectTrigger className="w-36 h-8 text-sm" data-testid="filter-match-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Messages</SelectItem>
                      <SelectItem value="matched">Matched</SelectItem>
                      <SelectItem value="unmatched">Unmatched</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    value={clientIdFilter}
                    onValueChange={(v) => { setClientIdFilter(v); setPage(1); }}
                  >
                    <SelectTrigger className="w-44 h-8 text-sm" data-testid="filter-client">
                      <SelectValue placeholder="All Clients" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Clients</SelectItem>
                      {clientsList.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.firmName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <div className="relative">
                    <Hash className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 w-36 pl-7 text-sm"
                      placeholder="Channel..."
                      value={channelFilter}
                      onChange={(e) => { setChannelFilter(e.target.value); setPage(1); }}
                      data-testid="filter-channel"
                    />
                  </div>

                  <div className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      type="date"
                      className="h-8 w-36 text-sm"
                      value={dateFrom}
                      onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                      data-testid="filter-date-from"
                    />
                    <span className="text-muted-foreground text-sm">-</span>
                    <Input
                      type="date"
                      className="h-8 w-36 text-sm"
                      value={dateTo}
                      onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                      data-testid="filter-date-to"
                    />
                  </div>

                  {(matchFilter !== "all" || channelFilter || clientIdFilter !== "all" || dateFrom || dateTo) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setMatchFilter("all");
                        setChannelFilter("");
                        setClientIdFilter("all");
                        setDateFrom("");
                        setDateTo("");
                        setPage(1);
                      }}
                      data-testid="button-clear-filters"
                    >
                      <X className="w-3.5 h-3.5 mr-1" />
                      Clear
                    </Button>
                  )}
                </div>

                {feedLoading ? (
                  <InlineLoadingSkeleton lines={5} />
                ) : messages.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-8">
                    No messages found. {stats?.total === 0 ? "Click Sync Now to pull messages." : "Try adjusting your filters."}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {messages.map((msg) => (
                      <MessageRow
                        key={msg.id}
                        msg={msg}
                        isExpanded={expandedId === msg.id}
                        onToggle={() => setExpandedId(expandedId === msg.id ? null : msg.id)}
                        clients={clientsList}
                        onReassign={(messageId, clientId) => reassignMutation.mutate({ messageId, clientId })}
                        isReassigning={reassigningId === msg.id}
                      />
                    ))}
                  </div>
                )}

                {pagination && pagination.totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-4 border-t" data-testid="pagination">
                    <p className="text-sm text-muted-foreground">
                      Page {pagination.page} of {pagination.totalPages}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page <= 1}
                        onClick={() => setPage(page - 1)}
                        data-testid="button-prev-page"
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= pagination.totalPages}
                        onClick={() => setPage(page + 1)}
                        data-testid="button-next-page"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card data-testid="card-sync-history">
              <CardHeader>
                <CardTitle className="text-lg">Sync History</CardTitle>
              </CardHeader>
              <CardContent>
                {syncHistory.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No sync runs yet.</p>
                ) : (
                  <div className="space-y-2">
                    {syncHistory.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between p-3 border rounded-lg text-sm"
                        data-testid={`row-sync-${entry.id}`}
                      >
                        <div className="flex items-center gap-3">
                          {entry.status === "running" ? (
                            <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                          ) : entry.status === "completed" ? (
                            <CheckCircle className="w-4 h-4 text-green-500" />
                          ) : entry.status === "completed_with_errors" ? (
                            <AlertCircle className="w-4 h-4 text-amber-500" />
                          ) : (
                            <X className="w-4 h-4 text-red-500" />
                          )}
                          <div>
                            <p className="font-medium capitalize">{entry.status.replace(/_/g, " ")}</p>
                            <p className="text-xs text-muted-foreground">
                              {entry.startedAt && format(new Date(entry.startedAt), "MMM d, h:mm a")}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 text-muted-foreground">
                          <span>{entry.channelsProcessed} channels</span>
                          <span className="text-green-600">+{entry.messagesCreated} new</span>
                          <span>{entry.messagesSkipped} skipped</span>
                          {entry.errors && (entry.errors as string[]).length > 0 && (
                            <span className="text-red-500">{(entry.errors as string[]).length} errors</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Dialog open={showConnectDialog} onOpenChange={setShowConnectDialog}>
        <DialogContent data-testid="dialog-connect-slack">
          <DialogHeader>
            <DialogTitle>Connect Slack Workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Enter your Slack Bot User OAuth Token. You can find this in your Slack app's
              OAuth & Permissions page. The bot needs <code>channels:history</code>,{" "}
              <code>channels:read</code>, <code>groups:history</code>,{" "}
              <code>groups:read</code>, <code>users:read</code>, and{" "}
              <code>users:read.email</code> scopes.
            </p>
            <Input
              placeholder="xoxb-..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              type="password"
              data-testid="input-bot-token"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowConnectDialog(false)} data-testid="button-cancel-connect">
                Cancel
              </Button>
              <Button
                onClick={() => connectMutation.mutate(botToken)}
                disabled={!botToken || connectMutation.isPending}
                data-testid="button-submit-connect"
              >
                {connectMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Check className="w-4 h-4 mr-1" />
                )}
                Connect
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
